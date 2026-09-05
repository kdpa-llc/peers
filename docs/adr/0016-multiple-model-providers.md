# ADR 0016 — Multiple Model Providers Behind One Tool Surface

## Status
Accepted

## Decision
Three providers are selectable from the console: `claude`, `openai` and `openrouter`, plus
`scripted` for the deterministic adapter. `--provider` chooses one and `--model` picks a model
within it; `PEERS_PROVIDER` and `PEERS_MODEL` are the environment equivalents.

OpenAI and OpenRouter are served by **one** adapter, `OpenAIModelAdapter`, because they are the
same Chat Completions wire protocol behind different base URLs. A provider is a preset —
base URL, credential variable, default model — not a file.

The tool table moves out of `claude.ts` into `tools.ts`, shared by every model-backed adapter.

## Why one tool table
This is the load-bearing part of the decision, not the transport.

An adapter's job is to translate between one wire format and the control plane's typed
actions. If each adapter carried its own copy of the tool definitions, the copies would
drift — a tool added for one provider, a permission gate forgotten on another — and
`CONTRACT_TESTS` #23 ("the tool surface equals the permission surface") would hold for
whichever provider the test happened to exercise while quietly failing for the rest. An agent
would then be able to do more, or less, depending on which model it ran against, which is
precisely the coupling ADR 0001 exists to prevent.

So there is one table, one permission filter, and a contract test (#29) asserting that both
adapters offer the same tool names for the same grants. That test fails if either adapter
grows a tool the other lacks.

## Why `fetch` rather than the OpenAI SDK
The request is a JSON body and the response is JSON. An SDK would add a second runtime
dependency to do work Node 22 already does, and would still need a compatibility shim for
OpenRouter's base URL and attribution headers. The `transport` seam is injectable, so the
translation layer is fully testable without network or credentials — the same property the
Anthropic adapter gets from its injected `client`.

This keeps the runtime dependency count at one, which is now a description of the project
rather than an aspiration.

## Why cost is reported as zero when pricing is unknown
Budgets are charged from real usage (ADR 0008). The Anthropic adapter ships with Claude Opus 5
list prices because it targets one model; the OpenAI-compatible adapter can point at any model
on any endpoint, including models whose price this project cannot know — an OpenRouter run may
resolve to a vendor with its own rates.

Guessing would put fabricated numbers into the budget ledger, and a budget that silently
mis-charges is worse than one that visibly does not charge. So cost is `0` unless `pricing` is
configured explicitly. An operator who wants budgets enforced against an OpenAI-compatible
provider supplies the rates for the model they chose.

## Consequences
`ClaudeModelAdapter` is no longer the only path to a live model, so the phrase "the live
adapter" is no longer meaningful; the console reports which provider and model it is running
against on every invocation.

The credential warning is now provider-aware: it names `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
or `OPENROUTER_API_KEY` depending on what was selected.

Adding a fourth OpenAI-compatible provider is an entry in `PRESETS`. Adding a provider with a
genuinely different protocol — Gemini, Bedrock's native API — is a new adapter that imports the
same `tools.ts`, and it must extend the #29 test rather than opt out of it.

Model-specific behaviour stays inside adapters. Nothing in the control plane branches on which
provider produced a decision, and nothing may start.
