# Security and Permissions

## Principle of least authority

Every execution should receive only the permissions required for its task. In the current v0
implementation, permissions are control-plane authorization records, not an operating-system
sandbox policy. The enforcement status below is part of the contract; a scope being present
in a record does not by itself make a local child process obey it.

Permissions belong to the durable agent and may be further restricted for each execution or worker.

## Permissions are parameterized

A permission is a `{kind, scope}` object, not a flat name — flat names cannot carry the
paths, allowlists, and budgets this document requires. The contract is
`docs/specs/permission.schema.json`. Examples:

```json
{ "kind": "fs.write",     "scope": { "paths": ["/workspaces/repo-x"] } }
{ "kind": "net.egress",   "scope": { "allow": ["github.com", "api.example.com"] } }
{ "kind": "model.invoke", "scope": { "budget_usd_per_day": 5 } }
{ "kind": "agent.delegate" }
```

When the control plane performs a scoped check, the audit log records the concrete grant, not
just a name. Worker-delegation subset checks understand path, host, and numeric scopes.

### Current enforcement matrix

| Permission or scope | Current enforcement |
| --- | --- |
| Permission kinds | Model calls require `model.invoke`; commands require `tool.exec` plus `sandbox.create`; permission-sensitive structured actions require their corresponding kind. Some lifecycle actions intentionally require no grant. |
| Delegated grants | A worker cannot receive a kind or scope broader than its manager holds. |
| `fs.read` / `fs.write` `paths` | Compared during delegation and enforced as virtual sandbox paths by `LocalSandbox`: readable snapshot/utility operands require `fs.read`, and `write_file` requires an `fs.write` path under `/outputs`. These checks are not kernel isolation. |
| `net.egress` `allow` / `unrestricted` | Compared during delegation. No network operation is exposed by `LocalSandbox`; it does not implement an OS-level network policy. |
| `model.invoke` budgets | `budget_usd_per_day` and `max_tokens_per_execution` are checked before and after every model call, and the remaining token authority caps requested provider output. Local USD accounting is not a provider billing quota and requires accurate model pricing; OpenAI-compatible pricing is programmatic-only today. |
| `agent.create_ephemeral` `max_concurrent` | Enforced by the control plane. |
| Sandbox `backend` / `policy` | Recorded and included in least-authority comparisons where applicable; not operationally enforced. |

## Permission categories

### Model
- allowed providers/models;
- token budget;
- spending limits.

### Filesystem
- read paths;
- write paths;
- ephemeral workspace;
- persistent workspace.

### Network
- no network;
- allowlisted domains;
- unrestricted network where explicitly permitted.

### Tools
- command execution;
- browser;
- Git;
- issue tracker;
- deployment;
- secrets access;
- database access.

### Organization
- message agents;
- delegate tasks;
- create ephemeral workers;
- propose durable agents;
- approve agent proposals;
- edit shared skills.

### Memory
- read own memory;
- mutate own memory;
- read shared memory;
- edit shared memory;
- delete durable history.

## Sandboxing

The sandbox is an adapter.

A common interface should support:

- create environment;
- mount declared inputs;
- execute command/tool;
- stream logs/events;
- collect artifacts;
- destroy environment.

Possible backends:
- local process;
- Docker;
- VM;
- microVM;
- remote cloud sandbox.

### Path rules

Mount and artifact handling is exactly where path-traversal and unsafe temp-file bugs
appear. Every backend is required to validate paths at its own boundary:

- mount destinations and artifact paths are canonicalized and verified against the
  per-execution root before use;
- reject `..` traversal, absolute paths outside the root, and symlink escapes at mount and
  artifact boundaries;
- artifact collection writes only into a dedicated per-execution output directory;
- treat every path check as defense in depth, not as a substitute for OS isolation.

`LocalSandbox` exposes only `ls`, `cat`, `grep`, `wc`, `head`, `tail`, `echo`, and a bounded
`write_file` operation. It removes unsafe flags, interpreters, and network clients; limits
the mounted snapshot and command operands using virtual `fs.*` paths; and removes execution
roots after collecting outputs into separate durable storage. It still runs same-user
utilities and is intended only for trusted, single-operator workloads. A container, VM,
microVM, or remote backend must provide kernel and network boundaries when required.

### Secrets brokering

There is no general secrets broker in v0. Supported model-provider credentials are read by
their adapters from the Peers process environment or supplied programmatically to an adapter.
Their exact values are registered with the runtime and redacted from assembled prompts,
model-generated intent, command arguments/results, provider errors, and stored tool events.
`LocalSandbox` gives
child processes only a fixed `PATH` and sandbox-local `HOME`, so provider variables are not
inherited.

Workspace snapshots also omit common secret inputs (`.git`, `.env*`, `.npmrc`, private-key
files, credential JSON, databases, and Peers state). This cannot identify every secret:
any other file covered by `fs.read` may reach the selected model provider when read. Operators
must keep arbitrary secrets outside readable scopes. A future broker should use named
references and scoped, short-lived credentials, preferably injected at a proxy boundary.

## Untrusted content and provenance

Agents process untrusted input (repository contents, web pages, external documents). An
agent steered by injected content will emit well-formed, policy-compliant messages and
plausible memory proposals — taint propagates through exactly the structured channels the
platform provides. Full injection defense is out of scope for v0, but recording provenance
is not: artifacts, inbox items, and memory proposals carry an optional `provenance` field
(`trusted` | `untrusted_content` | `external`) from day one, so later policy can act on it.

Corollary for governance: **review of proposals must assume the proposal may be
adversarial.** A compromised agent's "improvement" to a shared skill is the
highest-leverage attack in a self-improving organization.

## Human approval

Some actions may require an approval token.

Examples:
- external deployment;
- destructive infrastructure change;
- sending external communications;
- granting permissions;
- creating durable agents;
- modifying the platform constitution.

Approvals should be structured records, not informal phrases buried inside transcripts —
the contract is `docs/specs/approval.schema.json`.

## Audit

Every privileged action should record:
- actor agent;
- execution;
- permission checked (the concrete `{kind, scope}` grant);
- action;
- result;
- timestamp;
- associated human approval if required.

## Event payload redaction and retention

Raw tool output is not persisted. Audit events record the utility name, argument count, exit
status, and output byte counts; arguments and content remain out of the event store. Output
needed for reasoning is returned to the next model turn after exact provider-credential
redaction. Other event payloads still live in plaintext SQLite: visibility is not encryption,
an access-control system, or a retention policy.
