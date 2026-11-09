/**
 * Where a vault's app state lives, and its tables (ADR 0001, ADR 0003).
 *
 * The vault folder holds only `.peers/`: the vault's id, its layout (ADR 0005), and each
 * agent's definition and memory. Everything else — the SQLite database, what the owner
 * last saw of each page, note sketches, settings, the embedded T3's data — lives in the user
 * data directory, so the vault can be synced with iCloud Drive, Syncthing or git without a
 * live database inside it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { BotModel } from "./engine.ts";

export type VaultSettings = {
  /** Shown in prompts and the UI. */
  name: string;
  /** Owner's name as bots should address them. */
  owner: string;
  /** IANA time zone for schedules and dates. */
  tz: string;
  /** Public HTTPS origin when served through a proxy (Tailscale Serve). */
  origin?: string;
  /** Default model for bots that do not declare one. */
  default_model: BotModel;
};

export function readVaultId(root: string): string | undefined {
  const file = join(root, ".peers", "vault.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown };
    return typeof parsed.id === "string" && /^vault-[a-z0-9]{6,40}$/.test(parsed.id) ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

export function ensureVaultId(root: string): string {
  const existing = readVaultId(root);
  if (existing) return existing;
  const id = `vault-${randomBytes(6).toString("hex")}`;
  mkdirSync(join(root, ".peers"), { recursive: true });
  writeJsonAtomic(join(root, ".peers", "vault.json"), { id });
  return id;
}

/** The per-user data directory for one vault. */
export function stateDirFor(vaultId: string, override?: string): string {
  if (override) return override;
  if (process.env.PEERS_STATE_DIR) return join(process.env.PEERS_STATE_DIR, vaultId);
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Peers", vaultId);
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Peers", vaultId);
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "peers", vaultId);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.peers-tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function loadSettings(stateDir: string, defaults: VaultSettings): VaultSettings {
  const file = join(stateDir, "settings.json");
  if (!existsSync(file)) {
    writeJsonAtomic(file, defaults);
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<VaultSettings> & Record<string, unknown>;
    const { vault_daily_budget_usd: _b, pricing: _p, ...rest } = raw;
    const model = raw.default_model as { provider?: string } | undefined;
    // Settings from before ADR 0003 name API providers; keep only what maps onto T3.
    const provider = model?.provider === "codex" || model?.provider === "openai" ? "codex"
      : model?.provider === "claude" || model?.provider === "claude-code" ? "claude" : undefined;
    const default_model = provider ? { ...(raw.default_model as BotModel), provider } : defaults.default_model;
    return { ...defaults, ...rest, default_model } as VaultSettings;
  } catch {
    return defaults;
  }
}

export function saveSettings(stateDir: string, settings: VaultSettings): void {
  writeJsonAtomic(join(stateDir, "settings.json"), settings);
}

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(VAULT_SCHEMA);
  return db;
}

export const VAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_bots (
  bot_id TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0,
  def_json TEXT,
  project_id TEXT,
  project_path TEXT
);

CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_threads (
  thread_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  trigger_id TEXT,
  from_thread TEXT,
  seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_threads_bot ON vault_threads(bot_id);

CREATE TABLE IF NOT EXISTS vault_files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  author TEXT NOT NULL,
  outside_scope INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_seen (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_annotations (
  annotation_id TEXT PRIMARY KEY,
  client_key TEXT UNIQUE NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  thread_id TEXT,
  doc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_annotations_path ON vault_annotations(path);
CREATE INDEX IF NOT EXISTS idx_vault_annotations_thread ON vault_annotations(thread_id);

CREATE TABLE IF NOT EXISTS vault_idempotency (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS vault_pairing (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS vault_app_grants (
  root TEXT PRIMARY KEY,
  grant_json TEXT NOT NULL,
  granted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_triggers (
  bot_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  pending TEXT NOT NULL DEFAULT '[]',
  first_pending_at TEXT,
  fired TEXT NOT NULL DEFAULT '[]',
  last_slot TEXT,
  PRIMARY KEY (bot_id, trigger_id)
);
`;
