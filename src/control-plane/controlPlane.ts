/**
 * Control plane composition root.
 *
 * Owns mechanics and guardrails only (Constitution §3). It decides *when* an agent may run
 * (ADR 0002) and whether each requested action is authorized — never what the agent should
 * want. There is deliberately no branch anywhere in this file on a specific agent id or on
 * task text: no hard-coded orchestration graph.
 */
import type {
  Agent, AgentAction, Approval, Artifact, Delegation, Execution, InboxItem,
  MemoryProposal, ModelConfig, Permission, Provenance, Task, TriggerType, Usage, WorkerResult,
} from "../domain/types.ts";
import { TERMINAL_TASK_STATUSES } from "../domain/types.ts";

/** Sandbox lifetime for an execution with no delegation budget to inherit one from. */
const DEFAULT_SANDBOX_TIMEOUT_S = 300;

/**
 * Pre-call reservation used when the provider cannot quote the next response in advance.
 * It is deliberately conservative for normal calls, but it is still an estimate: one
 * unusually expensive response may cross a ceiling. The post-call gate records actual
 * usage and refuses that response's actions and tools when this happens.
 */
const MODEL_CALL_COST_RESERVATION_USD = 0.02;

/** Artifacts come out of the sandbox, so their bytes are never platform-controlled. */
const UNTRUSTED_ARTIFACT: Provenance = {
  source: "untrusted_content",
  detail: "collected from the execution sandbox",
};
import { Store } from "./store.ts";
import { EventLog } from "./events.ts";
import { Inbox } from "./inbox.ts";
import { Waits } from "./waits.ts";
import { MemoryService } from "./memory.ts";
import { ContextBuilder, DEFAULT_BUDGET } from "./context.ts";
import { Budgets, type BudgetLimits, addUsage, ZERO_USAGE } from "./budgets.ts";
import * as perms from "./permissions.ts";
import { iso, sequentialIds, systemClock, type Clock, type Ids } from "./runtime-env.ts";
import type { AgentRuntime } from "../data-plane/runtime.ts";

export type ControlPlaneOptions = {
  store?: Store;
  clock?: Clock;
  ids?: Ids;
  budgets?: BudgetLimits;
  /** Directory made available to worker sandboxes. */
  workspaceRoot?: string;
};

export type EligibleReason =
  | { type: "inbox"; item: InboxItem }
  | { type: "wait"; wait_id: string }
  | { type: "human"; note?: string };

type DispatchContext = {
  agent: Agent;
  task?: Task;
  execution: Execution;
  grants: Permission[];
  correlation_id?: string;
  causation_id?: string;
  artifacts: Artifact[];
  /** Set when this execution read sandbox output; see RuntimeOutcome.read_untrusted. */
  read_untrusted?: boolean;
};

/**
 * Provenance for records derived from an execution that read untrusted content
 * (CONTRACT_TESTS #19). Deliberately computed by the control plane rather than taken from
 * the agent: an agent that has just read attacker-controlled text is the last thing that
 * should get to declare its own output trusted.
 */
function provenanceFor(ctx: DispatchContext): Provenance | undefined {
  if (!ctx.read_untrusted) return undefined;
  return {
    source: "untrusted_content",
    detail: `derived from sandbox output read during ${ctx.execution.execution_id}`,
  };
}

export class ControlPlane {
  readonly store: Store;
  readonly events: EventLog;
  readonly inbox: Inbox;
  readonly waits: Waits;
  readonly memory: MemoryService;
  readonly context: ContextBuilder;
  readonly budgets: Budgets;
  private readonly runtime: AgentRuntime;
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly workspaceRoot: string;
  /** Agents queued for a human/wait-driven run that has no inbox item. */
  private readonly forced = new Map<string, EligibleReason>();

  constructor(runtime: AgentRuntime, opts: ControlPlaneOptions = {}) {
    this.runtime = runtime;
    this.store = opts.store ?? new Store();
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.ids ?? sequentialIds();
    this.events = new EventLog(this.store, this.clock, this.ids);
    this.inbox = new Inbox(this.store, this.events, this.clock, this.ids);
    this.waits = new Waits(this.store, this.events, this.clock, this.ids);
    this.memory = new MemoryService(this.store, this.events, this.clock, this.ids);
    this.context = new ContextBuilder(this.store, this.memory, {
      ...DEFAULT_BUDGET,
      window: runtime.contextWindow,
    });
    this.budgets = new Budgets(this.store, opts.budgets ?? {});
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
  }

  // ------------------------------------------------------------------ registry

  createAgent(
    spec: Omit<Agent, "created_at" | "revision" | "lifecycle_state"> &
      Partial<Pick<Agent, "lifecycle_state">>,
    opts: { ephemeral?: boolean } = {},
  ): Agent {
    const agent: Agent = {
      ...spec,
      lifecycle_state: spec.lifecycle_state ?? "active",
      created_at: iso(this.clock.now()),
      revision: 1,
      runtime_state: "IDLE",
    };
    this.store.putAgent(agent, opts.ephemeral ?? false);
    this.events.emit({
      type: "agent.created",
      agent_id: agent.agent_id,
      summary: `${agent.name}: ${agent.responsibility}`,
      payload: { ephemeral: opts.ephemeral ?? false },
      visibility: "organization",
    });
    return agent;
  }

  /**
   * Change which model an agent thinks with (ADR 0017).
   *
   * This is a change to the agent's durable definition, so it bumps `revision` and is
   * announced like any other definitional change — an operator moving a reviewer onto a
   * deeper thinking level should be visible in the timeline, not a silent config edit.
   */
  setAgentModel(agentId: string, config: ModelConfig | undefined): Agent {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`no such agent: ${agentId}`);
    const updated: Agent = { ...agent, model_config: config, revision: agent.revision + 1 };
    this.store.putAgent(updated, this.store.isEphemeral(agentId));
    this.events.emit({
      type: "agent.updated",
      agent_id: agentId,
      summary: config
        ? `model set to ${config.provider ?? "default"}${config.model ? `/${config.model}` : ""}` +
          `${config.thinking ? ` thinking=${config.thinking}` : ""}`
        : "model reset to the organization default",
      payload: { model_config: config, revision: updated.revision },
      visibility: "organization",
    });
    return updated;
  }

  getAgent(id: string): Agent {
    const a = this.store.getAgent(id);
    if (!a) throw new Error(`unknown agent '${id}'`);
    return a;
  }

  // ------------------------------------------------------------------ tasks

  /** Create and deliver a task. Routing fields are derived by the inbox (ADR 0010). */
  assignTask(args: {
    sender_id: string;
    recipient_id: string;
    objective: string;
    expected_output?: string;
    constraints?: string[];
    priority?: number;
    deadline?: string;
    correlation_id?: string;
    parent_task_id?: string;
    delegation?: Delegation;
    context_refs?: string[];
  }): Task {
    const now = iso(this.clock.now());
    const task: Task = {
      task_id: this.ids.next("task"),
      parent_task_id: args.parent_task_id,
      sender_id: args.sender_id,
      recipient_id: args.recipient_id,
      objective: args.objective,
      expected_output: args.expected_output,
      constraints: args.constraints,
      context_refs: args.context_refs,
      priority: args.priority ?? 0,
      deadline: args.deadline,
      correlation_id: args.correlation_id ?? this.ids.next("corr"),
      status: "queued",
      created_at: now,
      updated_at: now,
      delegation: args.delegation,
    };
    this.store.putTask(task);
    this.events.emit({
      type: "task.created",
      agent_id: args.recipient_id,
      task_id: task.task_id,
      correlation_id: task.correlation_id,
      summary: task.objective,
      payload: { sender: task.sender_id, delegated: !!task.delegation },
      visibility: "organization",
    });
    this.inbox.deliverTask(task);
    return task;
  }

  private setTaskStatus(taskId: string, status: Task["status"], summary: string): Task | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return task; // terminal is final
    task.status = status;
    task.updated_at = iso(this.clock.now());
    this.store.putTask(task);

    const typeByStatus: Record<string, string> = {
      accepted: "task.accepted", completed: "task.completed", failed: "task.failed",
      cancelled: "task.cancelled", blocked: "task.blocked",
    };
    const type = typeByStatus[status];
    if (type) {
      this.events.emit({
        type,
        agent_id: task.recipient_id,
        task_id: task.task_id,
        correlation_id: task.correlation_id,
        summary,
        visibility: "organization",
      });
    }

    if (TERMINAL_TASK_STATUSES.includes(status)) {
      this.waits.cancelForTask(task.task_id);                       // CONTRACT_TESTS #9
      const woken = this.waits.satisfy("task_completed", (p) => p.task_id === task.task_id);
      for (const w of woken) this.wake(w.agent_id, { type: "wait", wait_id: w.wait_id });
    }
    return task;
  }

  // ------------------------------------------------------------------ scheduling

  /**
   * Eligibility only (ADR 0002): an agent may run when it is active, has no execution in
   * flight (ADR 0009), and something is waiting for it that matches its subscriptions.
   */
  eligible(): { agent: Agent; reason: EligibleReason }[] {
    const out: { agent: Agent; reason: EligibleReason }[] = [];
    for (const agent of this.store.listAgents({ includeEphemeral: true })) {
      if (agent.lifecycle_state !== "active") continue;
      if (this.store.runningExecutions(agent.agent_id).length > 0) continue; // ADR 0009

      const pending = this.store.pendingInbox(agent.agent_id)
        .filter((i) => this.subscribed(agent, i));
      if (pending.length > 0) {
        out.push({ agent, reason: { type: "inbox", item: pending[0]! } });
        continue;
      }
      const forced = this.forced.get(agent.agent_id);
      if (forced) out.push({ agent, reason: forced });
    }
    return out;
  }

  /** Subscription filter (ADR 0008): unmatched items are delivered but do not wake. */
  private subscribed(agent: Agent, item: InboxItem): boolean {
    const s = agent.subscriptions;
    if (!s) return true;
    if (s.kinds && !s.kinds.includes(item.kind)) return false;
    if (s.min_priority !== undefined && (item.priority ?? 0) < s.min_priority) return false;
    return true;
  }

  /** Queue an agent to run without an inbox item (human trigger, or a fired wait). */
  wake(agentId: string, reason: EligibleReason): void {
    this.forced.set(agentId, reason);
  }

  /** Run every currently eligible agent once. Returns the number of executions performed. */
  async tick(): Promise<number> {
    for (const wait of this.waits.sweepTimeouts()) {
      this.wake(wait.agent_id, { type: "wait", wait_id: wait.wait_id });
    }
    const ready = this.eligible();
    for (const { agent, reason } of ready) {
      await this.runExecution(agent.agent_id, reason);
    }
    return ready.length;
  }

  /** Drive the organization until nothing is eligible. */
  async drain(maxRounds = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  // ------------------------------------------------------------------ execution

  async runExecution(agentId: string, reason: EligibleReason): Promise<Execution> {
    const agent = this.getAgent(agentId);
    if (this.store.runningExecutions(agentId).length > 0) {
      throw new Error(`agent ${agentId} already has an execution in flight (ADR 0009)`);
    }
    this.forced.delete(agentId);

    const triggerType: TriggerType =
      reason.type === "inbox" ? "inbox" : reason.type === "wait" ? "wait" : "human";
    const triggerRef =
      reason.type === "inbox" ? reason.item.item_id
        : reason.type === "wait" ? reason.wait_id : undefined;

    const item = reason.type === "inbox" ? reason.item : undefined;
    const task = this.taskForItem(item);
    const correlation = task?.correlation_id ?? item?.correlation_id;

    const execution: Execution = {
      execution_id: this.ids.next("exec"),
      agent_id: agentId,
      trigger: { type: triggerType, ref: triggerRef },
      status: "running",
      started_at: iso(this.clock.now()),
      usage: { ...ZERO_USAGE },
    };
    this.store.putExecution(execution);
    this.store.setRuntimeState(agentId, "RUNNING");
    const startEvent = this.events.emit({
      type: "execution.started",
      agent_id: agentId,
      execution_id: execution.execution_id,
      task_id: task?.task_id,
      correlation_id: correlation,
      summary: `triggered by ${triggerType}`,
      visibility: "organization",
    });

    const grants = this.effectiveGrants(agent, task);
    const modelInvoke = perms.check(grants, { kind: "model.invoke" });
    if (!modelInvoke.allowed) {
      this.events.emit({
        type: "permission.denied",
        agent_id: agentId,
        execution_id: execution.execution_id,
        task_id: task?.task_id,
        correlation_id: correlation,
        summary: "model.invoke denied; model was not called",
        payload: { action: "model.invoke" },
        visibility: "audit",
      });
      if (item) this.inbox.markProcessed(item.item_id, agentId);
      return this.finishExecution(execution, "failed", {
        reason: "permission_denied",
        detail: "effective grants do not include model.invoke",
      }, correlation, task);
    }

    if (task && task.status === "queued") this.setTaskStatus(task.task_id, "accepted", "accepted");

    const built = this.context.build({
      agent, task, trigger: triggerType, recentEvents: 15,
      // Sized to the model this agent will actually run on, not to a single global window.
      window: this.runtime.windowFor(agent.model_config),
    });
    execution.context_manifest = built.manifest;
    this.store.putExecution(execution);

    try {
      const today = iso(this.clock.now()).slice(0, 10);
      // Grants combine as authority alternatives: any unbounded model.invoke grant makes
      // the grant-level token authority unbounded; otherwise the broadest explicit grant
      // wins. A delegation ceiling remains an independent upper bound.
      const grantTokenLimit = perms.broadestGrantCeiling(
        grants,
        "model.invoke",
        "max_tokens_per_execution",
      );
      const tokenLimits = [grantTokenLimit, task?.delegation?.budget.max_tokens]
        .filter((limit): limit is number => limit !== undefined);
      const modelTokenLimit = tokenLimits.length > 0 ? Math.min(...tokenLimits) : undefined;
      const budgetVerdict = (pending: Usage, reservation: Usage) => {
        const verdict = this.budgets.check(agent, pending, reservation, today, {
          grants,
          delegation: task?.delegation?.budget,
          current_execution_id: execution.execution_id,
        });
        return verdict.ok
          ? verdict
          : {
              ok: false as const,
              detail: `${verdict.scope} limit ${verdict.limit} ${verdict.unit} reached ` +
                `(projected/spent ${verdict.spent} ${verdict.unit})`,
            };
      };
      const outcome = await this.runtime.runExecution({
        execution_id: execution.execution_id,
        context: built,
        grants,
        correlation_id: correlation,
        // Read from the agent's own record, exactly as its permissions are. The control
        // plane still knows nothing about which agent should use which model.
        model_config: agent.model_config,
        model_token_limit: modelTokenLimit,
        model_call_budget: {
          before: (pending) => budgetVerdict(pending, {
            // The built context is the best available input-token estimate. Tool results on
            // later turns can increase it, so the actual post-call check remains decisive.
            input_tokens: built.total_tokens,
            output_tokens: 1,
            cost_usd: MODEL_CALL_COST_RESERVATION_USD,
          }),
          after: (actual) => {
            // Persist provider-reported usage before deciding whether its response may act.
            // Budget queries exclude this row and add `actual`, preventing double counting.
            execution.usage = { ...actual };
            this.store.putExecution(execution);
            return budgetVerdict(actual, ZERO_USAGE);
          },
        },
        // Provisioned on the grant, not on the role. The runtime's contract has always been
        // "workers always; managers only if granted", but this branched on whether the task
        // was delegated, so a manager holding sandbox.create still could not run a single
        // command. Branching on role here is also exactly what the control plane is not
        // supposed to do.
        sandbox: perms.check(grants, { kind: "sandbox.create" }).allowed
          ? {
              mounts: [{ source: this.workspaceRoot, target: "workspace" }],
              timeout_seconds: task?.delegation?.budget.timeout_seconds ?? DEFAULT_SANDBOX_TIMEOUT_S,
            }
          : undefined,
      });

      // Runtime usage is cumulative, not a delta; callbacks may already have persisted it.
      execution.usage = { ...outcome.usage };
      this.store.putExecution(execution);

      if (outcome.budget_exhausted) {
        if (item) this.inbox.markProcessed(item.item_id, agentId);
        return this.finishExecution(execution, "failed", {
          reason: "budget_exhausted",
          detail: outcome.budget_exhausted,
        }, correlation, task);
      }

      for (const artifact of outcome.artifacts) {
        // Collected from the sandbox, so its bytes are untrusted regardless of what else
        // the execution did.
        this.recordArtifact(
          { ...artifact, provenance: artifact.provenance ?? UNTRUSTED_ARTIFACT },
          agentId, execution.execution_id, correlation,
        );
      }

      for (const action of outcome.actions) {
        await this.dispatch(action, {
          agent, task, execution, grants,
          correlation_id: correlation,
          causation_id: startEvent.event_id,
          artifacts: outcome.artifacts,
          read_untrusted: outcome.read_untrusted,
        });
      }

      if (item) this.inbox.markProcessed(item.item_id, agentId);
      return this.finishExecution(execution, "completed", undefined, correlation, task);
    } catch (err) {
      if (item) this.inbox.markProcessed(item.item_id, agentId);
      return this.finishExecution(execution, "failed", {
        reason: "runtime_error",
        detail: err instanceof Error ? err.message : String(err),
      }, correlation, task);
    }
  }

  private taskForItem(item: InboxItem | undefined): Task | undefined {
    if (!item) return undefined;
    if (item.kind === "task") {
      const t = item.payload as unknown as Task;
      return this.store.getTask(t.task_id) ?? t;
    }
    if (item.kind === "delegation_result") {
      const r = item.payload as unknown as WorkerResult;
      const child = this.store.getTask(r.task_id);
      return child?.parent_task_id ? this.store.getTask(child.parent_task_id) : undefined;
    }
    return undefined;
  }

  /** A worker runs under the delegation's restricted grants, never the manager's own. */
  private effectiveGrants(agent: Agent, task: Task | undefined): Permission[] {
    if (task?.delegation?.granted_permissions) return task.delegation.granted_permissions;
    return agent.permissions ?? [];
  }

  private finishExecution(
    execution: Execution,
    status: "completed" | "failed",
    error: Execution["error"] | undefined,
    correlation: string | undefined,
    task: Task | undefined,
  ): Execution {
    execution.status = status;
    execution.ended_at = iso(this.clock.now());
    if (error) execution.error = error;
    this.store.putExecution(execution);

    const blocked = error?.reason === "budget_exhausted";
    this.store.setRuntimeState(
      execution.agent_id,
      blocked ? "BLOCKED" : status === "failed" ? "ERROR" : this.restingState(execution.agent_id),
    );

    if (blocked) {
      this.events.emit({
        type: "budget.exhausted",
        agent_id: execution.agent_id,
        execution_id: execution.execution_id,
        correlation_id: correlation,
        summary: error?.detail ?? "budget exhausted",
        payload: { needs_human_attention: true },
        visibility: "user",
      });
    }

    this.events.emit({
      type: status === "completed" ? "execution.completed" : "execution.failed",
      agent_id: execution.agent_id,
      execution_id: execution.execution_id,
      task_id: task?.task_id,
      correlation_id: correlation,
      summary: status === "completed" ? "execution completed" : `execution failed: ${error?.reason}`,
      usage: execution.usage,
      visibility: "organization",
    });

    // A worker execution must always yield a terminal result for its task (ADR 0007).
    if (task?.delegation && status === "failed") {
      this.deliverTerminalResult(task, {
        task_id: task.task_id,
        delegation_id: task.delegation.delegation_id,
        status: "failed",
        summary: `worker execution failed: ${error?.reason ?? "unknown"}`,
        error: error?.detail,
      });
    }
    return execution;
  }

  /** An agent with an unresolved wait rests in WAITING; otherwise IDLE (AGENT_CONTRACT). */
  private restingState(agentId: string): string {
    const waiting = this.store.activeWaits().some((w) => w.wait.agent_id === agentId);
    return waiting ? "WAITING" : "IDLE";
  }

  // ------------------------------------------------------------------ actions

  private async dispatch(action: AgentAction, ctx: DispatchContext): Promise<void> {
    const allow = (
      kind: Permission["kind"],
      request: Omit<perms.CheckRequest, "kind"> = {},
    ): boolean => {
      const r = perms.check(ctx.grants, { kind, ...request });
      this.events.emit({
        type: r.allowed ? "permission.checked" : "permission.denied",
        agent_id: ctx.agent.agent_id,
        execution_id: ctx.execution.execution_id,
        correlation_id: ctx.correlation_id,
        summary: `${kind} ${r.allowed ? "granted" : "denied"}`,
        payload: { action: action.type, grant: r.grant ? perms.describe(r.grant) : undefined },
        visibility: "audit",
      });
      return r.allowed;
    };

    switch (action.type) {
      case "note":
        // A no-op marker. There is no registered event type for "the agent said something
        // without acting", and reusing another type would corrupt the timeline.
        break;

      case "send_message": {
        if (!allow("agent.message")) break;
        this.inbox.deliverMessage({
          sender_id: ctx.agent.agent_id,
          recipient_id: action.recipient_id,
          correlation_id: ctx.correlation_id,
          causation_id: ctx.causation_id,
          // A message repeating what an agent just read from a file carries that file's
          // trust level to the recipient, who otherwise cannot tell.
          provenance: provenanceFor(ctx),
        }, action.body);
        this.waits.satisfy("reply", (p) => p.from_agent_id === ctx.agent.agent_id);
        break;
      }

      case "create_task": {
        if (!allow("agent.delegate")) break;
        this.assignTask({
          sender_id: ctx.agent.agent_id,
          recipient_id: action.recipient_id,
          objective: action.objective,
          expected_output: action.expected_output,
          correlation_id: ctx.correlation_id,
        });
        break;
      }

      case "delegate_task":
        await this.performDelegation(action, ctx);
        break;

      case "register_wait":
        this.waits.register({
          agent_id: ctx.agent.agent_id,
          task_id: ctx.task?.task_id,
          kind: action.kind,
          predicate: action.predicate,
          timeout_seconds: action.timeout_seconds,
          correlation_id: ctx.correlation_id,
        });
        this.store.setRuntimeState(ctx.agent.agent_id, "WAITING");
        break;

      case "cancel_wait":
        this.waits.cancel(action.wait_id);
        break;

      case "retrieve_memory":
        // Retrieval already happened during context assembly; recorded for the audit trail.
        this.events.emit({
          type: "permission.checked",
          agent_id: ctx.agent.agent_id,
          execution_id: ctx.execution.execution_id,
          summary: "memory retrieval",
          visibility: "audit",
        });
        break;

      case "propose_memory_update": {
        if (!allow("memory.write_own")) break;
        const proposal: MemoryProposal = {
          ...action.proposal,
          agent_id: ctx.agent.agent_id,
          source_execution: ctx.execution.execution_id,
        };
        const proposed = this.memory.propose(
          { ...proposal, provenance: provenanceFor(ctx) ?? proposal.provenance },
          ctx.execution.execution_id,
        );
        const outcome = this.memory.apply(proposed);
        if (!outcome.applied && outcome.requiresApproval) {
          this.requestApproval(ctx, `memory.${proposal.operation}`, proposed.proposal_id);
        }
        break;
      }

      case "create_ephemeral_worker":
        // Workers are created as part of a delegation; a bare request is recorded only.
        allow("agent.create_ephemeral");
        break;

      case "propose_durable_agent":
        // Constitution §9/§16: propose, never apply. Humans create durable agents in v0.
        this.requestApproval(ctx, "agent.propose_durable", action.name, {
          responsibility: action.responsibility, rationale: action.rationale,
        });
        break;

      case "request_permission":
        this.requestApproval(ctx, "permission.grant", perms.describe(action.permission), {
          reason: action.reason,
        });
        break;

      case "publish_artifact": {
        // Artifact URIs are virtual paths in platform-managed storage. Reject schemes,
        // traversal, and empty locations before applying the fs.write path scope.
        const normalized = action.uri.replaceAll("\\", "/");
        const parts = normalized.split("/");
        const isScheme = /^[a-z][a-z\d+.-]*:/i.test(normalized);
        if (!normalized || isScheme || parts.includes("..")) {
          this.events.emit({
            type: "permission.denied",
            agent_id: ctx.agent.agent_id,
            execution_id: ctx.execution.execution_id,
            correlation_id: ctx.correlation_id,
            summary: "fs.write denied for invalid artifact URI",
            payload: { action: action.type },
            visibility: "audit",
          });
          break;
        }
        const virtualPath = `/${parts.filter((part) => part && part !== ".").join("/")}`;
        if (virtualPath === "/" || !allow("fs.write", { path: virtualPath })) break;
        this.recordArtifact({
          artifact_id: this.ids.next("art"),
          kind: action.kind,
          uri: action.uri,
          created_at: iso(this.clock.now()),
          // The platform's determination wins over the agent's claim: an execution that
          // read untrusted content cannot publish an artifact marked trusted.
          provenance: provenanceFor(ctx) ?? action.provenance,
        }, ctx.agent.agent_id, ctx.execution.execution_id, ctx.correlation_id);
        break;
      }

      case "mark_task_blocked":
        this.setTaskStatus(action.task_id, "blocked", action.reason);
        this.store.setRuntimeState(ctx.agent.agent_id, "BLOCKED");
        break;

      case "mark_task_complete":
        this.setTaskStatus(action.task_id, "completed", action.summary);
        break;

      case "return_worker_result": {
        if (!ctx.task?.delegation) break;
        this.deliverTerminalResult(ctx.task, {
          ...action.result,
          task_id: ctx.task.task_id,
          delegation_id: ctx.task.delegation.delegation_id,
          artifacts: [...(action.result.artifacts ?? []), ...ctx.artifacts.map((a) => a.artifact_id)],
          usage: ctx.execution.usage,
        });
        break;
      }
    }
  }

  private requestApproval(
    ctx: { agent: Agent; execution: Execution; correlation_id?: string },
    actionName: string,
    subjectRef?: string,
    payload?: Record<string, unknown>,
  ): Approval {
    const approval: Approval = {
      approval_id: this.ids.next("appr"),
      action: actionName,
      requested_by_agent_id: ctx.agent.agent_id,
      execution_id: ctx.execution.execution_id,
      subject_ref: subjectRef,
      status: "pending",
      created_at: iso(this.clock.now()),
    };
    this.store.putApproval(approval);
    this.events.emit({
      type: "approval.requested",
      agent_id: ctx.agent.agent_id,
      execution_id: ctx.execution.execution_id,
      correlation_id: ctx.correlation_id,
      summary: `approval requested: ${actionName}`,
      payload: { approval_id: approval.approval_id, ...payload },
      visibility: "user",
    });
    return approval;
  }

  /** Human decision on a pending approval (Constitution §16). */
  decideApproval(
    approvalId: string, decision: "approved" | "denied", approver: string, reason?: string,
  ): void {
    const approval = this.store.listApprovals().find((a) => a.approval_id === approvalId);
    if (!approval) throw new Error(`unknown approval '${approvalId}'`);
    approval.status = decision;
    approval.approver = approver;
    approval.reason = reason;
    approval.decided_at = iso(this.clock.now());
    this.store.putApproval(approval);
    this.events.emit({
      type: decision === "approved" ? "approval.granted" : "approval.denied",
      agent_id: approval.requested_by_agent_id,
      summary: `${approver} ${decision} ${approval.action}`,
      payload: { approval_id: approvalId },
      visibility: "user",
    });
    this.waits.satisfy("approval", (p) => p.approval_id === approvalId);
  }

  private recordArtifact(
    artifact: Artifact, agentId: string, executionId: string, correlation?: string,
  ): void {
    const full: Artifact = {
      ...artifact,
      created_by_agent_id: artifact.created_by_agent_id ?? agentId,
      created_in_execution: artifact.created_in_execution ?? executionId,
    };
    if (this.store.getArtifact(full.artifact_id)) return;
    this.store.putArtifact(full);
    this.events.emit({
      type: "artifact.created",
      agent_id: agentId,
      execution_id: executionId,
      correlation_id: correlation,
      summary: `${full.kind}: ${full.uri}`,
      payload: { artifact_id: full.artifact_id },
      visibility: "organization",
    });
    this.waits.satisfy("artifact_changed", (p) => p.artifact_id === full.artifact_id);
  }

  // ------------------------------------------------------------------ delegation

  /**
   * Ephemeral workers this manager currently has in flight. A worker is retired when it
   * returns its result (or its task reaches a terminal state), so "active" is the live set.
   */
  private liveWorkersFor(managerId: string): number {
    return this.store.listAgents({ includeEphemeral: true })
      .filter((a) => a.lifecycle_state === "active" && a.metadata?.manager_agent_id === managerId)
      .length;
  }

  private async performDelegation(
    action: Extract<AgentAction, { type: "delegate_task" }>,
    ctx: DispatchContext,
  ): Promise<void> {
    const manager = ctx.agent;

    for (const kind of ["agent.delegate", "agent.create_ephemeral"] as const) {
      if (!perms.check(ctx.grants, { kind }).allowed) {
        this.events.emit({
          type: "permission.denied",
          agent_id: manager.agent_id,
          execution_id: ctx.execution.execution_id,
          correlation_id: ctx.correlation_id,
          summary: `${kind} denied; delegation refused`,
          visibility: "audit",
        });
        return;
      }
    }

    // Depth limit (ADR 0009 / 0012): a delegated task may not itself delegate.
    if (ctx.task?.delegation) {
      this.events.emit({
        type: "delegation.failed",
        agent_id: manager.agent_id,
        execution_id: ctx.execution.execution_id,
        correlation_id: ctx.correlation_id,
        summary: "delegation depth limit reached (max depth 1, ADR 0009)",
        visibility: "organization",
      });
      return;
    }

    // Concurrency limit on ephemeral workers (CONTRACT_TESTS #28). `max_concurrent` was
    // being carried through the subset check and printed by `describe`, so it looked
    // enforced from every angle except the one that matters: nothing counted live workers
    // against it. A scope that bounds nothing is worse than an absent one, because a reader
    // stops looking.
    const limit = perms.check(ctx.grants, { kind: "agent.create_ephemeral" }).grant?.scope?.max_concurrent;
    if (limit !== undefined) {
      const live = this.liveWorkersFor(manager.agent_id);
      if (live >= limit) {
        this.events.emit({
          type: "delegation.failed",
          agent_id: manager.agent_id,
          execution_id: ctx.execution.execution_id,
          correlation_id: ctx.correlation_id,
          summary: `ephemeral worker limit reached (${live}/${limit}); delegation refused`,
          visibility: "organization",
        });
        return;
      }
    }

    // Least authority (CONTRACT_TESTS #5): worker grants ⊆ manager grants.
    const requested = action.granted_permissions ?? [];
    const subset = perms.isSubset(requested, manager.permissions ?? []);
    if (!subset.ok) {
      this.events.emit({
        type: "delegation.failed",
        agent_id: manager.agent_id,
        execution_id: ctx.execution.execution_id,
        correlation_id: ctx.correlation_id,
        summary: `worker grant ${subset.offending ? perms.describe(subset.offending) : "?"} ` +
                 "exceeds manager authority",
        visibility: "audit",
      });
      return;
    }

    const workerId = this.ids.next("worker");
    this.createAgent({
      agent_id: workerId,
      name: `Worker ${workerId}`,
      responsibility: action.objective,
      mission: `Ephemeral worker for ${manager.name}. Complete one bounded task and return a structured result.`,
      permissions: requested,
      subscriptions: { kinds: ["task"] },
      // Attribution for the concurrency limit: the cap is per manager, not org-wide.
      metadata: { manager_agent_id: manager.agent_id },
    }, { ephemeral: true });

    const delegation: Delegation = {
      delegation_id: this.ids.next("dlg"),
      manager_agent_id: manager.agent_id,
      artifact_refs: action.artifact_refs,
      granted_permissions: requested,
      output_contract: action.output_contract,
      budget: action.budget,
    };

    const child = this.assignTask({
      sender_id: manager.agent_id,
      recipient_id: workerId,
      objective: action.objective,
      expected_output: action.expected_output,
      constraints: action.constraints,
      context_refs: action.context_refs,
      correlation_id: ctx.correlation_id,
      parent_task_id: ctx.task?.task_id,
      delegation,
    });

    this.events.emit({
      type: "delegation.created",
      agent_id: manager.agent_id,
      execution_id: ctx.execution.execution_id,
      task_id: child.task_id,
      correlation_id: ctx.correlation_id,
      causation_id: ctx.causation_id,
      summary: `delegated to ${workerId}: ${action.objective}`,
      payload: {
        delegation_id: delegation.delegation_id,
        worker_id: workerId,
        grants: requested.map(perms.describe),
      },
      visibility: "organization",
    });

    // The agent asked to wait for the result; only the control plane knows the child id.
    if (action.wait_for_result !== false) {
      this.waits.register({
        agent_id: manager.agent_id,
        task_id: ctx.task?.task_id,
        kind: "task_completed",
        predicate: { task_id: child.task_id },
        timeout_seconds: action.wait_timeout_seconds ?? action.budget.timeout_seconds * 2,
        correlation_id: ctx.correlation_id,
      });
      this.store.setRuntimeState(manager.agent_id, "WAITING");
    }
  }

  /**
   * Deliver the one terminal result for a delegated task, transactionally with its event
   * (outbox pattern, ADR 0007). A manager can never be left waiting on a dead worker.
   */
  private deliverTerminalResult(childTask: Task, result: WorkerResult): void {
    if (this.store.countDelegationResults(childTask.task_id) > 0) return; // already settled
    const delegation = childTask.delegation;
    if (!delegation) return;

    this.store.transaction(() => {
      this.inbox.deliverDelegationResult({
        sender_id: childTask.recipient_id,
        recipient_id: delegation.manager_agent_id,
        correlation_id: childTask.correlation_id,
        priority: childTask.priority,
      }, result);

      const t = this.store.getTask(childTask.task_id);
      if (t && !TERMINAL_TASK_STATUSES.includes(t.status)) {
        t.status = result.status === "completed" ? "completed" : "failed";
        t.updated_at = iso(this.clock.now());
        this.store.putTask(t);
      }

      this.events.emit({
        type: result.status === "completed" ? "delegation.completed"
          : result.status === "timeout" ? "delegation.timeout" : "delegation.failed",
        agent_id: delegation.manager_agent_id,
        task_id: childTask.task_id,
        correlation_id: childTask.correlation_id,
        summary: result.summary,
        payload: { delegation_id: result.delegation_id, status: result.status },
        visibility: "organization",
      });
    });

    // Resolve the manager's waits now that the child task is terminal.
    this.waits.cancelForTask(childTask.task_id);
    const woken = this.waits.satisfy("task_completed", (p) => p.task_id === childTask.task_id);
    for (const w of woken) this.wake(w.agent_id, { type: "wait", wait_id: w.wait_id });

    // Retire the ephemeral worker.
    const worker = this.store.getAgent(childTask.recipient_id);
    if (worker && this.store.isEphemeral(worker.agent_id)) {
      worker.lifecycle_state = "retired";
      this.store.putAgent(worker, true);
      this.events.emit({
        type: "agent.retired",
        agent_id: worker.agent_id,
        summary: "ephemeral worker retired after returning its result",
        visibility: "organization",
      });
    }
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Crash recovery (ADR 0007). Executions left running at startup are orphaned; they become
   * failed and retry-eligible, and any delegated task they owned still yields a terminal
   * result so no manager waits forever.
   */
  recoverOrphans(): Execution[] {
    const orphans = this.store.runningExecutions();
    for (const exec of orphans) {
      exec.status = "failed";
      exec.ended_at = iso(this.clock.now());
      exec.error = { reason: "orphaned", detail: "control plane restarted mid-execution" };
      this.store.putExecution(exec);
      this.store.setRuntimeState(exec.agent_id, "ERROR");
      this.events.emit({
        type: "execution.failed",
        agent_id: exec.agent_id,
        execution_id: exec.execution_id,
        summary: "orphaned by control-plane restart; retry-eligible",
        payload: { reason: "orphaned" },
        visibility: "organization",
      });

      for (const task of this.store.listTasks()) {
        if (task.recipient_id !== exec.agent_id || !task.delegation) continue;
        if (TERMINAL_TASK_STATUSES.includes(task.status)) continue;
        this.deliverTerminalResult(task, {
          task_id: task.task_id,
          delegation_id: task.delegation.delegation_id,
          status: "failed",
          summary: "worker orphaned by control-plane restart",
          error: "orphaned",
        });
      }
    }
    return orphans;
  }

  /** Executions eligible for retry under policy (ADR 0007). */
  retryable(policy: { maxRetries: number } = { maxRetries: 2 }): Execution[] {
    return this.store.listExecutions().filter((e) => {
      if (e.status !== "failed") return false;
      if (e.error?.reason === "budget_exhausted") return false; // needs a human, not a retry
      const root = e.retry_of ?? e.execution_id;
      const attempts = this.store.listExecutions().filter((x) => x.retry_of === root).length;
      return attempts < policy.maxRetries;
    });
  }

  /** Retry a failed execution: a new record, never a mutation of the old one (ADR 0007). */
  async retry(
    executionId: string, policy: { maxRetries: number } = { maxRetries: 2 },
  ): Promise<Execution | undefined> {
    const original = this.store.getExecution(executionId);
    if (!original || original.status !== "failed") return undefined;

    const root = original.retry_of ?? original.execution_id;
    const attempts = this.store.listExecutions().filter((e) => e.retry_of === root).length;
    if (attempts >= policy.maxRetries) return undefined;

    const retryExec: Execution = {
      execution_id: this.ids.next("exec"),
      agent_id: original.agent_id,
      trigger: { type: "retry", ref: original.execution_id },
      status: "running",
      retry_of: root,
      started_at: iso(this.clock.now()),
      usage: { ...ZERO_USAGE },
    };
    this.store.putExecution(retryExec);
    this.events.emit({
      type: "execution.retried",
      agent_id: original.agent_id,
      execution_id: retryExec.execution_id,
      summary: `retry of ${original.execution_id}`,
      payload: { retry_of: root },
      visibility: "organization",
    });
    return this.finishExecution(retryExec, "completed", undefined, undefined, undefined);
  }

  totalUsage(): Usage {
    return this.store.listExecutions()
      .reduce<Usage>((acc, e) => addUsage(acc, e.usage), { ...ZERO_USAGE });
  }
}
