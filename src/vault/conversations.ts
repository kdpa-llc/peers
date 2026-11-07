/**
 * Conversations with bots (ADR 0003, PRODUCT.md §4.3).
 *
 * Each bot has as many conversations as the owner likes; each is a T3 thread in the bot's
 * project. The first message of every conversation carries the bot's brief. Writing
 * `@Name` in any message also sends it to that bot, as a new conversation that links back.
 * When a run ends, the conversation is saved as text so other bots can read it.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Bot, BotRegistry } from "./bots.ts";
import type { BotEngine, EngineMessage, EngineThread, ThreadState } from "./engine.ts";
import { brief, forDisplay, mentions, withContext } from "./messages.ts";
import type { Layout } from "./layout.ts";
import type { VaultSettings } from "./state.ts";

export type Origin = "chat" | "notes" | "trigger" | "mention" | "manual" | "setup";

export type ThreadView = {
  id: string;
  bot_id: string;
  title: string;
  origin: Origin;
  state: ThreadState;
  error?: string;
  created_at: string;
  updated_at: string;
  last_run_at?: string;
  unread: boolean;
  archived: boolean;
  trigger_id?: string;
  from_thread?: string;
  model?: { provider: string; model: string };
};

export type DisplayMessage = {
  id: string;
  role: "owner" | "bot" | "trigger" | "system";
  text: string;
  at: string;
  streaming: boolean;
  notes?: { path: string; count: number };
  context?: string;
};

type Row = { thread_id: string; bot_id: string; origin: Origin; trigger_id: string | null; from_thread: string | null; seen_at: string | null; created_at: string };

export type Context = { path?: string; selection?: string };

export class Conversations {
  private readonly db: DatabaseSync;
  private readonly engine: BotEngine;
  private readonly registry: BotRegistry;
  private readonly root: string;
  readonly transcriptsDir: string;
  private readonly settings: () => VaultSettings;
  private readonly layout: () => Layout;
  private readonly now: () => Date;
  private readonly changed: (botId: string, thread: ThreadView) => void;
  private readonly exported = new Map<string, string>();

  constructor(args: {
    db: DatabaseSync; engine: BotEngine; registry: BotRegistry; root: string; stateDir: string;
    settings: () => VaultSettings; layout: () => Layout; now: () => Date; onChange: (botId: string, thread: ThreadView) => void;
  }) {
    this.db = args.db;
    this.engine = args.engine;
    this.registry = args.registry;
    this.root = args.root;
    this.transcriptsDir = join(args.stateDir, "conversations");
    this.settings = args.settings;
    this.layout = args.layout;
    this.now = args.now;
    this.changed = args.onChange;
    mkdirSync(this.transcriptsDir, { recursive: true, mode: 0o700 });
  }

  private row(threadId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM vault_threads WHERE thread_id = ?").get(threadId) as Row | undefined;
  }

  botOf(threadId: string): string | undefined {
    return this.row(threadId)?.bot_id;
  }

  // ------------------------------------------------------------------ projects

  /**
   * The vault's T3 project. All agents share it, rooted at the vault, so every agent's working
   * directory is the vault root; the brief says what each one looks after.
   */
  async project(): Promise<string> {
    const row = this.db.prepare("SELECT value FROM vault_meta WHERE key = 'project'").get() as { value?: string } | undefined;
    let known: { id?: string; path?: string } = {};
    try { known = row?.value ? JSON.parse(row.value) : {}; } catch { known = {}; }
    if (known.id && known.path === this.root && this.verified.has(known.id)) return known.id;
    const id = await this.engine.ensureProject(this.root, this.settings().name, known.path === this.root ? known.id : undefined);
    this.db.prepare("INSERT INTO vault_meta (key, value) VALUES ('project', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ id, path: this.root }));
    this.verified.add(id);
    return id;
  }

  private readonly verified = new Set<string>();

  // ------------------------------------------------------------------ sending

  briefFor(bot: Bot): string {
    const s = this.settings();
    const date = new Intl.DateTimeFormat("en-GB", {
      timeZone: s.tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
    }).format(this.now());
    const layout = this.layout();
    return brief({
      botName: bot.def.name,
      kind: bot.kind,
      home: bot.path,
      ...(bot.front ? { front: bot.front } : {}),
      vaultRoot: this.root,
      owner: s.owner,
      date,
      ...(bot.def.instructions ? { instructions: bot.def.instructions } : {}),
      writeHint: this.registry.writeHint(bot),
      memoryPath: this.registry.memoryPath(bot),
      otherBots: this.registry.list().filter((b) => b.def.id !== bot.def.id && !b.archived)
        .map((b) => ({ name: b.def.name, path: b.kind === "vault" ? "everything no other agent looks after" : b.kind === "folder" ? `${b.path}/` : b.path })),
      rules: layout.rules,
      readonly: layout.readonly,
      conversationsDir: this.transcriptsDir,
    });
  }

  /** Start a conversation with a bot. The message is sent after the bot's brief. */
  async start(bot: Bot, text: string, opts: { origin: Origin; title?: string; trigger_id?: string; from_thread?: string } ): Promise<string> {
    const projectId = await this.project();
    const model = { ...this.settings().default_model, ...(bot.def.model ?? {}) };
    const title = (opts.title ?? titleFrom(text)).slice(0, 120);
    const threadId = await this.engine.launch({ projectId, title, model, text: `${this.briefFor(bot)}\n\n${text}` });
    this.db.prepare(
      `INSERT OR IGNORE INTO vault_threads (thread_id, bot_id, origin, trigger_id, from_thread, seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(threadId, bot.def.id, opts.origin, opts.trigger_id ?? null, opts.from_thread ?? null,
      opts.origin === "trigger" || opts.origin === "mention" ? null : this.now().toISOString(), this.now().toISOString());
    const view = this.view(threadId);
    if (view) this.changed(bot.def.id, view);
    return threadId;
  }

  /** Add a message to a conversation; it runs after anything already running there. */
  async post(threadId: string, text: string): Promise<void> {
    if (!this.row(threadId)) throw new Error(`no conversation ${threadId}`);
    await this.engine.send(threadId, text);
    this.markRead(threadId);
  }

  /**
   * A message from the owner: into an existing conversation, or a new one with `botId`.
   * Every other bot it @mentions gets it too, as a new conversation of its own.
   */
  async fromOwner(args: { botId: string; threadId?: string; text: string; context?: Context }): Promise<{
    thread_id: string; mentioned: { bot_id: string; name: string; thread_id: string }[];
  }> {
    const bot = this.registry.get(args.botId);
    if (!bot) throw new Error(`no bot ${args.botId}`);
    const names = this.registry.list().filter((b) => !b.archived).map((b) => b.def.name);
    const others = mentions(args.text, names).map((n) => this.registry.byName(n))
      .filter((b): b is Bot => !!b && b.def.id !== bot.def.id);
    const body = withContext(args.text, { ...args.context, ...(others.length ? { alsoTo: others.map((b) => b.def.name) } : {}) });
    let threadId = args.threadId;
    if (threadId) {
      if (this.botOf(threadId) !== bot.def.id) throw new Error("that conversation belongs to another bot");
      await this.post(threadId, body);
    } else {
      threadId = await this.start(bot, body, { origin: "chat" });
    }
    const mentioned: { bot_id: string; name: string; thread_id: string }[] = [];
    for (const other of others) {
      const id = await this.start(other, withContext(args.text, { ...args.context, from: bot.def.name }), {
        origin: "mention", from_thread: threadId,
      });
      mentioned.push({ bot_id: other.def.id, name: other.def.name, thread_id: id });
    }
    return { thread_id: threadId, mentioned };
  }

  // ------------------------------------------------------------------ reading

  view(threadId: string): ThreadView | undefined {
    const row = this.row(threadId);
    const t = this.engine.thread(threadId);
    if (!row) return undefined;
    const now = this.now().toISOString();
    const lastRun = t?.lastRunAt;
    return {
      id: threadId,
      bot_id: row.bot_id,
      title: t?.title ?? "Conversation",
      origin: row.origin,
      state: t?.state ?? "idle",
      ...(t?.error ? { error: t.error } : {}),
      created_at: t?.createdAt ?? row.created_at ?? now,
      updated_at: t?.updatedAt ?? row.created_at ?? now,
      ...(lastRun ? { last_run_at: lastRun } : {}),
      unread: !!lastRun && (!row.seen_at || lastRun > row.seen_at),
      archived: t?.archived ?? false,
      ...(row.trigger_id ? { trigger_id: row.trigger_id } : {}),
      ...(row.from_thread ? { from_thread: row.from_thread } : {}),
      ...(t?.model ? { model: t.model } : {}),
    };
  }

  list(botId: string, opts: { archived?: boolean } = {}): ThreadView[] {
    const rows = this.db.prepare("SELECT thread_id FROM vault_threads WHERE bot_id = ?").all(botId) as { thread_id: string }[];
    return rows.map((r) => this.view(r.thread_id)).filter((v): v is ThreadView => !!v && v.archived === !!opts.archived)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  all(): ThreadView[] {
    const rows = this.db.prepare("SELECT thread_id FROM vault_threads").all() as { thread_id: string }[];
    return rows.map((r) => this.view(r.thread_id)).filter((v): v is ThreadView => !!v);
  }

  /** The newest conversation a trigger started, to keep its runs in one place. */
  triggerThread(botId: string, triggerId: string): ThreadView | undefined {
    const rows = this.db.prepare("SELECT thread_id FROM vault_threads WHERE bot_id = ? AND trigger_id = ? ORDER BY created_at DESC").all(botId, triggerId) as { thread_id: string }[];
    return rows.map((r) => this.view(r.thread_id)).find((v) => v && !v.archived);
  }

  async messages(threadId: string): Promise<DisplayMessage[]> {
    const row = this.row(threadId);
    if (!row) throw new Error(`no conversation ${threadId}`);
    return (await this.engine.messages(threadId)).map((m) => display(m, row.origin)).filter((m) => m.text || m.notes || m.streaming);
  }

  unread(botId: string): number {
    return this.list(botId).filter((t) => t.unread).length;
  }

  stateOf(botId: string): ThreadState {
    const threads = this.list(botId);
    if (threads.some((t) => t.state === "working")) return "working";
    if (threads.some((t) => t.state === "waiting")) return "waiting";
    return "idle";
  }

  workingBots(): Set<string> {
    const out = new Set<string>();
    for (const t of this.engine.threads()) {
      if (t.state !== "working") continue;
      const bot = this.botOf(t.id);
      if (bot) out.add(bot);
    }
    return out;
  }

  /** The owner has read the conversation up to its latest reply. */
  markRead(threadId: string): void {
    const now = this.now().toISOString();
    const last = this.engine.thread(threadId)?.lastRunAt;
    this.db.prepare("UPDATE vault_threads SET seen_at = ? WHERE thread_id = ?").run(last && last > now ? last : now, threadId);
  }

  async stop(threadId: string): Promise<void> {
    await this.engine.interrupt(threadId);
  }

  async stopBot(botId: string): Promise<number> {
    const working = this.list(botId).filter((t) => t.state === "working");
    for (const t of working) await this.engine.interrupt(t.id);
    return working.length;
  }

  async archive(threadId: string): Promise<void> {
    await this.engine.archive(threadId);
  }

  // ------------------------------------------------------------------ engine updates

  /** An engine thread changed. Returns the view when it is one of ours. */
  onEngine(t: EngineThread): ThreadView | undefined {
    const view = this.view(t.id);
    if (!view) return undefined;
    this.changed(view.bot_id, view);
    if (t.state !== "working" && t.lastRunAt && this.exported.get(t.id) !== t.lastRunAt) {
      this.exported.set(t.id, t.lastRunAt);
      void this.exportTranscript(view).catch(() => { /* best effort */ });
    }
    return view;
  }

  /** Save a conversation as text where other bots can read it. */
  async exportTranscript(view: ThreadView): Promise<void> {
    const bot = this.registry.get(view.bot_id);
    if (!bot) return;
    const dir = join(this.transcriptsDir, safeName(bot.def.name));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const owner = this.settings().owner;
    const msgs = await this.messages(view.id);
    const name = `${view.created_at.slice(0, 10)} ${safeName(view.title)} (${view.id.slice(0, 8)}).md`;
    // A renamed conversation keeps one file.
    for (const f of readdirSync(dir)) if (f.endsWith(`(${view.id.slice(0, 8)}).md`) && f !== name) unlinkSync(join(dir, f));
    const body = [
      `# ${view.title}`, "",
      `${bot.def.name} · ${view.origin} · started ${view.created_at}`, "",
      ...msgs.map((m) => {
        const who = m.role === "owner" ? owner : m.role === "bot" ? bot.def.name : m.role === "trigger" ? "Trigger" : "System";
        const notes = m.notes ? ` (sent ${m.notes.count} note${m.notes.count === 1 ? "" : "s"} on ${m.notes.path})` : "";
        return `**${who}** · ${m.at}${notes}\n\n${m.text}\n`;
      }),
    ].join("\n");
    writeFileSync(join(dir, name), body, { mode: 0o600 });
  }
}

function display(m: EngineMessage, origin: Origin): DisplayMessage {
  if (m.role === "assistant") return { id: m.id, role: "bot", text: m.text, at: m.createdAt, streaming: m.streaming };
  if (m.role === "system") return { id: m.id, role: "system", text: m.text, at: m.createdAt, streaming: false };
  const d = forDisplay(m.text);
  return {
    id: m.id,
    role: origin === "trigger" ? "trigger" : "owner",
    text: d.text,
    at: m.createdAt,
    streaming: false,
    ...(d.notes ? { notes: d.notes } : {}),
    ...(d.context ? { context: d.context } : {}),
  };
}

export function titleFrom(text: string): string {
  const plain = forDisplay(text).text.replace(/\s+/g, " ").trim();
  if (!plain) return "Conversation";
  return plain.length > 60 ? `${plain.slice(0, 57).trimEnd()}…` : plain;
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
}
