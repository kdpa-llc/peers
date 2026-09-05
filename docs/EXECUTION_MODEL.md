# Execution Model

## Principle

Agents have agency. The platform has mechanics.

The scheduler should answer:

> When is this agent eligible to run?

The agent should answer:

> Given my responsibility and current state, what should I do?

## Trigger types

An execution may be triggered by:

### Human trigger
The user explicitly asks an agent to act or enters its session.

### Inbox trigger
An inbox item arrives that matches the agent's declared subscriptions (kind, minimum
priority — ADR 0008). Wake-up is not execution: items that don't match are delivered but do
not wake the agent, so timer-driven "anything to do?" wakes don't burn model budget. All
delivery uses the unified InboxItem envelope (ADR 0010).

### Wait-condition trigger
An agent previously declared:

- wake me when Agent B replies;
- wake me when task T completes;
- wake me when artifact A changes;
- wake me after a specific time;
- wake me when approval P is granted.

Every wait carries a **mandatory timeout** with a declared disposition (default: wake the
agent with a `timeout` outcome, keeping the semantic decision with the agent). Waits are
cancelled when their owning task reaches a terminal state. See ADR 0007 and
`docs/specs/wait_condition.schema.json`.

### Retry trigger
A failed execution becomes eligible for retry.

### Maintenance trigger
The platform may enqueue a maintenance task when a threshold is reached, such as:
- context pressure;
- memory size;
- stale summaries;
- unresolved inbox backlog.

The maintenance task is an invitation to perform work; the agent still owns the semantic decision.

## Execution lifecycle

1. Trigger becomes eligible.
2. Control plane creates an execution record.
3. Context builder retrieves bounded relevant state.
4. Runtime starts a session.
5. Agent reasons and acts.
6. Runtime emits structured events.
7. Agent may:
   - complete;
   - delegate;
   - message a peer;
   - request permission;
   - register a wait;
   - propose memory updates.
8. Control plane persists results.
9. Observer updates human-readable status.
10. Ephemeral runtime context may be discarded.

## Failure and retry semantics

Specified, not emergent (ADR 0007):

- Executions are journaled; terminal execution records are never mutated. Retries create
  new executions referencing the original (`retry_of`).
- On control-plane restart, executions still marked running become `failed(orphaned)` and
  retry-eligible. Retry policy is a platform default (2 retries, exponential backoff),
  overridable per agent policy.
- Delegation outcomes are always delivered: exactly one terminal inbox item
  (`completed | failed | timeout | cancelled`) per delegated task, written transactionally
  with its event (outbox pattern). A manager never waits forever on a dead worker.
- A worker result that fails schema validation is `failed`; the raw output is preserved as
  an artifact for diagnosis.

## Task lifecycle ownership

The recipient moves a task through `accepted → running/waiting/blocked → completed/failed`.
The sender — or a human — may cancel any non-terminal task; the control plane marks it
`cancelled` and notifies the recipient. Terminal states are final.

## Manager-worker pattern

Long-lived agents should generally be managers of their responsibility.

When execution becomes:
- large;
- specialized;
- context-heavy;
- parallelizable;
- risky to contaminate long-term context,

the manager should delegate to a fresh worker.

Delegation is a specialization of the normal Task contract (ADR 0012), not a separate work
payload. The worker receives one delegated `Task` (`docs/specs/task.schema.json`):
- the normal task objective, constraints, context references, expected output, priority, and deadline;
- `parent_task_id` pointing to the manager's current task;
- a `delegation` object (`docs/specs/delegation.schema.json`) containing the delegation id,
  manager id, additional artifact references, restricted permissions, worker-specific output
  contract, and timeout/cost/token budget.

The worker returns (`docs/specs/worker_result.schema.json`):
- the delegated task id and delegation id;
- terminal status;
- result;
- artifacts;
- evidence;
- concise summary;
- proposed learnings, in the standard MemoryProposal shape so the manager can accept them
  without translation.

The manager integrates the result without importing the worker's full token history.
Workers may not delegate further in v0 — maximum delegation depth is 1 (ADR 0009).

## Inter-agent communication

Prefer structured communication over open-ended group chat.

A task should include:
- sender;
- recipient;
- objective;
- context references;
- constraints;
- expected output;
- priority;
- correlation ID;
- deadline if applicable.

Conversational payloads are allowed for message-like inbox items, but the envelope should remain structured.

## Concurrency

In v0, **durable agents run one execution at a time** (ADR 0009): the scheduler serializes
per agent, and parallelism comes from ephemeral workers, which do run concurrently.

The control plane bounds worker and organization concurrency:
- max concurrent workers per manager;
- organization-wide concurrency;
- model budget (ADR 0008);
- sandbox quota;
- external API rate limits.

Those constraints are operational policy, not domain logic. Inbox delivery order is
deterministic mechanics — priority, then deadline, then age — but what the agent acts on
remains the agent's choice.
