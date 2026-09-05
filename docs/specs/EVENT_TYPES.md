# Event Type Registry

The event schema (ADR 0006) keeps `event_type` intentionally small and extensible: a dotted
`<entity>.<past_tense_verb>` string matching `^[a-z_]+\.[a-z_]+$`. This file is the registry of
known types. New types are added here **in the same change** that introduces them (ADR 0011).

## Initial taxonomy

| Entity | Types |
|---|---|
| agent | `agent.created`, `agent.updated`, `agent.paused`, `agent.retired` |
| execution | `execution.started`, `execution.completed`, `execution.failed`, `execution.retried` |
| task | `task.created`, `task.accepted`, `task.completed`, `task.failed`, `task.cancelled`, `task.blocked` |
| inbox | `inbox.delivered`, `inbox.processed` |
| delegation | `delegation.created`, `delegation.completed`, `delegation.failed`, `delegation.timeout` |
| wait | `wait.registered`, `wait.satisfied`, `wait.timeout`, `wait.cancelled` |
| tool | `tool.invoked`, `tool.completed`, `tool.failed` |
| artifact | `artifact.created` |
| permission | `permission.requested`, `permission.checked`, `permission.approved`, `permission.denied` |
| approval | `approval.requested`, `approval.granted`, `approval.denied` |
| memory | `memory.proposed`, `memory.revised`, `memory.archived` |
| budget | `budget.warning`, `budget.exhausted` |
| user | `user.intervened` |

## Conventions

- `correlation_id` identifies the workflow an event belongs to; `causation_id` is the `event_id`
  of the event that directly caused this one. Both should be set whenever known.
- Execution and tool events carry `usage` when the model adapter reports it (ADR 0008).
- `visibility` governs who may see the payload (see SECURITY_AND_PERMISSIONS: payload
  redaction). It is not a retention policy.
