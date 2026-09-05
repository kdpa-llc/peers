# ADR 0012 — Delegation Is a Specialized Task

## Status
Accepted

## Decision
A delegation is represented as a normal `Task`, delivered in an `InboxItem` with `kind: task`.

A delegated task:
- has `parent_task_id` set to the manager's current task id;
- carries the generic work description on `Task` (`objective`, `constraints`, `context_refs`, `expected_output`, priority/deadline);
- carries a `delegation` field conforming to `delegation.schema.json` for worker-specific execution constraints: delegation id, manager id, artifact refs, restricted permissions, output contract, budget, and provenance.

`DelegationPackage` is therefore not a second inbox payload type and does not duplicate fields already owned by `Task`.

Worker completion is delivered separately as `InboxItem(kind: delegation_result)` with a `WorkerResult` payload that identifies both the delegated `task_id` and `delegation_id`.

`inbox_item.schema.json` must enforce these payload contracts conditionally by `kind`.

## Why
ADR 0010 established one inbox envelope, but the first schema pass left two competing descriptions for `kind: task`: `Task` in `inbox_item.schema.json` and `DelegationPackage` in ADR 0010/delegation prose. Leaving both valid would force the implementation to invent a relationship between Task lifecycle state and delegation execution state, undermining ADR 0011's rule that schemas are authoritative.

Making delegation a specialization of Task gives one work identity, one lifecycle, one cancellation path, and one delivery shape while keeping worker-specific constraints explicit.

## Consequences
- `task.schema.json` gains an optional `delegation` reference and requires `parent_task_id` when it is present.
- `delegation.schema.json` contains only worker-specific fields; generic task fields are removed.
- `worker_result.schema.json` identifies the delegated Task as well as the delegation.
- `inbox_item.schema.json` validates `kind: task` payloads against `task.schema.json` and `kind: delegation_result` against `worker_result.schema.json`.
- The implementation should persist Task as the work record and treat the nested delegation object as execution policy for the ephemeral worker.
