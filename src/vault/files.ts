/**
 * What changed in the vault since the owner last looked (ADR 0003, PRODUCT.md §4.2).
 *
 * Bots edit files directly, so there are no changesets to undo. Peers keeps, per file, its
 * current hash and who most likely changed it, and, per page, the version the owner last
 * saw. A page whose hash differs from the seen one shows its changed lines until the owner
 * has looked at it. The first scan of a vault counts everything as seen.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { diffLines, type Hunk } from "./diff.ts";
import { kindOf, type Vault } from "./vault.ts";

export type Attribution = { author: string; outsideScope: boolean; viaTrigger?: boolean };
export type FileChange = { path: string; op: "write" | "delete"; author: string; outsideScope: boolean; created: boolean; viaTrigger?: boolean };
export type FileRow = { path: string; hash: string; size: number; mtime_ms: number; author: string; outside_scope: number; updated_at: string };

const SEEN_LIMIT = 1024 * 1024;

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export class FileTracker {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly vault: Vault;
  private readonly blobDir: string;
  private readonly now: () => Date;
  private readonly attribute: (rel: string) => Attribution;

  constructor(args: {
    root: string; db: DatabaseSync; vault: Vault; blobDir: string; now: () => Date;
    attribute: (rel: string) => Attribution;
  }) {
    this.root = args.root;
    this.db = args.db;
    this.vault = args.vault;
    this.blobDir = args.blobDir;
    this.now = args.now;
    this.attribute = args.attribute;
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
  }

  row(rel: string): FileRow | undefined {
    return this.db.prepare("SELECT * FROM vault_files WHERE path = ?").get(rel) as FileRow | undefined;
  }

  hashOf(rel: string): string | null {
    try { return sha256(readFileSync(join(this.root, rel))); } catch { return null; }
  }

  isEmpty(): boolean {
    return !(this.db.prepare("SELECT 1 FROM vault_files LIMIT 1").get());
  }

  /** Reconcile the disk with what Peers knows. Returns the changes found. */
  scan(): FileChange[] {
    const baseline = this.isEmpty();
    const present = new Set<string>();
    const out: FileChange[] = [];
    for (const f of this.vault.files()) {
      present.add(f.path);
      const known = this.row(f.path);
      if (known && known.size === f.size && known.mtime_ms === f.mtime) continue;
      const c = this.record(f.path, { baseline, size: f.size, mtime: f.mtime });
      if (c) out.push(c);
    }
    const known = this.db.prepare("SELECT path FROM vault_files").all() as { path: string }[];
    for (const { path } of known) {
      if (present.has(path)) continue;
      const c = this.record(path);
      if (c) out.push(c);
    }
    return out;
  }

  /** A watcher hint for one path. Returns the change, or undefined when nothing changed. */
  touch(rel: string): FileChange | undefined {
    return this.record(rel);
  }

  private record(rel: string, opts: { baseline?: boolean; size?: number; mtime?: number } = {}): FileChange | undefined {
    const abs = join(this.root, rel);
    const prior = this.row(rel);
    let st;
    try { st = statSync(abs); } catch { st = undefined; }
    if (!st || !st.isFile()) {
      if (!prior) return undefined;
      this.db.prepare("DELETE FROM vault_files WHERE path = ?").run(rel);
      this.forgetSeen(rel);
      const who = this.attribute(rel);
      return { path: rel, op: "delete", author: who.author, outsideScope: who.outsideScope, created: false, ...(who.viaTrigger ? { viaTrigger: true } : {}) };
    }
    const data = readFileSync(abs);
    const hash = sha256(data);
    const size = opts.size ?? st.size;
    const mtime = opts.mtime ?? st.mtimeMs;
    if (prior && prior.hash === hash) {
      this.db.prepare("UPDATE vault_files SET size = ?, mtime_ms = ? WHERE path = ?").run(size, mtime, rel);
      return undefined;
    }
    const who: Attribution = opts.baseline ? { author: "external", outsideScope: false } : this.attribute(rel);
    this.db.prepare(
      `INSERT INTO vault_files (path, hash, size, mtime_ms, author, outside_scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms,
         author = excluded.author, outside_scope = excluded.outside_scope, updated_at = excluded.updated_at`,
    ).run(rel, hash, size, mtime, who.author, who.outsideScope ? 1 : 0, this.now().toISOString());
    if (opts.baseline) {
      this.markSeen(rel, data);
      return undefined;
    }
    return { path: rel, op: "write", author: who.author, outsideScope: who.outsideScope, created: !prior, ...(who.viaTrigger ? { viaTrigger: true } : {}) };
  }

  /** Move tracking with a file the owner moved, so it does not show as new. */
  moved(from: string, to: string): void {
    this.db.prepare("UPDATE OR REPLACE vault_files SET path = ? WHERE path = ?").run(to, from);
    this.db.prepare("UPDATE OR REPLACE vault_seen SET path = ? WHERE path = ?").run(to, from);
  }

  movedFolder(from: string, to: string): void {
    for (const table of ["vault_files", "vault_seen"]) {
      const rows = this.db.prepare(`SELECT path FROM ${table} WHERE path LIKE ? ESCAPE '\\'`).all(`${likeEscape(from)}/%`) as { path: string }[];
      for (const r of rows) this.db.prepare(`UPDATE OR REPLACE ${table} SET path = ? WHERE path = ?`).run(to + r.path.slice(from.length), r.path);
    }
  }

  // ------------------------------------------------------------------ seen

  /** The owner has looked at this file as it is now (or as `data`). */
  markSeen(rel: string, data?: Buffer): string | null {
    let buf = data;
    if (!buf) {
      try { buf = readFileSync(join(this.root, rel)); } catch { return null; }
    }
    const hash = sha256(buf);
    const old = this.db.prepare("SELECT hash FROM vault_seen WHERE path = ?").get(rel) as { hash?: string } | undefined;
    if (old?.hash === hash) return hash;
    const k = kindOf(rel);
    if ((k === "page" || k === "text") && buf.length <= SEEN_LIMIT) {
      const file = join(this.blobDir, hash);
      if (!existsSync(file)) writeFileSync(file, buf, { mode: 0o600 });
    }
    this.db.prepare(
      `INSERT INTO vault_seen (path, hash, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, seen_at = excluded.seen_at`,
    ).run(rel, hash, this.now().toISOString());
    if (old?.hash) this.dropBlob(old.hash);
    return hash;
  }

  private forgetSeen(rel: string): void {
    const old = this.db.prepare("SELECT hash FROM vault_seen WHERE path = ?").get(rel) as { hash?: string } | undefined;
    this.db.prepare("DELETE FROM vault_seen WHERE path = ?").run(rel);
    if (old?.hash) this.dropBlob(old.hash);
  }

  private dropBlob(hash: string): void {
    if (this.db.prepare("SELECT 1 FROM vault_seen WHERE hash = ? LIMIT 1").get(hash)) return;
    try { unlinkSync(join(this.blobDir, hash)); } catch { /* never stored */ }
  }

  seenHash(rel: string): string | undefined {
    return (this.db.prepare("SELECT hash FROM vault_seen WHERE path = ?").get(rel) as { hash?: string } | undefined)?.hash;
  }

  /** What the owner saw last, when it was kept. */
  seenContent(rel: string): string | undefined {
    const hash = this.seenHash(rel);
    if (!hash) return undefined;
    try { return readFileSync(join(this.blobDir, hash), "utf8"); } catch { return undefined; }
  }

  /**
   * How a page differs from what the owner last saw: undefined when it has been seen as it
   * is; `created` for a page they have never opened; hunks against the seen text otherwise.
   */
  changeFor(rel: string, content: string): { created: boolean; hunks: Hunk[]; author: string; at: string; outsideScope: boolean } | undefined {
    const row = this.row(rel);
    const seen = this.seenHash(rel);
    const hash = sha256(content);
    if (seen === hash || !row) return undefined;
    const before = seen ? this.seenContent(rel) : "";
    return {
      created: !seen,
      hunks: before === undefined ? [] : diffLines(before, content),
      author: row.author,
      at: row.updated_at,
      outsideScope: !!row.outside_scope,
    };
  }

  /** Files that changed since the owner last looked, newest first. */
  unseen(limit = 200): FileRow[] {
    return this.db.prepare(
      `SELECT f.* FROM vault_files f LEFT JOIN vault_seen s ON s.path = f.path
       WHERE s.hash IS NULL OR s.hash != f.hash ORDER BY f.updated_at DESC LIMIT ?`,
    ).all(limit) as FileRow[];
  }

  /** Mark everything as seen ("Mark all as seen" on Today). */
  seeAll(): number {
    let n = 0;
    for (const r of this.unseen(10_000)) if (this.markSeen(r.path)) n++;
    return n;
  }
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
