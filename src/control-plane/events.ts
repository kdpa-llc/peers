/**
 * Append-only event log (ADR 0006). Observers, the UI, and audit read from here; nothing
 * derives truth from model transcripts.
 *
 * Event types are validated against the registry in docs/specs/EVENT_TYPES.md so a typo
 * cannot silently create a new type (ADR 0011).
 */
import type { AgentEvent, Usage, Visibility } from "../domain/types.ts";
import type { Store } from "./store.ts";
import type { Clock, Ids } from "./runtime-env.ts";
import { iso } from "./runtime-env.ts";

/** Mirrors docs/specs/EVENT_TYPES.md. Kept in sync by tests/contracts/events.test.ts. */
export const EVENT_TYPES = new Set<string>([
  "agent.created", "agent.updated", "agent.paused", "agent.retired",
  "execution.started", "execution.completed", "execution.failed", "execution.retried",
  "task.created", "task.accepted", "task.completed", "task.failed", "task.cancelled", "task.blocked",
  "inbox.delivered", "inbox.processed",
  "delegation.created", "delegation.completed", "delegation.failed", "delegation.timeout",
  "wait.registered", "wait.satisfied", "wait.timeout", "wait.cancelled",
  "tool.invoked", "tool.completed", "tool.failed",
  "artifact.created",
  "permission.requested", "permission.checked", "permission.approved", "permission.denied",
  "approval.requested", "approval.granted", "approval.denied",
  "memory.proposed", "memory.revised", "memory.archived",
  "budget.warning", "budget.exhausted",
  "user.intervened",
]);

export type EmitInput = {
  type: string;
  agent_id: string;
  execution_id?: string;
  task_id?: string;
  correlation_id?: string;
  causation_id?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  usage?: Usage;
  visibility?: Visibility;
};

export class EventLog {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly ids: Ids;

  constructor(store: Store, clock: Clock, ids: Ids) {
    this.store = store;
    this.clock = clock;
    this.ids = ids;
  }

  emit(input: EmitInput): AgentEvent {
    if (!EVENT_TYPES.has(input.type)) {
      throw new Error(
        `unregistered event_type '${input.type}' — add it to docs/specs/EVENT_TYPES.md and EVENT_TYPES`,
      );
    }
    const event: AgentEvent = {
      event_id: this.ids.next("evt"),
      event_type: input.type,
      timestamp: iso(this.clock.now()),
      agent_id: input.agent_id,
      execution_id: input.execution_id,
      task_id: input.task_id,
      correlation_id: input.correlation_id,
      causation_id: input.causation_id,
      summary: input.summary,
      payload: input.payload,
      usage: input.usage,
      visibility: input.visibility ?? "internal",
    };
    this.store.appendEvent(event);
    return event;
  }

  since(seq: number): AgentEvent[] { return this.store.events({ sinceSeq: seq }); }
  all(): AgentEvent[] { return this.store.events(); }
  forAgent(agentId: string): AgentEvent[] { return this.store.events({ agentId }); }
}

/**
 * Payload redaction by visibility (SECURITY_AND_PERMISSIONS). Audit keeps the full payload;
 * anything shown to users or peers is summarized. Applied at read time by the observer/UI
 * so the audit record stays complete.
 */
export function redactForAudience(e: AgentEvent, audience: Visibility): AgentEvent {
  if (audience === "audit") return e;
  if ((e.visibility ?? "internal") === "audit") {
    return { ...e, payload: { redacted: true, reason: "audit-only payload" } };
  }
  return e;
}
