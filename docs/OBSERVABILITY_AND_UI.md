# Observability and UI

## Product principle

The user should not need to watch token streams to manage the organization.

The system should make autonomy legible.

## Observer pattern

The runtime emits normalized events.

Observers consume events and derive:
- summaries;
- status;
- blockers;
- progress narratives;
- anomaly signals;
- attention requests.

Observers must not become the source of truth.

All derived summaries should be traceable back to underlying events.

For v0, the observer is a **deterministic template over events** — this keeps traceability
trivially true while the event taxonomy stabilizes. An LLM summarizer is a labeled,
optional enhancement on top, never a replacement for the deterministic view. "Observers may
themselves be agents" remains the long-term direction.

## Minimum event categories

The concrete type registry is `docs/specs/EVENT_TYPES.md` (dotted `entity.verb` names,
with `correlation_id`/`causation_id` conventions). Categories:

- agent lifecycle;
- execution lifecycle;
- task lifecycle;
- message sent/received;
- delegation;
- wait registered/satisfied;
- tool invocation;
- artifact created;
- permission requested/approved/denied;
- memory proposal;
- memory revision;
- error/retry;
- user intervention.

## Management UI

The default UI should behave like an operations console.

### Organization view
Show:
- agent name;
- responsibility;
- status;
- current objective;
- active task count;
- blocker state;
- last meaningful event;
- attention needed.

### Agent detail view
Show:
- identity and mission;
- current execution;
- inbox;
- delegations;
- recent events;
- memory summary;
- skills;
- permissions;
- artifacts;
- direct interaction entry point.

### Timeline
A normalized timeline should hide low-value token noise.

Example entries:

```text
10:02 Payments Agent accepted incident investigation.
10:03 Delegated log analysis to Worker 8f1.
10:07 Worker 8f1 found timeout regression in checkout-service.
10:08 Payments Agent requested code-change permission.
10:10 Human approved change.
10:14 Patch produced; tests passing.
```

## TUI versus web UI

A TUI is an excellent forcing function here because it emphasizes primitives over visual polish.

A minimal TUI might provide:
- agent list;
- status badges;
- event stream;
- task/inbox view;
- command to enter an agent session.

The web UI can later use the same APIs and event stream.

The architecture should not assume the TUI is permanent.

## Direct chat

Direct chat is a drill-down tool.

The user should be able to enter an agent session to:
- ask why it made a decision;
- provide context;
- change priority;
- resolve a blocker;
- inspect detailed output.

This does not make chat the primary global interface.
