# ADR 0018 — The Control Plane Is Not Built on an External Agent Harness

## Status
Accepted

## Decision
Peers keeps its own execution loop. It does not adopt an external coding-agent harness —
Codex CLI, Claude Code, or similar — as the foundation on which agents run.

The option is not closed. A harness may later be added as **one `Runtime` backend among
several**, selected per agent the way `model_config` selects a provider (ADR 0017). That
requires extracting a `Runtime` interface first: `controlPlane.ts:32` currently imports the
concrete `AgentRuntime`.

## What was investigated
The question was whether an existing open-source harness could supply the machinery a
long-lived agent needs, rather than rebuilding and re-testing it here. The test case was a
concrete scenario: an agent that watches deployment pipelines hourly, root-causes a blocker,
messages a human with the finding and a question, accepts a conversational correction
("always ship with >90% coverage"), remembers it, prepares a change, and waits for CI it does
not control.

Decomposing that scenario against the current code:

| Capability the scenario needs | State today |
| --- | --- |
| Create the agent from an external coding session | `createAgent` exists; needs an MCP or skill surface |
| Wake on a clock, hourly or daily | `tick()` (`controlPlane.ts:281`) sweeps expired waits and wakes their agents. **Nothing calls it on a clock** — no `setInterval` exists anywhere in `src/` |
| Reach the pipeline over the network | **Missing.** `net.egress` scopes are represented and compared during delegation, but no HTTP tool or OS-level network policy exists |
| Root-cause in a sandbox | Exists |
| Message a human and ask a question | Partial. Messages send; `attentionNeeded` (`observer.ts:138`) surfaces only blocked agents and pending approvals, so an unanswered question is invisible |
| Human replies in natural language | Exists (`peers chat`) |
| Remember a durable instruction | Exists — `propose_memory_update`, revision chain, approval gate |
| Wait for something outside its control | Four wait kinds resolve (`task_completed`, `reply`, `approval`, `artifact_changed`) and every wait carries a timeout. **No external-signal wait** — no webhook or poll |
| Track a task across days | Exists |
| Verify the work is actually done | **Missing.** `mark_task_complete` (`controlPlane.ts:635`) sets task status from the agent's own unchecked claim |

Five gaps. **A harness supplies none of them.** What a harness supplies — file editing, shell,
search, context compaction, a permission prompt UI — is session-scoped, and all of it sits in
the one row that already works.

## Why the shape is wrong
The scenario is defined by waiting: an hour between polls, twenty minutes for CI, a day for a
human to answer. A harness is a session that starts, runs to completion, and exits, holding a
transcript in memory throughout.

A long-lived agent needs the opposite. It must **stop existing between turns** and be
reconstructed from durable state when something wakes it. Building on a harness means either
keeping a process alive for days accumulating a transcript — costly, and precisely what
Constitution §5 rejects — or reimplementing durable suspension around it, which is the control
plane that already exists here.

## What adopting one would cost
The harness would replace `runtime.ts`: 181 lines. Against that:

- **Provider independence.** A vendor's harness re-couples the project to that vendor, undoing
  ADR 0016.
- **The tool surface equals the permission surface** (`CONTRACT_TESTS` #23, #29). A harness
  ships built-in edit and shell tools that do not route through the grant check, so
  least-authority delegation stops being enforceable. That is the security story.
- **Determinism.** The suite runs against a scripted adapter with no network. A subprocess
  harness cannot be scripted the same way, and most of the suite would go with it.
- **Context reconstruction** (Constitution §5). Harnesses accumulate a session transcript by
  design.

Four load-bearing decisions inverted to save 181 lines.

## Where a harness does fit
One row of the table: preparing the change itself. That is a bounded, in-repo coding job with a
clear start and end — a harness's home ground, and where mature edit, search and test tools
beat a single `run_command` primitive by a wide margin.

That is the `Runtime` backend option, and it is the form in which this decision should be
revisited.

## What was not done
Candidate harnesses were **not** evaluated in detail. Codex CLI, and whatever else now exists,
were not examined for what they expose as an embeddable library rather than a terminal
program — a distinction that decides whether the `Runtime` backend idea is viable at all.

That evaluation was deliberately deferred, because it does not change the decision above: none
of the five gaps is filled by any harness, so the gaps get built either way. It should happen
before the `Runtime` interface is extracted, not before the gaps are closed.

## Consequences
The five gaps are the roadmap, and every one of them is control-plane work:

1. A process that ticks, plus a `schedule` field on the agent. The wake-me-later primitive
   already exists; only the clock is missing.
2. `net.egress` enforcement and an HTTP tool, so an agent can observe a system it does not run.
3. A human-facing surface for unanswered questions, so `attentionNeeded` covers "waiting on
   you" and not only "blocked".
4. An external-signal wait, so an agent can suspend on a webhook or a poll.
5. Goal verification. `Agent.success_criteria` exists in the schema and nothing reads it; that
   is the hook. Completion should be checked rather than asserted.

Note that (5) is not something any harness could provide: verification requires knowing the
goal, and the goal is organizational knowledge. By Constitution §2 that makes it control-plane
work by definition.

This ADR is superseded if a harness is adopted as a `Runtime` backend, which would be a new
ADR rather than an amendment to this one.
