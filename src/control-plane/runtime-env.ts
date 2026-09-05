/**
 * Injectable clock and id source. Everything time- or id-dependent goes through these so
 * the whole control plane is deterministic under test.
 */

export type Clock = { now(): Date; advance?(ms: number): void };
export type Ids = { next(prefix: string): string };

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(startIso = "2026-08-17T12:00:00.000Z"): Clock {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; },
  };
}

/** Collision-resistant ids. Required whenever state outlives the process. */
export function randomIds(): Ids {
  return {
    next: (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * Monotonic, prefix-scoped ids: repeatable across runs for stable assertions.
 *
 * Single-process use only — the counter restarts at 1 in a new process, so reusing these
 * against a persisted store collides with ids written by an earlier run. Use `randomIds`
 * for anything durable.
 */
export function sequentialIds(): Ids {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${String(n).padStart(3, "0")}`;
    },
  };
}

export const iso = (d: Date): string => d.toISOString();
