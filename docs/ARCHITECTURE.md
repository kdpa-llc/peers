# Architecture

## High-level structure

```text
                         ┌──────────────────────────┐
                         │     Management UI        │
                         │ agents / status / drill  │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │      Control Plane       │
                         │                          │
                         │ Identity & Registry      │
                         │ Task / Inbox Service     │
                         │ Scheduler / Wakeups      │
                         │ Permissions              │
                         │ Memory Services          │
                         │ Agent Discovery          │
                         │ Event Store              │
                         │ Observer(s)              │
                         └────────────┬─────────────┘
                                      │ stable runtime API
                         ┌────────────▼─────────────┐
                         │       Data Plane         │
                         │     Agent Runtime(s)     │
                         │                          │
                         │ Model Adapter            │
                         │ Tool Execution           │
                         │ Sandbox Adapter          │
                         │ Session Execution        │
                         │ Event Emission           │
                         └────────────┬─────────────┘
                                      │
                           ┌──────────▼──────────┐
                           │ Sandbox / Executor │
                           │ container / VM /   │
                           │ remote / local     │
                           └────────────────────┘
```

## Control plane responsibilities

The control plane owns platform mechanics.

### Identity and registry
Stores:
- agent ID;
- human-readable name;
- responsibility;
- mission;
- capabilities;
- permissions;
- memory policy;
- lifecycle state;
- relationships.

### Agent discovery
Agents should be able to ask:

> Who is responsible for X?

Discovery should be based primarily on declared responsibility and capability metadata.

### Inbox and task delivery
Each durable agent has an inbox. All delivery uses one envelope — the InboxItem
(ADR 0010, `docs/specs/inbox_item.schema.json`) — whose `kind` distinguishes:
- task;
- message;
- reply;
- notification;
- review request;
- permission request;
- system maintenance request;
- delegation result.

Agents declare inbox subscriptions (kind, minimum priority) that determine which delivered
items wake them (ADR 0008).

### Scheduler and wake-up service
The scheduler should not decide what an agent wants to do.

It should reliably wake agents when:
- a relevant inbox item arrives;
- a timer fires;
- a wait condition is satisfied;
- a retry becomes eligible;
- a platform maintenance threshold is reached;
- a human explicitly requests execution.

### Permissions
The control plane enforces parameterized `{kind, scope}` grants
(`docs/specs/permission.schema.json`):
- allowed tools;
- virtual filesystem scope in the local backend (network scopes are reserved for a future
  brokered or isolated backend);
- model budget;
- agent creation rights;
- durable-memory mutation rights;
- external side-effect rights;
- sandbox policies.

### Budgets and usage accounting
Every execution records model usage. Pre- and post-call gates enforce execution,
per-agent-per-day, organization, delegation, and token limits; exhaustion transitions the
agent to BLOCKED with a human-attention flag (ADR 0008). USD accuracy depends on configured
provider pricing and remains a local guardrail rather than a billing quota.

### Memory services
The control plane provides:
- storage;
- retrieval;
- versioning;
- archival;
- compaction primitives;
- memory-update transactions.

Agents provide semantics.

### Event store
All normalized execution events are recorded centrally for:
- observability;
- audit;
- debugging;
- derived status;
- metrics.

Events carry `correlation_id` (workflow) and `causation_id` (direct cause) so timelines are
reconstructable rather than heuristic; the type registry is `docs/specs/EVENT_TYPES.md`.

## Data plane responsibilities

The runtime executes work.

It should:
- start or resume sessions;
- construct runtime context supplied by the control plane;
- invoke a model;
- expose tools;
- execute tool calls;
- manage sandbox interactions;
- stream normalized events;
- return results and artifacts.

A runtime may be replaced without changing the durable agent model.

## Observer layer

Observers consume events.

They do not control execution.

Their outputs may include:
- current status;
- concise execution summary;
- blocker explanations;
- progress estimates when evidence supports them;
- anomaly detection;
- user-facing timeline entries.

Observers should be replaceable and may themselves be agents.

## Storage model

The reference implementation uses a relational database plus an append-only event table.

Suggested durable entities (schemas in `docs/specs/`, ADR 0011):
- agents;
- responsibilities;
- skills;
- permissions;
- inbox_items;
- tasks;
- executions (with usage);
- wait_conditions;
- memories;
- memory_proposals;
- memory_revisions;
- artifacts;
- approvals;
- budgets / usage rollups;
- agent_relationships;
- events.

Raw runtime transcripts may be stored for audit, but should not be the primary state representation.
