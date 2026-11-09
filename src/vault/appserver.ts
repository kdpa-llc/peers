/**
 * App servers (ADR 0007): an app's server code, run on demand once the owner allows it.
 *
 * In the container each server runs under bubblewrap: its own user, process, IPC, UTS and
 * cgroup namespaces; `/usr` and `/etc` read-only; its app folder read-only at `/app` and its
 * `data/` folder writable at `/app/data`; a private `/tmp`; no `/proc`, no vault, no Peers
 * state; and a clean environment. It shares the container's network. It reads the vault
 * through the same policy-checked data API as the app's pages, with a token of its own
 * (`PEERS_API`). Outside a system with bubblewrap, servers do not start unless the operator
 * turns the sandbox off for development (CONTRACT_TESTS #9).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AppInfo } from "./apps.ts";

export type SandboxMode = "bwrap" | "off" | "none";
export type ServerState = "stopped" | "starting" | "running" | "crashed" | "unavailable";
export type ServerStatus = { state: ServerState; message?: string; started_at?: string; log: string };

const LOG_TAIL = 64 * 1024;
const LOG_ROTATE = 1024 * 1024;
const CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

/** Why a server cannot answer: no sandbox here, not allowed, or it failed to start. */
export class ServerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerUnavailable";
  }
}

type Running = {
  root: string;
  child: ChildProcess;
  port: number;
  ready: Promise<number>;
  state: "starting" | "running";
  token: string;
  startedAt: number;
  lastUsed: number;
  stale: boolean;
  /** Set when Peers stops it, so its exit is not counted as a crash. */
  stopping: boolean;
};

export type AppServersOptions = {
  vaultRoot: string;
  logDir: string;
  now: () => Date;
  /** "bwrap", "off" (development and tests only), or "none"; detected when absent. */
  sandbox?: SandboxMode;
  /** A data-API token for the server's own use, and its revocation. */
  token: (app: AppInfo) => string;
  revoke: (token: string) => void;
  idleMs?: number;
  maxRunning?: number;
  startTimeoutMs?: number;
};

/** Find a program on PATH. */
function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return undefined;
}

/**
 * Which sandbox this system offers. `PEERS_APP_SANDBOX=off` runs servers unsandboxed, for
 * development only; otherwise bubblewrap, if it is installed and can make namespaces here.
 */
export function detectSandbox(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  if (env.PEERS_APP_SANDBOX === "off") return "off";
  const bin = which("bwrap");
  if (!bin) return "none";
  const probe = spawnSync(bin, [...baseArgs(), "--dev", "/dev", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  return probe.status === 0 ? "bwrap" : "none";
}

/** The read-only system every sandbox gets: /usr, /etc, and the merged-/usr links. */
function baseArgs(): string[] {
  const a = ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc"];
  for (const p of ["/bin", "/sbin", "/lib", "/lib64"]) {
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) a.push("--symlink", readlinkSync(p), p);
    else if (st.isDirectory()) a.push("--ro-bind", p, p);
  }
  return a;
}

/** bubblewrap's arguments for one app server (exported for the contract test). */
export function bwrapArgs(o: { appDir: string; dataDir: string; env: Record<string, string>; command: string[] }): string[] {
  const a = [...baseArgs(), "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", o.appDir, "/app", "--bind", o.dataDir, "/app/data", "--chdir", "/app"];
  for (const [k, v] of Object.entries(o.env)) a.push("--setenv", k, v);
  a.push("--", ...o.command);
  return a;
}

/** How to run a server file: Python, or Node (which strips TypeScript types itself). */
export function serverCommand(file: string, path: string, sandboxed: boolean): string[] {
  if (/\.py$/i.test(file)) return ["python3", "-u", path];
  const node = sandboxed ? "node" : process.execPath;
  const major = Number(process.versions.node.split(".")[0]);
  return /\.m?ts$/i.test(file) && major < 23 ? [node, "--experimental-strip-types", path] : [node, path];
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = connect({ host: "127.0.0.1", port });
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("error", () => done(false));
  });
}

const logName = (root: string): string => `${root.replace(/\//g, "--").replace(/[^\w .-]/g, "_") || "vault"}.log`;

export class AppServers {
  private readonly opts: AppServersOptions;
  private modeValue?: SandboxMode;
  private apiOrigin?: string;
  private readonly running = new Map<string, Running>();
  private readonly logs = new Map<string, string>();
  private readonly crashes = new Map<string, number[]>();
  private readonly failures = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(opts: AppServersOptions) {
    this.opts = opts;
    this.modeValue = opts.sandbox;
  }

  /** Detected on first use, so a vault without app servers never probes. */
  get mode(): SandboxMode {
    this.modeValue ??= detectSandbox();
    return this.modeValue;
  }

  /** Where the server reaches Peers' data API (set once the HTTP server listens). */
  setApiOrigin(origin: string): void {
    this.apiOrigin = origin;
    this.timer ??= setInterval(() => this.sweep(), 30_000);
    this.timer.unref?.();
  }

  get logDir(): string {
    return this.opts.logDir;
  }

  logFile(root: string): string {
    return join(this.opts.logDir, logName(root));
  }

  status(root: string): ServerStatus {
    const r = this.running.get(root);
    const log = this.logs.get(root) ?? "";
    if (r) return { state: r.state, started_at: new Date(r.startedAt).toISOString(), log };
    if (this.mode === "none") {
      return { state: "unavailable", message: "App servers run inside the Peers container, where bubblewrap sandboxes them.", log };
    }
    const failure = this.failures.get(root);
    return failure ? { state: "crashed", message: failure, log } : { state: "stopped", log };
  }

  /** The port of the app's running server, starting it if needed. */
  async ensure(app: AppInfo): Promise<number> {
    if (!app.server) throw new ServerUnavailable("this app has no server");
    if (this.mode === "none") throw new ServerUnavailable(this.status(app.root).message!);
    if (!this.apiOrigin) throw new ServerUnavailable("Peers is not serving yet");
    const r = this.running.get(app.root);
    if (r && !r.stale && r.child.exitCode === null && r.child.signalCode === null) {
      r.lastUsed = this.opts.now().getTime();
      return r.ready;
    }
    if (r) await this.stop(app.root);
    const now = this.opts.now().getTime();
    const recent = (this.crashes.get(app.root) ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
    if (recent.length >= CRASHES) {
      throw new ServerUnavailable(`the server stopped ${recent.length} times in a minute; fix it, then restart it from the app's bar`);
    }
    const max = this.opts.maxRunning ?? 4;
    while (this.running.size >= max) {
      const lru = [...this.running.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0]!;
      await this.stop(lru.root);
    }
    return this.start(app);
  }

  private async start(app: AppInfo): Promise<number> {
    const mode = this.mode;
    const appDir = join(this.opts.vaultRoot, app.root);
    const dataDir = join(appDir, "data");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(this.opts.logDir, { recursive: true, mode: 0o700 });
    const port = await freePort();
    const token = this.opts.token(app);
    const sandboxed = mode === "bwrap";
    const env: Record<string, string> = {
      PATH: sandboxed ? "/usr/local/bin:/usr/bin:/bin" : process.env.PATH ?? "/usr/bin:/bin",
      HOME: sandboxed ? "/tmp" : mkdtempSync(join(tmpdir(), "peers-app-home-")),
      LANG: "C.UTF-8",
      PORT: String(port),
      HOST: "127.0.0.1",
      PEERS_API: `${this.apiOrigin}/apps/${token}/_peers/`,
      PEERS_APP: app.root,
      PEERS_DATA: sandboxed ? "/app/data" : dataDir,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
    };
    const command = serverCommand(app.server!, sandboxed ? `/app/${app.server}` : join(appDir, app.server!), sandboxed);
    const child = sandboxed
      ? spawn(which("bwrap")!, bwrapArgs({ appDir, dataDir, env, command }), { cwd: "/", env: {}, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command[0]!, command.slice(1), { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = this.opts.now().getTime();
    this.failures.delete(app.root);
    this.log(app.root, `--- ${new Date(startedAt).toISOString()} starting ${app.server} (${sandboxed ? "sandboxed" : "sandbox off"})\n`);
    child.stdout?.on("data", (d) => this.log(app.root, String(d)));
    child.stderr?.on("data", (d) => this.log(app.root, String(d)));

    const entry: Running = {
      root: app.root, child, port, token, startedAt, lastUsed: startedAt, stale: false, stopping: false, state: "starting",
      ready: Promise.resolve(port),
    };
    this.running.set(app.root, entry);
    child.on("exit", (code, signal) => {
      this.log(app.root, `--- exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}\n`);
      this.opts.revoke(token);
      if (this.running.get(app.root) === entry) {
        this.running.delete(app.root);
        if (!entry.stopping) {
          this.failures.set(app.root, `the server exited${code !== null ? ` with code ${code}` : ""}`);
          const list = this.crashes.get(app.root) ?? [];
          list.push(this.opts.now().getTime());
          this.crashes.set(app.root, list.slice(-CRASHES));
        }
      }
    });
    child.on("error", (err) => this.log(app.root, `--- could not start: ${err.message}\n`));

    entry.ready = (async (): Promise<number> => {
      const deadline = Date.now() + (this.opts.startTimeoutMs ?? 20_000);
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        if (await canConnect(port)) {
          entry.state = "running";
          return port;
        }
        await new Promise((ok) => setTimeout(ok, 100));
      }
      const exited = child.exitCode !== null || child.signalCode !== null;
      if (!exited) await this.stop(app.root);
      const tail = (this.logs.get(app.root) ?? "").trim().split("\n").slice(-12).join("\n");
      throw new ServerUnavailable(`${exited ? "the server exited before it listened" : "the server did not listen"} on $PORT\n${tail}`);
    })();
    return entry.ready;
  }

  /** Stop one app's server. */
  async stop(root: string): Promise<boolean> {
    const r = this.running.get(root);
    if (!r) return false;
    r.stopping = true;
    this.running.delete(root);
    this.opts.revoke(r.token);
    if (r.child.exitCode === null && r.child.signalCode === null) {
      const gone = new Promise<void>((ok) => r.child.once("exit", () => ok()));
      r.child.kill("SIGTERM");
      const timer = setTimeout(() => r.child.kill("SIGKILL"), 3000);
      await gone;
      clearTimeout(timer);
    }
    return true;
  }

  /** Forget its crashes and start again. */
  async restart(app: AppInfo): Promise<number> {
    await this.stop(app.root);
    this.crashes.delete(app.root);
    this.failures.delete(app.root);
    return this.ensure(app);
  }

  /** A change in an app folder, outside its data, restarts its server on the next request. */
  fileChanged(path: string): void {
    for (const r of this.running.values()) {
      const inside = r.root === "" || path.startsWith(`${r.root}/`);
      if (inside && !path.startsWith(r.root ? `${r.root}/data/` : "data/")) r.stale = true;
    }
  }

  /** Stop servers nobody used for a while. */
  async sweep(): Promise<number> {
    const now = this.opts.now().getTime();
    const idle = [...this.running.values()].filter((r) => now - r.lastUsed > (this.opts.idleMs ?? 10 * 60_000));
    for (const r of idle) await this.stop(r.root);
    return idle.length;
  }

  touch(root: string): void {
    const r = this.running.get(root);
    if (r) r.lastUsed = this.opts.now().getTime();
  }

  async stopAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.running.keys()].map((root) => this.stop(root)));
  }

  private log(root: string, text: string): void {
    const tail = ((this.logs.get(root) ?? "") + text).slice(-LOG_TAIL);
    this.logs.set(root, tail);
    try {
      const file = this.logFile(root);
      if (existsSync(file) && statSync(file).size > LOG_ROTATE) renameSync(file, `${file}.1`);
      appendFileSync(file, text);
    } catch { /* the log is best effort */ }
  }
}
