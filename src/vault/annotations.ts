/**
 * Notes: marks on a page plus the owner's instruction (TECHNICAL.md §8, ADR 0003).
 *
 * Drafts are stored as soon as a mark exists. Sending re-anchors every note against the
 * page as it is now; a note whose quote, prefix and suffix do not match exactly one place
 * becomes `unresolved` and is not sent (a misplaced edit is worse than no edit). The batch
 * goes to the page's bot as one message in a conversation. When that conversation's run
 * ends, each note is `applied` if the text it marks changed, otherwise `answered`.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Bot, BotRegistry } from "./bots.ts";
import { diffLines, touches } from "./diff.ts";
import type { EngineThread } from "./engine.ts";
import { sha256 } from "./files.ts";
import { notesMessage, type NoteLine } from "./messages.ts";
import { isOrgPath, orgHidden } from "./org.ts";
import { checkRead } from "./paths.ts";
import { kindOf } from "./vault.ts";

export type Quote = { exact: string; prefix?: string; suffix?: string };
export type Target = { lines?: [number, number]; quote?: Quote; label?: string };

export type NoteStatus =
  | "draft" | "sent" | "working" | "applied" | "answered" | "declined" | "done" | "unresolved" | "failed";

export type Note = {
  annotation_id: string;
  client_key: string;
  path: string;
  doc_blob?: string | null;
  tool: "select" | "pen" | "arrow";
  anchor?: Target & { to?: Target; page?: number; region?: [number, number, number, number] };
  ink?: { paths: string[]; frame: { width: number; height: number } } | null;
  instruction?: string;
  attachment_id?: string | null;
  status: NoteStatus;
  reason?: string | null;
  thread_id?: string | null;
  bot_id?: string | null;
  sent_at?: string | null;
  /** Hash of the page when the note was sent; its text is kept until the outcome is known. */
  sent_blob?: string | null;
  created_at: string;
  updated_at?: string;
};

type Row = Record<string, string | number | null>;

const FINAL: NoteStatus[] = ["applied", "answered", "declined", "done", "failed"];

// ------------------------------------------------------------------ anchoring

/**
 * A plain-text projection of markdown source with a map back to source offsets, so a quote
 * taken from the rendered page can be found in the source despite markup characters.
 */
export function project(source: string): { plain: string; map: number[] } {
  const plain: string[] = [];
  const map: number[] = [];
  let i = 0;
  let lineStart = true;
  const push = (ch: string, at: number): void => {
    if (/\s/.test(ch)) {
      if (plain.length && plain[plain.length - 1] !== " ") { plain.push(" "); map.push(at); }
      return;
    }
    plain.push(ch);
    map.push(at);
  };
  while (i < source.length) {
    if (lineStart) {
      const m = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\|)?/.exec(source.slice(i, i + 40));
      if (m && m[0].length) i += m[0].length;
      lineStart = false;
      continue;
    }
    const ch = source[i]!;
    if (ch === "\n") { push(" ", i); i++; lineStart = true; continue; }
    if (ch === "]" && source[i + 1] === "(") {
      const close = source.indexOf(")", i);
      if (close > 0 && close - i < 400) { i = close + 1; continue; }
    }
    if (ch === "[" && source[i + 1] === "[") {
      const close = source.indexOf("]]", i);
      const inner = close > 0 ? source.slice(i + 2, close) : "";
      if (close > 0 && !inner.includes("\n")) {
        const label = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
        const labelAt = i + 2 + (inner.includes("|") ? inner.indexOf("|") + 1 : 0);
        for (let k = 0; k < label.length; k++) push(label[k]!, labelAt + k);
        i = close + 2;
        continue;
      }
    }
    if ("*_`~[]|\\".includes(ch) || (ch === "=" && (source[i + 1] === "=" || source[i - 1] === "="))) { i++; continue; }
    push(ch, i);
    i++;
  }
  return { plain: plain.join(""), map };
}

const norm = (s: string): string => s.replace(/[*_`~\[\]|\\]/g, "").replace(/\s+/g, " ").trim();

function lineOf(source: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") n++;
  return n;
}

/** The visible text of an Org source, with the same map back to source offsets. */
export function projectOrg(source: string): { plain: string; map: number[] } {
  const hidden = orgHidden(source);
  const plain: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (hidden[i]) continue;
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      if (plain.length && plain[plain.length - 1] !== " ") { plain.push(" "); map.push(i); }
      continue;
    }
    // The same characters `norm` drops from a quote.
    if ("*_`~[]|\\".includes(ch)) continue;
    plain.push(ch);
    map.push(i);
  }
  return { plain: plain.join(""), map };
}

/** Find a quote in the source. Returns lines only when exactly one place matches. */
export function locate(source: string, quote: Quote, format: "markdown" | "org" = "markdown"): [number, number] | undefined {
  const exact = norm(quote.exact);
  if (!exact) return undefined;
  const { plain, map } = format === "org" ? projectOrg(source) : project(source);
  const hits: number[] = [];
  for (let at = plain.indexOf(exact); at >= 0; at = plain.indexOf(exact, at + 1)) hits.push(at);
  let candidates = hits;
  if (candidates.length > 1 && quote.prefix) {
    const pre = norm(quote.prefix).slice(-24);
    if (pre) candidates = candidates.filter((at) => plain.slice(Math.max(0, at - pre.length - 2), at).trimEnd().endsWith(pre.trimEnd()));
  }
  if (candidates.length > 1 && quote.suffix) {
    const suf = norm(quote.suffix).slice(0, 24);
    if (suf) candidates = candidates.filter((at) => plain.slice(at + exact.length, at + exact.length + suf.length + 2).trimStart().startsWith(suf.trimStart()));
  }
  if (candidates.length !== 1) return undefined;
  const start = map[candidates[0]!]!;
  const end = map[Math.min(map.length - 1, candidates[0]! + exact.length - 1)]!;
  return [lineOf(source, start), lineOf(source, end)];
}

function label(lines: [number, number] | undefined, quote?: Quote): string {
  const where = !lines ? "" : lines[0] === lines[1] ? `Line ${lines[0]}` : `Lines ${lines[0]}-${lines[1]}`;
  const q = quote?.exact ? norm(quote.exact) : "";
  const excerpt = q ? `"${q.length > 60 ? `${q.slice(0, 57)}…` : q}"` : "";
  return [where, excerpt].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ service

export type Deliver = (bot: Bot, text: string, title: string) => Promise<string>;

export class Notes {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly registry: BotRegistry;
  private readonly root: string;
  private readonly attachmentsDir: string;
  private readonly snapshots: string;
  private readonly changed: (note: Note) => void;
  private readonly inflight = new Map<string, Promise<SendResult>>();

  constructor(args: {
    db: DatabaseSync; now: () => Date; registry: BotRegistry; root: string; stateDir: string;
    onChange?: (note: Note) => void;
  }) {
    this.db = args.db;
    this.now = args.now;
    this.registry = args.registry;
    this.root = args.root;
    this.attachmentsDir = join(args.stateDir, "attachments");
    this.snapshots = join(args.stateDir, "note-pages");
    this.changed = args.onChange ?? (() => {});
    mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.snapshots, { recursive: true, mode: 0o700 });
  }

  private iso(): string { return this.now().toISOString(); }

  private load(row: Row | undefined): Note | undefined {
    return row ? (JSON.parse(String(row.doc)) as Note) : undefined;
  }

  get(id: string): Note | undefined {
    return this.load(this.db.prepare("SELECT doc FROM vault_annotations WHERE annotation_id = ?").get(id) as Row | undefined);
  }

  byKey(key: string): Note | undefined {
    return this.load(this.db.prepare("SELECT doc FROM vault_annotations WHERE client_key = ?").get(key) as Row | undefined);
  }

  forPath(path: string): Note[] {
    return (this.db.prepare("SELECT doc FROM vault_annotations WHERE path = ? ORDER BY created_at").all(path) as Row[])
      .map((r) => this.load(r)!);
  }

  forThread(threadId: string): Note[] {
    return (this.db.prepare("SELECT doc FROM vault_annotations WHERE thread_id = ? ORDER BY created_at").all(threadId) as Row[])
      .map((r) => this.load(r)!);
  }

  unresolved(): Note[] {
    return (this.db.prepare("SELECT doc FROM vault_annotations WHERE status IN ('unresolved', 'failed') ORDER BY updated_at DESC LIMIT 50").all() as Row[])
      .map((r) => this.load(r)!);
  }

  private save(note: Note): Note {
    note.updated_at = this.iso();
    this.db.prepare(
      `INSERT INTO vault_annotations (annotation_id, client_key, path, status, thread_id, doc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(annotation_id) DO UPDATE SET path = excluded.path, status = excluded.status,
         thread_id = excluded.thread_id, doc = excluded.doc, updated_at = excluded.updated_at`,
    ).run(note.annotation_id, note.client_key, note.path, note.status, note.thread_id ?? null,
      JSON.stringify(note), note.created_at, note.updated_at);
    this.changed(note);
    return note;
  }

  private hashOf(path: string): string | null {
    try { return sha256(readFileSync(join(this.root, path))); } catch { return null; }
  }

  /** Create or update a draft. Notes already sent cannot be edited. */
  upsert(input: Partial<Note> & { client_key: string; path: string }): Note {
    const path = checkRead(this.root, input.path);
    if (typeof input.client_key !== "string" || input.client_key.length < 8 || input.client_key.length > 80) {
      throw new Error("client_key must be 8-80 characters");
    }
    const existing = this.byKey(input.client_key);
    if (existing && !["draft", "unresolved"].includes(existing.status)) return existing;
    const now = this.iso();
    const note: Note = {
      annotation_id: existing?.annotation_id ?? `ann-${randomId()}`,
      client_key: input.client_key,
      path,
      doc_blob: input.doc_blob ?? existing?.doc_blob ?? this.hashOf(path),
      tool: (["select", "pen", "arrow"] as const).includes(input.tool as "pen") ? input.tool! : existing?.tool ?? "select",
      ...(input.anchor ?? existing?.anchor ? { anchor: sanitizeAnchor(input.anchor ?? existing?.anchor) } : {}),
      ...(input.ink !== undefined || existing?.ink ? { ink: sanitizeInk(input.ink ?? existing?.ink) } : {}),
      instruction: String(input.instruction ?? existing?.instruction ?? "").slice(0, 4000),
      attachment_id: input.attachment_id ?? existing?.attachment_id ?? null,
      status: "draft",
      reason: null,
      created_at: existing?.created_at ?? now,
    };
    return this.save(note);
  }

  remove(id: string): boolean {
    const note = this.get(id);
    if (!note || !["draft", "unresolved", ...FINAL].includes(note.status)) return false;
    this.db.prepare("DELETE FROM vault_annotations WHERE annotation_id = ?").run(id);
    this.changed({ ...note, status: "done", reason: "removed" });
    return true;
  }

  saveAttachment(png: Buffer): string {
    if (png.length > 2 * 1024 * 1024) throw new Error("attachment larger than 2 MB");
    if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) throw new Error("attachment must be a PNG");
    const id = `att-${sha256(png).slice(0, 20)}`;
    const file = this.attachmentPath(id)!;
    if (!existsSync(file)) writeFileSync(file, png, { mode: 0o600 });
    return id;
  }

  attachmentPath(id: string): string | undefined {
    return /^att-[a-f0-9]{20}$/.test(id) ? join(this.attachmentsDir, `${id}.png`) : undefined;
  }

  attachment(id: string): Buffer | undefined {
    const file = this.attachmentPath(id);
    return file && existsSync(file) ? readFileSync(file) : undefined;
  }

  /**
   * Send the draft notes with these keys to the page's bot. Repeating the same idempotency
   * key returns the first result instead of sending twice.
   */
  send(args: { path: string; keys: string[]; idempotency_key: string }, deliver: Deliver): Promise<SendResult> {
    const idemKey = `notes:${args.idempotency_key}`;
    const prior = this.db.prepare("SELECT result FROM vault_idempotency WHERE key = ?").get(idemKey) as Row | undefined;
    if (prior) return Promise.resolve(JSON.parse(String(prior.result)) as SendResult);
    const running = this.inflight.get(idemKey);
    if (running) return running;
    const p = this.doSend(args, deliver, idemKey).finally(() => this.inflight.delete(idemKey));
    this.inflight.set(idemKey, p);
    return p;
  }

  private async doSend(args: { path: string; keys: string[] }, deliver: Deliver, idemKey: string): Promise<SendResult> {
    const path = checkRead(this.root, args.path);
    const notes = args.keys.map((k) => this.byKey(k)).filter((n): n is Note => !!n && n.path === path && ["draft", "unresolved"].includes(n.status));
    const bot = this.registry.ownerOf(path);
    const kind = kindOf(path);
    let raw: Buffer | undefined;
    try { raw = readFileSync(join(this.root, path)); } catch { raw = undefined; }
    const source = raw && (kind === "page" || kind === "text") ? raw.toString("utf8") : "";
    const currentBlob = raw ? sha256(raw) : null;
    const sent: Note[] = [];
    const unresolved: Note[] = [];
    for (const note of notes) {
      const resolved = this.resolve(note, source, currentBlob);
      if (!resolved) {
        unresolved.push(this.save({ ...note, status: "unresolved", reason: "the page changed and this mark no longer points at one place; redraw it" }));
        continue;
      }
      sent.push({ ...note, anchor: resolved });
    }
    let threadId: string | undefined;
    if (sent.length > 0) {
      const text = this.message(path, kind, sent);
      // Named by the page and its first instruction, so several sends on one page tell apart.
      const page = path.split("/").pop()!.replace(/\.(md|markdown|org)$/i, "");
      const first = sent.map((n) => n.instruction?.trim() ?? "").find(Boolean);
      const title = first ? `${page}: ${first.length > 48 ? `${first.slice(0, 47)}…` : first}` : `Notes on ${page}`;
      threadId = await deliver(bot, text, title);
      if (currentBlob && source) {
        const snap = join(this.snapshots, currentBlob);
        if (!existsSync(snap)) writeFileSync(snap, source, { mode: 0o600 });
      }
      const at = this.iso();
      for (const n of sent) {
        this.save({ ...n, status: "sent", thread_id: threadId, bot_id: bot.def.id, sent_at: at, sent_blob: currentBlob, reason: null });
      }
    }
    const result: SendResult = {
      ...(threadId ? { thread_id: threadId } : {}), recipient: bot.def.id,
      sent: sent.map((n) => this.get(n.annotation_id)!), unresolved,
    };
    this.db.prepare("INSERT OR IGNORE INTO vault_idempotency (key, result, created_at) VALUES (?, ?, ?)")
      .run(idemKey, JSON.stringify(result), this.iso());
    return result;
  }

  /** Resolve a note against the page as it is now. Undefined means unresolved. */
  private resolve(note: Note, source: string, currentBlob: string | null): Note["anchor"] | undefined {
    const a = note.anchor ?? {};
    if (!a.quote?.exact) {
      // Region notes on images and PDFs, or a whole-page note.
      return { ...a, label: a.label ?? (a.page ? `Page ${a.page}` : "Whole page") };
    }
    const unchanged = currentBlob !== null && note.doc_blob === currentBlob;
    const format = isOrgPath(note.path) ? "org" : "markdown";
    const lines = unchanged && a.lines ? a.lines : locate(source, a.quote, format);
    if (!lines) return undefined;
    let to = a.to;
    if (to?.quote?.exact) {
      const toLines = unchanged && to.lines ? to.lines : locate(source, to.quote, format);
      if (!toLines) return undefined;
      to = { ...to, lines: toLines, label: label(toLines, to.quote) };
    }
    return { ...a, lines, label: label(lines, a.quote), ...(to ? { to } : {}) };
  }

  private message(path: string, kind: string, notes: Note[]): string {
    const lines: NoteLine[] = notes.map((n) => {
      const a = n.anchor ?? {};
      const sketch = n.attachment_id ? this.attachmentPath(n.attachment_id) : undefined;
      const extra = [
        a.to?.quote?.exact ? `the arrow points at "${a.to.quote.exact.slice(0, 300)}"` : "",
        a.region ? `region on the page (fractions x, y, w, h): ${a.region.map((v) => v.toFixed(2)).join(", ")}` : "",
        sketch && existsSync(sketch) ? `a picture of what the owner drew is at ${sketch}; look at it` : "",
      ].filter(Boolean).join("; ");
      return {
        id: n.annotation_id,
        tool: n.tool,
        ...(a.lines ? { lines: a.lines } : {}),
        ...(a.to?.lines ? { toLines: a.to.lines } : {}),
        ...(a.page ? { page: a.page } : {}),
        ...(a.quote?.exact ? { quote: a.quote.exact } : {}),
        instruction: [n.instruction?.trim(), extra ? `(${extra})` : ""].filter(Boolean).join(" "),
      };
    });
    const msg = notesMessage(path, lines);
    if (kind === "page" || kind === "text") return msg;
    return `${msg}\n${path} is ${kind === "pdf" ? "a PDF" : "an image"}: do not edit it. Answer here, or write a companion page next to it.`;
  }

  // ------------------------------------------------------------------ outcomes

  /** A conversation changed state: settle the notes it was handling. */
  onThread(t: EngineThread): void {
    const open = this.forThread(t.id).filter((n) => !FINAL.includes(n.status) && n.status !== "unresolved" && n.status !== "draft");
    if (!open.length) return;
    if (t.state === "working") {
      for (const n of open) if (n.status === "sent") this.save({ ...n, status: "working" });
      return;
    }
    // Only a run that finished after the notes were sent says anything about them.
    const ended = t.lastRunAt ?? t.updatedAt;
    const pending = open.filter((n) => !n.sent_at || ended > n.sent_at);
    if (!pending.length) return;
    if (t.state === "failed") {
      for (const n of pending) this.save({ ...n, status: "failed", reason: t.error ?? "the run did not finish" });
    } else if (t.state === "idle") {
      for (const n of pending) this.save({ ...n, ...this.outcome(n) });
    }
    this.prune();
  }

  private outcome(note: Note): { status: NoteStatus; reason: string | null } {
    const k = kindOf(note.path);
    if (k !== "page" && k !== "text") return { status: "answered", reason: null };
    let after = "";
    try { after = readFileSync(join(this.root, note.path), "utf8"); } catch { return { status: "applied", reason: "the page was moved or deleted" }; }
    const beforeFile = note.sent_blob ? join(this.snapshots, note.sent_blob) : undefined;
    const before = beforeFile && existsSync(beforeFile) ? readFileSync(beforeFile, "utf8") : undefined;
    if (before === undefined) return { status: "done", reason: null };
    if (before === after) return { status: "answered", reason: null };
    if (!note.anchor?.lines) return { status: "applied", reason: null };
    const hunks = diffLines(before, after);
    if (touches(hunks, note.anchor.lines) || (note.anchor.to?.lines && touches(hunks, note.anchor.to.lines))) {
      return { status: "applied", reason: null };
    }
    return { status: "answered", reason: "the page changed, but not the marked text" };
  }

  /** Drop page snapshots no open note needs. */
  private prune(): void {
    const open = new Set((this.db.prepare(
      "SELECT doc FROM vault_annotations WHERE status IN ('sent', 'working')",
    ).all() as Row[]).map((r) => (JSON.parse(String(r.doc)) as Note).sent_blob).filter(Boolean));
    for (const n of this.db.prepare("SELECT doc FROM vault_annotations WHERE status IN ('applied', 'answered', 'done', 'failed', 'declined')").all() as Row[]) {
      const blob = (JSON.parse(String(n.doc)) as Note).sent_blob;
      if (blob && !open.has(blob)) {
        try { unlinkSync(join(this.snapshots, blob)); } catch { /* already gone */ }
      }
    }
  }
}

export type SendResult = { thread_id?: string; recipient: string; sent: Note[]; unresolved: Note[] };

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeAnchor(raw: unknown): Note["anchor"] {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, any>;
  const lines = (v: unknown): [number, number] | undefined =>
    Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1) ? [v[0], v[1]] as [number, number] : undefined;
  const quote = (v: any): Quote | undefined => v && typeof v.exact === "string"
    ? { exact: v.exact.slice(0, 4000), ...(typeof v.prefix === "string" ? { prefix: v.prefix.slice(-200) } : {}), ...(typeof v.suffix === "string" ? { suffix: v.suffix.slice(0, 200) } : {}) }
    : undefined;
  const target = (v: any): Target | undefined => v && typeof v === "object"
    ? { ...(lines(v.lines) ? { lines: lines(v.lines) } : {}), ...(quote(v.quote) ? { quote: quote(v.quote) } : {}), ...(typeof v.label === "string" ? { label: v.label.slice(0, 200) } : {}) }
    : undefined;
  const region = Array.isArray(a.region) && a.region.length === 4 && a.region.every((n: unknown) => typeof n === "number" && n >= 0 && n <= 1)
    ? a.region as [number, number, number, number] : undefined;
  return {
    ...target(a),
    ...(target(a.to) ? { to: target(a.to) } : {}),
    ...(Number.isInteger(a.page) && a.page >= 1 ? { page: a.page } : {}),
    ...(region ? { region } : {}),
  };
}

function sanitizeInk(raw: unknown): Note["ink"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const paths = Array.isArray(r.paths) ? r.paths.filter((p: unknown) => typeof p === "string" && /^[MLCQZmlcqz0-9.,\s-]*$/.test(p)).slice(0, 40).map((p: string) => p.slice(0, 20000)) : [];
  const frame = r.frame && Number.isFinite(r.frame.width) && Number.isFinite(r.frame.height)
    ? { width: Number(r.frame.width), height: Number(r.frame.height) } : { width: 0, height: 0 };
  return { paths, frame };
}
