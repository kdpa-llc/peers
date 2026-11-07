/**
 * Agents: one per folder or page the layout names, plus the vault agent at the root
 * (TECHNICAL.md §4, ADR 0005). Internally they are still called bots.
 *
 * An agent's definition is `.peers/agents/<id>.json` at the vault root, with the path it
 * owns, so a vault where a project is a single page works the same as one where it is a
 * folder. The vault database remembers each id's path and its last accepted definition, so
 * a definition that arrives from outside, or changes on disk to add automation, waits for
 * the owner's review (CONTRACT_TESTS #5). Agents that lose their folder are found again by
 * name, or reported.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Schedule } from "./schedules.ts";
import type { BotModel, Provider, Thinking } from "./engine.ts";
import { writeJsonAtomic, type VaultSettings } from "./state.ts";
import { frontPage, isFrontPage, isPagePattern, matches, PAGE_EXT, within, type Layout } from "./layout.ts";
import type { TreeNode, Vault } from "./vault.ts";

/** The vault agent at the root, an agent for a folder, or one for a single page. */
export type BotKind = "vault" | "folder" | "page";
export type WriteScope = "folder" | "folder+resources" | "vault";
export const COLORS = ["teal", "indigo", "amber", "rose", "green", "violet", "slate", "orange"] as const;
export type BotColor = (typeof COLORS)[number];

export type ScheduleTrigger = {
  id: string; kind: "schedule"; every: Schedule["every"]; n?: number; at?: string;
  day?: Schedule["day"]; heartbeat?: boolean; prompt: string; enabled?: boolean;
};
export type FileTrigger = { id: string; kind: "file_change"; path: string; prompt: string; enabled?: boolean };
export type BotTrigger = ScheduleTrigger | FileTrigger;

export type BotDef = {
  id: string;
  name: string;
  /** The folder or page this agent looks after; "" for the vault agent. */
  path?: string;
  color?: BotColor;
  instructions?: string;
  model?: BotModel;
  write_scope?: WriteScope;
  /** Kept for old definitions; bots run on the owner's Claude or ChatGPT plan, not metered. */
  daily_budget_usd?: number;
  paused?: boolean;
  /** Where a folder or page was before "Move to archive", for Restore. */
  archived_from?: string | null;
  needs_review?: boolean;
  triggers?: BotTrigger[];
};

export type Bot = {
  def: BotDef;
  /** The folder or page it looks after, relative to the vault root; "" for the vault agent. */
  path: string;
  kind: BotKind;
  /** Inside a paused part of the layout (an archive): it does nothing on its own. */
  archived: boolean;
  /** The page that introduces it: a folder's index, README or folder note, or the page itself. */
  front?: string;
};

function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bot";
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function newBotId(name: string): string {
  return `bot-${slug(name)}-${randomBytes(3).toString("hex")}`;
}

export function colorFor(id: string): BotColor {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

const EVERY = new Set(["minutes", "hours", "day", "weekday", "week"]);
const DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
/** Older definitions named API providers; they map onto the two T3 providers. */
const PROVIDERS: Record<string, Provider | null> = {
  claude: "claude", "claude-code": "claude", codex: "codex", openai: "codex", openrouter: null, scripted: null,
};
const THINKING = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Validate a definition (mirrors bot.schema.json). Returns a clean copy or throws. */
export function validateDef(raw: unknown): BotDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("definition must be an object");
  const r = raw as Record<string, unknown>;
  const allowed = new Set(["id", "name", "path", "color", "instructions", "model", "write_scope", "daily_budget_usd",
    "paused", "archived_from", "needs_review", "triggers"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new Error(`unknown field '${k}'`);
  if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(r.id)) throw new Error("invalid id");
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 120) throw new Error("invalid name");
  const def: BotDef = { id: r.id, name: r.name.trim() };
  if (r.path !== undefined) {
    if (typeof r.path !== "string" || r.path.includes("..") || r.path.startsWith("/") || r.path.length > 512) throw new Error("invalid path");
    def.path = r.path.replace(/\/+$/, "");
  }
  if (r.color !== undefined) {
    if (!COLORS.includes(r.color as BotColor)) throw new Error("invalid color");
    def.color = r.color as BotColor;
  }
  if (r.instructions !== undefined) {
    if (typeof r.instructions !== "string" || r.instructions.length > 20000) throw new Error("invalid instructions");
    def.instructions = r.instructions;
  }
  if (r.model !== undefined && r.model !== null) {
    const m = r.model as Record<string, unknown>;
    if (typeof m !== "object") throw new Error("invalid model");
    const model: BotModel = {};
    if (m.provider !== undefined) {
      if (!(String(m.provider) in PROVIDERS)) throw new Error("invalid model provider");
      const provider = PROVIDERS[String(m.provider)];
      if (provider) model.provider = provider;
    }
    if (m.model !== undefined) {
      if (typeof m.model !== "string" || !m.model) throw new Error("invalid model id");
      model.model = m.model;
    }
    if (m.thinking !== undefined) {
      if (!THINKING.has(String(m.thinking))) throw new Error("invalid thinking level");
      model.thinking = m.thinking as Thinking;
    }
    if (Object.keys(model).length) def.model = model;
  }
  if (r.write_scope !== undefined) {
    if (!["folder", "folder+resources", "vault"].includes(String(r.write_scope))) throw new Error("invalid write_scope");
    def.write_scope = r.write_scope as WriteScope;
  }
  if (r.daily_budget_usd !== undefined) {
    const n = Number(r.daily_budget_usd);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("invalid daily_budget_usd");
    def.daily_budget_usd = n;
  }
  for (const k of ["paused", "needs_review"] as const) {
    if (r[k] !== undefined) {
      if (typeof r[k] !== "boolean") throw new Error(`invalid ${k}`);
      def[k] = r[k] as boolean;
    }
  }
  if (r.archived_from !== undefined && r.archived_from !== null) {
    if (typeof r.archived_from !== "string" || r.archived_from.includes("..") || r.archived_from.startsWith("/")) throw new Error("invalid archived_from");
    def.archived_from = r.archived_from;
  }
  if (r.triggers !== undefined) {
    if (!Array.isArray(r.triggers) || r.triggers.length > 20) throw new Error("invalid triggers");
    def.triggers = r.triggers.map((t, i) => validateTrigger(t, i));
    const ids = new Set(def.triggers.map((t) => t.id));
    if (ids.size !== def.triggers.length) throw new Error("trigger ids must be unique");
  }
  return def;
}

function validateTrigger(raw: unknown, i: number): BotTrigger {
  if (!raw || typeof raw !== "object") throw new Error(`trigger ${i} must be an object`);
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) throw new Error(`trigger ${i} needs an id`);
  if (typeof t.prompt !== "string" || !t.prompt.trim()) throw new Error(`trigger ${i} needs a prompt`);
  const enabled = t.enabled === undefined ? undefined : Boolean(t.enabled);
  if (t.kind === "schedule") {
    if (!EVERY.has(String(t.every))) throw new Error(`trigger ${i}: invalid every`);
    const out: ScheduleTrigger = { id: t.id, kind: "schedule", every: t.every as Schedule["every"], prompt: t.prompt.trim() };
    if (t.n !== undefined) {
      const n = Number(t.n);
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error(`trigger ${i}: invalid n`);
      out.n = n;
    }
    if (t.at !== undefined) {
      if (typeof t.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.at)) throw new Error(`trigger ${i}: invalid at`);
      out.at = t.at;
    }
    if (t.day !== undefined) {
      if (!DAYS.has(String(t.day))) throw new Error(`trigger ${i}: invalid day`);
      out.day = t.day as Schedule["day"];
    }
    if (t.heartbeat !== undefined) out.heartbeat = Boolean(t.heartbeat);
    if (enabled !== undefined) out.enabled = enabled;
    return out;
  }
  if (t.kind === "file_change") {
    const path = typeof t.path === "string" ? t.path : "";
    if (path.includes("..") || path.startsWith("/")) throw new Error(`trigger ${i}: invalid path`);
    return { id: t.id, kind: "file_change", path, prompt: t.prompt.trim(), ...(enabled !== undefined ? { enabled } : {}) };
  }
  throw new Error(`trigger ${i}: unknown kind`);
}

/** A display name from a page's title, or a file or folder name. */
export function displayName(root: string, path: string, front?: string): string {
  const pretty = (p: string): string => {
    const base = (p.split("/").pop() ?? p).replace(PAGE_EXT, "").replace(/[-_]+/g, " ").trim();
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Vault";
  };
  if (front) {
    try {
      const head = readFileSync(join(root, front), "utf8").slice(0, 4000);
      const t = /^#\+TITLE:\s*(.+)$/mi.exec(head)?.[1] ?? /^title:\s*["']?(.+?)["']?\s*$/mi.exec(head)?.[1] ?? /^#\s+(.+)$/m.exec(head)?.[1];
      // A very long title ("Job Search / Career Evidence (figure-out-next-steps)") makes a
      // poor name to @mention; the file or folder name is better then.
      if (t && t.trim().length <= 48) return t.trim();
    } catch { /* unreadable: use the name */ }
  }
  return path ? pretty(path) : "Vault";
}

export class BotRegistry {
  private readonly vault: Vault;
  private readonly db: DatabaseSync;
  private readonly settings: () => VaultSettings;
  private readonly layout: () => Layout;
  private bots = new Map<string, Bot>();
  /** Definitions that could not be read, by file, with the reason. */
  readonly invalid = new Map<string, string>();
  /** Agents whose folder or page is gone and could not be found again. */
  readonly lost = new Map<string, BotDef>();

  constructor(args: { vault: Vault; db: DatabaseSync; settings: () => VaultSettings; layout: () => Layout }) {
    this.vault = args.vault;
    this.db = args.db;
    this.settings = args.settings;
    this.layout = args.layout;
  }

  get agentsDir(): string { return join(this.vault.root, ".peers", "agents"); }

  list(): Bot[] { return [...this.bots.values()]; }
  get(id: string): Bot | undefined { return this.bots.get(id); }
  byPath(path: string): Bot | undefined { return this.list().find((b) => b.path === path); }
  vaultBot(): Bot { return this.list().find((b) => b.kind === "vault")!; }
  byName(name: string): Bot | undefined {
    const n = name.trim().toLowerCase();
    return this.list().find((b) => !b.archived && b.def.name.toLowerCase() === n);
  }

  /** The agent that answers for a path: the page's own agent, or the nearest folder's. */
  ownerOf(rel: string): Bot {
    const pages = this.list().filter((b) => b.kind === "page");
    for (const b of pages) {
      // A page agent also owns the folder of the same name next to it (attachments).
      if (rel === b.path || rel.startsWith(`${b.path.replace(PAGE_EXT, "")}/`)) return b.archived ? this.vaultBot() : b;
    }
    const parts = rel.split("/");
    for (let i = parts.length; i > 0; i--) {
      const b = this.byPath(parts.slice(0, i).join("/"));
      if (b && b.kind === "folder") return b.archived ? this.vaultBot() : b;
    }
    return this.vaultBot();
  }

  defFile(id: string): string {
    return join(this.agentsDir, `${id}.json`);
  }

  memoryFile(bot: Bot): string {
    return join(this.agentsDir, `${bot.def.id}.memory.md`);
  }

  memoryPath(bot: Bot): string {
    return `.peers/agents/${bot.def.id}.memory.md`;
  }

  /** The folder an id was last bound to, if this vault has seen it. */
  private boundFolder(id: string): string | undefined {
    const row = this.db.prepare("SELECT folder FROM vault_bots WHERE bot_id = ?").get(id) as { folder?: string } | undefined;
    return row?.folder ?? undefined;
  }

  /** The definition as Peers last wrote or accepted it. */
  private storedDef(id: string): BotDef | undefined {
    const row = this.db.prepare("SELECT def_json FROM vault_bots WHERE bot_id = ?").get(id) as { def_json?: string | null } | undefined;
    try { return row?.def_json ? JSON.parse(row.def_json) as BotDef : undefined; } catch { return undefined; }
  }

  /** Every folder and page the layout gives an agent, besides the root. */
  homes(tree: TreeNode = this.vault.tree()): { path: string; kind: "folder" | "page" }[] {
    const layout = this.layout();
    const folderPats = layout.agents.filter((p) => !isPagePattern(p));
    const pagePats = layout.agents.filter((p) => isPagePattern(p));
    const out: { path: string; kind: "folder" | "page" }[] = [];
    const walk = (n: TreeNode): void => {
      for (const c of n.children ?? []) {
        if (within(c.path, layout.hidden)) continue;
        if (c.type === "dir") {
          if (folderPats.some((p) => matches(c.path, p)) && !layout.exclude.includes(c.path)) out.push({ path: c.path, kind: "folder" });
          walk(c);
        } else if (PAGE_EXT.test(c.path) && !isFrontPage(c.path) && pagePats.some((p) => matches(c.path, p)) && !layout.exclude.includes(c.path)) {
          out.push({ path: c.path, kind: "page" });
        }
      }
    };
    walk(tree);
    // A folder next to a page agent with the same name holds that page's attachments: it
    // belongs to the page's agent, not to an agent of its own.
    const pageStems = new Set(out.filter((h) => h.kind === "page").map((h) => h.path.replace(PAGE_EXT, "")));
    return out.filter((h) => h.kind === "page" || !pageStems.has(h.path));
  }

  private readDefs(): BotDef[] {
    mkdirSync(this.agentsDir, { recursive: true });
    const defs: BotDef[] = [];
    for (const f of readdirSync(this.agentsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const def = validateDef(JSON.parse(readFileSync(join(this.agentsDir, f), "utf8")));
        const stem = f.slice(0, -5);
        if (def.id !== stem) {
          // A copied file keeps its old id inside: the file name wins.
          if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(stem)) throw new Error("file name is not an agent id");
          def.id = stem;
          writeJsonAtomic(join(this.agentsDir, f), def);
        }
        defs.push(def);
      } catch (err) {
        this.invalid.set(`.peers/agents/${f}`, err instanceof Error ? err.message : String(err));
      }
    }
    return defs;
  }

  /** `.bot.json` and `.bot/MEMORY.md` from before ADR 0005 move into `.peers/agents/`. */
  private migrateLegacy(homes: { path: string }[]): void {
    for (const folder of ["", ...homes.map((h) => h.path)]) {
      const old = join(this.vault.root, folder, ".bot.json");
      if (!existsSync(old)) continue;
      try {
        const def = validateDef(JSON.parse(readFileSync(old, "utf8")));
        if (!existsSync(this.defFile(def.id))) {
          mkdirSync(this.agentsDir, { recursive: true });
          writeJsonAtomic(this.defFile(def.id), { ...def, path: folder });
          const mem = join(this.vault.root, folder, ".bot", "MEMORY.md");
          if (existsSync(mem)) renameSync(mem, join(this.agentsDir, `${def.id}.memory.md`));
        }
        rmSync(old, { force: true });
        rmSync(join(this.vault.root, folder, ".bot"), { recursive: true, force: true });
      } catch {
        // An unreadable old file stays where it is; the folder gets a fresh agent.
      }
    }
  }

  /** Read every definition, create missing ones, and record bindings. Safe to call often. */
  sync(): Bot[] {
    this.invalid.clear();
    this.lost.clear();
    const tree = this.vault.tree();
    const layout = this.layout();
    const homes = this.homes(tree);
    this.migrateLegacy(homes);
    const defs = this.readDefs();
    const byPath = new Map<string, BotDef>();
    const unplaced: BotDef[] = [];
    for (const d of defs) {
      const p = d.path ?? "";
      const exists = p === "" || existsSync(join(this.vault.root, p));
      if (exists && !byPath.has(p)) byPath.set(p, d);
      else unplaced.push(d);
    }
    const next = new Map<string, Bot>();
    const place = (path: string, kind: BotKind): void => {
      let def = byPath.get(path);
      let created = false;
      if (!def) {
        // A definition whose folder moved: the same name, unclaimed, is the same agent.
        const base = path.split("/").pop() ?? "";
        const idx = unplaced.findIndex((d) => d.path !== undefined && d.path.split("/").pop() === base && !existsSync(join(this.vault.root, d.path)));
        if (idx >= 0) {
          def = { ...unplaced[idx]!, path };
          unplaced.splice(idx, 1);
          created = true;
        }
      }
      const front = kind === "page" ? path : frontPage(this.vault.root, path);
      if (!def) {
        const name = kind === "vault" ? titleCase(this.settings().name) : displayName(this.vault.root, path, front);
        def = { id: newBotId(name), name, path, color: colorFor(path || name), triggers: [] };
        created = true;
      }
      // A definition nobody here created, or one changed on disk (a sync, an editor, a bot)
      // to add automation or widen its scope, waits for the owner's review.
      const known = this.boundFolder(def.id) !== undefined;
      const automated = (d: BotDef): string => JSON.stringify([(d.triggers ?? []).filter((t) => t.enabled), d.write_scope ?? "folder"]);
      const risky = (def.triggers ?? []).some((t) => t.enabled) || (def.write_scope && def.write_scope !== "folder");
      const stored = known ? this.storedDef(def.id) : undefined;
      if (!created && !def.needs_review && risky && (!known || (!!stored && automated(stored) !== automated(def)))) {
        def = { ...def, needs_review: true };
        created = true;
      }
      if (def.path !== path) { def = { ...def, path }; created = true; }
      if (created) {
        mkdirSync(this.agentsDir, { recursive: true });
        writeJsonAtomic(this.defFile(def.id), def);
      }
      next.set(def.id, { def, path, kind, archived: path !== "" && within(path, layout.paused), ...(front ? { front } : {}) });
    };
    place("", "vault");
    for (const h of homes) place(h.path, h.kind);
    for (const d of unplaced) if (!next.has(d.id)) this.lost.set(d.id, d);
    this.bots = next;
    const bind = this.db.prepare(
      `INSERT INTO vault_bots (bot_id, folder, retired, def_json) VALUES (?, ?, 0, ?)
       ON CONFLICT(bot_id) DO UPDATE SET folder = excluded.folder, retired = 0,
         def_json = CASE WHEN ? THEN excluded.def_json ELSE vault_bots.def_json END`,
    );
    // A definition waiting for review is not accepted yet: keep the last accepted one.
    for (const bot of next.values()) bind.run(bot.def.id, bot.path, JSON.stringify(bot.def), bot.def.needs_review ? 0 : 1);
    const ids = [...next.keys()];
    this.db.prepare(`UPDATE vault_bots SET retired = 1 WHERE bot_id NOT IN (${ids.map(() => "?").join(",") || "''"})`).run(...ids);
    return this.list();
  }

  /** Change a definition from the API. Validated and written. */
  update(id: string, patch: Partial<BotDef>): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`no such bot ${id}`);
    const def = validateDef({ ...bot.def, ...patch, id: bot.def.id, path: bot.path });
    writeJsonAtomic(this.defFile(id), def);
    if (!def.needs_review) this.db.prepare("UPDATE vault_bots SET def_json = ? WHERE bot_id = ?").run(JSON.stringify(def), id);
    const updated = { ...bot, def };
    this.bots.set(id, updated);
    return updated;
  }

  /** Point an agent at a new path after the app moved its folder or page. */
  move(id: string, path: string, extra: Partial<BotDef> = {}): void {
    const bot = this.bots.get(id);
    if (!bot) return;
    writeJsonAtomic(this.defFile(id), validateDef({ ...bot.def, ...extra, path }));
  }

  /** Paths a bot may change ("" is everything). */
  writable(bot: Bot): string[] {
    const scope = bot.def.write_scope ?? "folder";
    if (scope === "vault") return [""];
    if (bot.kind === "page") return [bot.path, bot.path.replace(PAGE_EXT, "")];
    if (bot.kind === "folder") return [bot.path];
    return [""];
  }

  /** Whether a change to this path is inside what the bot may write. */
  mayWrite(bot: Bot, rel: string): boolean {
    if (rel.startsWith(".peers/")) return rel === this.memoryPath(bot);
    const scope = bot.def.write_scope ?? "folder";
    if (scope === "vault") return true;
    // The vault agent writes everything no other agent looks after.
    if (bot.kind === "vault") return this.ownerOf(rel).def.id === bot.def.id;
    return this.writable(bot).some((f) => rel === f || rel.startsWith(`${f}/`));
  }

  /** The sentence in an agent's brief that says where it may write. */
  writeHint(bot: Bot): string {
    const scope = bot.def.write_scope ?? "folder";
    if (scope === "vault") return "You may create and edit pages anywhere in the vault.";
    if (bot.kind === "vault") {
      return "You may edit pages that no other agent looks after (see the list below); ask the owner before changing theirs.";
    }
    if (bot.kind === "page") {
      return `Edit only your page${existsSync(join(this.vault.root, bot.path.replace(PAGE_EXT, ""))) ? ` and the folder ${bot.path.replace(PAGE_EXT, "")}/ next to it` : ""}. To change anything else, ask the owner.`;
    }
    return "Create and edit pages only inside your folder. To change anything else, ask the owner.";
  }

  schedules(bot: Bot): (Schedule & { trigger: ScheduleTrigger })[] {
    return (bot.def.triggers ?? [])
      .filter((t): t is ScheduleTrigger => t.kind === "schedule" && t.enabled === true)
      .map((t) => ({
        id: t.id, every: t.every, prompt: t.heartbeat ? `Heartbeat check: ${t.prompt}` : t.prompt,
        tz: this.settings().tz, trigger: t,
        ...(t.n !== undefined ? { n: t.n } : {}),
        ...(t.at !== undefined ? { at: t.at } : {}),
        ...(t.day !== undefined ? { day: t.day } : {}),
      }));
  }

  /** Where a file trigger of this agent watches. */
  triggerScope(bot: Bot, t: FileTrigger): string {
    if (bot.kind === "page") return bot.path;
    return [bot.path, t.path].filter(Boolean).join("/");
  }
}

