# Memory and Context

## Core principle

Long-term identity does not imply long-term prompt history.

Context is a **reconstructed working set**.

Memory is **durable structured knowledge**.

History is **evidence**.

These are separate concepts.

## Memory layers

### 1. Identity memory
Highly durable:
- responsibility;
- mission;
- operating principles;
- stable preferences;
- ownership boundaries.

### 2. Working state
Short-lived:
- current objective;
- current plan;
- active blockers;
- pending delegations;
- recent execution state.

### 3. Curated long-term knowledge
Durable semantic memory:
- architecture facts;
- domain knowledge;
- decisions;
- recurring lessons;
- important relationships;
- operational playbooks.

### 4. Experience memory
Patterns learned from prior work:
- what worked;
- what failed;
- common pitfalls;
- useful heuristics.

### 5. Artifacts
External durable objects:
- code;
- documents;
- reports;
- datasets;
- patches;
- plans.

Artifacts should be referenced, not necessarily copied into memory.

### 6. Archive
Raw transcripts and low-value evidence may be retained for audit without entering normal context.

## Context assembly

For each execution, build context using:
- current responsibility;
- active task;
- relevant memory retrieval;
- recent unresolved events;
- selected peer responsibilities;
- required artifacts.

Use explicit token budgets by section.

Example:

```text
10% identity + policies
15% task + current state
25% retrieved memory
15% peer/org context
30% task artifacts/evidence
 5% spare
```

The exact percentages are tunable. The important part is having a budget.

The percentages apply to a per-execution **context target** chosen per model (e.g. at most
50% of the model's context window), so the budget composes with model swaps rather than
assuming one window size.

## Memory updates

Agents should propose memory changes as explicit operations
(`docs/specs/memory_proposal.schema.json`):

- create;
- revise;
- merge;
- supersede;
- archive;
- delete when policy allows.

Each change should include:
- rationale;
- source execution;
- confidence;
- references/evidence;
- timestamp;
- previous revision if updating.

Applied changes are recorded as immutable revisions
(`docs/specs/memory_revision.schema.json`). Auto-apply policy in v0: create/revise/archive
of the agent's own memory within quota; review required for delete, shared memory, or
memory referenced by another agent.

## When memory management happens

Three useful triggers:

### End-of-task consolidation
Workers return proposed learnings with their results.

Managers decide what deserves durable retention.

### Threshold-based maintenance
The platform can enqueue a maintenance request when:
- memories become too large;
- retrieval quality degrades;
- duplicate entries accumulate;
- context pressure repeatedly occurs.

### Periodic refactoring
A durable agent may periodically review and reorganize its memory.

The platform schedules the opportunity; the agent performs the semantic refactor.

## Shared memory-management skill

Provide a reusable, versioned skill that can:
- identify duplicates;
- summarize related notes;
- detect stale knowledge;
- generate memory diffs;
- evaluate retrieval usefulness;
- propose merges;
- preserve provenance.

A dedicated specialist agent may improve this shared skill over time.

That specialist should not automatically rewrite every agent's memory.
