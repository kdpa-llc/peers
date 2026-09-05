# ADR 0006 — Normalize Runtime Activity into Structured Events

## Status
Accepted

## Decision
Agent runtimes must emit structured events consumed by observers and UIs.

## Why
Humans cannot effectively manage many agents by reading full token streams.

## Consequences
The event schema becomes a foundational compatibility surface and should remain intentionally small and extensible.
