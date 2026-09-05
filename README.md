<div align="center">

# 👥 Peers

**Run long-lived AI agents that own a responsibility, keep their own memory, and coordinate as peers**

[![License: MIT][license-badge]][license]
[![Node][node-badge]][nodejs]
[![Runtime deps][deps-badge]][package-json]

[![CI][ci-badge]][ci-workflow]
[![CodeQL][codeql-badge]][codeql-workflow]

[![GitHub Stars][stars-badge]][stargazers]
[![GitHub Forks][forks-badge]][network]
[![GitHub Issues][issues-badge]][repo-issues]
[![GitHub Last Commit][commit-badge]][commits]
[![PRs Welcome][prs-badge]][contributing]

[Quick Start](#-quick-start) •
[Features](#-features) •
[Configuration](#-configuration) •
[Architecture](#️-architecture) •
[Contracts](#-contracts) •
[Security](#-security) •
[FAQ](#-faq) •
[Contributing](#-contributing)

</div>

---

## 📑 Table of Contents

- [What is Peers?](#what-is-peers)
- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [🎯 Usage](#-usage)
- [🔧 Configuration](#-configuration)
- [🏗️ Architecture](#️-architecture)
- [📐 Contracts](#-contracts)
- [🔒 Security](#-security)
- [❓ FAQ](#-faq)
- [🧪 Testing](#-testing)
- [🤝 Contributing](#-contributing)
- [🔗 Complementary Projects](#-complementary-projects)
- [💖 Support This Project](#-support-this-project)

---

## What is Peers?

A **control plane for long-lived, responsibility-driven AI agents**. Each agent has a stable
identity, an explicit responsibility, its own memory, tools, inbox, execution environment,
and autonomy within policy. Agents delegate work, message peers, spawn temporary workers,
and — subject to permission — propose new agents.

The control plane provides mechanics and guardrails. It does **not** encode the intelligence
of the organization: there is no orchestration graph, and no branch anywhere on agent id or
task text. Swap the model adapter and the organization behaves differently with zero platform
changes — a claim the test suite checks rather than asserts.

It is written for people **building** agent systems, and for anyone who wants to read the
architecture of one: the contracts, the permission model and the event log are written down
rather than implied. It is not an assistant and not a product — it is the machinery an
assistant would sit on top of.

### 🆚 When to reach for this

Reach for Peers when the work is open-ended and long-running: agents that hold a
responsibility over weeks, accumulate memory about a system, and hand work to each other
without a human sequencing every step. Do not reach for it when the steps are known in
advance — a workflow engine will run a fixed pipeline more cheaply and more predictably than
an agent reasoning its way to the same place. Do not reach for it when a single assistant in
a single conversation would do; the coordination machinery here only starts paying for
itself once several agents outlive one exchange. And read [Security](#-security) before
pointing it at anything you care about: the bundled sandbox confines paths in code rather
than in the kernel, so it belongs on a machine and a repository you trust.

## ✨ Features

- **🧠 Context reconstruction, not transcript accumulation** — every execution is assembled from durable state under a token budget, so cost per execution is bounded rather than growing with history
- **🌳 Delegation with structured returns** — a manager spawns an ephemeral worker with a strict subset of its own authority, and gets a typed result back
- **🤝 Peer collaboration** — durable agents discover each other from context and message sideways, with no manager in between
- **🔐 Parameterized permissions** — `{kind, scope}` grants checked in the control plane at dispatch; a worker's authority is a subset of its manager's *by construction*
- **💰 Per-call budget gates** — execution, agent-day, organization, delegation, and token limits checked around every model call; USD accuracy depends on configured model pricing
- **🏷️ Provenance tainting** — an execution that reads sandbox output taints what it produces, and cannot claim otherwise
- **📼 Event-sourced observability** — correlation and causation ids thread a whole exchange into one readable timeline
- **🔌 Adapters all the way down** — models, sandboxes, stores and runtimes sit behind explicit interfaces
- **🔀 Claude, OpenAI or OpenRouter** — one tool surface across all three, with a contract test asserting a provider swap cannot change what an agent is allowed to do
- **🎚️ A model per agent** — provider, model and thinking level are part of an agent's durable definition, so a security reviewer can think deeper than a chore-filer and still be there after a restart
- **📦 One runtime dependency** — the Anthropic SDK. Everything else is `node:sqlite`, `node:test`, and TypeScript type stripping

## 🚀 Quick Start

### Prerequisites

- **Node.js 22.13+** — the first Node 22 release where `node:sqlite` works without a runtime
  flag. Contributor commands use Node's built-in TypeScript type stripping.
- **An API key for one provider** — the console runs against a real model by default:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`. Pass `--scripted` to run
  without one.
- **Python 3 with `jsonschema`** — *optional*. Only `python3 scripts/validate-schemas.py`
  needs it; the tests and the console do not.

### 1. Install

```bash
git clone https://github.com/kdpa-llc/peers
cd peers
npm install
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / OPENROUTER_API_KEY
```

### 2. Run an organization

State lives in a SQLite file, so an organization survives process restarts. Point Peers at
your repository, register an agent from the checked-in creation manifest, and give it work:

```bash
export PEERS_DB=./my-org.db
export PEERS_WORKSPACE=/path/to/your/repo
npm run peers -- agent create --file examples/agent.json
npm run peers -- task create --file examples/task.json
npm run peers -- run                                   # one cycle, then exit
# Or choose the long-lived process instead:
npm run peers -- start                                 # stay up and poll continuously
npm run peers -- org                                   # who exists, what they own
npm run peers -- timeline                              # normalized, low-noise history
npm run peers -- agent repo-maintainer                 # drill into one agent
npm run peers -- chat repo-maintainer "why delegate?"  # direct human intervention
npm run peers -- recover                               # orphan recovery after a crash
```

The JSON files are creation manifests, not stored records: Peers validates them, rejects
unknown fields, and supplies ids, timestamps, status, and revisions owned by the control
plane. You can also create both records directly from the command line:

```bash
npm run peers -- agent create \
  --id docs-maintainer --name "Docs Maintainer" \
  --responsibility "Keep documentation accurate" \
  --mission "Find and fix the highest-impact documentation gaps" \
  --permission model.invoke --permission memory.write_own
npm run peers -- task create --recipient docs-maintainer \
  --objective "Audit the getting-started guide" --priority 2
```

File manifests are the right choice for scoped permissions, model selection, subscriptions,
and the rest of an agent's durable definition. Inline creation is convenient for a small
agent or an ad-hoc task; no permissions are granted implicitly.

The agent receives its task and decides what to do from its responsibility and reconstructed
context. Those decisions are the model's ([ADR 0014][adr-0014]) — the control plane contains
no branch that produces them.

Claude is the default. `--provider` picks another, and `--model` picks a model within it
([ADR 0016][adr-0016]):

```bash
npm run peers -- run --provider openai
npm run peers -- run --provider openrouter --model anthropic/claude-opus-4
npm run peers -- run --model claude-sonnet-5
```

OpenAI and OpenRouter share one adapter because they share one wire protocol. Programmatic
users can give that adapter another `baseURL` for a compatible endpoint; the CLI currently
offers the two named presets. All three providers expose the same tools for the same grants,
and a contract test fails if that ever stops being true.

Those flags set the organization's default. An individual agent can hold its own, recorded on
its record alongside its permissions and surviving restarts ([ADR 0017][adr-0017]):

```bash
npm run peers -- model security-reviewer --provider claude --thinking max
npm run peers -- model chore-filer --provider openai --model gpt-5-mini --thinking low
npm run peers -- model security-reviewer reset      # back to the organization default
npm run peers -- agent security-reviewer            # shows the effective model and where it came from
```

### 3. Run the deterministic demo

`--scripted` swaps the model for a fixed script ([ADR 0015][adr-0015]). No API key, no
network, no cost, and identical output from one run to the next — which is why CI uses it.
`seed` is retained for this reference scenario; real organizations should use `agent create`
and `task create`:

```bash
npm run peers -- seed --scripted
npm run peers -- run --scripted
npm run peers -- timeline --scripted
```

```text
Repository Maintainer created — Repository Maintainer: Keep repository checkout-service healthy, tested …
Repository Maintainer accepted the task
Worker worker-001 created — Worker worker-001: Analyze the failing tests and return root cause plus evidence.
Repository Maintainer delegated to worker-001: Analyze the failing tests and return root cause plus evidence.
Repository Maintainer is waiting on task_completed (timeout 1800s)
Worker worker-001 accepted the task
Worker worker-001 produced file: .peers-artifacts/peers-exec-002-…/outputs/root-cause.md
Repository Maintainer received worker result — Timeout regression: checkout test exceeds the 2000ms default.
wait.satisfied: wait wait-001 satisfied
Worker worker-001 retired
Repository Maintainer recorded a learning — create mem-001 r1: Durable architectural fact recovered from a worker …
Repository Maintainer completed the task — Identified the checkout timeout regression as the top maintenance issue.
```

Timestamps and event ids are elided above and the durable artifact path is shortened. Same control
plane, same events, same permissions, same budgets — only the source of the decisions
differs, which is the whole claim.

## 🎯 Usage

The management console is the primary surface. The organization view answers *who exists,
what they own, what is happening, what needs attention*; chatting with one agent is a
drill-down, not the home screen.

| Command | What it shows |
| --- | --- |
| `agent create` | Register a durable agent from `--file <agent.json>` or explicit fields |
| `task create` | Assign work from `--file <task.json>` or `--recipient` and `--objective` |
| `seed` | Seed the hard-coded deterministic reference scenario (demo/CI only) |
| `run` | Drive eligible work to quiescence once, then exit |
| `start` | Keep draining eligible work; gracefully stop on `SIGINT` or `SIGTERM` |
| `org` | Every durable agent, its state, its responsibility, and anything needing attention |
| `timeline` | The normalized, low-noise history of the whole organization, redacted to the user audience |
| `events` | The raw event log, straight from the store; `--since <seq>` pages from a sequence number |
| `agent <id>` | One agent: permissions, executions (with failure detail), inbox, memory |
| `chat <id> "…"` | Send a message as a human and let the agent respond |
| `model <id>` | Set the agent's own provider, model and thinking level; `reset` returns it to the default |
| `approve` / `deny` | Act on pending approval records |
| `recover` | Re-establish executions orphaned by a crash |
| `--help` / `--version` | Show command help or the installed package version without opening the database |

## 🔧 Configuration

### Environment Variables

The console reads these variables directly ([`src/cli/main.ts`][cli-main]):

- **`PEERS_DB`** — path to the SQLite file the organization lives in. Default:
  `.peers.db` in the working directory. Point it elsewhere to keep several independent
  organizations side by side.
- **`PEERS_WORKSPACE`** — the repository root mounted into agent sandboxes. **This is how
  you aim the organization at your own code.** When unset, real providers use the current
  directory. Scripted demo runs generate their known throwaway fixture under the system temp
  directory.
- **`PEERS_ARTIFACTS`** — durable storage for verified sandbox outputs. Default:
  `.peers-artifacts` in the working directory.
- **`PEERS_INTERVAL_MS`** — polling interval for `start`, in milliseconds. Default: `1000`.
  `--interval-ms` overrides it for one invocation.
- **`ANTHROPIC_API_KEY`** (or **`ANTHROPIC_AUTH_TOKEN`**), **`OPENAI_API_KEY`**, and
  **`OPENROUTER_API_KEY`** — the credential for the selected provider. Required unless you
  pass `--scripted`; the console names the one it wanted if it is missing.
- **`PEERS_PROVIDER`**, **`PEERS_MODEL`** and **`PEERS_THINKING`** — defaults for
  `--provider`, `--model` and `--thinking`, so a shell can be pointed at one provider once.
  An agent's own `model_config` overrides all of them.

OpenAI/OpenRouter return token counts but not a portable dollar cost. Their adapter therefore
records `$0` unless a programmatic caller supplies its `pricing` option; the CLI does not expose
that option yet. Token/turn limits still apply, but use provider-side spending limits because
the CLI's USD gates cannot be accurate for those providers.

```bash
export PEERS_DB=./my-org.db
export PEERS_WORKSPACE=/path/to/your/repo
npm run peers -- agent create --file examples/agent.json
npm run peers -- task create --file examples/task.json
npm run peers -- run
```

### Command-Line Options

**`--provider <name>`** — `claude` (default), `openai`, `openrouter`, or `scripted`
([ADR 0016][adr-0016]). **`--model <id>`** picks a model within the provider, and
**`--thinking <level>`** sets reasoning depth: `low`, `medium`, `high`, `xhigh` or `max`.
These are the organization's defaults; an agent's own declaration wins ([ADR 0017][adr-0017]).
**`--scripted`** is shorthand for `--provider scripted` ([ADR 0015][adr-0015]).

Selection flags apply to any console command and are stripped before the command is parsed, so
`run --provider openai` and `--provider openai run` are the same. Both `--provider x` and
`--provider=x` work. Without `--scripted`, a run costs money and is not deterministic.

**`timeline [n]`** — number of timeline entries to print. Default: `40`.

**`events [--since <seq>]`** — start the raw event dump at a sequence number. Default: `0`.

**`start [--interval-ms <milliseconds>]`** — continuously drain eligible work, then poll
again after the configured interval. The first cycle runs immediately. `Ctrl-C` (`SIGINT`)
and `SIGTERM` stop cleanly after any in-flight cycle finishes. Use `run` for one cycle and
exit, such as from cron or CI.

**`agent create --file <agent.json>`** — register a validated durable agent. Alternatively,
pass `--id`, `--name`, `--responsibility`, and `--mission`; repeat `--permission`, `--skill`,
or `--success-criterion` as needed. Inline permissions are unscoped, so use a file manifest
when a permission needs path, host, budget, or concurrency limits. Creation refuses to
replace an existing agent id.

**`task create --file <task.json>`** — create and deliver validated work. Alternatively,
pass `--recipient` and `--objective`, plus optional `--sender`, `--expected-output`,
`--priority`, `--deadline`, repeated `--constraint`, or repeated `--context-ref`. The sender
defaults to `human:cli`; the recipient must already be a durable agent.

## 🏗️ Architecture

Two layers, deliberately separated ([ADR 0001][adr-0001]):

- **Control plane** — identity, responsibilities, permissions, discovery, lifecycle,
  scheduling mechanics, memory services, inter-agent messaging, observability, UI.
- **Data plane / agent runtime** — agent sessions, tools, sandboxes, model calls, event
  streams.

The scheduler owns *eligibility*; the agent owns *intent* ([ADR 0002][adr-0002]). The control
plane never decides what an agent should want.

Three documents cover most of it:

1. [`PROJECT_CONSTITUTION.md`](https://github.com/kdpa-llc/peers/blob/main/PROJECT_CONSTITUTION.md) — the architectural north star, and
   the rules the project holds itself to
2. [`docs/ARCHITECTURE.md`](https://github.com/kdpa-llc/peers/blob/main/docs/ARCHITECTURE.md) — how the two layers are laid out
3. [`docs/adr/`](https://github.com/kdpa-llc/peers/tree/main/docs/adr) — the decisions, and why

The schemas in [`docs/specs/`](https://github.com/kdpa-llc/peers/tree/main/docs/specs) are the source of truth for every shape these
layers exchange, and [`docs/`](https://github.com/kdpa-llc/peers/tree/main/docs) covers the execution model, memory and context, the
permission model, and observability in depth.

## 📐 Contracts

The contracts are the deliverable. Implementations are meant to be replaceable; the shapes
they agree on are not.

- **[`docs/specs/*.json`](https://github.com/kdpa-llc/peers/tree/main/docs/specs)** — JSON Schema is the source of truth
  ([ADR 0011][adr-0011]). Change a schema *before* the TypeScript that mirrors it.
- **[`docs/specs/CONTRACT_TESTS.md`](https://github.com/kdpa-llc/peers/blob/main/docs/specs/CONTRACT_TESTS.md)** — the 30 cross-record
  invariants JSON Schema cannot express, numbered. Tests cite the number they enforce.

```bash
pip install jsonschema
python3 scripts/validate-schemas.py
```

That script installs no Node on purpose: a schema change that breaks the shapes the control
plane emits fails there even when the TypeScript still compiles.

Schema fields that are recorded but **not yet enforced** say so in their own description — a
scope key that bounds nothing is worse than an absent one.

## 🔒 Security

[`SECURITY.md`](https://github.com/kdpa-llc/peers/blob/main/SECURITY.md) carries the full threat model — what the security boundary
covers, and what it deliberately leaves to the operator. The short version:

- **`LocalSandbox` is not a kernel boundary.** It exposes only constrained file utilities,
  enforces virtual filesystem scopes in code, and removes execution roots, but its processes
  still run as the same OS user.
- **Prompt injection is expected, not prevented.** Agents read files they do not control, and
  a persuasive file can convince a model. Permission and per-call budget gates limit the
  available mechanics; provenance *labels* derived content, it does not defend against it.
- **Nothing is multi-tenant.** No authentication, no authorization, no encryption at rest.

Report vulnerabilities through [private advisories][security-advisories], not public issues.

## ❓ FAQ

<details>
<summary><strong>Q: Is this a workflow engine or an agent framework?</strong></summary>
<p>Neither. It is a control plane. There is no graph to author and no chain to configure — agents decide what to do from their responsibility and their reconstructed context, and the platform supplies identity, permissions, budgets, memory, messaging, and observability around that.</p>
</details>

<details>
<summary><strong>Q: Do I need an API key to try it?</strong></summary>
<p>For the tests, no — <code>npm test</code> injects a scripted adapter and needs no key, no network and no wall-clock time. For the console, yes: it runs against a real model by default, because that is the point of it. Any one of <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code> or <code>OPENROUTER_API_KEY</code> will do, and <code>--scripted</code> gives you the keyless path on any command.</p>
</details>

<details>
<summary><strong>Q: Which models does it support?</strong></summary>
<p>Claude, OpenAI, and anything OpenRouter proxies. Programmatic users of <code>OpenAIModelAdapter</code> can also pass <code>baseURL</code> for another OpenAI-compatible endpoint, including a local one; the CLI does not expose that option yet. Three adapters ship: <code>ClaudeModelAdapter</code>, <code>OpenAIModelAdapter</code> (which serves OpenAI and OpenRouter, since they share a wire protocol) and <code>ScriptedModelAdapter</code> (deterministic, used by CI). The interface is deliberately small — <code>complete(req) → { actions, usage, tool_calls? }</code> — so a provider with a genuinely different protocol is a new file that imports the same tool table.</p>
</details>

<details>
<summary><strong>Q: Why only one runtime dependency?</strong></summary>
<p>Because the contracts are the point and the implementation should be easy to replace. <code>node:sqlite</code>, <code>node:test</code>, and type stripping cover everything else, so the only thing pulled in is the SDK that talks to the model — and that is reached through the <code>ModelAdapter</code> interface, so replacing it is a file, not a rewrite.</p>
</details>

<details>
<summary><strong>Q: Can agents create other agents?</strong></summary>
<p>They can create ephemeral workers, subject to an <code>agent.create_ephemeral</code> grant and its <code>max_concurrent</code> cap. Durable agents can only be <em>proposed</em> — a human creates them. That is a deliberate constraint, not a missing feature.</p>
</details>

<details>
<summary><strong>Q: Is it safe to run against my own repository?</strong></summary>
<p>Against one you trust, on a machine where the blast radius is acceptable, yes. Not against untrusted input — the local sandbox is not an isolation boundary. See <a href="https://github.com/kdpa-llc/peers/blob/main/SECURITY.md">SECURITY.md</a>.</p>
</details>

<details>
<summary><strong>Q: How do I add a new capability an agent can use?</strong></summary>
<p>Add the action to the <code>AgentAction</code> union and dispatch, gate it on a permission, and add a numbered entry to <code>CONTRACT_TESTS.md</code> if it introduces a cross-record rule. Never branch on agent id or task text in the control plane.</p>
</details>

## 🧪 Testing

The suite is deterministic: fixed clock, sequential ids, scripted model adapter, in-memory
SQLite. No network, no API key, no wall-clock time ([ADR 0015][adr-0015]).

```bash
npm test                              # deterministic contract + acceptance tests
npm run typecheck                     # tsc --noEmit
npm run build                         # emitted ESM + declarations in dist/
npm run test:package                  # pack, clean-install, import, and run the CLI
python3 scripts/validate-schemas.py   # schemas, independent of the implementation
```

CI runs exactly these, plus a management-console smoke test that proves an organization
survives a process restart. The npm package is intentionally private until scope ownership
and the release credential are verified; the [release guide](https://github.com/kdpa-llc/peers/blob/main/RELEASING.md)
documents the safety gate and the planned tag-based flow.

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md][contributing] for guidelines — including the
conventions that will trip you up, and what this repository deliberately does **not** have.

Quick start:

1. Fork the repository
2. Create your feature branch
3. Make your changes and test
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/)
5. Open a Pull Request

Note: This project follows a [Code of Conduct][code-of-conduct].

## 🔗 Complementary Projects

**Other MCP and AI tooling from KDPA:**

### [Local Skills MCP][local-skills-mcp]

**Portable, reusable prompt libraries for any MCP client** — write expert skills once and use
them across Claude Code, Cline, Continue.dev, or custom agents, with lazy loading so only
names and descriptions occupy context.

### [MCP Compression Proxy][mcp-compression-proxy]

**Aggregate tools from multiple MCP servers with LLM-based description compression** — 50–80%
token reduction across your tool surface.

## 💖 Support This Project

If you find Peers useful, please consider supporting its development!

<div align="center">

[![GitHub Sponsors][sponsor-github-badge]][sponsor-github]
[![Buy Me A Coffee][sponsor-coffee-badge]][sponsor-coffee]
[![PayPal][sponsor-paypal-badge]][sponsor-paypal]

</div>

**Ways to support:**

- ⭐ [Star this repository][stargazers]
- 💰 Sponsor via the badges above
- 🐛 [Report bugs and suggest features][repo-issues]
- 📝 [Contribute code or documentation][contributing]

## 📄 License

MIT License - see [LICENSE][license-file] file. **Copyright © 2026 KDPA**

## 🙏 Acknowledgments

Built on the [Claude API][claude-api], and on the idea that an organization is a better
metaphor for coordinated intelligence than a pipeline.

---

<div align="center">

**[⬆ Back to Top](#-peers)**

Made with ❤️ by KDPA

</div>

[license-badge]: https://img.shields.io/badge/License-MIT-yellow.svg
[license]: https://opensource.org/licenses/MIT
[license-file]: https://github.com/kdpa-llc/peers/blob/main/LICENSE
[node-badge]: https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg
[nodejs]: https://nodejs.org/
[deps-badge]: https://img.shields.io/badge/runtime%20deps-1-blue.svg
[package-json]: https://github.com/kdpa-llc/peers/blob/main/package.json
[ci-badge]: https://github.com/kdpa-llc/peers/actions/workflows/ci.yml/badge.svg
[ci-workflow]: https://github.com/kdpa-llc/peers/actions/workflows/ci.yml
[codeql-badge]: https://github.com/kdpa-llc/peers/actions/workflows/codeql.yml/badge.svg
[codeql-workflow]: https://github.com/kdpa-llc/peers/actions/workflows/codeql.yml
[stars-badge]: https://img.shields.io/github/stars/kdpa-llc/peers?style=social
[stargazers]: https://github.com/kdpa-llc/peers/stargazers
[forks-badge]: https://img.shields.io/github/forks/kdpa-llc/peers?style=social
[network]: https://github.com/kdpa-llc/peers/network/members
[issues-badge]: https://img.shields.io/github/issues/kdpa-llc/peers
[repo-issues]: https://github.com/kdpa-llc/peers/issues
[commit-badge]: https://img.shields.io/github/last-commit/kdpa-llc/peers
[commits]: https://github.com/kdpa-llc/peers/commits/main
[prs-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg
[contributing]: https://github.com/kdpa-llc/peers/blob/main/CONTRIBUTING.md
[code-of-conduct]: https://github.com/kdpa-llc/peers/blob/main/CODE_OF_CONDUCT.md
[cli-main]: https://github.com/kdpa-llc/peers/blob/main/src/cli/main.ts
[security-advisories]: https://github.com/kdpa-llc/peers/security/advisories/new
[adr-0001]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0001-control-plane-data-plane.md
[adr-0002]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0002-agent-autonomy-scheduler.md
[adr-0011]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0011-schemas-are-source-of-truth.md
[adr-0014]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0014-claude-model-adapter.md
[adr-0015]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0015-model-is-the-default.md
[adr-0016]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0016-multiple-model-providers.md
[adr-0017]: https://github.com/kdpa-llc/peers/blob/main/docs/adr/0017-per-agent-model.md
[sponsor-github-badge]: https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=github
[sponsor-github]: https://github.com/sponsors/moscaverd
[sponsor-coffee-badge]: https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee
[sponsor-coffee]: https://buymeacoffee.com/moscaverd
[sponsor-paypal-badge]: https://img.shields.io/badge/PayPal-donate-blue?logo=paypal
[sponsor-paypal]: https://paypal.me/moscaverd
[claude-api]: https://docs.claude.com/
[local-skills-mcp]: https://github.com/kdpa-llc/local-skills-mcp
[mcp-compression-proxy]: https://github.com/kdpa-llc/mcp-compression-proxy
