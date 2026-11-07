/**
 * One small store. Panes subscribe to the keys they render and patch their own DOM, so a
 * change to the chat never re-renders the page.
 */

export type Listener<S> = (state: S, changed: Set<keyof S>) => void;

export class Store<S extends Record<string, unknown>> {
  private state: S;
  private readonly listeners: { keys: Set<keyof S> | null; fn: Listener<S> }[] = [];
  private pending = new Set<keyof S>();
  private scheduled = false;

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S { return this.state; }

  set(patch: Partial<S> | ((s: S) => Partial<S>)): void {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const [k, v] of Object.entries(next) as [keyof S, unknown][]) {
      if (this.state[k] !== v) {
        changed = true;
        this.pending.add(k);
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...next };
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const changed = this.pending;
    this.pending = new Set();
    for (const l of [...this.listeners]) {
      if (!l.keys || [...changed].some((k) => l.keys!.has(k))) l.fn(this.state, changed);
    }
  }

  on(keys: (keyof S)[] | null, fn: Listener<S>): () => void {
    const entry = { keys: keys ? new Set(keys) : null, fn };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}
