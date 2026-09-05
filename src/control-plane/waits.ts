/**
 * Wait conditions (ADR 0007). Every wait carries a mandatory timeout; waits are cancelled
 * when their owning task reaches a terminal state. A timed-out wait wakes its agent with a
 * `timeout` outcome, keeping the semantic decision with the agent (ADR 0002).
 */
import type { WaitCondition, WaitKind } from "../domain/types.ts";
import type { Store } from "./store.ts";
import type { Clock, Ids } from "./runtime-env.ts";
import { iso } from "./runtime-env.ts";
import type { EventLog } from "./events.ts";

export class Waits {
  private readonly store: Store;
  private readonly events: EventLog;
  private readonly clock: Clock;
  private readonly ids: Ids;

  constructor(store: Store, events: EventLog, clock: Clock, ids: Ids) {
    this.store = store;
    this.events = events;
    this.clock = clock;
    this.ids = ids;
  }

  register(args: {
    agent_id: string;
    task_id?: string;
    kind: WaitKind;
    predicate?: Record<string, unknown>;
    timeout_seconds: number;
    on_timeout?: "wake_with_timeout" | "cancel";
    correlation_id?: string;
  }): WaitCondition {
    if (!Number.isFinite(args.timeout_seconds) || args.timeout_seconds <= 0) {
      throw new Error("wait requires a positive timeout_seconds (ADR 0007)");
    }
    const now = this.clock.now();
    const wait: WaitCondition = {
      wait_id: this.ids.next("wait"),
      agent_id: args.agent_id,
      task_id: args.task_id,
      kind: args.kind,
      predicate: args.predicate,
      timeout_seconds: args.timeout_seconds,
      on_timeout: args.on_timeout ?? "wake_with_timeout",
      status: "active",
      created_at: iso(now),
    };
    const timeoutAt = iso(new Date(now.getTime() + args.timeout_seconds * 1000));
    this.store.putWait(wait, timeoutAt);
    this.events.emit({
      type: "wait.registered",
      agent_id: args.agent_id,
      task_id: args.task_id,
      correlation_id: args.correlation_id,
      summary: `waiting on ${args.kind} (timeout ${args.timeout_seconds}s)`,
      payload: { wait_id: wait.wait_id, kind: args.kind, predicate: args.predicate },
    });
    return wait;
  }

  private resolve(
    wait: WaitCondition,
    status: "satisfied" | "timeout" | "cancelled",
    type: string,
  ): void {
    wait.status = status;
    wait.resolved_at = iso(this.clock.now());
    const timeoutAt = iso(new Date(new Date(wait.created_at).getTime() + wait.timeout_seconds * 1000));
    this.store.putWait(wait, timeoutAt);
    this.events.emit({
      type,
      agent_id: wait.agent_id,
      task_id: wait.task_id,
      summary: `wait ${wait.wait_id} ${status}`,
      payload: { wait_id: wait.wait_id, kind: wait.kind },
    });
  }

  /** Satisfy every active wait whose predicate matches. Returns the agents to wake. */
  satisfy(kind: WaitKind, matcher: (predicate: Record<string, unknown>) => boolean): WaitCondition[] {
    const woken: WaitCondition[] = [];
    for (const { wait } of this.store.activeWaits()) {
      if (wait.kind !== kind) continue;
      if (!matcher(wait.predicate ?? {})) continue;
      this.resolve(wait, "satisfied", "wait.satisfied");
      woken.push(wait);
    }
    return woken;
  }

  /** Cancel every wait owned by a task that has reached a terminal state. */
  cancelForTask(taskId: string): void {
    for (const wait of this.store.waitsForTask(taskId)) {
      if (wait.status !== "active") continue;
      this.resolve(wait, "cancelled", "wait.cancelled");
    }
  }

  cancel(waitId: string): void {
    const wait = this.store.getWait(waitId);
    if (!wait || wait.status !== "active") return;
    this.resolve(wait, "cancelled", "wait.cancelled");
  }

  /** Waits whose deadline has passed. The scheduler wakes their agents. */
  sweepTimeouts(): WaitCondition[] {
    const now = this.clock.now().getTime();
    const fired: WaitCondition[] = [];
    for (const { wait, timeout_at } of this.store.activeWaits()) {
      if (new Date(timeout_at).getTime() > now) continue;
      this.resolve(wait, "timeout", "wait.timeout");
      if (wait.on_timeout !== "cancel") fired.push(wait);
    }
    return fired;
  }
}
