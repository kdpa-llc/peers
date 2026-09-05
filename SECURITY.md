# Security Policy

## Supported Versions

Fixes land on `main`. The project has not published a release yet, so only the current
default branch is supported.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |

## Reporting a Vulnerability

**Please do not open a public issue for a vulnerability.**

Use [GitHub's private vulnerability reporting](https://github.com/kdpa-llc/peers/security/advisories/new)
on this repository; private vulnerability reporting is enabled. If GitHub does not make that
form available to you, open an issue containing only "security report, requesting private
contact" and nothing else, and a maintainer will follow up. The issue and its metadata are
public; do not include vulnerability details there.

Please include what you would want to receive yourself: what the flaw is, how to reproduce
it, what an attacker gets, and a suggested fix if you have one.

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 5 business days
- **Updates**: while we work on it
- **Credit**: in the advisory, unless you would rather stay anonymous

Please give us reasonable time to fix an issue before disclosing it publicly.

## Threat model

This section matters more than the process above. An agent platform has an unusual threat
model, and being vague about it would be worse than saying nothing. What follows is the
security boundary this project claims, and the boundary it deliberately does not.

### The local sandbox is not an isolation boundary

`LocalSandbox` runs a small set of file utilities as the same OS user as the process that
started it. It removes interpreter and network-capable commands, validates each supported
option and filesystem operand, enforces virtual `fs.read`/`fs.write` paths, rejects escaping
links, and gives subprocesses a minimal environment. These are code-level controls, not a
kernel boundary; do not treat them as containment for hostile native code.

The `Sandbox` interface (ADR 0005) exists so a container, VM, or microVM backend can be
dropped in where hostile-code isolation is required. `LocalSandbox` is the backend for
trusted repositories under a single operator.

### Prompt injection is expected, not prevented

Agents read files they do not control. Text in a source file, a log, or a dependency can
address the agent reading it, and a sufficiently persuasive file can convince a model to try
something its author did not intend. Nothing here prevents that, and we do not claim to
detect it.

What the current design does instead is record authority and apply selected control-plane
gates:

- **Permission gates.** Model calls require `model.invoke`; sandbox commands require both
  `tool.exec` and `sandbox.create`. `LocalSandbox` limits readable snapshots and command
  operands to `fs.read` paths and limits `write_file` to `fs.write` paths under `outputs/`.
  A worker's grants must also be equal to or narrower than its manager's grants
  (`CONTRACT_TESTS` #5, #23). `net.egress` is not an implemented capability: the local
  command surface exposes no network client, but there is no OS-level network policy.
- **Budget accounting.** Every model call has pre- and post-call checks at the execution,
  agent-day, organization, delegation, and token scopes. Actual usage is persisted before a
  response may run tools or actions. This is not a billing-system quota: estimates can be
  wrong, a response can cross a limit before its cost is known, and OpenAI-compatible USD
  accounting requires programmatically supplied model pricing (not currently exposed by the
  CLI). Provider output requests are capped by remaining token authority, but input estimates
  and provider reporting remain part of the boundary.
- **Provenance.** An execution that reads sandbox output taints the memories, artifacts, and
  messages it produces (`CONTRACT_TESTS` #26, #27). The control plane makes that
  determination, not the agent — an agent that has just read attacker-controlled text is the
  last thing that should get to declare its own output trusted. This is **labelling, not
  defense**: it does not stop anything, it makes the origin of a claim recoverable later.
- **Bounded model loops.** An execution runs at most `MAX_TURNS` model turns (ADR 0013), so a
  model that never decides anything costs a bounded amount.

### Credentials, tool output, and model data

The supported model credentials are `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY`, and `OPENROUTER_API_KEY`. Provider adapters read these from the process
environment or accept them programmatically. Their exact configured values are registered
with the runtime and redacted at the final boundary from assembled prompts, model-generated
intent, command arguments/results, provider error messages, and persisted tool events.
`LocalSandbox` does not inherit them in its subprocess environment.

This is not general secret detection. Workspace snapshots omit `.git`, `.env*`, `.npmrc`,
common private-key/credential files, databases, and Peers state, but an arbitrary secret
can have any filename or value. Any other file deliberately covered by `fs.read` may be sent
to the model when read. Raw command output is returned to the next model turn after provider
credential redaction; events persist only exit status and byte counts, not the output.
Keep all other secrets outside readable scopes.

A model run sends reconstructed agent context and tool results to the selected provider:
Anthropic, OpenAI, or OpenRouter. Their data-handling terms therefore apply to that content.
The `scripted` adapter is the local, credential-free option used by tests.

### Out of scope

Deliberate non-goals, listed so nobody assumes otherwise:

- No authentication, authorization, or multi-tenancy. Anyone who can run the CLI is the
  operator, with full authority over every agent.
- No host-level network egress policy. `net.egress` scopes are represented and compared when
  worker grants are derived, but the current local backend exposes no network operation.
- No kernel-level filesystem isolation. Local path scopes are enforced by the command and
  snapshot code and remain defense in depth around same-user utilities.
- No reliable automated detection or redaction of arbitrary secrets. Named provider
  credentials and common secret-file classes receive explicit protection.
- No rate limiting and no hard provider-side spending quota. Cost budgets are local
  pre-call guardrails based on estimates and reported usage.
- No encryption at rest. The SQLite file holds agent memory and event history in plaintext.
- No supply-chain verification of the one runtime dependency beyond `npm ci` and the
  lockfile.

## If you are evaluating this for real use

Run it against repositories and workloads you trust, on a machine where the local process's
blast radius is acceptable, with provider-side spending limits and an API budget you are
willing to lose. Keep mounted workspaces free of credentials. The architecture and its
contracts are the deliverable; isolation and hard egress controls are the operator's to
supply through another `Sandbox` backend and its environment.
