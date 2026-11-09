/**
 * The vault's HTTP server (TECHNICAL.md §11–13, ADR 0003).
 *
 * Binds to loopback only. Phone access goes through an HTTPS proxy (Tailscale Serve) with
 * `origin` set to its address. Every API request needs a device session; every write needs
 * the `X-Peers: 1` header and a matching Origin; the Host header must be one we serve
 * (DNS rebinding). Client modules are TypeScript served as JavaScript after type stripping,
 * so there is no build step.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";
import { BadRequest, HttpError, statusFor, type VaultApp } from "./app.ts";
import { appCsp, appData, appFile, canRead, type AppReply, type AppSession } from "./apps.ts";
import { validateDef } from "./bots.ts";
import { checkRead } from "./paths.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository (or installed package) root: src/vault/ → ../../ */
export const PACKAGE_ROOT = resolve(HERE, "..", "..");
const WEB_ROOT = join(PACKAGE_ROOT, "web");
/**
 * The parsers the browser shares (Markdown and Org): the TypeScript source in a checkout,
 * compiled JS when installed. Compiled modules import each other as `.js`, so both names map.
 */
const SHARED_MODULES = new Set(["markdown", "org"]);
function sharedModule(pathname: string): string | undefined {
  const m = /^\/src\/vault\/(\w+)\.(ts|js)$/.exec(pathname);
  if (!m || !SHARED_MODULES.has(m[1]!)) return undefined;
  return [join(PACKAGE_ROOT, "src", "vault", `${m[1]}.ts`), join(PACKAGE_ROOT, "dist", "vault", `${m[1]}.js`)].find((f) => existsSync(f));
}

const SESSION_COOKIE = "peers_session";
const SESSION_DAYS = 90;
const PAIR_MINUTES = 10;
const JSON_LIMIT = 1024 * 1024;
const ATTACHMENT_LIMIT = 2 * 1024 * 1024;
/** Request bodies an app sends its server, and how long Peers waits for an answer (ADR 0007). */
const APP_BODY_LIMIT = 10 * 1024 * 1024;
const APP_TIMEOUT_MS = 60_000;
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

export type ServerOptions = {
  port?: number;
  host?: string;
  /** Public origin when served through an HTTPS proxy, e.g. https://mac.tailnet.ts.net */
  origin?: string;
};

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const APP_CSP = [
  "default-src 'self'", "img-src 'self' blob:", "connect-src 'self'", "script-src 'self'",
  "style-src 'self'", "worker-src 'self'", "font-src 'self'", "object-src 'none'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "manifest-src 'self'",
].join("; ");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

/** Raw file types we serve inline, each confirmed by its magic bytes. */
const RAW_TYPES: Record<string, { type: string; magic?: (b: Buffer) => boolean }> = {
  ".png": { type: "image/png", magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  ".jpg": { type: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  ".jpeg": { type: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  ".gif": { type: "image/gif", magic: (b) => b.subarray(0, 3).toString() === "GIF" },
  ".webp": { type: "image/webp", magic: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  ".pdf": { type: "application/pdf", magic: (b) => b.subarray(0, 5).toString() === "%PDF-" },
  ".svg": { type: "image/svg+xml", magic: (b) => /<svg[\s>]/i.test(b.subarray(0, 2048).toString("utf8")) },
};

type Req = IncomingMessage & { url: string };
type Ctx = { req: Req; res: ServerResponse; url: URL; device?: string };

export class VaultServer {
  readonly app: VaultApp;
  private port: number;
  private readonly host: string;
  private readonly origin?: URL;
  private server?: Server;
  private readonly stripped = new Map<string, { mtime: number; code: string }>();
  private readonly sse = new Set<ServerResponse>();

  constructor(app: VaultApp, opts: ServerOptions = {}) {
    this.app = app;
    this.port = opts.port ?? 4777;
    this.host = opts.host ?? "127.0.0.1";
    const origin = opts.origin ?? app.settings.origin;
    this.origin = origin ? new URL(origin) : undefined;
  }

  get localOrigin(): string {
    return `http://${this.host === "::1" ? "[::1]" : this.host}:${this.port}`;
  }

  async listen(): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req as Req, res).catch((err) => this.fail(res, err));
    });
    await new Promise<void>((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(this.port, this.host, () => ok());
    });
    const addr = this.server.address();
    // Port 0 asks the OS for a free port; Host and Origin checks need the real one.
    if (typeof addr === "object" && addr) this.port = addr.port;
    // App servers reach the data API over loopback, whatever address Peers is bound to.
    this.app.appServers.setApiOrigin(this.host === "::1" ? `http://[::1]:${this.port}` : `http://127.0.0.1:${this.port}`);
    return this.port;
  }

  async close(): Promise<void> {
    for (const r of this.sse) r.end();
    await new Promise<void>((ok) => this.server?.close(() => ok()) ?? ok());
  }

  // ------------------------------------------------------------------ pairing

  /** A single-use pairing code, valid for ten minutes (`peers pair`, Settings). */
  createPairingCode(): string {
    return mintPairingCode(this.app.db, this.app.clock.now());
  }

  private redeem(code: string, name: string): string | undefined {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 6) return undefined;
    const db = this.app.db;
    const row = db.prepare("SELECT * FROM vault_pairing WHERE code_hash = ?").get(sha(clean)) as Record<string, string | null> | undefined;
    if (!row || row.used_at || Date.parse(String(row.expires_at)) < this.app.clock.now().getTime()) return undefined;
    const r = db.prepare("UPDATE vault_pairing SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
      .run(this.app.clock.now().toISOString(), sha(clean));
    if (Number(r.changes) !== 1) return undefined;
    const token = randomBytes(32).toString("base64url");
    const id = `dev-${randomBytes(6).toString("hex")}`;
    db.prepare("INSERT INTO vault_devices (device_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name.slice(0, 80) || "Device", sha(token), this.app.clock.now().toISOString(), this.app.clock.now().toISOString());
    return token;
  }

  private sessionDevice(req: Req): string | undefined {
    const cookie = req.headers.cookie ?? "";
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(cookie);
    if (!m) return undefined;
    const row = this.app.db.prepare(
      "SELECT device_id, token_hash, last_seen_at FROM vault_devices WHERE token_hash = ? AND revoked_at IS NULL",
    ).get(sha(m[1]!)) as Record<string, string> | undefined;
    if (!row) return undefined;
    // Constant-time confirmation of the looked-up hash.
    if (!timingSafeEqual(Buffer.from(row.token_hash!), Buffer.from(sha(m[1]!)))) return undefined;
    const now = this.app.clock.now();
    if (!row.last_seen_at || now.getTime() - Date.parse(row.last_seen_at) > 60_000) {
      this.app.db.prepare("UPDATE vault_devices SET last_seen_at = ? WHERE device_id = ?").run(now.toISOString(), row.device_id);
    }
    return row.device_id;
  }

  private setSession(ctx: Ctx, token: string): void {
    const secure = this.isSecure(ctx.req);
    ctx.res.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`);
  }

  // ------------------------------------------------------------------ request checks

  /** Requests through the local proxy carry forwarded headers; trust them only from loopback. */
  private fromLoopback(req: Req): boolean {
    const a = req.socket.remoteAddress ?? "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  }

  private isSecure(req: Req): boolean {
    return this.fromLoopback(req) && req.headers["x-forwarded-proto"] === "https" ||
      (!!this.origin && this.origin.protocol === "https:" && this.hostOf(req) === this.origin.host);
  }

  private hostOf(req: Req): string {
    const forwarded = this.fromLoopback(req) ? req.headers["x-forwarded-host"] : undefined;
    return String(forwarded ?? req.headers.host ?? "").toLowerCase();
  }

  private allowedHosts(): Set<string> {
    const hosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]);
    if (this.origin) hosts.add(this.origin.host.toLowerCase());
    return hosts;
  }

  private allowedOrigins(): Set<string> {
    const o = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`, `http://[::1]:${this.port}`]);
    if (this.origin) o.add(this.origin.origin);
    return o;
  }

  // ------------------------------------------------------------------ dispatch

  private async handle(req: Req, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!this.allowedHosts().has(this.hostOf(req))) {
      return this.send(res, 421, { error: "unknown host" });
    }
    const url = new URL(req.url, "http://local");
    const ctx: Ctx = { req, res, url };
    // App frames: their own policy, framed by Peers only (ADR 0006).
    if (url.pathname.startsWith("/apps/")) return this.serveApp(ctx);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (!url.pathname.startsWith("/api/")) return this.serveStatic(ctx);

    // The API answers Peers' own pages only: never an opaque-origin app frame, never another
    // site (CONTRACT_TESTS #6). The SameSite=Strict cookie already keeps the session out of
    // such requests; these refuse them before they reach a route.
    const site = String(req.headers["sec-fetch-site"] ?? "");
    if (req.headers.origin === "null" || (site && site !== "same-origin" && site !== "none")) {
      return this.send(res, 403, { error: "cross-origin request refused" });
    }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      if (req.headers["x-peers"] !== "1") return this.send(res, 403, { error: "missing X-Peers header" });
      const origin = req.headers.origin;
      if (origin && !this.allowedOrigins().has(origin)) return this.send(res, 403, { error: "cross-origin request refused" });
    }
    if (url.pathname === "/api/pair" && method === "POST") {
      const body = await this.json(req);
      const token = this.redeem(String(body.code ?? ""), String(body.name ?? "Device"));
      if (!token) return this.send(res, 403, { error: "that code is wrong, used or expired" });
      this.setSession(ctx, token);
      return this.send(res, 200, { ok: true });
    }
    ctx.device = this.sessionDevice(req);
    if (!ctx.device) return this.send(res, 401, { error: "pair this device first" });
    res.setHeader("Cache-Control", "no-store");
    return this.route(ctx, method);
  }

  private async route(ctx: Ctx, method: string): Promise<void> {
    const { url, res } = ctx;
    const app = this.app;
    const p = url.pathname;
    const q = (k: string): string => url.searchParams.get(k) ?? "";
    const m = (re: RegExp): RegExpExecArray | null => re.exec(p);
    let match: RegExpExecArray | null;

    if (method === "GET" && p === "/api/state") {
      return this.send(res, 200, {
        vault: { id: app.vaultId, name: app.settings.name, owner: app.settings.owner, tz: app.settings.tz },
        layout: app.layout,
        settings: { default_model: app.settings.default_model, origin: app.settings.origin ?? null },
        engine: { kind: app.engine.kind, providers: await app.engine.providers() },
        demo: app.demoMode(),
        bots: app.registry.list().map((b) => app.botStatus(b)),
        epoch: app.bus.epoch, seq: app.bus.current,
        device: ctx.device,
      });
    }
    if (method === "GET" && p === "/api/tree") {
      return this.send(res, 200, { ...app.treeView(), changed: app.files.unseen(500).map((f) => f.path) });
    }
    if (method === "GET" && p === "/api/layout") return this.send(res, 200, { layout: app.layout, error: app.layoutError ?? null });
    if (method === "PUT" && p === "/api/layout") return this.send(res, 200, { layout: app.updateLayout((await this.json(ctx.req)).layout) });
    if (method === "GET" && p === "/api/file") return this.send(res, 200, app.readFile(q("path")));
    if (method === "GET" && p === "/api/raw") return this.serveRaw(ctx, q("path"));
    if (method === "POST" && p === "/api/seen") {
      const b = await this.json(ctx.req);
      return this.send(res, 200, { ok: app.markSeen(String(b.path ?? ""), typeof b.hash === "string" ? b.hash : undefined) });
    }
    if (method === "POST" && p === "/api/seen/all") return this.send(res, 200, { seen: app.seeAll() });
    if (method === "POST" && p === "/api/folders") {
      const b = await this.json(ctx.req);
      return this.send(res, 200, await app.createFolder(String(b.parent ?? ""), String(b.name ?? ""),
        b.brief ? String(b.brief) : undefined, b.agent !== false));
    }
    if (method === "POST" && p === "/api/folders/archive") return this.send(res, 200, app.archive(String((await this.json(ctx.req)).path)));
    if (method === "POST" && p === "/api/folders/restore") return this.send(res, 200, app.restore(String((await this.json(ctx.req)).path)));
    if (method === "POST" && p === "/api/files/move") {
      const b = await this.json(ctx.req);
      return this.send(res, 200, app.moveFile(String(b.from), String(b.to)));
    }
    if (method === "POST" && p === "/api/files/delete") return this.send(res, 200, app.deleteFile(String((await this.json(ctx.req)).path)));

    if (method === "POST" && p === "/api/bots") return this.send(res, 200, app.addAgent(String((await this.json(ctx.req)).path ?? "")));
    if (method === "DELETE" && (match = m(/^\/api\/bots\/([\w-]+)$/))) return this.send(res, 200, app.removeAgent(match[1]!));
    if (method === "GET" && (match = m(/^\/api\/bots\/([\w-]+)$/))) return this.send(res, 200, app.botDetail(match[1]!));
    if (method === "PATCH" && (match = m(/^\/api\/bots\/([\w-]+)$/))) return this.send(res, 200, app.updateBot(match[1]!, await this.json(ctx.req) as never));
    if (method === "POST" && (match = m(/^\/api\/bots\/([\w-]+)\/run$/))) return this.send(res, 200, { thread_id: await app.runNow(match[1]!) });
    if (method === "POST" && (match = m(/^\/api\/bots\/([\w-]+)\/stop$/))) {
      app.requireBot(match[1]!);
      return this.send(res, 200, { stopped: await app.conversations.stopBot(match[1]!) });
    }
    if (method === "GET" && (match = m(/^\/api\/bots\/([\w-]+)\/threads$/))) {
      app.requireBot(match[1]!);
      return this.send(res, 200, { threads: app.conversations.list(match[1]!, { archived: q("archived") === "1" }) });
    }
    if (method === "POST" && (match = m(/^\/api\/bots\/([\w-]+)\/messages$/))) {
      const b = await this.json(ctx.req);
      const key = `msg:${String(b.client_key ?? "")}`;
      if (b.client_key) {
        const prior = app.db.prepare("SELECT result FROM vault_idempotency WHERE key = ?").get(key) as { result?: string } | undefined;
        if (prior?.result) return this.send(res, 200, JSON.parse(prior.result));
      }
      const context = b.context && typeof b.context === "object" ? {
        ...(typeof b.context.path === "string" ? { path: b.context.path } : {}),
        ...(typeof b.context.selection === "string" ? { selection: b.context.selection } : {}),
      } : undefined;
      const result = await app.send({
        botId: match[1]!, text: String(b.text ?? b.body ?? ""),
        ...(typeof b.thread_id === "string" && b.thread_id ? { threadId: b.thread_id } : {}),
        ...(context ? { context } : {}),
      });
      if (b.client_key) {
        app.db.prepare("INSERT OR IGNORE INTO vault_idempotency (key, result, created_at) VALUES (?, ?, ?)")
          .run(key, JSON.stringify(result), app.clock.now().toISOString());
      }
      return this.send(res, 200, result);
    }
    if (method === "GET" && (match = m(/^\/api\/threads\/([\w:.-]+)$/))) {
      const thread = app.requireThread(match[1]!);
      return this.send(res, 200, { thread, messages: await app.conversations.messages(thread.id), notes: app.notes.forThread(thread.id) });
    }
    if (method === "POST" && (match = m(/^\/api\/threads\/([\w:.-]+)\/(read|stop|archive)$/))) {
      const thread = app.requireThread(match[1]!);
      if (match[2] === "read") app.conversations.markRead(thread.id);
      else if (match[2] === "stop") await app.conversations.stop(thread.id);
      else await app.conversations.archive(thread.id);
      app.bus.publish("thread.updated", { bot_id: thread.bot_id, thread_id: thread.id });
      app.bus.publish("bots.changed", { bot_id: thread.bot_id });
      app.bus.publish("today.changed");
      return this.send(res, 200, { ok: true });
    }
    if (method === "GET" && (match = m(/^\/api\/bots\/([\w-]+)\/memory$/))) return this.send(res, 200, app.memory(match[1]!));
    if (method === "PUT" && (match = m(/^\/api\/bots\/([\w-]+)\/memory$/))) {
      const b = await this.json(ctx.req);
      if (typeof b.text !== "string") throw new BadRequest("text is required");
      return this.send(res, 200, app.saveMemory(match[1]!, b.text));
    }
    if (method === "GET" && p === "/api/providers") return this.send(res, 200, { engine: app.engine.kind, providers: app.signins.status() });
    if (method === "POST" && (match = m(/^\/api\/providers\/(claude|codex)\/(login|code|cancel)$/))) {
      const provider = match[1] as "claude" | "codex";
      if (match[2] === "login") return this.send(res, 200, { login: await app.signins.start(provider) });
      if (match[2] === "cancel") { app.signins.cancel(provider); return this.send(res, 200, { ok: true }); }
      const b = await this.json(ctx.req);
      if (!app.signins.submit(provider, String(b.code ?? ""))) throw new BadRequest("no sign-in is waiting for a code");
      return this.send(res, 200, { ok: true });
    }
    if (method === "GET" && p === "/api/models") {
      return this.send(res, 200, { models: await app.engine.models(), providers: await app.engine.providers(), default_model: app.settings.default_model });
    }

    if (method === "GET" && p === "/api/annotations") return this.send(res, 200, { notes: app.notes.forPath(checkRead(app.root, q("path"))) });
    if (method === "POST" && p === "/api/annotations") return this.send(res, 200, app.notes.upsert(await this.json(ctx.req) as never));
    if (method === "DELETE" && (match = m(/^\/api\/annotations\/([\w-]+)$/))) return this.send(res, 200, { removed: app.notes.remove(match[1]!) });
    if (method === "POST" && p === "/api/annotations/send") {
      const b = await this.json(ctx.req);
      const keys = Array.isArray(b.keys) ? b.keys.map(String).slice(0, 50) : [];
      const into = typeof b.thread_id === "string" ? b.thread_id : undefined;
      const result = await app.notes.send(
        { path: String(b.path), keys, idempotency_key: String(b.idempotency_key ?? randomBytes(8).toString("hex")) },
        async (bot, text, title) => {
          if (into && app.conversations.botOf(into) === bot.def.id && !app.conversations.view(into)?.archived) {
            await app.conversations.post(into, text);
            return into;
          }
          return app.conversations.start(bot, text, { origin: "notes", title });
        },
      );
      return this.send(res, 200, result);
    }
    if (method === "POST" && p === "/api/attachments") {
      const data = await this.raw(ctx.req, ATTACHMENT_LIMIT);
      return this.send(res, 200, { attachment_id: app.notes.saveAttachment(data) });
    }
    if (method === "GET" && (match = m(/^\/api\/attachments\/(att-[a-f0-9]{20})$/))) {
      const data = app.notes.attachment(match[1]!);
      if (!data) return this.send(res, 404, { error: "no such attachment" });
      res.writeHead(200, { "Content-Type": "image/png", "Content-Security-Policy": "sandbox; default-src 'none'" });
      return void res.end(data);
    }

    if (method === "GET" && p === "/api/today") return this.send(res, 200, app.today());
    if (method === "GET" && p === "/api/search") return this.send(res, 200, { results: app.search(q("q")) });
    if (method === "PATCH" && p === "/api/settings") {
      const b = await this.json(ctx.req);
      const patch: Record<string, unknown> = {};
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 80);
      if (typeof b.owner === "string" && b.owner.trim()) patch.owner = b.owner.trim().slice(0, 80);
      if (b.default_model && typeof b.default_model === "object") {
        try {
          const model = validateDef({ id: "settings-check", name: "x", model: b.default_model }).model;
          if (!model?.provider) throw new Error("choose Claude or Codex");
          patch.default_model = model;
        } catch (err) {
          throw new BadRequest(err instanceof Error ? err.message : String(err));
        }
      }
      app.updateSettings(patch as never);
      return this.send(res, 200, { ok: true });
    }
    if (method === "POST" && p === "/api/pairing-codes") return this.send(res, 200, { code: this.createPairingCode(), minutes: PAIR_MINUTES });
    if (method === "GET" && p === "/api/devices") {
      const rows = app.db.prepare("SELECT device_id, name, created_at, last_seen_at, revoked_at FROM vault_devices ORDER BY created_at").all();
      return this.send(res, 200, { devices: rows, current: ctx.device });
    }
    if (method === "DELETE" && (match = m(/^\/api\/devices\/([\w-]+)$/))) {
      app.db.prepare("UPDATE vault_devices SET revoked_at = ? WHERE device_id = ?").run(app.clock.now().toISOString(), match[1]!);
      app.appSessions.revokeDevice(match[1]!);
      return this.send(res, 200, { ok: true });
    }
    if (method === "POST" && p === "/api/apps/open") return this.send(res, 200, app.openApp(String((await this.json(ctx.req)).path ?? ""), ctx.device!));
    if (method === "POST" && p === "/api/apps/grant") {
      const b = await this.json(ctx.req);
      const network = Array.isArray(b.network) ? b.network.map(String).slice(0, 20) : [];
      return this.send(res, 200, app.grantApp(String(b.root ?? ""), network, b.server === true));
    }
    if (method === "POST" && p === "/api/apps/revoke") return this.send(res, 200, await app.revokeApp(String((await this.json(ctx.req)).root ?? "")));
    if (method === "GET" && p === "/api/apps/server") return this.send(res, 200, app.appServer(q("root")));
    if (method === "POST" && p === "/api/apps/server/restart") return this.send(res, 200, await app.restartAppServer(String((await this.json(ctx.req)).root ?? "")));
    if (method === "POST" && p === "/api/apps/server/stop") return this.send(res, 200, await app.stopAppServer(String((await this.json(ctx.req)).root ?? "")));
    if (method === "GET" && p === "/api/events") return this.events(ctx);
    return this.send(res, 404, { error: "not found" });
  }

  // ------------------------------------------------------------------ live events

  private events(ctx: Ctx): void {
    const { req, res } = ctx;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const bus = this.app.bus;
    const last = String(req.headers["last-event-id"] ?? ctx.url.searchParams.get("since") ?? "");
    const [epoch, seqText] = last.split(":");
    const write = (id: string, type: string, data: unknown): void => {
      res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    if (last) {
      const missed = epoch === bus.epoch ? bus.since(Number(seqText)) : undefined;
      if (!missed) write(`${bus.epoch}:${bus.current}`, "resync", { reason: "missed events" });
      else for (const e of missed) write(`${bus.epoch}:${e.seq}`, e.type, e.data);
    }
    write(`${bus.epoch}:${bus.current}`, "hello", { epoch: bus.epoch, seq: bus.current });
    const unsubscribe = bus.subscribe((e) => write(`${bus.epoch}:${e.seq}`, e.type, e.data));
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25_000);
    this.sse.add(res);
    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      this.sse.delete(res);
    });
  }

  // ------------------------------------------------------------------ app frames (ADR 0006)

  /** The origin the browser used, as CSP has to name it (ADR 0006 §7). */
  private browserOrigin(req: Req): string {
    return `${this.isSecure(req) ? "https" : "http"}://${this.hostOf(req)}`;
  }

  /**
   * Everything under `/apps/<token>/`: the app's files, and under `_peers/` its read-only data
   * API. No session is read or needed here; the token is the capability.
   */
  private serveApp(ctx: Ctx): void | Promise<void> {
    const { req, res, url } = ctx;
    const method = req.method ?? "GET";
    const m = /^\/apps\/([A-Za-z0-9_-]{20,64})\/(.*)$/.exec(url.pathname);
    const session = m ? this.app.appSessions.get(m[1]!, this.app.clock.now()) : undefined;
    // The frame's origin is opaque, so its module scripts and fetches are CORS requests.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    if (!session) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
      return this.send(res, 404, { error: "this app link has expired; open the app again" });
    }
    res.setHeader("Content-Security-Policy", appCsp(this.browserOrigin(req), session.token, session.network));
    // `_peers/` is Peers' data API and `_api/` the app's own server, at any depth of the app.
    const raw = m![2]!;
    const segments = raw.split("/");
    const at = segments.findIndex((x) => x === "_peers" || x === "_api");
    if (at >= 0 && segments[at] === "_api") return this.proxyApp(ctx, session, segments.slice(at + 1).join("/"));
    if (method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Max-Age": "600" });
      return void res.end();
    }
    if (method !== "GET" && method !== "HEAD") return this.send(res, 405, { error: "apps read the vault; they change it only through their server" });
    let sub: string;
    try {
      sub = decodeURIComponent(raw);
    } catch {
      return this.send(res, 400, { error: "bad path" });
    }
    let reply: AppReply;
    if (at >= 0) {
      const name = segments.slice(at + 1).map((x) => decodeURIComponent(x)).join("/");
      if (name === "events") return this.appEvents(ctx, session);
      reply = appData(this.app.root, session, name, url.searchParams);
    } else {
      reply = appFile(this.app.root, session, sub);
    }
    const body = typeof reply.body === "string" ? Buffer.from(reply.body) : reply.body;
    res.writeHead(reply.status, { "Content-Type": reply.type, "Content-Length": String(body.length) });
    res.end(method === "HEAD" ? undefined : body);
  }

  /**
   * `_api/…` goes to the app's own server (ADR 0007), once the owner allowed it. Peers answers
   * the CORS preflight itself, sends no cookies or Peers headers on, and keeps its own CSP
   * and CORS headers on the answer.
   */
  private async proxyApp(ctx: Ctx, session: AppSession, rest: string): Promise<void> {
    const { req, res, url } = ctx;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      const asked = String(req.headers["access-control-request-headers"] ?? "").replace(/[^\w, -]/g, "").slice(0, 400);
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
        ...(asked ? { "Access-Control-Allow-Headers": asked } : {}),
        "Access-Control-Max-Age": "600",
      });
      return void res.end();
    }
    if (!session.app.server) return this.send(res, 404, { error: "this app has no server" });
    if (!session.server || !this.app.appServerAllowed(session.app)) return this.send(res, 403, { error: "the owner has not allowed this app's server" });
    let port: number;
    try {
      port = await this.app.appServers.ensure(session.app);
    } catch (err) {
      return this.send(res, 503, { error: (err as Error).message });
    }
    const body = method === "GET" || method === "HEAD" ? undefined : await this.raw(req, APP_BODY_LIMIT);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.includes(k) || k === "cookie" || k === "host" || k.startsWith("x-forwarded-") || k === "origin" || k === "referer") continue;
      headers[k] = v;
    }
    headers.host = `127.0.0.1:${port}`;
    headers["x-peers-app"] = encodeURIComponent(session.app.root);
    if (body) headers["content-length"] = String(body.length);
    this.app.appServers.touch(session.app.root);
    await new Promise<void>((done) => {
      const upstream = httpRequest({ host: "127.0.0.1", port, method, path: `/${rest}${url.search}`, headers }, (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined || HOP_BY_HOP.includes(k) || k === "set-cookie" || k.startsWith("access-control-") ||
            k === "content-security-policy" || k === "x-frame-options") continue;
          out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
        up.on("end", done);
        up.on("error", () => { res.destroy(); done(); });
      });
      upstream.setTimeout(APP_TIMEOUT_MS, () => upstream.destroy(new Error("the app's server took too long")));
      upstream.on("error", (err) => {
        if (!res.headersSent) this.send(res, 502, { error: `the app's server did not answer: ${err.message}` });
        else res.destroy();
        done();
      });
      // The browser went away before the answer finished.
      res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(body);
    });
  }

  /** Change events for what an app can read. */
  private appEvents(ctx: Ctx, session: AppSession): void {
    const { req, res } = ctx;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": hello\n\n");
    const unsubscribe = this.app.bus.subscribe((e) => {
      if (e.type !== "file.changed" || !Array.isArray(e.data.paths)) return;
      const paths = (e.data.paths as unknown[]).filter((p): p is string => typeof p === "string" && canRead(session.app, p));
      if (paths.length) res.write(`event: change\ndata: ${JSON.stringify({ paths })}\n\n`);
    });
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25_000);
    this.sse.add(res);
    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      this.sse.delete(res);
    });
  }

  // ------------------------------------------------------------------ files

  private serveRaw(ctx: Ctx, input: string): void {
    const rel = checkRead(this.app.root, input);
    const abs = join(this.app.root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return this.send(ctx.res, 404, { error: "not found" });
    const data = readFileSync(abs);
    const allowed = RAW_TYPES[extname(rel).toLowerCase()];
    const inline = !!allowed && (!allowed.magic || allowed.magic(data));
    // Whatever a bot or a download put in the vault, it never runs as a page on this origin.
    const headers: Record<string, string> = {
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "Content-Length": String(data.length),
    };
    if (inline) {
      headers["Content-Type"] = allowed!.type;
    } else {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Disposition"] = `attachment; filename="${rel.split("/").pop()!.replace(/["\\\r\n]/g, "_")}"`;
    }
    ctx.res.writeHead(200, headers);
    ctx.res.end(data);
  }

  private serveStatic(ctx: Ctx): void {
    const { url, res, req } = ctx;
    let pathname = decodeURIComponent(url.pathname);
    // One-time local pairing link printed at start: exchange it, then drop it from the URL.
    const pair = url.searchParams.get("pair");
    if (pathname === "/" && pair) {
      const token = this.redeem(pair, deviceName(String(req.headers["user-agent"] ?? "")));
      if (token) this.setSession(ctx, token);
      res.writeHead(303, { Location: "/" });
      return void res.end();
    }
    let file: string | undefined;
    if (pathname === "/" || pathname === "/index.html") file = join(WEB_ROOT, "index.html");
    else if (pathname === "/sw.js") file = join(WEB_ROOT, "sw.js");
    else if (pathname === "/manifest.webmanifest") file = join(WEB_ROOT, "manifest.webmanifest");
    else if (sharedModule(pathname)) file = sharedModule(pathname);
    else if (pathname.startsWith("/web/")) file = within(WEB_ROOT, pathname.slice(5));
    else if (pathname.startsWith("/vendor/pdfjs/")) {
      const base = pdfjsRoot();
      file = base ? within(base, pathname.slice("/vendor/pdfjs/".length)) : undefined;
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      // Unknown app routes load the shell; the client router takes it from there.
      if (!extname(pathname)) file = join(WEB_ROOT, "index.html");
      else return this.send(res, 404, { error: "not found" });
    }
    const ext = extname(file);
    const type = STATIC_TYPES[ext];
    if (!type) return this.send(res, 404, { error: "not found" });
    let body: string | Buffer;
    if (ext === ".ts") body = this.strip(file);
    else body = readFileSync(file);
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Security-Policy": APP_CSP,
      "Cache-Control": ext === ".html" || pathname === "/sw.js" ? "no-cache" : "no-cache",
    };
    if (pathname === "/sw.js") headers["Service-Worker-Allowed"] = "/";
    res.writeHead(200, headers);
    res.end(body);
  }

  private strip(file: string): string {
    const mtime = statSync(file).mtimeMs;
    const cached = this.stripped.get(file);
    if (cached && cached.mtime === mtime) return cached.code;
    const source = readFileSync(file, "utf8");
    const strip = (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, opts?: Record<string, unknown>) => string }).stripTypeScriptTypes;
    if (!strip) throw new Error("this Node version cannot strip TypeScript types; use Node 22.13 or later");
    const code = strip(source, { mode: "strip" });
    this.stripped.set(file, { mtime, code });
    return code;
  }

  // ------------------------------------------------------------------ helpers

  private async raw(req: Req, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, "request body is too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private async json(req: Req): Promise<Record<string, any>> {
    const type = String(req.headers["content-type"] ?? "");
    if (!type.startsWith("application/json")) throw new HttpError(415, "send JSON");
    const data = await this.raw(req, JSON_LIMIT);
    try {
      const parsed = JSON.parse(data.toString("utf8") || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return void res.end();
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  }

  private fail(res: ServerResponse, err: unknown): void {
    const status = statusFor(err);
    if (status === 500) console.error("vault server error:", err);
    this.send(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
  }
}

/** Mint a pairing code into a vault database (also used by `peers pair`). */
export function mintPairingCode(db: import("node:sqlite").DatabaseSync, now: Date): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (const b of randomBytes(6)) code += alphabet[b % alphabet.length];
  const expires = new Date(now.getTime() + PAIR_MINUTES * 60_000);
  db.prepare("INSERT INTO vault_pairing (code_hash, expires_at) VALUES (?, ?)").run(sha(code), expires.toISOString());
  return code;
}

function within(base: string, rel: string): string | undefined {
  const target = normalize(join(base, rel));
  return target.startsWith(base.endsWith(sep) ? base : base + sep) ? target : undefined;
}

function pdfjsRoot(): string | undefined {
  for (const candidate of [
    join(PACKAGE_ROOT, "node_modules", "pdfjs-dist"),
    join(PACKAGE_ROOT, "..", "pdfjs-dist"),
  ]) {
    if (existsSync(join(candidate, "build"))) return candidate;
  }
  return undefined;
}

function deviceName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac browser";
  return "Browser";
}
