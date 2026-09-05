# ADR 0007 — Execution Failure, Retry, and Wait Semantics

## Status
Accepted

## Decision
Failure behavior is specified, not emergent:

- Every execution is journaled: the execution record plus append-only events are the authoritative account of progress.
- On control-plane restart, executions still marked running are set to `failed` with reason `orphaned` and become retry-eligible under policy.
- Retries create new execution records referencing the original (`retry_of`); terminal execution records are never mutated.
- Retry policy is a platform default (2 retries, exponential backoff), overridable by agent policy. Retries are a mechanic; whether to keep pursuing a goal after retries are exhausted is the agent's decision.
- Delegation outcomes are always delivered: the control plane guarantees exactly one terminal inbox item per delegated task — `completed`, `failed`, `timeout`, or `cancelled` — written transactionally with the corresponding event (outbox pattern). A manager can never wait forever on a worker that no longer exists.
- A worker result that fails schema validation is treated as `failed`; the raw output is preserved as an artifact for diagnosis.
- Every wait condition carries a mandatory timeout and an on-timeout disposition. The default disposition wakes the agent with a `timeout` outcome, leaving the semantic decision with the agent. Waits are cancelled when their owning task reaches a terminal state.

## Why
Unspecified failure semantics become load-bearing accidental behavior in the first implementation. Timeouts on waits are the cheap, sufficient v0 answer to deadlock (A waits on B, B waits on A; or B never replies).

## Consequences
`execution.schema.json` and `wait_condition.schema.json` carry the fields above. Phase 5 of the roadmap gains a crash-recovery acceptance test: kill the control plane mid-execution and mid-wait; on restart, orphaned executions are retry-eligible and no wait is lost.
