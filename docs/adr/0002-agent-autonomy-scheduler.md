# ADR 0002 — Scheduler Manages Eligibility, Agents Manage Intent

## Status
Accepted

## Decision
The central scheduler will determine when an agent may run, not what domain action it should take.

Agents may declare wait conditions and react to inbox items, timers, retries, or maintenance triggers.

## Why
A workflow engine would centralize intelligence and undermine responsibility-driven autonomy.

## Consequences
Agents need explicit mechanisms for waiting, delegation, and task state.
