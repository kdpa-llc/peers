# ADR 0011 — Schemas Are the Source of Truth

## Status
Accepted

## Decision
The JSON Schemas in `docs/specs/` are authoritative for every shared data shape. Prose documents reference them and are corrected when they disagree. New or changed contracts land as schema changes first, prose second.

The schemas describe **stored records**; creation manifests (e.g. `examples/agent.yaml`) may omit system-assigned fields (`created_at`, `revision`), which the control plane assigns at registration.

## Why
Schema/prose drift appeared before any code existed (fields required by `AGENT_CONTRACT.md` missing from `agent.schema.json`, envelope fields in `EXECUTION_MODEL.md` missing from `task.schema.json`). With a coding agent as the primary builder, ambiguity between two sources of truth becomes silent invention.

## Consequences
The implementation validates examples and fixtures against the schemas in CI. The event type registry lives in `docs/specs/EVENT_TYPES.md` and is updated in the same change as any new event type.

Each schema declares an absolute `$id`; validators load the whole `docs/specs/` directory into a registry keyed by `$id`, which is what makes the relative cross-file references resolve. A schema loaded alone will fail with an unresolvable reference.

Schemas constrain shape only. Cross-record invariants — envelope/Task equality, delegation depth, least-authority permission subsetting, budget enforcement, orphan recovery — cannot be expressed in JSON Schema and are enumerated in `docs/specs/CONTRACT_TESTS.md`, which the implementation covers with deterministic tests.
