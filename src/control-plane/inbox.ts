/**
 * Unified inbox delivery (ADR 0010).
 *
 * One envelope for every delivery. For `kind: task` the Task is authoritative and the
 * envelope's routing fields are derived copies — this module is the single write boundary
 * that derives them, so the equality invariant (CONTRACT_TESTS #1) cannot be violated by
 * a caller passing conflicting values.
 */
import type { InboxItem, InboxKind, Provenance, Task, WorkerResult } from "../domain/types.ts";
import type { Store } from "./store.ts";
import type { Clock, Ids } from "./runtime-env.ts";
import { iso } from "./runtime-env.ts";
import type { EventLog } from "./events.ts";

export type DeliverBase = {
  sender_id: string;
  recipient_id: string;
  correlation_id?: string;
  causation_id?: string;
  priority?: number;
  deadline?: string;
  provenance?: Provenance;
};

export class Inbox {
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

  /**
   * Deliver a Task. Routing fields are derived from the Task itself — callers do not get
   * to set them independently, which is how the equality invariant is guaranteed rather
   * than merely asserted.
   */
  deliverTask(task: Task, opts: { causation_id?: string; provenance?: Provenance } = {}): InboxItem {
    return this.write({
      kind: "task",
      sender_id: task.sender_id,
      recipient_id: task.recipient_id,
      correlation_id: task.correlation_id,
      causation_id: opts.causation_id,
      priority: task.priority ?? 0,
      deadline: task.deadline,
      provenance: opts.provenance,
      payload: task as unknown as Record<string, unknown>,
      task_id: task.task_id,
    });
  }

  /**
   * Deliver the single terminal result for a delegated task (ADR 0007).
   * Rejects a second terminal result for the same task (CONTRACT_TESTS #3).
   */
  deliverDelegationResult(base: DeliverBase, result: WorkerResult): InboxItem {
    if (this.store.countDelegationResults(result.task_id) > 0) {
      throw new Error(
        `delegation result already delivered for task ${result.task_id}; ` +
        "exactly one terminal result is permitted (ADR 0007)",
      );
    }
    return this.write({
      ...base,
      kind: "delegation_result",
      payload: result as unknown as Record<string, unknown>,
      task_id: result.task_id,
    });
  }

  deliverMessage(base: DeliverBase, body: string): InboxItem {
    return this.write({ ...base, kind: "message", payload: { body } });
  }

  deliverNotification(base: DeliverBase, payload: Record<string, unknown>): InboxItem {
    return this.write({ ...base, kind: "notification", payload });
  }

  deliverMaintenance(base: DeliverBase, payload: Record<string, unknown>): InboxItem {
    return this.write({ ...base, kind: "maintenance", payload });
  }

  private write(
    args: DeliverBase & { kind: InboxKind; payload: Record<string, unknown>; task_id?: string },
  ): InboxItem {
    const item: InboxItem = {
      item_id: this.ids.next("inbox"),
      sender_id: args.sender_id,
      recipient_id: args.recipient_id,
      kind: args.kind,
      correlation_id: args.correlation_id,
      causation_id: args.causation_id,
      priority: args.priority ?? 0,
      deadline: args.deadline,
      created_at: iso(this.clock.now()),
      payload: args.payload,
      provenance: args.provenance,
    };
    this.store.putInboxItem(item);
    this.events.emit({
      type: "inbox.delivered",
      agent_id: args.recipient_id,
      task_id: args.task_id,
      correlation_id: item.correlation_id,
      causation_id: item.causation_id,
      summary: `${args.kind} from ${args.sender_id}`,
      payload: { item_id: item.item_id, kind: args.kind },
    });
    return item;
  }

  markProcessed(itemId: string, agentId: string): void {
    const item = this.store.getInboxItem(itemId);
    if (!item) return;
    item.processed_at = iso(this.clock.now());
    this.store.putInboxItem(item);
    this.events.emit({
      type: "inbox.processed",
      agent_id: agentId,
      correlation_id: item.correlation_id,
      summary: `processed ${item.kind} ${item.item_id}`,
      payload: { item_id: item.item_id },
    });
  }

  pending(agentId: string): InboxItem[] { return this.store.pendingInbox(agentId); }

  /**
   * Verifies the envelope's routing copies still agree with the Task payload.
   * The write path derives them, so this is a defensive audit used by contract tests and
   * by the CLI when inspecting stored state.
   */
  static routingMatchesTask(item: InboxItem): { ok: boolean; field?: string } {
    if (item.kind !== "task") return { ok: true };
    const t = item.payload as unknown as Task;
    const pairs: [string, unknown, unknown][] = [
      ["sender_id", item.sender_id, t.sender_id],
      ["recipient_id", item.recipient_id, t.recipient_id],
      ["correlation_id", item.correlation_id, t.correlation_id],
      ["priority", item.priority ?? 0, t.priority ?? 0],
      ["deadline", item.deadline, t.deadline],
    ];
    for (const [field, envelope, task] of pairs) {
      if (envelope === undefined && task === undefined) continue;
      if (envelope !== task) return { ok: false, field };
    }
    return { ok: true };
  }
}
