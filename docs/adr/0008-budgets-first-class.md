# ADR 0008 — Budgets and Usage Accounting Are First-Class Mechanics

## Status
Accepted

## Decision
- Every execution records model usage (input/output tokens, cost) reported by the model adapter; execution events carry the same usage.
- Every model call is checked before and after provider-reported usage at the per-execution,
  per-agent-per-day, organization, delegation, and model-token scopes. A pre-call reservation
  reduces overshoot; a response that crosses a limit is charged but cannot run tools/actions.
- A tripped budget transitions the agent to `BLOCKED` with a human-attention flag. Budget exhaustion never fails silently.
- Wake-up is not execution: agents declare inbox subscriptions (which item kinds and priorities wake them), and the scheduler enforces the filter mechanically. A wake therefore implies a deliverable reason to run; timer wakes with nothing actionable do not consume model budget.

## Why
For a system of long-lived, self-waking autonomous agents, runaway spend is the most likely
first production incident. Accounting must exist before autonomy does. These checks are
local guardrails, not provider billing quotas: USD enforcement depends on accurate pricing,
and one call can exceed an estimate before its actual usage is known. The subscription filter
stays on the correct side of ADR 0002: the agent declares its own filter (intent); the
scheduler merely enforces it (mechanics).

## Consequences
Implemented in Phase 1, not Phase 9, because it shapes the execution record. `execution.schema.json` and `event.schema.json` carry usage; the parameterized permission model (see `docs/specs/permission.schema.json`) expresses budget grants; `agent.schema.json` carries subscriptions.
