# ADR 0005 — Sandbox Is a Pluggable Backend

## Status
Accepted

## Decision
The runtime will expose a generic sandbox interface.

Docker may be the first real implementation, but the architecture must allow local, VM, microVM, remote, or vendor executors.

## Why
Execution isolation is necessary, but coupling the platform to one isolation technology would create unnecessary lock-in.

## Consequences
Sandbox lifecycle and artifact handling need explicit contracts.
