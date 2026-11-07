/**
 * The commands that run inside the container (or in development): `serve`, `pair`, `login`
 * (TECHNICAL.md §13, ADR 0004). On the host, `peers up` starts the container that runs them
 * (box.ts).
 *
 *   peers serve [dir] [--port 4777] [--host 0.0.0.0] [--origin https://mac.tailnet.ts.net]
 *                     [--demo] [--scripted] [--t3-bin path] [--agent-homes dir] [--state-dir dir]
 *   peers pair [dir]              a one-time pairing code for a phone or another browser
 *   peers login claude|codex      sign the agents' own Claude Code or Codex in, once
 *
 * Agents run on an embedded headless T3 (ADR 0003) with their own Claude Code and Codex
 * config folders. `--scripted` runs the demo engine instead: no T3, no model, no cost.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VaultApp } from "./app.ts";
import { mintPairingCode, PACKAGE_ROOT, VaultServer } from "./server.ts";
import { ensureVaultId, openDb, stateDirFor } from "./state.ts";
import { cleanEnv, defaultAgentHomes, resolveT3Bin } from "./t3/runtime.ts";

export function parse(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["--demo", "--scripted", "--no-watch", "--build"].includes(a)) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      flags.set(a.slice(2), true);
    }
  }
  return { positional, flags };
}

export const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export function vaultDir(positional: string[]): string {
  return resolve(positional[0] ?? process.env.PEERS_VAULT ?? join(homedir(), "Peers Vault"));
}

/** Sign the agents' own Claude Code or Codex in, in their own config folder (ADR 0003). */
export function login(argv: string[]): number {
  const { positional, flags } = parse(argv);
  const which = positional[0];
  const base = str(flags.get("agent-homes"));
  const homes = base ? { claude: join(base, "claude"), codex: join(base, "codex") } : defaultAgentHomes();
  if (which !== "claude" && which !== "codex") {
    console.error("usage: peers login claude|codex");
    return 2;
  }
  const home = homes[which];
  mkdirSync(home, { recursive: true, mode: 0o700 });
  console.log(`Signing in the agents' ${which === "claude" ? "Claude Code" : "Codex"} (kept in ${home}, separate from yours).`);
  const r = which === "claude"
    ? spawnSync("claude", ["auth", "login", "--claudeai"], { stdio: "inherit", env: cleanEnv(process.env, { CLAUDE_CONFIG_DIR: home }) })
    : spawnSync("codex", ["login", "--device-auth"], { stdio: "inherit", env: cleanEnv(process.env, { CODEX_HOME: home }) });
  if (r.error) {
    console.error(`could not run ${which}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

/** Mint a one-time pairing code for a vault this machine (or container) serves. */
export function pair(argv: string[]): number {
  const { positional, flags } = parse(argv);
  const dir = vaultDir(positional);
  if (!existsSync(join(dir, ".peers", "vault.json"))) {
    console.error(`${dir} is not a Peers vault yet; start it first`);
    return 1;
  }
  const id = ensureVaultId(dir);
  const db = openDb(join(stateDirFor(id, str(flags.get("state-dir"))), "vault.db"));
  const code = mintPairingCode(db, new Date());
  db.close();
  console.log(`Pairing code: ${code}`);
  console.log("Valid once, for 10 minutes. Open the vault's address on the device and type it in.");
  return 0;
}

/** Run the vault server in this process. */
export async function serve(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  const dir = vaultDir(positional);
  const stateOverride = str(flags.get("state-dir"));
  mkdirSync(dir, { recursive: true });
  const visible = readdirSync(dir).filter((n) => !n.startsWith("."));
  if (flags.get("demo") && visible.length === 0) {
    cpSync(join(PACKAGE_ROOT, "examples", "vault"), dir, { recursive: true });
    console.log(`Copied the demo vault into ${dir}`);
  }

  const t3Bin = str(flags.get("t3-bin")) ?? resolveT3Bin();
  const scripted = !!flags.get("scripted") || process.env.PEERS_ENGINE === "demo";
  if (!scripted && !t3Bin) {
    console.error("T3 is not installed here, so agents cannot run. Use `peers up` (the container has it), pass --t3-bin, or try --scripted for the demo.");
    return 1;
  }
  const homesBase = str(flags.get("agent-homes"));
  const homes = homesBase ? { claude: join(homesBase, "claude"), codex: join(homesBase, "codex") } : defaultAgentHomes();
  if (!scripted) console.log("Starting the agents' T3…");
  let app: VaultApp;
  try {
    app = await VaultApp.open({
      root: dir,
      ...(stateOverride ? { stateDir: stateOverride } : {}),
      engine: scripted ? "demo" : "t3",
      homes,
      ...(t3Bin ? { t3Bin } : {}),
      ...(flags.get("no-watch") ? { watcher: false as const } : {}),
      log: (l) => console.error(l),
    });
  } catch (err) {
    console.error(`Could not start the agents: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const origin = str(flags.get("origin"));
  if (origin) app.updateSettings({ origin });
  // Inside the container the server listens on the container's own interface; the host
  // publishes it on its loopback only (ADR 0004).
  const host = str(flags.get("host"));
  const server = new VaultServer(app, {
    port: Number(str(flags.get("port")) ?? process.env.PEERS_PORT ?? 4777),
    ...(origin ? { origin } : {}), ...(host ? { host } : {}),
  });
  const port = await server.listen();
  app.start();
  const code = server.createPairingCode();
  const model = app.settings.default_model;
  console.log(`\nPeers · ${dir}`);
  console.log(`State:  ${app.stateDir}`);
  console.log(`Agents: ${app.registry.list().length} (${app.demoMode() ? "DEMO MODE: scripted agents" : `embedded T3 · ${model.provider}${model.model ? ` · ${model.model}` : ""}`})`);
  if (!app.demoMode()) {
    for (const a of app.signins.status()) {
      console.log(`        ${a.provider}: ${a.signed_in ? "signed in" : "not signed in (sign in from Settings)"}`);
    }
    console.log(`        sign-ins: ${homes.claude} and ${homes.codex}`);
  }
  console.log(`\nOpen:   http://127.0.0.1:${port}/?pair=${code}`);
  console.log("        (one-time link, valid 10 minutes; run `peers pair` for a new code)");
  if (origin) console.log(`Phone:  ${origin}  (pair with \`peers pair ${JSON.stringify(dir)}\`)`);
  else console.log("Phone:  `tailscale serve --bg " + port + "`, then restart with --origin https://<mac>.<tailnet>.ts.net");

  await new Promise<void>((done) => {
    const stop = (): void => { done(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  console.log("\nStopping…");
  await server.close();
  await app.stop();
  return 0;
}
