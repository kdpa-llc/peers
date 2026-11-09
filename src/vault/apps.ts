/**
 * App pages (ADR 0006): web pages and small web apps that live in the vault and run in a
 * sandboxed frame with an opaque origin.
 *
 * An app is reached only through a capability path, `/apps/<token>/…`, minted for one app and
 * one device by the session-holding client. Under that path the server serves the app's own
 * files and, under `_peers/`, a read-only data API over the vault paths the app may read. The
 * frame never holds the session, and its CSP keeps it inside its token's path and the
 * origins the owner allowed (CONTRACT_TESTS #6–#8).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { matches, within } from "./layout.ts";
import { parseMarkdown, plainText, type MdBlock } from "./markdown.ts";
import { isOrgPath, parseOrg } from "./org.ts";
import { basename, checkRead, dirname, extname, PolicyError, visibleName } from "./paths.ts";

export const MANIFEST = "peers.app.json";
export const APP_PAGE = /\.html?$/i;
/** Tokens live this long without being reopened. */
export const APP_TOKEN_HOURS = 12;
const MAX_SESSIONS = 500;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_LIST = 5000;
const MAX_TASK_FILES = 2000;

export type AppManifest = {
  name?: string;
  description?: string;
  entry?: string;
  reads?: string[];
  network?: string[];
  /** Server code Peers runs in a sandbox once the owner allows it (ADR 0007). */
  server?: string;
};

/** An app as the server resolves it from a vault path. */
export type AppInfo = {
  /** The app folder ("" for a page in the vault's root folder). */
  root: string;
  /** The page to open, relative to `root`. */
  entry: string;
  name: string;
  /** Whether the folder has a peers.app.json. */
  manifest: boolean;
  description?: string;
  reads: string[];
  /** Origins the manifest asks for. */
  network: string[];
  /** Its server file, relative to `root`, when it has one. */
  server?: string;
};

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

// ------------------------------------------------------------------ manifests

export const SERVER_FILE = /\.(ts|mts|js|mjs|cjs|py)$/i;
const ORIGIN = /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

/** Check a manifest against docs/specs/app.schema.json. */
export function validateManifest(raw: unknown): AppManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("peers.app.json must be a JSON object");
  const m = raw as Record<string, unknown>;
  const known = new Set(["name", "description", "entry", "reads", "network", "server"]);
  for (const k of Object.keys(m)) if (!known.has(k)) throw new AppError(`peers.app.json has an unknown field "${k}"`);
  const out: AppManifest = {};
  if (m.name !== undefined) {
    if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 80) throw new AppError("name must be 1 to 80 characters");
    out.name = m.name.trim();
  }
  if (m.description !== undefined) {
    if (typeof m.description !== "string" || m.description.length > 500) throw new AppError("description must be up to 500 characters");
    out.description = m.description;
  }
  if (m.entry !== undefined) {
    const e = m.entry;
    if (typeof e !== "string" || !e || e.length > 200 || e.startsWith("/") || e.includes("\\") ||
      /(^|\/)\./.test(e) || /[\u0000-\u001f]/.test(e) || !APP_PAGE.test(e)) {
      throw new AppError("entry must be an .html page inside the app folder");
    }
    out.entry = e;
  }
  if (m.reads !== undefined) {
    if (!Array.isArray(m.reads) || m.reads.length > 50) throw new AppError("reads must be a list of up to 50 paths");
    out.reads = m.reads.map((r) => {
      if (typeof r !== "string" || !r || r.length > 300 || r.includes("..") || /(^|\/)\./.test(r) || r.startsWith("/")) {
        throw new AppError(`reads: "${String(r)}" is not a vault path pattern`);
      }
      return r;
    });
  }
  if (m.server !== undefined) {
    const f = m.server;
    if (typeof f !== "string" || !f || f.length > 200 || f.startsWith("/") || f.includes("\\") ||
      /(^|\/)\./.test(f) || /[\u0000-\u001f]/.test(f) || !SERVER_FILE.test(f)) {
      throw new AppError("server must be a .ts, .js or .py file inside the app folder");
    }
    out.server = f;
  }
  if (m.network !== undefined) {
    if (!Array.isArray(m.network) || m.network.length > 20) throw new AppError("network must be a list of up to 20 origins");
    out.network = m.network.map((o) => {
      if (typeof o !== "string" || !ORIGIN.test(o)) throw new AppError(`network: "${String(o)}" is not an https origin`);
      return o;
    });
  }
  return out;
}

function readManifest(root: string, folder: string): AppManifest {
  const file = join(root, folder, MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new AppError(`peers.app.json is not valid JSON: ${(err as Error).message}`);
  }
  return validateManifest(raw);
}

function isDir(abs: string): boolean {
  try { return statSync(abs).isDirectory(); } catch { return false; }
}

/** The nearest folder at or above `folder` (never the vault root) with a peers.app.json. */
function appFolderOf(root: string, folder: string): string | undefined {
  for (let f = folder; f; f = dirname(f)) {
    if (existsSync(join(root, f, MANIFEST))) return f;
  }
  return undefined;
}

/**
 * Which app a vault path opens: a folder app (a folder with peers.app.json, or a page inside
 * one), or a single .html page. Undefined for anything else.
 */
export function findApp(root: string, input: string): AppInfo | undefined {
  const path = checkRead(root, input);
  const abs = join(root, path);
  const folder = isDir(abs) ? path : dirname(path);
  const appFolder = appFolderOf(root, folder);
  if (appFolder !== undefined) {
    const m = readManifest(root, appFolder);
    const entry = !isDir(abs) && APP_PAGE.test(path) ? path.slice(appFolder.length + 1) : m.entry ?? "index.html";
    if (!existsSync(join(root, appFolder, entry))) throw new AppError(`${appFolder}/${entry} does not exist`);
    if (m.server && !existsSync(join(root, appFolder, m.server))) throw new AppError(`${appFolder}/${m.server} does not exist`);
    return {
      root: appFolder, entry, manifest: true, name: m.name ?? basename(appFolder),
      ...(m.description ? { description: m.description } : {}),
      reads: m.reads ?? [], network: m.network ?? [],
      ...(m.server ? { server: m.server } : {}),
    };
  }
  if (isDir(abs) || !APP_PAGE.test(path)) return undefined;
  return { root: folder, entry: basename(path), manifest: false, name: basename(path).replace(APP_PAGE, ""), reads: [], network: [] };
}

/** Folders in the vault with a valid manifest, and the page each opens. */
export function appEntry(root: string, folder: string): string | undefined {
  if (!folder || !existsSync(join(root, folder, MANIFEST))) return undefined;
  try {
    const entry = readManifest(root, folder).entry ?? "index.html";
    return existsSync(join(root, folder, entry)) ? `${folder}/${entry}` : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ scope

/** Whether an app may read a vault path: its own folder, or what its manifest lists. */
export function canRead(app: Pick<AppInfo, "root" | "reads">, rel: string): boolean {
  if (app.root === "" || rel === app.root || rel.startsWith(`${app.root}/`)) return true;
  return within(rel, app.reads);
}

/**
 * Whether a folder shows in a listing: readable, or on the way to something readable (the
 * app's own folder, or the leading segments of a `reads` pattern).
 */
export function canSeeFolder(app: Pick<AppInfo, "root" | "reads">, rel: string): boolean {
  if (rel === "" || canRead(app, rel) || app.root.startsWith(`${rel}/`)) return true;
  const depth = rel.split("/").length;
  return app.reads.some((p) => {
    const head = p.split("/").slice(0, depth);
    return head.includes("**") || head.length === depth && matches(rel, head.join("/"));
  });
}

/** Normalise and check a path the app asked for; folders may also be ones on the way. */
function requireReadable(root: string, app: Pick<AppInfo, "root" | "reads">, input: string, opts: { folder?: boolean } = {}): string {
  const rel = checkRead(root, input, { allowRoot: !!opts.folder });
  const ok = canRead(app, rel) || !!opts.folder && canSeeFolder(app, rel);
  if (!ok) throw new PolicyError(`this app may not read ${rel || "the vault root"}`);
  return rel;
}

// ------------------------------------------------------------------ sessions and grants

export type AppSession = {
  token: string;
  app: AppInfo;
  /** The device that opened it, or `server:<root>` for an app server's own token. */
  device: string;
  /** Origins the owner allowed that the manifest still asks for. */
  network: string[];
  /** Whether the owner allowed its server. */
  server: boolean;
  expires: number;
};

/** Capability tokens, in memory: a restart ends every one (ADR 0006 §3). */
export class AppSessions {
  private readonly byToken = new Map<string, AppSession>();

  open(app: AppInfo, device: string, grant: { network: string[]; server: boolean }, now: Date, hours = APP_TOKEN_HOURS): AppSession {
    if (this.byToken.size >= MAX_SESSIONS) {
      const oldest = [...this.byToken.values()].find((s) => !s.device.startsWith("server:"));
      if (oldest) this.byToken.delete(oldest.token);
    }
    const session: AppSession = {
      token: randomBytes(24).toString("base64url"), app, device, network: grant.network, server: grant.server,
      expires: now.getTime() + hours * 3600_000,
    };
    this.byToken.set(session.token, session);
    return session;
  }

  get(token: string, now: Date): AppSession | undefined {
    const s = this.byToken.get(token);
    if (!s) return undefined;
    if (s.expires <= now.getTime()) {
      this.byToken.delete(token);
      return undefined;
    }
    return s;
  }

  revoke(token: string): void {
    this.byToken.delete(token);
  }

  /** Every token for an app's frames (not its server's own), when the owner takes back a grant. */
  revokeApp(root: string): number {
    let n = 0;
    for (const [token, s] of this.byToken) {
      if (s.app.root === root && !s.device.startsWith("server:")) {
        this.byToken.delete(token);
        n++;
      }
    }
    return n;
  }

  revokeDevice(device: string): number {
    let n = 0;
    for (const [token, s] of this.byToken) {
      if (s.device === device) {
        this.byToken.delete(token);
        n++;
      }
    }
    return n;
  }

  all(): AppSession[] {
    return [...this.byToken.values()];
  }
}

export type AppGrant = { network: string[]; server?: boolean };

/** What the owner allowed each app, kept in Peers' state so the vault cannot grant itself. */
export class AppGrants {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(root: string): AppGrant {
    const row = this.db.prepare("SELECT grant_json FROM vault_app_grants WHERE root = ?").get(root) as { grant_json?: string } | undefined;
    if (!row?.grant_json) return { network: [] };
    try {
      const g = JSON.parse(row.grant_json) as Partial<AppGrant>;
      return {
        network: Array.isArray(g.network) ? g.network.filter((o) => typeof o === "string") : [],
        ...(g.server === true ? { server: true } : {}),
      };
    } catch {
      return { network: [] };
    }
  }

  set(root: string, grant: AppGrant, now: Date): void {
    this.db.prepare("INSERT INTO vault_app_grants (root, grant_json, granted_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(root) DO UPDATE SET grant_json = excluded.grant_json, granted_at = excluded.granted_at")
      .run(root, JSON.stringify(grant), now.toISOString());
  }

  remove(root: string): boolean {
    return Number(this.db.prepare("DELETE FROM vault_app_grants WHERE root = ?").run(root).changes) > 0;
  }
}

/** What an app may use now, and what it asks for beyond that. */
export function effectiveGrant(app: AppInfo, grant: AppGrant): { allowed: string[]; asks: string[]; server: boolean; asksServer: boolean } {
  const allowed = app.network.filter((o) => grant.network.includes(o));
  const server = !!app.server && grant.server === true;
  return { allowed, asks: app.network.filter((o) => !allowed.includes(o)), server, asksServer: !!app.server && !server };
}

// ------------------------------------------------------------------ the frame's policy

/**
 * The CSP every response under `/apps/<token>/` carries. `origin` is the origin the browser
 * used (ADR 0006 §7): sandboxed documents do not match `'self'` in WebKit, and naming the token
 * path keeps the app away from the rest of the server.
 */
export function appCsp(origin: string, token: string, network: string[]): string {
  const self = `${origin}/apps/${token}/`;
  const net = network.length ? ` ${network.join(" ")}` : "";
  return [
    "sandbox allow-scripts allow-forms allow-modals allow-downloads",
    `default-src ${self}`,
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:${net}`,
    `style-src ${self} 'unsafe-inline'${net}`,
    `img-src ${self} data: blob:${net}`,
    `font-src ${self} data:${net}`,
    `media-src ${self} data: blob:${net}`,
    `connect-src ${self}${net}`,
    `worker-src ${self} blob:`,
    `frame-src ${self}`,
    "object-src 'none'",
    `base-uri ${self}`,
    "form-action 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

// ------------------------------------------------------------------ files and data

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".org": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
};

export function contentType(rel: string): string {
  return TYPES[extname(rel)] ?? "application/octet-stream";
}

export type AppReply = { status: number; type: string; body: string | Buffer };

const json = (status: number, body: unknown): AppReply =>
  ({ status, type: "application/json; charset=utf-8", body: JSON.stringify(body) });

function readLimited(abs: string): Buffer {
  const st = statSync(abs);
  if (st.size > MAX_FILE_BYTES) throw new AppError("file is too large for an app to read");
  return readFileSync(abs);
}

/** One of the app's own files: `sub` is relative to the app folder; a folder serves its index.html. */
export function appFile(root: string, session: AppSession, sub: string): AppReply {
  const app = session.app;
  let rel = checkRead(root, app.root ? `${app.root}/${sub}` : sub, { allowRoot: true });
  if (app.root && rel !== app.root && !rel.startsWith(`${app.root}/`)) return json(404, { error: "not found" });
  if (isDir(join(root, rel))) rel = rel ? `${rel}/index.html` : "index.html";
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return json(404, { error: "not found" });
  return { status: 200, type: contentType(rel), body: readLimited(abs) };
}

export type FileEntry = { path: string; name: string; type: "file" | "dir"; size?: number; mtime?: string };

function listFolder(root: string, app: AppInfo, folder: string, recursive: boolean): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_LIST) return;
      if (!visibleName(e.name) || e.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!canSeeFolder(app, path)) continue;
        out.push({ path, name: e.name, type: "dir" });
        if (recursive && depth < 12) walk(path, depth + 1);
      } else if (e.isFile() && canRead(app, path)) {
        let st;
        try { st = statSync(join(root, path)); } catch { continue; }
        out.push({ path, name: e.name, type: "file", size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      }
    }
  };
  walk(folder, 0);
  return out;
}

const PAGE = /\.(md|markdown|org)$/i;

function parsePage(root: string, rel: string): { title?: string; blocks: MdBlock[]; tags?: string[] } {
  const text = readLimited(join(root, rel)).toString("utf8");
  const doc = isOrgPath(rel) ? parseOrg(text) : parseMarkdown(text);
  let title = doc.title;
  if (!title) {
    const first = doc.blocks.find((b) => b.t !== "frontmatter");
    if (first?.t === "heading" && first.level === 1) title = plainText(first.c);
  }
  return { ...(title ? { title } : {}), blocks: doc.blocks, ...(doc.tags?.length ? { tags: doc.tags } : {}) };
}

export type Task = {
  path: string;
  line: number;
  title: string;
  done: boolean;
  /** Org keyword (TODO, NEXT, DONE…); absent for Markdown checkboxes. */
  todo?: string;
  priority?: string;
  tags?: string[];
  deadline?: string;
  scheduled?: string;
  /** The heading the task sits under, for Markdown checkboxes. */
  section?: string;
};

/** Tasks in one page: Org headings with a TODO keyword, and Markdown or Org checkboxes. */
export function pageTasks(path: string, blocks: MdBlock[]): Task[] {
  const out: Task[] = [];
  let section: string | undefined;
  const items = (list: Extract<MdBlock, { t: "list" }>): void => {
    for (const item of list.items) {
      if (item.task !== null) {
        const first = item.c.find((b) => b.t === "para");
        const title = first && first.t === "para" ? plainText(first.c) : "";
        out.push({ path, line: item.line[0], title, done: item.task, ...(section ? { section } : {}) });
      }
      for (const b of item.c) if (b.t === "list") items(b);
    }
  };
  const walk = (list: MdBlock[]): void => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b.t === "heading") {
        section = plainText(b.c);
        if (b.todo) {
          const task: Task = { path, line: b.line[0], title: section, done: !!b.done, todo: b.todo };
          if (b.priority) task.priority = b.priority;
          if (b.tags?.length) task.tags = b.tags;
          const next = list[i + 1];
          if (next?.t === "planning") {
            for (const p of next.items) {
              const kind = p.kind.toLowerCase();
              if (kind === "deadline") task.deadline = p.date;
              else if (kind === "scheduled") task.scheduled = p.date;
            }
          }
          out.push(task);
        }
      } else if (b.t === "list") {
        items(b);
      } else if (b.t === "quote" || b.t === "callout") {
        walk(b.c);
      }
    }
  };
  walk(blocks);
  return out;
}

/** The data API under `/apps/<token>/_peers/`. */
export function appData(root: string, session: AppSession, name: string, params: URLSearchParams): AppReply {
  const app = session.app;
  try {
    if (name === "app") {
      return json(200, {
        name: app.name, root: app.root, entry: app.entry, reads: app.reads, network: session.network, server: session.server,
        ...(app.description ? { description: app.description } : {}),
      });
    }
    if (name === "file") {
      const rel = requireReadable(root, app, params.get("path") ?? "");
      const abs = join(root, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) return json(404, { error: `no file ${rel}` });
      return { status: 200, type: contentType(rel), body: readLimited(abs) };
    }
    if (name === "list") {
      const rel = requireReadable(root, app, params.get("path") ?? "", { folder: true });
      if (!isDir(join(root, rel))) return json(404, { error: `no folder ${rel}` });
      return json(200, { path: rel, entries: listFolder(root, app, rel, params.get("recursive") === "1") });
    }
    if (name === "page") {
      const rel = requireReadable(root, app, params.get("path") ?? "");
      if (!PAGE.test(rel)) return json(400, { error: "only Markdown and Org pages parse" });
      if (!existsSync(join(root, rel))) return json(404, { error: `no file ${rel}` });
      return json(200, { path: rel, format: isOrgPath(rel) ? "org" : "markdown", ...parsePage(root, rel) });
    }
    if (name === "tasks") {
      const rel = requireReadable(root, app, params.get("path") ?? "", { folder: true });
      const abs = join(root, rel);
      if (!existsSync(abs)) return json(404, { error: `no file or folder ${rel}` });
      const files = isDir(abs)
        ? listFolder(root, app, rel, true).filter((e) => e.type === "file" && PAGE.test(e.path)).slice(0, MAX_TASK_FILES).map((e) => e.path)
        : PAGE.test(rel) ? [rel] : [];
      const tasks: Task[] = [];
      for (const f of files) {
        try { tasks.push(...pageTasks(f, parsePage(root, f).blocks)); } catch { /* unreadable page: skip */ }
      }
      return json(200, { path: rel, tasks });
    }
    if (name === "peers.js") return { status: 200, type: "text/javascript; charset=utf-8", body: HELPER };
    return json(404, { error: "not found" });
  } catch (err) {
    if (err instanceof PolicyError) return json(403, { error: err.message });
    if (err instanceof AppError) return json(400, { error: err.message });
    throw err;
  }
}

/**
 * The helper an app loads with `<script src="_peers/peers.js"></script>`. It finds its token
 * path from its own URL, so it works from any page depth.
 */
export const HELPER = `/* Peers app helper (ADR 0006). Paths are vault paths, like "Projects/Garden/README.md". */
(function () {
  "use strict";
  var src = (document.currentScript && document.currentScript.src) || location.href;
  var m = /^(.*?\\/apps\\/[^/]+\\/)/.exec(src);
  var base = m ? m[1] : "./";
  function url(name, params) {
    var q = params ? new URLSearchParams(params).toString() : "";
    return base + "_peers/" + name + (q ? "?" + q : "");
  }
  function get(name, params, as) {
    return fetch(url(name, params)).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        var msg = t;
        try { msg = JSON.parse(t).error || t; } catch (e) { /* plain text */ }
        throw new Error(msg || r.statusText);
      });
      return as === "json" ? r.json() : as === "blob" ? r.blob() : r.text();
    });
  }
  var listeners = [];
  var source = null;
  function listen() {
    if (source) return;
    source = new EventSource(url("events"));
    source.addEventListener("change", function (e) {
      var paths = [];
      try { paths = JSON.parse(e.data).paths || []; } catch (err) { /* ignore */ }
      listeners.slice().forEach(function (fn) {
        try { fn(paths); } catch (err) { console.error(err); }
      });
    });
  }
  function post(message) { parent.postMessage(Object.assign({ peers: 1 }, message), "*"); }
  // Peers' day or night theme, as <html data-theme>; it follows Peers while the app is open.
  function theme(t) {
    if (t !== "day" && t !== "night") return;
    document.documentElement.setAttribute("data-theme", t);
    if (window.peers) window.peers.theme = t;
    document.dispatchEvent(new CustomEvent("peers:theme", { detail: t }));
  }
  var initial = /(?:^#|&)theme=(day|night)/.exec(location.hash);
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source === parent && d && d.peers === 1 && d.type === "theme") theme(d.theme);
  });
  window.peers = {
    /** "day" or "night": Peers' theme. */
    theme: initial ? initial[1] : "day",
    /** The app: { name, root, entry, reads, network }. */
    info: function () { return get("app", null, "json"); },
    text: function (path) { return get("file", { path: path }); },
    json: function (path) { return get("file", { path: path }, "json"); },
    blob: function (path) { return get("file", { path: path }, "blob"); },
    /** Files and folders in a folder: [{ path, name, type, size, mtime }]. */
    list: function (path, opts) {
      var p = { path: path || "" };
      if (opts && opts.recursive) p.recursive = "1";
      return get("list", p, "json").then(function (r) { return r.entries; });
    },
    /** A Markdown or Org page parsed: { title, blocks, tags }. */
    page: function (path) { return get("page", { path: path }, "json"); },
    /** Tasks in a page or a folder: [{ path, line, title, done, todo, priority, tags, deadline, scheduled, section }]. */
    tasks: function (path) { return get("tasks", { path: path || "" }, "json").then(function (r) { return r.tasks; }); },
    /** Call fn(paths) whenever files this app can read change. Returns a function that stops it. */
    onChange: function (fn) {
      listeners.push(fn);
      listen();
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },
    /** Open a vault page in Peers. */
    open: function (path) { post({ type: "open", path: String(path) }); },
    /** Propose a message to this folder's agent; the owner confirms before it is sent. */
    ask: function (text) { post({ type: "ask", text: String(text) }); },
    /** Call the app's server (ADR 0007): fetch(path under _api/, init). */
    api: function (path, init) { return fetch(base + "_api/" + String(path || "").replace(/^\\/+/, ""), init); },
    /** POST JSON to the app's server and read JSON back; GET when data is undefined. */
    call: function (path, data) {
      var init = data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
      return window.peers.api(path, init).then(function (r) {
        return r.text().then(function (t) {
          var body = t;
          try { body = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ }
          if (!r.ok) throw new Error((body && body.error) || t || r.statusText);
          return body;
        });
      });
    },
    /** URL of a file in this app, for links and images. */
    url: function (path) { return base + String(path).replace(/^\\/+/, ""); }
  };
  if (initial) theme(initial[1]);
})();
`;
