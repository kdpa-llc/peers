/**
 * Watching the vault for changes by bots, the owner's editors and sync tools (TECHNICAL.md §10).
 *
 * The watcher is an interface so tests emit changes synchronously instead of waiting on
 * `fs.watch` timing. Notifications are hints: the file tracker compares hashes and records
 * only real changes, and a startup scan catches whatever happened while Peers was not running.
 */
import { watch, type FSWatcher } from "node:fs";

export interface Watcher {
  start(onChange: (rel: string) => void): void;
  stop(): void;
}

/** Production watcher: recursive `fs.watch`, filtered to visible paths. */
export class FsWatcher implements Watcher {
  private readonly root: string;
  private handle?: FSWatcher;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(root: string) {
    this.root = root;
  }

  start(onChange: (rel: string) => void): void {
    try {
      this.handle = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).replaceAll("\\", "/");
        if (rel.endsWith(".peers-tmp")) return;
        // Hidden paths are ignored, except the layout and agent definitions in .peers/ (a
        // sync, an editor or a bot may change them).
        if (!/^\.peers\/(layout\.json|agents\/[^/]+\.json)$/.test(rel)) {
          const parts = rel.split("/");
          if (parts.slice(0, -1).some((p) => p.startsWith(".")) || (parts.at(-1)!.startsWith(".") && parts.at(-1) !== ".bot.json")) return;
        }
        clearTimeout(this.timers.get(rel));
        this.timers.set(rel, setTimeout(() => { this.timers.delete(rel); onChange(rel); }, 300));
      });
    } catch {
      // Some file systems cannot watch recursively; the periodic scan still catches changes.
    }
  }

  stop(): void {
    this.handle?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Test watcher: `emit` delivers a change at once. */
export class ManualWatcher implements Watcher {
  private listener?: (rel: string) => void;
  start(onChange: (rel: string) => void): void { this.listener = onChange; }
  stop(): void { this.listener = undefined; }
  emit(rel: string): void { this.listener?.(rel); }
}
