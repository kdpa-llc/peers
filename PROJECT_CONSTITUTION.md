# Project Constitution

**Version 1.1** — amendments require human approval and a version bump (see §9, §16).

This document is the architectural north star. Human contributors and coding agents should read it before making implementation decisions.

## 1. Agents own responsibilities

An agent is not merely a prompt or a chat session. It is a persistent organizational actor with a stable identity, explicit responsibility, policies, memory, capabilities, and an inbox.

Its core question is:

> What am I responsible for, and what should I do next to fulfill that responsibility?

## 2. Avoid hard-coded orchestration

The platform should not require a predefined DAG describing every interaction.

Central infrastructure manages:
- lifecycle;
- delivery;
- wake-up mechanics;
- permissions;
- resource limits;
- persistence;
- observability.

Agents decide:
- how to pursue their mission;
- when to delegate;
- who to ask for help;
- when they are blocked;
- what knowledge is worth retaining.

## 3. Treat the control plane as infrastructure, not management intelligence

The control plane should be deliberately boring. It should provide reliable mechanics and guardrails without becoming the brain of the agent organization.

If domain reasoning can live inside an agent, it generally should.

## 4. Separate identity from execution

A long-lived agent may execute many short-lived sessions.

Agent identity, responsibility, memory, relationships, and history are durable.

Model context, process state, containers, and worker sessions are disposable.

## 5. Rebuild context; do not accumulate it forever

Never equate long-lived identity with an infinitely growing chat transcript.

For each execution, assemble a bounded context from:
- identity;
- current responsibility;
- active task;
- relevant durable memory;
- recent events;
- retrieved artifacts.

Raw history is archival evidence, not default prompt context.

## 6. Delegate heavy work

Long-lived manager agents should remain focused on responsibility, judgment, planning, coordination, and memory.

Large execution tasks should usually be delegated to fresh, bounded workers.

Workers return:
- results;
- artifacts;
- evidence;
- a concise summary;
- proposed memory updates.

Then they can terminate.

## 7. Memory belongs to the agent

The platform provides memory primitives and shared memory-management skills.

The agent owns the semantic decision about what should be learned, merged, revised, or forgotten.

Do not create a central omniscient memory janitor responsible for understanding every domain.

## 8. Skills are reusable methods, not state containers

Skills should preferably be stateless, versioned, testable capabilities.

Examples:
- summarize execution history;
- consolidate memory;
- perform code review;
- discover relevant agents;
- prepare a delegation;
- assess whether a memory is stale.

Agents own knowledge. Skills provide methods.

## 9. Agents may improve the organization, but governance remains explicit

Agents may:
- propose new agents;
- propose new skills;
- improve shared skills;
- suggest platform changes;
- propose policy changes.

Applying high-impact changes should require an explicit permission boundary, review rule, or deployment policy.

Separate **proposal** from **application**.

## 10. Temporary agents are cheap; permanent agents are organizational commitments

Use ephemeral workers freely when appropriate.

Creating a durable agent means introducing:
- persistent identity;
- ongoing responsibility;
- permissions;
- memory;
- operational cost;
- governance.

Permanent agent creation should therefore be more deliberate.

## 11. Observability is a first-class product feature

Humans should not have to read every token produced by every agent.

The platform should expose structured events and derived summaries.

Users need to understand:
- what an agent owns;
- what it is doing;
- why it is doing it;
- what it is waiting for;
- what it delegated;
- what changed;
- what needs human attention.

## 12. The UI is a management console

The primary interface should optimize for:
- overview;
- accountability;
- navigation;
- intervention;
- inspection.

Deep chat is a drill-down interaction, not necessarily the home screen.

## 13. Sandboxes are pluggable

Execution may happen in:
- a local process;
- a Docker container;
- a VM;
- a microVM;
- a remote executor;
- a vendor sandbox.

The agent model and control plane must not depend on one sandbox provider.

## 14. Events are the common observability language

Every runtime should emit normalized structured events.

Observers, UIs, audit systems, metrics, and debugging tools consume those events rather than scraping arbitrary model transcripts.

## 15. Prefer inspectable autonomy over invisible autonomy

Autonomous behavior should leave a trail:
- decisions;
- delegations;
- state transitions;
- memory changes;
- permissions used;
- artifacts produced.

The system should be understandable after the fact.

## 16. The enforcement boundary is human-controlled

An agent must never be able to modify the code that enforces its own permissions, the
scheduler, or this constitution. Agents may propose changes to any of them; applying those
changes is a human act.

Review of any proposal must assume the proposal may be adversarial — agents process
untrusted content, and a steered agent emits well-formed, policy-compliant proposals.
