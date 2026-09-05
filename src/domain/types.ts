/**
 * Domain types mirroring docs/specs/*.schema.json.
 * The schemas remain authoritative (ADR 0011); tests/contracts/schemas.test.ts asserts
 * that instances produced by this implementation validate against them.
 */

// ---------- Permissions (permission.schema.json) ----------

export type PermissionKind =
  | "fs.read" | "fs.write"
  | "net.egress"
  | "model.invoke"
  | "sandbox.create"
  | "tool.exec"
  | "agent.message" | "agent.delegate" | "agent.create_ephemeral"
  | "agent.propose_durable" | "agent.approve_proposals"
  | "skill.edit_shared"
  | "memory.read_own" | "memory.write_own"
  | "memory.read_shared" | "memory.write_shared"
  | "history.delete"
  | "external.side_effect";

export type PermissionScope = {
  paths?: string[];
  allow?: string[];
  unrestricted?: boolean;
  budget_usd_per_day?: number;
  max_tokens_per_execution?: number;
  max_concurrent?: number;
  backend?: string;
  policy?: string;
};

export type Permission = { kind: PermissionKind; scope?: PermissionScope };

// ---------- Provenance (artifact.schema.json#/properties/provenance) ----------

export type Provenance = {
  source: "trusted" | "untrusted_content" | "external";
  detail?: string;
};

// ---------- Agent (agent.schema.json) ----------

export type LifecycleState = "active" | "paused" | "retired";
export type RuntimeState = "IDLE" | "READY" | "RUNNING" | "WAITING" | "BLOCKED" | "ERROR";

export type MemoryPolicy = {
  style?: string;
  prefer_evidence?: boolean;
  distill_completed_tasks?: boolean;
  archive_raw_transcripts?: boolean;
  retention_rules?: string[];
};

export type Relationships = {
  reports_to?: string;
  peers?: string[];
  delegates_to?: string[];
  reviews?: string[];
  owns_service_for?: string[];
};

export type Subscriptions = { kinds?: InboxKind[]; min_priority?: number };

/**
 * An agent's model, recorded alongside its permissions because it is the same kind of fact:
 * part of what this agent *is*, not how one run happened to be invoked. A reviewer that
 * reasons about supply-chain security may warrant a deeper thinking level than an agent that
 * files chores, and that difference should survive a restart.
 */
export type ModelConfig = {
  provider?: "claude" | "openai" | "openrouter" | "scripted";
  model?: string;
  /** Reasoning depth. Mapped onto each provider's own parameter; ignored where there is none. */
  thinking?: "low" | "medium" | "high" | "xhigh" | "max";
};

export type Agent = {
  agent_id: string;
  name: string;
  responsibility: string;
  mission: string;
  success_criteria?: string[];
  lifecycle_state: LifecycleState;
  created_at: string;
  revision: number;
  skills?: string[];
  permissions?: Permission[];
  /** Which model this agent thinks with; absent means the organization's default. */
  model_config?: ModelConfig;
  memory_policy?: MemoryPolicy;
  relationships?: Relationships;
  subscriptions?: Subscriptions;
  metadata?: Record<string, unknown>;
  // Runtime state is control-plane bookkeeping, not part of the durable definition.
  runtime_state?: RuntimeState;
};

// ---------- Inbox (inbox_item.schema.json) ----------

export type InboxKind =
  | "task" | "message" | "reply" | "notification"
  | "review_request" | "permission_request" | "maintenance"
  | "delegation_result";

export type InboxItem = {
  item_id: string;
  sender_id: string;
  recipient_id: string;
  kind: InboxKind;
  correlation_id?: string;
  causation_id?: string;
  priority?: number;
  deadline?: string;
  created_at: string;
  processed_at?: string;
  payload: Record<string, unknown>;
  provenance?: Provenance;
};

// ---------- Delegation (delegation.schema.json) ----------

export type DelegationBudget = {
  timeout_seconds: number;
  max_cost_usd?: number;
  max_tokens?: number;
};

export type Delegation = {
  delegation_id: string;
  manager_agent_id: string;
  artifact_refs?: string[];
  granted_permissions?: Permission[];
  output_contract: string;
  budget: DelegationBudget;
  provenance?: Provenance;
};

// ---------- Task (task.schema.json) ----------

export type TaskStatus =
  | "queued" | "accepted" | "running" | "waiting"
  | "blocked" | "completed" | "failed" | "cancelled";

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

export type Task = {
  task_id: string;
  parent_task_id?: string;
  sender_id: string;
  recipient_id: string;
  objective: string;
  context_refs?: string[];
  constraints?: string[];
  expected_output?: string;
  priority?: number;
  deadline?: string;
  correlation_id?: string;
  status: TaskStatus;
  created_at: string;
  updated_at?: string;
  delegation?: Delegation;
  result_item_id?: string;
  metadata?: Record<string, unknown>;
};

// ---------- Worker result (worker_result.schema.json) ----------

export type WorkerStatus = "completed" | "failed" | "timeout" | "cancelled";

export type WorkerResult = {
  task_id: string;
  delegation_id: string;
  status: WorkerStatus;
  result?: Record<string, unknown>;
  summary: string;
  artifacts?: string[];
  evidence?: string[];
  proposed_learnings?: MemoryProposal[];
  error?: string;
  usage?: Usage;
};

// ---------- Execution (execution.schema.json) ----------

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
};

export type TriggerType = "human" | "inbox" | "wait" | "retry" | "maintenance";
export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled";

export type Execution = {
  execution_id: string;
  agent_id: string;
  trigger: { type: TriggerType; ref?: string };
  status: ExecutionStatus;
  retry_of?: string;
  started_at: string;
  ended_at?: string;
  error?: { reason: string; detail?: string };
  usage?: Usage;
  context_manifest?: string[];
};

// ---------- Wait conditions (wait_condition.schema.json) ----------

export type WaitKind = "reply" | "task_completed" | "artifact_changed" | "time" | "approval";
export type WaitStatus = "active" | "satisfied" | "timeout" | "cancelled";

export type WaitCondition = {
  wait_id: string;
  agent_id: string;
  task_id?: string;
  kind: WaitKind;
  predicate?: Record<string, unknown>;
  timeout_seconds: number;
  on_timeout?: "wake_with_timeout" | "cancel";
  status: WaitStatus;
  created_at: string;
  resolved_at?: string;
};

// ---------- Memory (memory*.schema.json) ----------

export type MemoryKind = "identity" | "knowledge" | "experience" | "working" | "archive";
export type MemoryStatus = "active" | "superseded" | "archived";
export type MemoryOperation =
  | "create" | "revise" | "merge" | "supersede" | "archive" | "delete";

export type MemoryRecord = {
  memory_id: string;
  agent_id: string;
  kind: MemoryKind;
  content: string;
  revision: number;
  confidence?: number;
  source_refs?: string[];
  /** Set by the control plane from what the producing execution read, not by the agent. */
  provenance?: Provenance;
  supersedes?: string[];
  status?: MemoryStatus;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
};

export type MemoryProposal = {
  proposal_id?: string;
  agent_id: string;
  operation: MemoryOperation;
  target_memory_ids?: string[];
  kind?: MemoryKind;
  content?: string;
  rationale: string;
  confidence?: number;
  source_execution?: string;
  evidence_refs?: string[];
  provenance?: Provenance;
};

export type MemoryRevision = {
  revision_id: string;
  memory_id: string;
  revision: number;
  operation: MemoryOperation;
  proposal_id?: string;
  rationale: string;
  confidence?: number;
  source_execution?: string;
  evidence_refs?: string[];
  provenance?: Provenance;
  previous_revision?: number;
  actor_agent_id: string;
  approval_id?: string;
  created_at: string;
};

// ---------- Artifacts (artifact.schema.json) ----------

export type Artifact = {
  artifact_id: string;
  kind: string;
  uri: string;
  content_hash?: string;
  created_by_agent_id?: string;
  created_in_execution?: string;
  created_at: string;
  provenance?: Provenance;
  metadata?: Record<string, unknown>;
};

// ---------- Approvals (approval.schema.json) ----------

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type Approval = {
  approval_id: string;
  action: string;
  requested_by_agent_id: string;
  execution_id?: string;
  subject_ref?: string;
  approver?: string;
  status: ApprovalStatus;
  reason?: string;
  created_at: string;
  decided_at?: string;
};

// ---------- Events (event.schema.json) ----------

export type Visibility = "internal" | "organization" | "user" | "audit";

export type AgentEvent = {
  event_id: string;
  event_type: string;
  timestamp: string;
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

// ---------- Agent actions (AGENT_CONTRACT.md) ----------
// The agent expresses intent only through these. The control plane authorizes each one
// and performs the mechanic (ADR 0002): the runtime never mutates durable state.

export type AgentAction =
  | { type: "send_message"; recipient_id: string; body: string }
  | { type: "create_task"; recipient_id: string; objective: string; expected_output?: string }
  | {
      type: "delegate_task";
      objective: string;
      expected_output?: string;
      constraints?: string[];
      context_refs?: string[];
      artifact_refs?: string[];
      granted_permissions?: Permission[];
      output_contract: string;
      budget: DelegationBudget;
      /**
       * Wait for the worker's result before running again (default true). The agent
       * declares the intent; the control plane fills in the child task id it mints, since
       * the agent cannot know it at request time.
       */
      wait_for_result?: boolean;
      wait_timeout_seconds?: number;
    }
  | { type: "register_wait"; kind: WaitKind; predicate?: Record<string, unknown>; timeout_seconds: number }
  | { type: "cancel_wait"; wait_id: string }
  | { type: "retrieve_memory"; query?: string }
  | { type: "propose_memory_update"; proposal: Omit<MemoryProposal, "agent_id"> }
  | { type: "create_ephemeral_worker"; purpose: string }
  | { type: "propose_durable_agent"; name: string; responsibility: string; rationale: string }
  | { type: "request_permission"; permission: Permission; reason: string }
  | { type: "publish_artifact"; kind: string; uri: string; provenance?: Provenance }
  | { type: "mark_task_blocked"; task_id: string; reason: string }
  | { type: "mark_task_complete"; task_id: string; summary: string }
  | { type: "return_worker_result"; result: Omit<WorkerResult, "task_id" | "delegation_id"> }
  | { type: "note"; text: string };
