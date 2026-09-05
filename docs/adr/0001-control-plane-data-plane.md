# ADR 0001 — Separate Control Plane from Data Plane

## Status
Accepted

## Decision
The system will separate durable organizational mechanics from runtime execution.

The control plane owns identity, lifecycle, permissions, tasks, wakeups, memory services, discovery, events, and UI-facing state.

The data plane runs model sessions, tools, and sandboxes.

## Why
This allows agent runtimes and sandbox technologies to evolve independently from the durable organizational model.

## Consequences
Runtime adapters require a stable interface and normalized event model.
