# Agent Contract

A durable agent is defined by structured state, not only by a system prompt.

## Required fields

### Identity
- `agent_id`
- `name`
- `created_at`
- `lifecycle_state`

### Responsibility
A concise statement of what the agent owns.

Example:

> Own the correctness, maintainability, and delivery of the payments service.

Responsibility should be stable enough to support discovery.

### Mission
A longer explanation of what good performance means over time.

### Success criteria
Signals that tell the agent whether it is fulfilling its responsibility.

### Capabilities
- tools;
- skills;
- runtime features;
- accessible repositories;
- approved external systems.

### Policies
- budget;
- security;
- escalation rules;
- approval requirements;
- sandbox constraints;
- retention rules.

Permissions are parameterized `{kind, scope}` grants, not flat names — see
`docs/specs/permission.schema.json` and SECURITY_AND_PERMISSIONS.

### Subscriptions
An inbox wake-up filter (ADR 0008): which item kinds and priorities make the agent
eligible to run. Declared by the agent (intent), enforced by the scheduler (mechanics).

### Memory policy
Defines preferred memory behavior, not the actual memory contents.

Examples:
- aggressive distillation;
- high evidence retention;
- retain architectural decisions indefinitely;
- archive routine status after 30 days.

### Relationships
Optional structured relationships:
- reports_to;
- peers;
- delegates_to;
- reviews;
- owns_service_for.

## Runtime states

**Invariant (v0):** a durable agent has at most one execution at a time (ADR 0009) — which
is what makes a single agent-level state meaningful. Parallelism happens through ephemeral
workers.

A simple initial state machine:

```text
IDLE
  │
  ├─ inbox/timer/user event ─► READY
  │
READY
  │
  └─ scheduled ─────────────► RUNNING
                               │
                               ├─ completed ─────► IDLE
                               ├─ waiting ───────► WAITING
                               ├─ needs human ───► BLOCKED
                               └─ error ─────────► ERROR

WAITING ── condition satisfied ─► READY
BLOCKED ── intervention received ─► READY
ERROR ── retry/recovery ─────────► READY
```

## Standard actions an agent may request

- `send_message`
- `create_task`
- `delegate_task`
- `register_wait`
- `cancel_wait`
- `retrieve_memory`
- `propose_memory_update`
- `create_ephemeral_worker`
- `propose_durable_agent`
- `request_permission`
- `publish_artifact`
- `mark_task_blocked`
- `mark_task_complete`

The control plane decides whether each action is authorized and then executes the mechanic.

All delivery-producing actions (`send_message`, `create_task`, `delegate_task`, replies,
notifications) emit a single unified InboxItem envelope with a `kind` field — one delivery
mechanic, one wake-up path (ADR 0010, `docs/specs/inbox_item.schema.json`).

## Agent prompt composition

The runtime prompt should be assembled from structured sources:

1. platform constitution;
2. agent identity;
3. responsibility;
4. mission and policies;
5. current task;
6. relevant peer directory;
7. retrieved durable memory;
8. recent state/events;
9. available tools and skills.

Do not make raw lifetime transcript history a required input.
