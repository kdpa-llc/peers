# ADR 0010 — One Inbox Envelope for All Delivery

## Status
Accepted

## Decision
All delivery to an agent — agent-to-agent and human-to-agent — uses a single `InboxItem` envelope: id, sender, recipient, kind, correlation and causation ids, priority, optional deadline, payload, provenance.

Tasks, messages, replies, notifications, review requests, permission requests, maintenance invitations, and delegation results are `kind` values, not separate delivery mechanisms. `send_message` produces `kind: message`; all work delivery, including delegation, produces `kind: task` with a `Task` payload. A delegated Task carries its worker-specific execution policy in `Task.delegation` (ADR 0012). Worker completion is returned as `kind: delegation_result` with a `WorkerResult` payload.

For `kind: task`, the Task is authoritative for work metadata. The envelope repeats `sender_id`, `recipient_id`, `correlation_id`, `priority`, and `deadline` only as denormalized routing/index fields so the scheduler can deliver and filter without decoding domain payloads. The control plane creates these copies from the Task and validates equality at the write boundary; callers do not independently set conflicting values.

## Why
The earlier docs implied three overlapping delivery concepts (messages, tasks, inbox items), which means triple plumbing: three delivery paths, three retention policies, three wake-up hooks. One envelope gives one delivery mechanic, one wake-up path, one schema. Explicit ownership of duplicated routing fields prevents the envelope from becoming a second writable source of task truth.

## Consequences
`inbox_item.schema.json` is the envelope and conditionally validates payload shape by `kind`. `task.schema.json` is the canonical work payload; `delegation.schema.json` extends a Task with worker-specific execution policy rather than competing with it. Inbox subscriptions (ADR 0008) filter on envelope fields (`kind`, `priority`). Cross-field equality between a Task and its routing envelope is an application invariant and must have a deterministic contract test because JSON Schema cannot express equality across nested duplicated values.
