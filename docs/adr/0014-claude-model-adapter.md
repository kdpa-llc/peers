# ADR 0014 — A Real Model Adapter, Behind the Same Interface

## Status
Accepted. The adapter-selection decision below is superseded by
[ADR 0015](0015-model-is-the-default.md): the model adapter is now the default and
`--live` no longer exists.

## Decision
`ClaudeModelAdapter` implements `ModelAdapter` against a live Claude model (Claude Opus 5 by default, adaptive thinking, effort `high`). At the time of this decision it was selected with `--live`. ADR 0015 subsequently made it the default, removed that flag, and retained the scripted adapter as the explicit `--scripted` test/offline path.

Three properties are load-bearing:

1. **Agent intent arrives as tool calls, not prose.** Every `AgentAction` the agent is permitted to take is exposed as a tool with a schema. The control plane receives typed intent and never parses free text for decisions.
2. **The tool surface is the permission surface.** A tool is offered only when the corresponding grant is held, so an agent is not shown a capability the control plane would refuse.
3. **Delegated authority is derived, not trusted.** The model names permission *kinds*; the adapter resolves them against the manager's own grants. A worker's permissions are a subset by construction (CONTRACT_TESTS #5) even when the model asks for more, and scopes come from the manager's grant rather than from model output.

The SDK client is built lazily, so constructing the adapter makes no network call. ADR 0015 subsequently moved `@anthropic-ai/sdk` from an optional dependency to the project's one runtime dependency when the model-backed path became the default.

## Why
Every design claim in this repository — that the control plane holds no orchestration graph, that context is reconstructed rather than accumulated, that permissions bound what an agent can do — was until now demonstrated only against a script that was written to demonstrate it. A real adapter is what turns those from assertions into tests.

Tools rather than prose because the alternative is a parser between the model and the control plane, and that parser becomes the place where the organization's behavior secretly lives.

At acceptance, keeping the SDK optional preserved a zero-runtime-dependency scripted path. ADR 0015 deliberately traded that property for making real model behavior the default and removed the old demo entry point.

## Consequences
Constitution §5 is preserved by construction: the adapter's conversation buffer is scoped to one `execution_id` and reset when a new one arrives, so no transcript crosses executions. Within an execution the buffer is required — the Messages API needs the assistant's `tool_use` blocks present for the matching `tool_result` blocks to be valid.

A policy refusal (`stop_reason: "refusal"`) returns a `note` action rather than throwing, so a declined turn does not strand the execution. Server-side fallbacks are enabled, so a refusal is retried on a fallback model within the same call.

Claude cost is computed from configured pricing and checked before and after each call through
the shared budget gates. A live response can cross a ceiling before its final usage is known;
the usage is retained, but intent from that response is discarded.

The adapter's translation layer is covered by contract tests against an injected fake transport, which is what keeps the suite deterministic and free of network and credentials. Live runs cost money and are not reproducible, so they stay out of CI by design.
