# ADR 0004 — Long-Lived Managers, Short-Lived Workers

## Status
Accepted

## Decision
Durable agents should remain focused on responsibility and coordination.

Context-heavy work should commonly be delegated to fresh workers with bounded context.

## Why
Long-running chat histories will overflow model context and degrade relevance.

## Consequences
Worker results need structured summaries, artifacts, evidence, and proposed learnings.
