/**
 * Signing the bots' own Claude Code and Codex in from the app (ADR 0003, ADR 0004).
 *
 * The logins run where the bots run (inside the container, or in-process in development), in the bots'
 * config folders. Claude prints a link and waits for the code the owner pastes back; Codex
 * prints a link and a device code and waits until the owner enters it. Peers relays both to
 * Settings and never stores or logs them.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Provider } from "./engine.ts";
import { cleanEnv, type AgentHomes } from "./t3/runtime.ts";

export type SignInState = {
  provider: Provider;
  signed_in: boolean;
  /** A login in progress, or how the last one ended. */
  login?: { status: "starting" | "waiting" | "done" | "failed"; url?: string; code?: string; needs_code?: boolean; message?: string };
};

type Login = { child: ChildProcess; state: NonNullable<SignInState["login"]>; output: string };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function parseLoginOutput(provider: Provider, text: string): { url?: string; code?: string } {
  const clean = text.replace(ANSI, "");
  const urls = clean.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  // Claude's sign-in link is the long OAuth URL; Codex prints its device page.
  const url = provider === "claude"
    ? urls.find((u) => /oauth|authorize|claude\.(ai|com)/.test(u)) ?? urls[0]
    : urls.find((u) => /device|auth\.openai|chatgpt/.test(u)) ?? urls[0];
  const code = provider === "codex" ? /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(clean)?.[1] : undefined;
  return { ...(url ? { url: url.replace(/[).,]+$/, "") } : {}), ...(code ? { code } : {}) };
}

export class SignIns {
  private readonly homes: AgentHomes;
  private readonly logins = new Map<Provider, Login>();
  private readonly last = new Map<Provider, SignInState["login"]>();
  private readonly changed: () => void;

  constructor(homes: AgentHomes, onChange: () => void = () => {}) {
    this.homes = homes;
    this.changed = onChange;
  }

  private env(provider: Provider): NodeJS.ProcessEnv {
    const home = this.homes[provider];
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return cleanEnv(process.env, provider === "claude"
      ? { CLAUDE_CONFIG_DIR: home, BROWSER: "/usr/bin/true" }
      : { CODEX_HOME: home, BROWSER: "/usr/bin/true" });
  }

  private readonly cache = new Map<Provider, { at: number; value: boolean }>();

  signedIn(provider: Provider): boolean {
    const hit = this.cache.get(provider);
    if (hit && Date.now() - hit.at < 15_000 && !this.logins.has(provider)) return hit.value;
    const value = this.check(provider);
    this.cache.set(provider, { at: Date.now(), value });
    return value;
  }

  private check(provider: Provider): boolean {
    try {
      if (provider === "claude") {
        const r = spawnSync("claude", ["auth", "status"], { env: this.env("claude"), encoding: "utf8", timeout: 20_000 });
        return (JSON.parse(r.stdout || "{}") as { loggedIn?: boolean }).loggedIn === true;
      }
      const r = spawnSync("codex", ["login", "status"], { env: this.env("codex"), encoding: "utf8", timeout: 20_000 });
      return r.status === 0 && /logged in/i.test(`${r.stdout}${r.stderr}`) && !/not logged in/i.test(`${r.stdout}${r.stderr}`);
    } catch {
      return false;
    }
  }

  status(): SignInState[] {
    return (["claude", "codex"] as Provider[]).map((p) => {
      const login = this.logins.get(p)?.state ?? this.last.get(p);
      return { provider: p, signed_in: this.signedIn(p), ...(login ? { login } : {}) };
    });
  }

  /** Start a login. Resolves once the link (and Codex's code) is known, or after 20 s. */
  async start(provider: Provider): Promise<SignInState["login"]> {
    this.logins.get(provider)?.child.kill("SIGTERM");
    const args = provider === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"];
    const child = spawn(provider === "claude" ? "claude" : "codex", args, { env: this.env(provider), stdio: ["pipe", "pipe", "pipe"] });
    const login: Login = { child, state: { status: "starting", needs_code: provider === "claude" }, output: "" };
    this.logins.set(provider, login);
    const onData = (d: Buffer): void => {
      login.output = (login.output + d.toString()).slice(-8000);
      const found = parseLoginOutput(provider, login.output);
      if (found.url && login.state.status === "starting" && (provider === "claude" || found.code)) {
        login.state = { ...login.state, status: "waiting", ...found };
        this.changed();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      login.state = { status: "failed", message: `could not run ${provider === "claude" ? "claude" : "codex"}: ${err.message}` };
    });
    child.on("exit", (code) => {
      if (this.logins.get(provider) !== login) return;
      this.logins.delete(provider);
      const tail = login.output.replace(ANSI, "").trim().split("\n").filter(Boolean).pop() ?? "";
      const state: SignInState["login"] = code === 0
        ? { status: "done" }
        : { status: "failed", message: /https?:\/\//.test(tail) ? "the sign-in did not finish" : tail.slice(0, 200) || "the sign-in did not finish" };
      this.last.set(provider, state);
      this.cache.delete(provider);
      this.changed();
    });
    const deadline = Date.now() + 20_000;
    while (login.state.status === "starting" && Date.now() < deadline && this.logins.get(provider) === login) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.logins.get(provider)?.state ?? this.last.get(provider);
  }

  /** Claude only: the code from the sign-in page. */
  submit(provider: Provider, code: string): boolean {
    const login = this.logins.get(provider);
    if (!login || !login.state.needs_code || !login.child.stdin?.writable) return false;
    const clean = code.trim();
    if (!clean || clean.length > 500 || /\s/.test(clean)) return false;
    login.child.stdin.write(`${clean}\n`);
    login.state = { ...login.state, needs_code: false, message: "checking the code" };
    this.changed();
    return true;
  }

  cancel(provider: Provider): void {
    this.logins.get(provider)?.child.kill("SIGTERM");
  }

  stop(): void {
    for (const l of this.logins.values()) l.child.kill("SIGTERM");
  }
}
