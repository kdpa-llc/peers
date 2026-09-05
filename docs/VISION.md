# Vision

## The product

The product is a management system for a set of semi-autonomous AI agents that behave more like members of an organization than nodes in a workflow.

A user should be able to create an agent by saying, in effect:

> You are responsible for X.

The system then gives that agent:
- an identity;
- a durable home;
- memory;
- tools;
- access to other agents;
- an execution environment;
- a way to receive events and tasks;
- the ability to decide how to pursue its responsibility.

The agent should not need the user to predefine every sequence of actions.

## Organizational metaphor

A useful mental model is a company.

Each durable agent has:
- a job description;
- areas of ownership;
- an inbox;
- colleagues;
- tools;
- working time;
- memory;
- permissions;
- escalation rules.

Agents know enough about other agents' responsibilities to discover who can help.

They coordinate by requests, tasks, messages, and shared artifacts—not by participating in one giant shared chat.

## Human interaction model

The user primarily sees an organization.

The default UI should answer:
- Who exists?
- What does each agent own?
- What is each agent currently doing?
- What is blocked?
- What changed recently?
- Which agents are collaborating?
- Where is human attention required?

The user can then open an individual agent to inspect details or converse directly.

## Long-term direction

The platform should eventually support agents that improve the platform itself.

Examples:
- a memory specialist improves the shared memory-management skill;
- an observability specialist improves summaries;
- a runtime specialist proposes better sandbox policies;
- a repository agent improves its own development tooling;
- an agent proposes creating a new specialist agent when responsibility is becoming overloaded.

This creates a recursive tool-building ecosystem, but one bounded by explicit permissions and review.
