# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Initial implementation: the control plane, the data-plane adapters, and the contracts they
agree on. No package or GitHub release has been published yet.

### Added

- **Control plane.** Agent identity, responsibilities, parameterized `{kind, scope}`
  permissions, discovery, lifecycle, scheduling mechanics, memory services, inter-agent
  messaging, and observability. It holds no orchestration graph and branches on neither agent
  id nor task text, so swapping the model adapter changes how the organization behaves
  without changing the platform.
- **Delegation with structured returns.** A manager spawns an ephemeral worker holding a
  strict subset of its own authority — derived from the manager's real grants rather than
  taken from model output — and receives a typed result back (ADR 0004, ADR 0012).
- **Peer collaboration.** Durable agents find each other in their reconstructed context and
  message sideways, with no manager in between and no delegation involved
  (`CONTRACT_TESTS` #24).
- **Context reconstruction.** Every execution is assembled from durable state under a token
  budget rather than accumulated as a transcript, so an agent holding more memory than the
  retrieval window returns is told how many records it is not being shown
  (`CONTRACT_TESTS` #25).
- **Model adapters behind one interface.** `ScriptedModelAdapter` makes the whole control
  plane deterministic under test; `ClaudeModelAdapter` lets a Claude model make the decisions
  instead (ADR 0014). Agent intent arrives as tool calls rather than prose, and a tool is
  offered only when the matching grant is held, so the tool surface is the permission surface.
  This is the default; `--scripted` selects the deterministic adapter (ADR 0015).
- **Three model providers** — Claude, OpenAI and OpenRouter, chosen with `--provider` and
  `--model` (ADR 0016). OpenAI and OpenRouter share one adapter because they share one wire
  protocol, which also makes any OpenAI-compatible endpoint reachable. All model-backed
  adapters draw their tools from one table, and a contract test asserts a provider swap cannot
  change what an agent is allowed to do (`CONTRACT_TESTS` #29).
- **A model per agent** (ADR 0017). Provider, model id and thinking level are part of an
  agent's durable definition, stored with its record and surviving restarts; changing one
  increments `revision` and is announced like any other definitional change. An agent that
  declares nothing inherits the organization default. Resolution reads the declared field and
  never the agent id, so the platform still holds no organizational knowledge
  (`CONTRACT_TESTS` #30). The context budget is sized from the window of the model the agent
  will actually run on.
- **A bounded model loop** (ADR 0013). Tool output returns to the model for another turn,
  capped at eight, with one sandbox spanning the execution and usage summed across turns.
- **Budget guardrails** — per-execution, per-agent-per-day, organization, delegation, and
  token scopes — charged from reported usage (ADR 0008).
- **Provenance tainting.** An execution that reads sandbox output taints the memories,
  artifacts, and messages it produces, and cannot claim otherwise: the control plane's
  determination overrides the agent's (`CONTRACT_TESTS` #26, #27).
- **Event-sourced observability** (ADR 0006). Correlation and causation ids thread a whole
  exchange into one readable timeline, redacted per audience.
- **Management console.** `org`, `timeline`, `events`, `agent`, `chat`, `approve`/`deny`, and
  `recover` — an organization survives process restarts and reclaims executions orphaned by a
  crash.
- **Contracts as the deliverable.** Fourteen JSON schemas as the source of truth (ADR 0011),
  thirty numbered cross-record invariants that JSON Schema cannot express, and a schema
  validator that runs with no Node installed so a contract break fails even when the
  TypeScript still compiles.
- **One runtime dependency.** The Anthropic SDK, reached through the `ModelAdapter`
  interface. Everything else is `node:sqlite`, `node:test`, and TypeScript type stripping,
  and the test suite injects its own adapter so it needs no key and no network.

### Security

- Path confinement rejects `..` in tool arguments rather than rewriting them
  (`assertArgConfined`).
- Delegated permissions are a strict subset of the manager's, enforced at the control plane.
- Per-call budget checks bound model loops and discard intent from a response that crosses a
  configured ceiling; provider charges may cross a ceiling before usage is known.
- Audit-visibility event payloads are redacted for other audiences.
- Registered provider credentials are redacted from model prompts and intent, command
  arguments/results, provider errors, and persisted tool events (`CONTRACT_TESTS` #18).

See [`SECURITY.md`](SECURITY.md) for the threat model — what the security boundary covers,
and what it deliberately leaves to the operator.

[Unreleased]: https://github.com/kdpa-llc/peers/commits/main
