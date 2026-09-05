/**
 * Observer (ADR 0006). Consumes events and derives human-readable status. It never controls
 * execution and is never the source of truth — every line it emits is traceable to an event.
 *
 * v0 is a deterministic template over events (OBSERVABILITY_AND_UI), which keeps that
 * traceability trivially true while the event taxonomy stabilizes.
 */
import type {
  AgentEvent, Approval, Artifact, Execution, InboxItem, MemoryRecord, Task, Visibility,
} from "../domain/types.ts";
import type { Agent } from "../domain/types.ts";
import { redactForAudience } from "../control-plane/events.ts";
import type { Store } from "../control-plane/store.ts";

export type OrgRow = {
  agent_id: string;
  name: string;
  responsibility: string;
  state: string;
  objective: string;
  active_tasks: number;
  blocked: boolean;
  attention: boolean;
  last_event: string;
};

export type TimelineEntry = { time: string; text: string; event_id: string };

export type AgentDetail = {
  agent: Agent | undefined;
  status: OrgRow | undefined;
  inbox: InboxItem[];
  executions: Execution[];
  delegations: Task[];
  memories: MemoryRecord[];
  artifacts: Artifact[];
  approvals: Approval[];
  events: AgentEvent[];
};

/** Phrasing per event type. Anything unlisted falls back to the event's own summary. */
const PHRASE: Record<string, (e: AgentEvent, who: (id: string) => string) => string> = {
  "agent.created": (e, who) => `${who(e.agent_id)} created — ${e.summary ?? ""}`,
  "agent.retired": (e, who) => `${who(e.agent_id)} retired`,
  "task.created": (e, who) => `${who(e.agent_id)} received task: ${e.summary ?? ""}`,
  "task.accepted": (e, who) => `${who(e.agent_id)} accepted the task`,
  "task.completed": (e, who) => `${who(e.agent_id)} completed the task — ${e.summary ?? ""}`,
  "task.blocked": (e, who) => `${who(e.agent_id)} is blocked: ${e.summary ?? ""}`,
  "delegation.created": (e, who) => `${who(e.agent_id)} ${e.summary ?? "delegated work"}`,
  "delegation.completed": (e, who) => `${who(e.agent_id)} received worker result — ${e.summary ?? ""}`,
  "delegation.failed": (e, who) => `${who(e.agent_id)} delegation failed — ${e.summary ?? ""}`,
  "delegation.timeout": (e, who) => `${who(e.agent_id)} delegation timed out`,
  "wait.registered": (e, who) => `${who(e.agent_id)} is ${e.summary ?? "waiting"}`,
  "wait.timeout": (e, who) => `${who(e.agent_id)} stopped waiting (timed out)`,
  "memory.revised": (e, who) => `${who(e.agent_id)} recorded a learning — ${e.summary ?? ""}`,
  "memory.archived": (e, who) => `${who(e.agent_id)} archived a memory`,
  "approval.requested": (e, who) => `${who(e.agent_id)} requested approval: ${e.summary ?? ""}`,
  "approval.granted": (e) => `${e.summary ?? "approval granted"}`,
  "budget.exhausted": (e, who) => `${who(e.agent_id)} hit a budget limit — needs attention`,
  "artifact.created": (e, who) => `${who(e.agent_id)} produced ${e.summary ?? "an artifact"}`,
};

/** Event types that are execution plumbing rather than organizational signal. */
const LOW_VALUE = new Set([
  "execution.started", "execution.completed", "inbox.delivered", "inbox.processed",
  "permission.checked", "tool.invoked", "tool.completed", "task.created", "memory.proposed",
]);

export class Observer {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private nameOf(agentId: string): string {
    return this.store.getAgent(agentId)?.name ?? agentId;
  }

  /** Organization view (OBSERVABILITY_AND_UI). */
  organization(): OrgRow[] {
    return this.store.listAgents().map((a) => {
      const events = this.store.events({ agentId: a.agent_id });
      const tasks = this.store.listTasks().filter((t) => t.recipient_id === a.agent_id);
      const active = tasks.filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
      const current = active[active.length - 1] ?? tasks[tasks.length - 1];
      const pendingApproval = this.store.listApprovals()
        .some((ap) => ap.requested_by_agent_id === a.agent_id && ap.status === "pending");
      const last = events[events.length - 1];
      return {
        agent_id: a.agent_id,
        name: a.name,
        responsibility: a.responsibility,
        state: a.runtime_state ?? "IDLE",
        objective: current?.objective ?? "—",
        active_tasks: active.length,
        blocked: a.runtime_state === "BLOCKED",
        attention: a.runtime_state === "BLOCKED" || pendingApproval,
        last_event: last ? `${last.event_type}: ${last.summary ?? ""}` : "—",
      };
    });
  }

  /**
   * Normalized timeline that hides low-value token noise. Every entry carries the event id
   * it came from, so any claim can be traced back (ADR 0006).
   */
  timeline(opts: { limit?: number; audience?: Visibility; includeAll?: boolean } = {}): TimelineEntry[] {
    const audience = opts.audience ?? "user";
    const who = (id: string): string => this.nameOf(id);
    const out: TimelineEntry[] = [];
    for (const raw of this.store.events()) {
      if (!opts.includeAll && LOW_VALUE.has(raw.event_type)) continue;
      const e = redactForAudience(raw, audience);
      const phrase = PHRASE[e.event_type];
      const text = phrase ? phrase(e, who) : `${e.event_type}: ${e.summary ?? ""}`;
      out.push({ time: e.timestamp.slice(11, 19), text, event_id: e.event_id });
    }
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  /** Everything the agent-detail view needs, derived from stored state and events. */
  agentDetail(agentId: string): AgentDetail {
    return {
      agent: this.store.getAgent(agentId),
      status: this.organization().find((r) => r.agent_id === agentId),
      inbox: this.store.inboxFor(agentId),
      executions: this.store.listExecutions(agentId),
      delegations: this.store.listTasks().filter((t) => t.sender_id === agentId && !!t.delegation),
      memories: this.store.activeMemories(agentId),
      artifacts: this.store.listArtifacts().filter((a) => a.created_by_agent_id === agentId),
      approvals: this.store.listApprovals().filter((a) => a.requested_by_agent_id === agentId),
      events: this.store.events({ agentId }),
    };
  }

  /** Blockers needing human attention, for the "where is attention required" question. */
  attentionNeeded(): { agent_id: string; reason: string }[] {
    const out: { agent_id: string; reason: string }[] = [];
    for (const row of this.organization()) {
      if (row.blocked) out.push({ agent_id: row.agent_id, reason: "blocked — budget or blocker" });
    }
    for (const a of this.store.listApprovals()) {
      if (a.status === "pending") {
        out.push({ agent_id: a.requested_by_agent_id, reason: `awaiting approval: ${a.action}` });
      }
    }
    return out;
  }
}
