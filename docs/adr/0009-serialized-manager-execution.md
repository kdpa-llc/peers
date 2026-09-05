# ADR 0009 — One Execution at a Time per Durable Agent (v0)

## Status
Accepted

## Decision
The control plane serializes executions per durable agent: exactly one execution runs at a time. Parallelism is achieved by delegating to ephemeral workers, which run concurrently.

Additionally for v0: workers may not delegate further — maximum delegation depth is 1.

## Why
The agent-level state machine in `AGENT_CONTRACT.md` is only coherent if an agent has at most one execution. Serializing also eliminates a class of races — concurrent memory writes, double-processing of inbox items — that would otherwise need locking semantics. Depth-1 delegation keeps correlation, budgets, and failure delivery simple.

## Consequences
The scheduler enforces per-agent mutual exclusion; concurrency limits in `EXECUTION_MODEL.md` apply to workers and to the organization, not to a single manager. If parallel manager execution is ever needed, the path is to move state onto executions and tasks and derive agent-level status as an aggregate — a new ADR, not a silent change.
