/**
 * `peers up` and friends: run the whole backend in one Linux container (ADR 0004).
 *
 *   peers up [dir] [--demo] [--scripted] [--origin URL] [--port 4777] [--build]
 *   peers down | status | logs | pair | build
 *   peers login claude|codex
 *
 * Uses Apple's `container` tool. The container runs the vault server, the bots' T3, Claude
 * Code and Codex, and sees only the vault folder (/vault) and its state folder (/state). Its
 * web port is published on the host's loopback only.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const IN_BOX = ["node", "/app/bin/peers.js"];

export type BoxOptions = {
  root: string;
  bin?: string;
  name?: string;
  stateDir?: string;
};

export function boxStateDir(): string {
  return process.env.PEERS_BOX_STATE ?? (platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Peers", "box")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "peers", "box"));
}

/** The arguments for `container run`. Pure, so tests can check what the box may reach. */
export function runArgs(a: {
  name: string; image: string; vault: string; state: string; port: number; memory?: string; cpus?: number;
  origin?: string; scripted?: boolean;
}): string[] {
  return [
    "run", "--detach", "--name", a.name,
    // The web port is reachable from this computer only; Tailscale Serve can forward to it. The
    // same number inside and out, because the server checks the Host header's port.
    "--publish", `127.0.0.1:${a.port}:${a.port}`,
    // The only parts of the host the box can see.
    "--volume", `${a.vault}:/vault`,
    "--volume", `${a.state}:/state`,
    "--memory", a.memory ?? "4G",
    "--cpus", String(a.cpus ?? 4),
    a.image,
    "serve", "/vault", "--host", "0.0.0.0", "--port", String(a.port),
    ...(a.origin ? ["--origin", a.origin] : []),
    ...(a.scripted ? ["--scripted"] : []),
  ];
}

export class Box {
  readonly root: string;
  readonly bin: string;
  readonly name: string;
  readonly stateDir: string;
  readonly image: string;

  constructor(opts: BoxOptions) {
    this.root = opts.root;
    this.bin = opts.bin ?? process.env.PEERS_CONTAINER_BIN ?? "container";
    this.name = opts.name ?? "peers-vault";
    this.stateDir = opts.stateDir ?? boxStateDir();
    const version = (JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as { version: string }).version;
    this.image = `peers-vault:${version}`;
  }

  run(args: string[], opts: SpawnSyncOptions = {}): { status: number; out: string } {
    const r = spawnSync(this.bin, args, { encoding: "utf8", ...opts });
    if (r.error) throw new Error(`could not run ${this.bin}: ${r.error.message}. Install Apple's container tool (github.com/apple/container).`);
    return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  ensureSystem(): void {
    if (this.run(["system", "status"]).status === 0) return;
    console.log("Starting Apple's container services…");
    if (this.run(["system", "start"], { stdio: "inherit" }).status !== 0) throw new Error("container services did not start");
  }

  hasImage(): boolean {
    return this.run(["image", "inspect", this.image]).status === 0;
  }

  build(): void {
    const file = join(this.root, "container", "Containerfile");
    if (!existsSync(file)) throw new Error("the Containerfile is missing from this installation");
    // The image takes the compiled app. In a checkout, compile it first.
    if (existsSync(join(this.root, "src")) && existsSync(join(this.root, "tsconfig.build.json"))) {
      const b = spawnSync("npm", ["run", "build"], { cwd: this.root, stdio: "inherit" });
      if (b.status !== 0) throw new Error("the app did not compile");
    }
    if (!existsSync(join(this.root, "dist", "cli", "main.js"))) throw new Error("dist/ is missing; run npm run build");
    console.log(`Building ${this.image} (T3, Claude Code, Codex and the vault server)…`);
    const r = this.run(["build", "--tag", this.image, "--file", file, this.root], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("the image did not build");
  }

  /** "running", "stopped", or undefined when there is no such container. */
  containerStatus(): string | undefined {
    const r = this.run(["inspect", this.name]);
    if (r.status !== 0) return undefined;
    try {
      // `container inspect` prints [{ status: { state: "running", … }, … }].
      const parsed = JSON.parse(r.out) as Record<string, any>[] | Record<string, any>;
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!first) return undefined;
      const state = typeof first.status === "string" ? first.status : first.status?.state;
      return typeof state === "string" ? state : "stopped";
    } catch {
      return /running/.test(r.out) ? "running" : "stopped";
    }
  }

  logs(): string {
    return this.run(["logs", this.name]).out;
  }

  async up(a: { vault: string; port: number; origin?: string; scripted?: boolean; demo?: boolean; rebuild?: boolean; memory?: string; cpus?: number }): Promise<number> {
    this.ensureSystem();
    if (a.rebuild || !this.hasImage()) this.build();
    const current = this.containerStatus();
    if (current === "running") {
      console.log(`${this.name} is already running. \`peers down\` stops it.`);
      return 0;
    }
    if (current) this.run(["delete", this.name]);
    mkdirSync(a.vault, { recursive: true });
    if (a.demo && readdirSync(a.vault).filter((n) => !n.startsWith(".")).length === 0) {
      cpSync(join(this.root, "examples", "vault"), a.vault, { recursive: true });
      console.log(`Copied the demo vault into ${a.vault}`);
    }
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const r = this.run(runArgs({ name: this.name, image: this.image, vault: a.vault, state: this.stateDir, port: a.port,
      ...(a.memory ? { memory: a.memory } : {}), ...(a.cpus ? { cpus: a.cpus } : {}),
      ...(a.origin ? { origin: a.origin } : {}), ...(a.scripted ? { scripted: true } : {}) }));
    if (r.status !== 0) {
      console.error(r.out.trim());
      return 1;
    }
    console.log(`Started ${this.name}: vault ${a.vault}, state ${this.stateDir}`);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const log = this.logs();
      const link = /Open:\s+(http:\/\/127\.0\.0\.1:\d+\/\?pair=\S+)/.exec(log);
      if (link) {
        console.log(log.split("\n").filter((l) => /^(Agents:|\s{8}[a-z])/.test(l)).join("\n"));
        console.log(`\nOpen:   ${link[1]}`);
        console.log("        (one-time link, valid 10 minutes; `peers pair` for a new code)");
        return 0;
      }
      if (this.containerStatus() !== "running") {
        console.error(`${this.name} stopped while starting:\n${log.slice(-1500)}`);
        return 1;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    console.error(`${this.name} did not report ready in 3 minutes; \`peers logs\` shows why.`);
    return 1;
  }

  down(): number {
    if (!this.containerStatus()) { console.log(`${this.name} is not running.`); return 0; }
    this.run(["stop", this.name], { stdio: "inherit" });
    this.run(["delete", this.name]);
    console.log(`Stopped ${this.name}. The vault and its state stay on this computer.`);
    return 0;
  }

  exec(args: string[], interactive = false): number {
    if (this.containerStatus() !== "running") { console.error(`${this.name} is not running; \`peers up\` starts it.`); return 1; }
    return this.run(["exec", ...(interactive ? ["--interactive", "--tty"] : []), this.name, ...IN_BOX, ...args], { stdio: "inherit" }).status;
  }
}

export async function runBoxCli(argv: string[], root: string): Promise<number> {
  const [sub, ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const next = rest[i + 1];
    if (["--demo", "--scripted", "--build"].includes(a) || next === undefined || next.startsWith("--")) flags.set(a.slice(2), true);
    else { flags.set(a.slice(2), next); i++; }
  }
  const str = (k: string): string | undefined => (typeof flags.get(k) === "string" ? flags.get(k) as string : undefined);
  const box = new Box({ root, ...(str("name") ? { name: str("name")! } : {}) });
  try {
    switch (sub) {
      case "up":
        return await box.up({
          vault: resolve(positional[0] ?? process.env.PEERS_VAULT ?? join(homedir(), "Peers Vault")),
          port: Number(str("port") ?? 4777),
          ...(str("origin") ? { origin: str("origin")! } : {}),
          ...(str("memory") ? { memory: str("memory")! } : {}),
          ...(str("cpus") ? { cpus: Number(str("cpus")) } : {}),
          scripted: flags.has("scripted"), demo: flags.has("demo"), rebuild: flags.has("build"),
        });
      case "down": return box.down();
      case "build": box.ensureSystem(); box.build(); return 0;
      case "status": {
        const s = box.containerStatus();
        console.log(s ? `${box.name}: ${s} (${box.image}, state in ${box.stateDir})` : `${box.name}: not created`);
        return 0;
      }
      case "logs": process.stdout.write(box.logs()); return 0;
      case "pair": return box.exec(["pair", "/vault"]);
      case "login": {
        const which = positional[0];
        if (which !== "claude" && which !== "codex") { console.error("usage: peers login claude|codex"); return 2; }
        return box.exec(["login", which], true);
      }
      default:
        console.error("usage: peers up|down|status|logs|pair|build|login");
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
