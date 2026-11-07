/**
 * Deterministic vault fixtures: a temporary folder, a fixed clock, no file watcher, and the
 * demo engine with no delay, so a test drives every run itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VaultApp } from "../src/vault/app.ts";
import { DemoEngine } from "../src/vault/engine.ts";
import { ManualWatcher } from "../src/vault/watch.ts";

/** A clock that stands still until a test moves it. */
export function fixedClock(startIso: string): { now(): Date; advance(ms: number): void } {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

export const BASE_FILES: Record<string, string> = {
  "Projects/Alpha/Plan.md": "# Plan\n\nShip on March 14.\n\n- [ ] Write copy\n- [ ] Test on phones\n",
  "Projects/Beta/Notes.md": "# Notes\n\nBeta notes.\n",
  "Areas/Finances/Budget.md": "# Budget\n\nKitchen fund: $9,000.\n",
  "Inbox/Clip.md": "# Clip\n\nSome clipped text.\n",
  "Resources/Ref.md": "# Ref\n",
  "Welcome.md": "# Welcome\n",
};

export type Fixture = {
  app: VaultApp;
  engine: DemoEngine;
  root: string;
  state: string;
  watcher: ManualWatcher;
  clock: ReturnType<typeof fixedClock>;
  /** Let every scripted run finish, then let the app see what changed. */
  settle(): Promise<void>;
  close(): Promise<void>;
};

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export async function makeVault(opts: { files?: Record<string, string>; start?: string } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "peers-vault-test-"));
  const root = join(dir, "vault");
  const state = join(dir, "state");
  writeFiles(root, opts.files ?? BASE_FILES);
  const clock = fixedClock(opts.start ?? "2026-11-06T10:00:00.000Z");
  const watcher = new ManualWatcher();
  const engine = new DemoEngine({ vaultRoot: root, delayMs: 0, now: () => clock.now() });
  const app = await VaultApp.open({ root, stateDir: state, clock, engine, watcher });
  app.startWatching();
  return {
    app, engine, root, state, watcher, clock,
    async settle() {
      await engine.idle();
      app.scan();
    },
    async close() {
      await app.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function botFor(app: VaultApp, folder: string): string {
  const bot = app.registry.byPath(folder);
  if (!bot) throw new Error(`no bot for ${folder}`);
  return bot.def.id;
}
