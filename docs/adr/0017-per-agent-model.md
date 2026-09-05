# ADR 0017 — An Agent's Model Is Part of Its Definition

## Status
Accepted

## Decision
`Agent.model_config` records the provider, model id, and thinking level an agent runs on. It
is stored with the agent, survives restarts, and changing it increments `revision` and emits
`agent.updated` — the same treatment every other definitional change gets.

An agent that declares nothing inherits the organization default, which the console sets with
`--provider`, `--model` and `--thinking`. `peers model <agent_id> [flags]` sets an agent's own,
and `peers model <agent_id> reset` returns it to the default.

`ModelResolver` turns a declaration into an adapter. The runtime accepts either a single
adapter — every agent thinks with the same model — or a resolver.

## Why this belongs on the agent
The organization already says that an agent is defined by what it owns and what it may do. Its
permissions are stored on the record; nobody would accept "which permissions this agent has"
being a property of how one run happened to be invoked. The model is the same kind of fact.

An agent reasoning about supply-chain security wants depth. An agent filing chores wants
throughput and a smaller bill. Making that a console flag means the distinction lives in
whoever typed the command, is lost on restart, and cannot differ between two agents running in
the same drain. Making it a field means the organization can be described, checked into a
repository, and restored.

It also makes the cost picture legible. Budgets are per-agent already (ADR 0008); with a model
per agent, an expensive agent is expensive for a reason recorded next to its budget.

## Why resolution reads a field and never an identity
`ModelResolver` takes a `ModelConfig`. It is not given the agent, and it never sees an
`agent_id` — enforced by a structural test alongside the behavioural ones (`CONTRACT_TESTS`
#30).

This is the same line ADR 0001 and Constitution §2 draw everywhere else. "The reviewer should
use a deeper model" is organizational knowledge. If the platform learned it, the platform would
be making an organizational decision, and the next such rule would be easier to add than to
resist. Instead the operator writes it on the agent, and the platform reads what is written.

## Why a fresh adapter per execution
Adapters hold a conversation buffer scoped to one execution (Constitution §5). Handing the same
instance to two executions would make that guarantee depend on them never interleaving, which
is a property of the scheduler rather than of the adapter. Constructing an adapter is cheap —
the provider client is built lazily on first call — so the resolver returns a new one per
execution and the invariant holds structurally.

## Why a provider change drops an inherited model id
A model id belongs to a provider. If an agent overrides only the provider, inheriting the
default's model id would send, say, `claude-opus-5` to OpenAI — a name it has never heard of,
and a confusing runtime failure rather than a configuration error. Thinking level is
provider-neutral, so that one does carry over.

## Consequences
The context budget is now sized per agent, from the window of the model that agent will
actually run on, rather than from a single global number.

Thinking level is mapped onto each provider's own parameter: Anthropic's effort takes all five
levels; Chat Completions' `reasoning_effort` takes three, so `high`, `xhigh` and `max` collapse
onto `high`. The collapse is lossy in one direction only — an agent asking for more thinking
than a provider can express gets the most it offers rather than an API error.

`peers agent <id>` reports the effective model and whether it came from the agent's own
declaration or the organization default, so an operator can tell the two apart without reading
the database.
