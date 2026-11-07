/**
 * The embedded headless T3 server the bots run on (ADR 0003).
 *
 * Peers starts its own `t3 serve` with its own data folder and port, so its conversations
 * never appear in the owner's T3 app. Claude Code and Codex inside it use the bots' own
 * config folders (signed in once), so bot sessions never appear in the owner's own Claude
 * Code or Codex history either. The child gets a clean environment: nothing that would tie
 * it to the session that launched Peers.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../state.ts";

export type AgentHomes = { claude: string; codex: string };

export type T3RuntimeOptions = {
  baseDir: string;
  vaultRoot: string;
  homes: AgentHomes;
  port?: number;
  bin?: string;
  log?: (line: string) => void;
};

/** Where the bots' own Claude Code and Codex config folders live. */
export function defaultAgentHomes(): AgentHomes {
  const base = process.env.PEERS_AGENT_HOMES
    ?? (platform() === "darwin"
      ? join(homedir(), "Library", "Application Support", "Peers", "agents")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "peers", "agents"));
  return { claude: join(base, "claude"), codex: join(base, "codex") };
}

/** The `t3` CLI to run: PEERS_T3_BIN (set in the container image), else `t3` on PATH. */
export function resolveT3Bin(): string | undefined {
  if (process.env.PEERS_T3_BIN) return process.env.PEERS_T3_BIN;
  const which = spawnSync("/usr/bin/env", ["which", "t3"], { encoding: "utf8" });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : undefined;
}

/** A child environment free of anything that ties it to the launching agent session or T3. */
export function cleanEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(CLAUDE|CLAUDECODE|T3|T3CODE|CODEX|AI_AGENT|ANTHROPIC|OPENAI|MCP_)/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** Point T3's two providers at the bots' homes, keeping any other settings. */
export function writeProviderSettings(baseDir: string, homes: AgentHomes): void {
  const dir = join(baseDir, "userdata");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { /* first start */ }
  settings.providerInstances = {
    ...(settings.providerInstances as Record<string, unknown> | undefined),
    claudeAgent: { driver: "claudeAgent", displayName: "Peers Claude", enabled: true, config: { homePath: homes.claude } },
    codex: { driver: "codex", displayName: "Peers Codex", enabled: true, config: { homePath: homes.codex } },
  };
  writeJsonAtomic(file, settings);
}

export async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

export class T3Runtime {
  readonly opts: T3RuntimeOptions;
  readonly bin: string;
  private child?: ChildProcess;
  private port = 0;
  private cachedToken?: { value: string; at: number };
  private lastOutput = "";

  constructor(opts: T3RuntimeOptions) {
    const bin = opts.bin ?? resolveT3Bin();
    if (!bin) throw new Error("T3 is not installed: the `t3` command was not found (set PEERS_T3_BIN)");
    this.opts = opts;
    this.bin = bin;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private env(): NodeJS.ProcessEnv {
    return cleanEnv(process.env, { T3CODE_HOME: this.opts.baseDir });
  }

  async start(): Promise<string> {
    mkdirSync(this.opts.baseDir, { recursive: true, mode: 0o700 });
    for (const h of Object.values(this.opts.homes)) mkdirSync(h, { recursive: true, mode: 0o700 });
    writeProviderSettings(this.opts.baseDir, this.opts.homes);
    this.port = this.opts.port ?? await freePort();
    this.child = spawn(this.bin, [
      "serve", "--base-dir", this.opts.baseDir, "--port", String(this.port), "--host", "127.0.0.1",
      "--no-browser", this.opts.vaultRoot,
    ], { cwd: this.opts.vaultRoot, env: this.env(), stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d: Buffer): void => {
      this.lastOutput = (this.lastOutput + d.toString()).slice(-4000);
    };
    this.child.stdout?.on("data", keep);
    this.child.stderr?.on("data", keep);
    this.child.on("exit", (code) => this.opts.log?.(`embedded T3 exited (${code})`));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) throw new Error(`T3 stopped while starting: ${this.lastOutput.slice(-600)}`);
      try {
        const res = await fetch(`${this.baseUrl}/api/orchestration/shell`, {
          headers: { Authorization: `Bearer ${await this.token()}`, "x-t3-orchestration-protocol": "2" },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return this.baseUrl;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("T3 did not start within 90 seconds");
  }

  /** A bearer token for this server, re-issued before it expires. */
  async token(): Promise<string> {
    if (this.cachedToken && Date.now() - this.cachedToken.at < 10 * 3600_000) return this.cachedToken.value;
    const r = spawnSync(this.bin, ["auth", "session", "issue", "--base-dir", this.opts.baseDir, "--ttl", "12h",
      "--label", "peers-vault", "--token-only"], { env: this.env(), encoding: "utf8", timeout: 30_000 });
    const value = (r.stdout ?? "").trim();
    if (r.status !== 0 || !value) throw new Error("could not issue a T3 session token");
    this.cachedToken = { value, at: Date.now() };
    return value;
  }

  /** Register a folder as a T3 project. Returns its id. */
  addProject(path: string, title: string): string {
    const r = spawnSync(this.bin, ["project", "add", "--base-dir", this.opts.baseDir, "--title", title, path], {
      env: this.env(), encoding: "utf8", timeout: 60_000,
    });
    const m = /Added project ([0-9a-f-]{36})/.exec(`${r.stdout}${r.stderr}`);
    if (!m) throw new Error(`T3 could not add the project ${title}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return m[1]!;
  }

  async stop(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    c.kill("SIGTERM");
    await new Promise<void>((ok) => {
      const t = setTimeout(() => { c.kill("SIGKILL"); ok(); }, 5000);
      c.once("exit", () => { clearTimeout(t); ok(); });
    });
  }
}
