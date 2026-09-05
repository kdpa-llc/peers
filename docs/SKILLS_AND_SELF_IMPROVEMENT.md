# Skills and Self-Improvement

## Skill model

A skill is a versioned reusable method that an agent can invoke.

Prefer skills that are:
- stateless;
- deterministic where practical;
- testable;
- documented;
- permission-aware;
- backward-compatible when possible.

Examples:
- memory consolidation;
- repository review;
- agent discovery;
- delegation packaging;
- incident triage;
- summarization;
- artifact comparison.

## Ownership

A durable agent may own the quality of a skill.

Example:

**Memory Platform Agent**
Responsibility:
> Improve the organization's memory-management methods and retrieval quality.

It may:
- benchmark memory strategies;
- improve prompts and algorithms;
- publish skill versions;
- create migration notes;
- recommend upgrades.

Individual agents decide whether to adopt a compatible new version, subject to platform policy.

## Recursive improvement

Agents may participate in improving:
- skills;
- runtime adapters;
- observers;
- UI summaries;
- policies;
- documentation;
- tests.

This is desirable, but self-improvement needs boundaries.

## Proposal versus application

High-impact mutations should follow:

```text
observe problem
    ↓
produce proposal
    ↓
review / automated policy check
    ↓
approve
    ↓
apply
    ↓
observe impact
    ↓
rollback if needed
```

Examples requiring stronger controls:
- granting new permissions;
- changing platform constitution;
- changing sandbox isolation;
- creating durable agents;
- deleting durable memory;
- modifying the agent-creation policy.

## Agent creation

Agents may be permitted to:

### Create ephemeral workers
Low governance overhead.

The parent defines:
- objective;
- lifetime;
- permissions;
- context;
- budget.

### Propose durable agents
Higher governance overhead.

A proposal should include:
- reason the new responsibility cannot be handled cleanly by an existing agent;
- proposed responsibility;
- mission;
- tools;
- required permissions;
- expected operational cost;
- lifecycle owner.

The control plane applies the organization policy.
