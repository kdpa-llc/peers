/**
 * Peers composition root (ADR 0001, ADR 0003). Opens one vault folder: its database,
 * bots, the engine they run on (an embedded headless T3, or the demo engine), and the
 * services the HTTP server and the CLI use.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Notes } from "./annotations.ts";
import { BotRegistry, type Bot, type BotDef } from "./bots.ts";
import { Conversations, type ThreadView } from "./conversations.ts";
import { DemoEngine, T3Engine, type BotEngine, type EngineThread } from "./engine.ts";
import { FileTracker, type Attribution, type FileChange } from "./files.ts";
import { AppError, appEntry, AppGrants, AppSessions, effectiveGrant, findApp, MANIFEST, type AppInfo } from "./apps.ts";
import { AppServers, type SandboxMode } from "./appserver.ts";
import { frontPage, layoutFile, PAGE_EXT, PARA_FOLDERS, paraLayout, readLayout, suggestLayout, validateLayout, within, type Layout } from "./layout.ts";
import { checkRead, PolicyError } from "./paths.ts";
import { ensureVaultId, loadSettings, openDb, saveSettings, stateDirFor, writeJsonAtomic, type VaultSettings } from "./state.ts";
import { SignIns } from "./signin.ts";
import { defaultAgentHomes, type AgentHomes } from "./t3/runtime.ts";
import { Triggers } from "./triggers.ts";
import { FsWatcher, type Watcher } from "./watch.ts";
import { kindOf, Vault, type TreeNode } from "./vault.ts";

export type Clock = { now(): Date };

export type OpenVaultOptions = {
  root: string;
  stateDir?: string;
  clock?: Clock;
  /** "t3" (default), "demo", or an engine instance (tests). */
  engine?: "t3" | "demo" | BotEngine;
  /** The bots' own Claude Code and Codex config folders. */
  homes?: AgentHomes;
  t3Bin?: string;
  watcher?: Watcher | false;
  log?: (line: string) => void;
  /** How app servers are sandboxed (ADR 0007); detected when absent. "off" is for tests and development. */
  appSandbox?: SandboxMode;
};

export type BusEvent = { seq: number; type: string; data: Record<string, unknown> };

/** Live events for the web client, with an epoch and sequence for replay (TECHNICAL.md §11). */
export class Bus {
  readonly epoch = randomBytes(4).toString("hex");
  private seq = 0;
  private readonly buffer: BusEvent[] = [];
  private readonly listeners = new Set<(e: BusEvent) => void>();

  publish(type: string, data: Record<string, unknown> = {}): void {
    const e = { seq: ++this.seq, type, data };
    this.buffer.push(e);
    if (this.buffer.length > 1000) this.buffer.shift();
    for (const l of this.listeners) {
      try { l(e); } catch { /* a broken client must not break the publisher */ }
    }
  }

  get current(): number { return this.seq; }

  /** Events after `seq`, or undefined when they are no longer buffered (the client resyncs). */
  since(seq: number): BusEvent[] | undefined {
    if (seq === this.seq) return [];
    const first = this.buffer[0];
    if (!first || seq < first.seq - 1 || seq > this.seq) return undefined;
    return this.buffer.filter((e) => e.seq > seq);
  }

  subscribe(fn: (e: BusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

/** How long after a bot's run a file change is still put down to that bot. */
const ATTRIBUTION_MS = 20_000;

export class VaultApp {
  readonly root: string;
  readonly stateDir: string;
  readonly vaultId: string;
  readonly clock: Clock;
  readonly db: DatabaseSync;
  readonly vault: Vault;
  readonly registry: BotRegistry;
  readonly files: FileTracker;
  readonly engine: BotEngine;
  readonly conversations: Conversations;
  readonly notes: Notes;
  readonly triggers: Triggers;
  readonly signins: SignIns;
  readonly bus = new Bus();
  /** Capability tokens for app frames, and what the owner allowed each app (ADR 0006). */
  readonly appSessions = new AppSessions();
  readonly appGrants: AppGrants;
  /** App servers, run on demand in a sandbox (ADR 0007). */
  readonly appServers: AppServers;
  private settingsValue: VaultSettings;
  private layoutValue: Layout;
  /** Why `.peers/layout.json` was not used, when it could not be read. */
  layoutError?: string;
  private readonly watcher?: Watcher;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private actingOwner = false;
  /** Per bot: when its last run ended (Infinity while working) and whether a trigger started it. */
  private readonly lastActive = new Map<string, { at: number; trigger: boolean }>();
  private unsubscribeEngine?: () => void;

  private constructor(opts: OpenVaultOptions) {
    this.root = resolve(opts.root);
    mkdirSync(this.root, { recursive: true });
    this.vaultId = ensureVaultId(this.root);
    this.stateDir = stateDirFor(this.vaultId, opts.stateDir);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.clock = opts.clock ?? { now: () => new Date() };
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    this.settingsValue = loadSettings(this.stateDir, {
      name: this.root.split("/").filter(Boolean).pop() ?? "Vault",
      owner: process.env.USER ? capitalize(process.env.USER) : "Owner",
      tz,
      default_model: { provider: "claude", model: "claude-sonnet-5-5", thinking: "medium" },
    });
    this.db = openDb(join(this.stateDir, "vault.db"));
    this.appGrants = new AppGrants(this.db);
    this.vault = new Vault(this.root);
    this.layoutValue = this.loadLayout();
    const now = (): Date => this.clock.now();
    this.registry = new BotRegistry({ vault: this.vault, db: this.db, settings: () => this.settingsValue, layout: () => this.layoutValue });
    this.files = new FileTracker({
      root: this.root, db: this.db, vault: this.vault, blobDir: join(this.stateDir, "seen"), now,
      attribute: (rel) => this.attribute(rel),
    });
    const engine = opts.engine ?? "t3";
    this.engine = typeof engine === "object" ? engine
      : engine === "demo" ? new DemoEngine({ vaultRoot: this.root, file: join(this.stateDir, "demo-engine.json"), now: () => this.clock.now() })
      : new T3Engine({
        baseDir: join(this.stateDir, "t3"), vaultRoot: this.root, homes: opts.homes ?? defaultAgentHomes(),
        ...(opts.t3Bin ? { bin: opts.t3Bin } : {}), ...(opts.log ? { log: opts.log } : {}),
      });
    this.conversations = new Conversations({
      db: this.db, engine: this.engine, registry: this.registry, root: this.root, stateDir: this.stateDir,
      settings: () => this.settingsValue, layout: () => this.layoutValue, now,
      onChange: (botId, t) => this.onThreadView(botId, t),
    });
    this.notes = new Notes({
      db: this.db, now, registry: this.registry, root: this.root, stateDir: this.stateDir,
      onChange: (n) => this.bus.publish("annotation.updated", { annotation_id: n.annotation_id, path: n.path, status: n.status }),
    });
    this.triggers = new Triggers({ db: this.db, registry: this.registry, conversations: this.conversations, now });
    this.signins = new SignIns(opts.homes ?? defaultAgentHomes(), () => this.bus.publish("agents.changed"));
    this.watcher = opts.watcher === false ? undefined : opts.watcher ?? new FsWatcher(this.root);
    this.appServers = new AppServers({
      vaultRoot: this.root, logDir: join(this.stateDir, "apps"), now,
      ...(opts.appSandbox ? { sandbox: opts.appSandbox } : {}),
      // The server reads the vault through the data API with a token of its own, which lives
      // as long as the process.
      token: (app) => this.appSessions.open(app, `server:${app.root}`, { network: [], server: true }, this.clock.now(), 24 * 365).token,
      revoke: (token) => this.appSessions.revoke(token),
    });
  }

  static async open(opts: OpenVaultOptions): Promise<VaultApp> {
    const app = new VaultApp(opts);
    app.registry.sync();
    app.scan();
    await app.engine.start();
    app.unsubscribeEngine = app.engine.onThread((t) => app.onEngineThread(t));
    return app;
  }

  get settings(): VaultSettings { return this.settingsValue; }

  updateSettings(patch: Partial<VaultSettings>): VaultSettings {
    this.settingsValue = { ...this.settingsValue, ...patch };
    saveSettings(this.stateDir, this.settingsValue);
    this.registry.sync();
    this.bus.publish("state.changed");
    return this.settingsValue;
  }

  demoMode(): boolean {
    return this.engine.kind === "demo";
  }

  // ------------------------------------------------------------------ layout (ADR 0005)

  get layout(): Layout { return this.layoutValue; }

  /**
   * The vault's layout: `.peers/layout.json`, or on first open one suggested from what is on
   * disk (an empty folder starts as a PARA vault), written so the owner can see and edit it.
   */
  private loadLayout(): Layout {
    try {
      const existing = readLayout(this.root);
      if (existing) { this.layoutError = undefined; return existing; }
    } catch (err) {
      this.layoutError = `.peers/layout.json: ${err instanceof Error ? err.message : String(err)}`;
      return this.layoutValue ?? suggestLayout(this.root);
    }
    const visible = readdirSync(this.root).filter((n) => !n.startsWith("."));
    let layout: Layout;
    if (visible.length === 0) {
      for (const f of PARA_FOLDERS) mkdirSync(join(this.root, f), { recursive: true });
      layout = paraLayout();
    } else {
      layout = suggestLayout(this.root);
    }
    this.writeLayout(layout);
    return layout;
  }

  private writeLayout(layout: Layout): void {
    mkdirSync(join(this.root, ".peers"), { recursive: true });
    writeJsonAtomic(layoutFile(this.root), layout);
  }

  updateLayout(raw: unknown): Layout {
    let layout: Layout;
    try { layout = validateLayout(raw); } catch (err) { throw new BadRequest(err instanceof Error ? err.message : String(err)); }
    this.writeLayout(layout);
    this.layoutValue = layout;
    this.layoutError = undefined;
    this.registry.sync();
    this.bus.publish("tree.changed");
    this.bus.publish("bots.changed");
    return layout;
  }

  /** Give a folder or page its own agent ("Give this folder an agent"). */
  addAgent(rel: string): Record<string, unknown> {
    const path = checkRead(this.root, rel);
    const abs = join(this.root, path);
    if (!existsSync(abs)) throw new NotFound(`no folder or page ${path}`);
    const isDir = statSync(abs).isDirectory();
    if (!isDir && !PAGE_EXT.test(path)) throw new BadRequest("only a folder or a page can have an agent");
    if (within(path, this.layoutValue.hidden)) throw new BadRequest(`${path} is hidden in this layout`);
    if (this.registry.byPath(path)) throw new Conflict(`${path} already has an agent`);
    const layout = { ...this.layoutValue, exclude: this.layoutValue.exclude.filter((p) => p !== path) };
    if (!this.registry.byPath(path)) layout.agents = [...layout.agents.filter((p) => p !== path), path];
    this.updateLayout(layout);
    const bot = this.registry.byPath(path);
    if (!bot) throw new Conflict(`${path} cannot have an agent (it is a folder's front page)`);
    return this.botDetail(bot.def.id);
  }

  /** Take a folder's or page's agent away. Its conversations and memory are kept. */
  removeAgent(id: string): Record<string, unknown> {
    const bot = this.requireBot(id);
    if (bot.kind === "vault") throw new BadRequest("the vault agent cannot be removed");
    const literal = this.layoutValue.agents.includes(bot.path);
    const layout = {
      ...this.layoutValue,
      agents: this.layoutValue.agents.filter((p) => p !== bot.path),
      exclude: literal ? this.layoutValue.exclude : [...this.layoutValue.exclude, bot.path],
    };
    this.updateLayout(layout);
    return { ok: true };
  }

  // ------------------------------------------------------------------ engine and files

  /** A conversation was started or changed: tell clients, and note which bots are working. */
  private onThreadView(botId: string, t: ThreadView): void {
    this.bus.publish("thread.updated", { bot_id: botId, thread_id: t.id, state: t.state, unread: t.unread });
    if (t.state === "working") {
      const prev = this.lastActive.get(botId);
      const trigger = t.origin === "trigger" || (prev?.at === Number.POSITIVE_INFINITY && prev.trigger);
      this.lastActive.set(botId, { at: Number.POSITIVE_INFINITY, trigger });
    }
  }

  private onEngineThread(t: EngineThread): void {
    const view = this.conversations.onEngine(t);
    if (!view) return;
    // onThreadView has recorded a start; here a bot's last running conversation has ended.
    if (t.state !== "working" && this.lastActive.get(view.bot_id)?.at === Number.POSITIVE_INFINITY && !this.conversations.workingBots().has(view.bot_id)) {
      // A run ended: pick up what it changed even if the watcher missed it.
      this.scan();
      this.lastActive.set(view.bot_id, { at: this.clock.now().getTime(), trigger: this.lastActive.get(view.bot_id)!.trigger });
    }
    this.notes.onThread(t);
    this.bus.publish("bots.changed", { bot_id: view.bot_id });
    if (t.state !== "working") this.bus.publish("today.changed");
  }

  /** Who most likely made a change: a bot that is working or just was, else someone outside. */
  private attribute(rel: string): Attribution {
    if (this.actingOwner) return { author: "human", outsideScope: false };
    // An app server writes only in its app's data/ folder (ADR 0007).
    for (let i = rel.indexOf("/data/"); i > 0; i = rel.indexOf("/data/", i + 1)) {
      const folder = rel.slice(0, i);
      if (existsSync(join(this.root, folder, MANIFEST)) && this.appServers.status(folder).state === "running") {
        return { author: `app:${folder}`, outsideScope: false };
      }
    }
    const now = this.clock.now().getTime();
    const candidates = [...this.lastActive.entries()]
      .filter(([, a]) => a.at === Number.POSITIVE_INFINITY || now - a.at < ATTRIBUTION_MS)
      .map(([id, a]) => ({ bot: this.registry.get(id), trigger: a.trigger }))
      .filter((c): c is { bot: Bot; trigger: boolean } => !!c.bot);
    if (!candidates.length) return { author: "external", outsideScope: false };
    const inScope = candidates.find((c) => this.registry.mayWrite(c.bot, rel));
    const pick = inScope ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!pick) return { author: "external", outsideScope: false };
    return { author: pick.bot.def.id, outsideScope: !inScope, ...(pick.trigger ? { viaTrigger: true } : {}) };
  }

  private onFileChange(c: FileChange): void {
    this.triggers.onChange(c);
    this.appServers.fileChanged(c.path);
    this.bus.publish("file.changed", { paths: [c.path], author: c.author, op: c.op });
    if (c.op === "delete" || c.created) this.bus.publish("tree.changed");
    this.bus.publish("today.changed");
  }

  /** Reconcile the disk with what Peers knows: outside edits, new and deleted files. */
  scan(): number {
    const changes = this.files.scan();
    for (const c of changes) this.onFileChange(c);
    if (changes.length) this.bus.publish("tree.changed");
    return changes.length;
  }

  private onWatch(rel: string): void {
    if (rel.startsWith(".peers/") || rel.endsWith(".bot.json")) {
      // The layout or an agent definition changed on disk (an editor, a sync, a bot).
      if (rel === ".peers/layout.json") this.layoutValue = this.loadLayout();
      this.registry.sync();
      this.bus.publish("bots.changed");
      this.bus.publish("tree.changed");
      return;
    }
    try { checkRead(this.root, rel); } catch { return; }
    let isFile = false;
    try { isFile = statSync(join(this.root, rel)).isFile(); } catch { isFile = false; }
    if (!isFile && !this.files.row(rel)) {
      // A folder appeared or vanished: maybe a new project or area.
      this.registry.sync();
      this.scan();
      this.bus.publish("tree.changed");
      this.bus.publish("bots.changed");
      return;
    }
    const c = this.files.touch(rel);
    if (c) this.onFileChange(c);
  }

  /** One dispatcher cycle: schedules and file triggers (TECHNICAL.md §10). */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.triggers.tick();
    } finally {
      this.ticking = false;
    }
  }

  /** Listen for outside edits (also used alone by tests, which drive ticks themselves). */
  startWatching(): void {
    this.watcher?.start((rel) => this.onWatch(rel));
  }

  start(intervalMs = 1000): void {
    this.startWatching();
    let rounds = 0;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("vault tick failed:", err));
      // A periodic scan catches anything the watcher missed (network drives, sleep).
      if (++rounds % 60 === 0) this.scan();
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.stop();
    this.unsubscribeEngine?.();
    this.signins.stop();
    await this.appServers.stopAll();
    await this.engine.stop();
    this.db.close();
  }

  // ------------------------------------------------------------------ bots

  botStatus(bot: Bot): Record<string, unknown> {
    const threads = this.conversations.list(bot.def.id);
    const next = this.triggers.coming(50).find((c) => c.bot_id === bot.def.id);
    const latest = threads[0];
    return {
      id: bot.def.id,
      name: bot.def.name,
      color: bot.def.color ?? "teal",
      kind: bot.kind,
      path: bot.path,
      ...(bot.front ? { front: bot.front } : {}),
      archived: bot.archived,
      paused: !!bot.def.paused,
      needs_review: !!bot.def.needs_review,
      state: bot.def.paused || bot.archived ? "paused" : this.conversations.stateOf(bot.def.id),
      unread: threads.filter((t) => t.unread).length,
      conversations: threads.length,
      last_error: latest?.state === "failed" ? latest.error ?? "the last run failed" : undefined,
      next_run: next ? { at: next.at, label: next.label } : undefined,
      model: { ...this.settingsValue.default_model, ...(bot.def.model ?? {}) },
    };
  }

  botDetail(id: string): Record<string, unknown> {
    const bot = this.requireBot(id);
    return { ...this.botStatus(bot), def: bot.def, write_scope: bot.def.write_scope ?? "folder", writable: this.registry.writable(bot) };
  }

  requireBot(id: string): Bot {
    const bot = this.registry.get(id);
    if (!bot) throw new NotFound(`no bot ${id}`);
    return bot;
  }

  requireThread(id: string): ThreadView {
    const t = this.conversations.view(id);
    if (!t) throw new NotFound(`no conversation ${id}`);
    return t;
  }

  updateBot(id: string, patch: Partial<BotDef>): Record<string, unknown> {
    const bot = this.requireBot(id);
    try {
      this.registry.update(bot.def.id, patch);
    } catch (err) {
      throw new BadRequest(err instanceof Error ? err.message : String(err));
    }
    this.bus.publish("bots.changed", { bot_id: id });
    return this.botDetail(id);
  }

  async runNow(id: string): Promise<string> {
    const bot = this.requireBot(id);
    if (bot.def.paused || bot.archived) throw new Conflict(`${bot.def.name} is paused`);
    return this.conversations.start(bot,
      "Manual run: look over your folder and do whatever is most useful now. Tell me briefly what you did.",
      { origin: "manual", title: "Manual run" });
  }

  async send(args: { botId: string; threadId?: string; text: string; context?: { path?: string; selection?: string } }) {
    const bot = this.requireBot(args.botId);
    if (bot.archived) throw new Conflict(`${bot.def.name} is archived; restore it to talk to it`);
    const text = args.text.trim();
    if (!text) throw new BadRequest("message is empty");
    if (text.length > 20000) throw new HttpError(413, "message is too long");
    if (args.threadId) {
      const t = this.requireThread(args.threadId);
      if (t.bot_id !== bot.def.id) throw new BadRequest("that conversation belongs to another bot");
    }
    const context = args.context ? {
      ...(args.context.path ? { path: checkRead(this.root, args.context.path) } : {}),
      ...(args.context.selection ? { selection: args.context.selection.slice(0, 4000) } : {}),
    } : undefined;
    return this.conversations.fromOwner({ botId: bot.def.id, ...(args.threadId ? { threadId: args.threadId } : {}), text, ...(context ? { context } : {}) });
  }

  memory(id: string): { path: string; text: string } {
    const bot = this.requireBot(id);
    const file = this.registry.memoryFile(bot);
    return { path: this.registry.memoryPath(bot), text: existsSync(file) ? readFileSync(file, "utf8") : "" };
  }

  saveMemory(id: string, text: string): { path: string; text: string } {
    const bot = this.requireBot(id);
    if (text.length > 200_000) throw new HttpError(413, "memory is too long");
    const file = this.registry.memoryFile(bot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    this.bus.publish("bots.changed", { bot_id: id });
    return this.memory(id);
  }

  // ------------------------------------------------------------------ files

  /**
   * The tree as the client shows it: hidden parts left out, and for each path its agent,
   * each folder's front page, and what is read-only.
   */
  treeView(): Record<string, unknown> {
    const layout = this.layoutValue;
    const prune = (n: TreeNode): TreeNode => ({
      ...n,
      ...(n.children ? { children: n.children.filter((c) => !within(c.path, layout.hidden)).map(prune) } : {}),
    });
    const tree = prune(this.vault.tree());
    const owners: Record<string, string> = {};
    for (const b of this.registry.list()) if (b.path) owners[b.path] = b.def.id;
    const fronts: Record<string, string> = {};
    const apps: string[] = [];
    const readonly: string[] = [];
    const walk = (n: TreeNode): void => {
      for (const c of n.children ?? []) {
        if (c.type === "dir") {
          // An app folder opens its app (ADR 0006); any other folder its front page.
          const app = appEntry(this.root, c.path);
          if (app) apps.push(c.path);
          const fp = app ?? frontPage(this.root, c.path);
          if (fp) fronts[c.path] = fp;
          walk(c);
        }
        if (layout.readonly.length && within(c.path, layout.readonly) && !within(n.path, layout.readonly)) readonly.push(c.path);
      }
    };
    walk(tree);
    const rootFront = frontPage(this.root, "");
    return { tree, owners, fronts, apps, readonly, ...(rootFront ? { root_front: rootFront } : {}), inbox: layout.inbox ?? null, archive: layout.archive ?? null };
  }

  readFile(rel: string): Record<string, unknown> {
    const path = checkRead(this.root, rel);
    const abs = join(this.root, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new NotFound(`no file ${path}`);
    const kind = kindOf(path);
    const row = this.files.row(path);
    const author = row?.author ?? "external";
    const out: Record<string, unknown> = {
      path, kind, hash: this.files.hashOf(path), author, author_name: this.authorName(author),
      updated_at: row?.updated_at ?? new Date(statSync(abs).mtimeMs).toISOString(),
      owner: this.registry.ownerOf(path).def.id,
      ...(within(path, this.layoutValue.readonly) ? { readonly: true } : {}),
    };
    if (kind === "page" || kind === "text") {
      const content = readFileSync(abs, "utf8");
      out.content = content;
      const change = this.files.changeFor(path, content);
      if (change) {
        out.change = {
          created: change.created, hunks: change.hunks, author: change.author,
          author_name: this.authorName(change.author), at: change.at, outside_scope: change.outsideScope,
        };
      }
    } else if (row && this.files.seenHash(path) !== row.hash) {
      out.change = { created: !this.files.seenHash(path), hunks: [], author, author_name: this.authorName(author), at: row.updated_at, outside_scope: !!row.outside_scope };
    }
    return out;
  }

  // ------------------------------------------------------------------ apps (ADR 0006)

  /** Open an app for a device: a capability path for its frame, and what it asks for beyond its grant. */
  openApp(path: string, device: string): Record<string, unknown> {
    const app = this.resolveApp(path);
    const g = effectiveGrant(app, this.appGrants.get(app.root));
    const session = this.appSessions.open(app, device, { network: g.allowed, server: g.server }, this.clock.now());
    // Start an allowed server now, so its first request does not wait for it.
    if (g.server) void this.appServers.ensure(app).catch(() => {});
    return {
      url: `/apps/${session.token}/${app.entry.split("/").map(encodeURIComponent).join("/")}`,
      app: {
        name: app.name, root: app.root, entry: app.entry, manifest: app.manifest, reads: app.reads, network: g.allowed, asks: g.asks,
        ...(app.description ? { description: app.description } : {}),
        ...(app.server ? { server: { file: app.server, allowed: g.server, asks: g.asksServer, ...this.appServers.status(app.root), log: undefined } } : {}),
      },
      owner: this.registry.ownerOf(app.root || checkRead(this.root, path)).def.id,
    };
  }

  private resolveApp(path: string): AppInfo {
    let app;
    try {
      app = findApp(this.root, path);
    } catch (err) {
      if (err instanceof AppError) throw new BadRequest(err.message);
      throw err;
    }
    if (!app) throw new NotFound(`${path} is not an app`);
    return app;
  }

  /** Whether the owner allows this app's server now (checked on every request it gets). */
  appServerAllowed(app: AppInfo): boolean {
    return effectiveGrant(app, this.appGrants.get(app.root)).server;
  }

  /** An app folder's server: its state and recent output. */
  appServer(root: string): Record<string, unknown> {
    const app = this.resolveApp(root);
    return { ...this.appServers.status(app.root), file: app.server ?? null, log_file: this.appServers.logFile(app.root) };
  }

  async restartAppServer(root: string): Promise<Record<string, unknown>> {
    const app = this.resolveApp(root);
    if (!app.server) throw new BadRequest(`${app.root} has no server`);
    if (!effectiveGrant(app, this.appGrants.get(app.root)).server) throw new HttpError(403, "allow this app's server first");
    try {
      await this.appServers.restart(app);
    } catch (err) {
      throw new HttpError(503, (err as Error).message);
    }
    return this.appServer(root);
  }

  async stopAppServer(root: string): Promise<Record<string, unknown>> {
    const app = this.resolveApp(root);
    await this.appServers.stop(app.root);
    return this.appServer(root);
  }

  /** The owner allows an app the origins, and the server, it asks for (only those). */
  grantApp(root: string, network: string[], server = false): Record<string, unknown> {
    const app = this.resolveApp(root);
    if (!app.manifest || app.root !== checkRead(this.root, root)) throw new BadRequest(`${root} is not an app folder`);
    const extra = network.filter((o) => !app.network.includes(o));
    if (extra.length) throw new BadRequest(`the app does not ask for ${extra.join(", ")}`);
    if (server && !app.server) throw new BadRequest("the app has no server");
    this.appGrants.set(app.root, { network: [...new Set(network)], ...(server ? { server: true } : {}) }, this.clock.now());
    this.bus.publish("apps.changed", { root: app.root });
    return { ok: true, network, server };
  }

  /** Take back what an app was allowed, and stop its server. */
  async revokeApp(root: string): Promise<Record<string, unknown>> {
    const rel = checkRead(this.root, root);
    const removed = this.appGrants.remove(rel);
    // Open frames lose their tokens too: they reopen with what is left.
    this.appSessions.revokeApp(rel);
    await this.appServers.stop(rel);
    this.bus.publish("apps.changed", { root: rel });
    return { ok: removed };
  }

  /** The owner has seen this file as it is (when `hash` still matches). */
  markSeen(rel: string, hash?: string): boolean {
    const path = checkRead(this.root, rel);
    if (hash && this.files.hashOf(path) !== hash) return false;
    const ok = !!this.files.markSeen(path);
    this.bus.publish("seen.changed", { path });
    this.bus.publish("today.changed");
    return ok;
  }

  seeAll(): number {
    const n = this.files.seeAll();
    this.bus.publish("seen.changed", {});
    this.bus.publish("tree.changed");
    this.bus.publish("today.changed");
    return n;
  }

  authorName(author: string): string {
    if (author === "external") return "outside Peers";
    if (author.startsWith("app:")) return `the ${author.slice(4).split("/").pop()} app`;
    if (author === "human") return "you";
    return this.registry.get(author)?.def.name ?? author;
  }

  private asOwner<T>(fn: () => T): T {
    this.actingOwner = true;
    try { return fn(); } finally { this.actingOwner = false; }
  }

  moveFile(from: string, to: string): Record<string, unknown> {
    const a = checkRead(this.root, from);
    const b = checkRead(this.root, to);
    if (!existsSync(join(this.root, a))) throw new NotFound(`no file ${a}`);
    if (existsSync(join(this.root, b))) throw new Conflict(`${b} already exists`);
    mkdirSync(dirname(join(this.root, b)), { recursive: true });
    renameSync(join(this.root, a), join(this.root, b));
    this.files.moved(a, b);
    this.asOwner(() => this.files.touch(b));
    this.bus.publish("tree.changed");
    return { ok: true, path: b };
  }

  deleteFile(rel: string): Record<string, unknown> {
    const path = checkRead(this.root, rel);
    const abs = join(this.root, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new NotFound(`no file ${path}`);
    rmSync(abs);
    const c = this.asOwner(() => this.files.touch(path));
    if (c) this.onFileChange(c);
    this.bus.publish("tree.changed");
    return { ok: true };
  }

  /** A new folder, with its own agent unless asked not to, and optionally a first conversation. */
  async createFolder(parentRel: string, name: string, brief?: string, withAgent = true): Promise<Record<string, unknown>> {
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    if (!clean || clean.startsWith(".")) throw new BadRequest("name is required");
    const parent = parentRel ? checkRead(this.root, parentRel) : "";
    if (parent && !this.vault.isDir(parent)) throw new BadRequest(`${parent} is not a folder`);
    const folder = parent ? `${parent}/${clean}` : clean;
    if (existsSync(join(this.root, folder))) throw new Conflict(`${folder} already exists`);
    mkdirSync(join(this.root, folder), { recursive: true });
    this.registry.sync();
    if (withAgent && !this.registry.byPath(folder)) this.addAgent(folder);
    const bot = this.registry.byPath(folder);
    let threadId: string | undefined;
    if (bot && brief?.trim()) {
      threadId = await this.conversations.start(bot,
        `Set up this folder: ${brief.trim()}\n\nWrite its front page (README.md, or README.org in an Org vault) and a first plan.`,
        { origin: "setup", title: `Set up ${clean}` });
    }
    this.bus.publish("tree.changed");
    this.bus.publish("bots.changed");
    return { folder, ...(bot ? { bot_id: bot.def.id } : {}), ...(threadId ? { thread_id: threadId } : {}) };
  }

  /** Move a folder or page with an agent into the layout's archive; its agent pauses. */
  archive(rel: string): Record<string, unknown> {
    const path = checkRead(this.root, rel);
    const bot = this.registry.byPath(path);
    const archive = this.layoutValue.archive;
    if (!archive) throw new BadRequest("this layout has no archive folder");
    if (!bot || bot.kind === "vault" || bot.archived) throw new BadRequest("only an active folder or page with an agent can be archived");
    if (this.conversations.stateOf(bot.def.id) === "working") throw new Conflict(`${bot.def.name} is working; archive it when it is idle`);
    mkdirSync(join(this.root, archive), { recursive: true });
    const dest = this.freeName(`${archive}/${path.split("/").pop()}`);
    this.moveHome(bot, dest);
    this.registry.move(bot.def.id, dest, { archived_from: path });
    this.afterMove();
    return { folder: dest };
  }

  restore(rel: string): Record<string, unknown> {
    const path = checkRead(this.root, rel);
    const bot = this.registry.byPath(path);
    if (!bot || !bot.archived) throw new BadRequest("only an archived folder or page can be restored");
    const back = bot.def.archived_from;
    if (!back) throw new BadRequest("Peers does not know where this came from; move it back by hand");
    const parent = back.split("/").slice(0, -1).join("/");
    if (parent) mkdirSync(join(this.root, parent), { recursive: true });
    const dest = this.freeName(back);
    this.moveHome(bot, dest);
    this.registry.move(bot.def.id, dest, { archived_from: null });
    this.afterMove();
    return { folder: dest };
  }

  /** Move an agent's folder, or its page and the page's folder of attachments. */
  private moveHome(bot: Bot, dest: string): void {
    this.moveFolder(bot.path, dest);
    if (bot.kind === "page") {
      const from = bot.path.replace(PAGE_EXT, "");
      const to = dest.replace(PAGE_EXT, "");
      if (this.vault.isDir(from) && !existsSync(join(this.root, to))) this.moveFolder(from, to);
    }
  }

  private afterMove(): void {
    this.registry.sync();
    this.bus.publish("tree.changed");
    this.bus.publish("bots.changed");
  }

  private moveFolder(from: string, to: string): void {
    mkdirSync(dirname(join(this.root, to)), { recursive: true });
    const wasDir = this.vault.isDir(from);
    renameSync(join(this.root, from), join(this.root, to));
    if (wasDir) this.files.movedFolder(from, to);
    else this.files.moved(from, to);
  }

  private freeName(base: string): string {
    if (!existsSync(join(this.root, base))) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base} (${i})`;
      if (!existsSync(join(this.root, candidate))) return candidate;
    }
    throw new Conflict(`no free name for ${base}`);
  }

  // ------------------------------------------------------------------ overview

  today(): Record<string, unknown> {
    const bots = this.registry.list();
    const names = (id: string): string => this.registry.get(id)?.def.name ?? id;
    const threads = this.conversations.all().filter((t) => !t.archived);
    const day = 24 * 3600_000;
    const now = this.clock.now().getTime();
    const unseen = this.files.unseen(60);
    return {
      needs_you: {
        replies: threads.filter((t) => t.unread && t.state !== "failed")
          .sort((a, b) => (b.last_run_at ?? "").localeCompare(a.last_run_at ?? ""))
          .slice(0, 10)
          .map((t) => ({ bot_id: t.bot_id, bot: names(t.bot_id), thread_id: t.id, title: t.title, at: t.last_run_at })),
        waiting: threads.filter((t) => t.state === "waiting").map((t) => ({ bot_id: t.bot_id, bot: names(t.bot_id), thread_id: t.id, title: t.title })),
        failures: threads.filter((t) => t.state === "failed" && now - Date.parse(t.updated_at) < day)
          .map((t) => ({ bot_id: t.bot_id, bot: names(t.bot_id), thread_id: t.id, title: t.title, detail: t.error, at: t.updated_at })),
        notes: this.notes.unresolved().slice(0, 10),
        review: bots.filter((b) => b.def.needs_review).map((b) => ({ bot_id: b.def.id, bot: b.def.name })),
        invalid: [
          ...(this.layoutError ? [{ folder: ".peers/layout.json", reason: this.layoutError }] : []),
          ...[...this.registry.invalid.entries()].map(([folder, reason]) => ({ folder, reason })),
        ],
        lost: [...this.registry.lost.values()].map((d) => ({ bot_id: d.id, bot: d.name, path: d.path ?? "" })),
        outside_scope: unseen.filter((f) => f.outside_scope).map((f) => ({ path: f.path, bot_id: f.author, bot: names(f.author), at: f.updated_at })),
      },
      changes: unseen.slice(0, 30).map((f) => ({
        path: f.path, author: f.author, author_name: this.authorName(f.author), at: f.updated_at,
        created: !this.files.seenHash(f.path), kind: kindOf(f.path),
      })),
      coming_up: this.triggers.coming(),
      bots: bots.map((b) => this.botStatus(b)),
      demo: this.demoMode(),
    };
  }

  search(q: string): Record<string, unknown>[] {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const out: Record<string, unknown>[] = [];
    for (const f of this.vault.files()) {
      if (out.length >= 40) break;
      const name = f.path.toLowerCase();
      if (name.includes(query)) { out.push({ path: f.path, kind: kindOf(f.path), match: "name" }); continue; }
      const k = kindOf(f.path);
      if ((k !== "page" && k !== "text") || f.size > 2_000_000) continue;
      let text = "";
      try { text = readFileSync(join(this.root, f.path), "utf8"); } catch { continue; }
      const lines = text.split("\n");
      const idx = lines.findIndex((l) => l.toLowerCase().includes(query));
      if (idx >= 0) out.push({ path: f.path, kind: k, match: "text", line: idx + 1, excerpt: lines[idx]!.trim().slice(0, 160) });
    }
    return out;
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class NotFound extends HttpError { constructor(m: string) { super(404, m); } }
export class Conflict extends HttpError { constructor(m: string) { super(409, m); } }
export class BadRequest extends HttpError { constructor(m: string) { super(400, m); } }

export function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof PolicyError) return 403;
  return 500;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
