# ADR 0013 — The Runtime Drives a Bounded Model Loop

## Status
Accepted

## Decision
`AgentRuntime.runExecution` calls the model adapter repeatedly within one execution instead of exactly once. A turn that returns any `AgentAction` ends the loop; a turn that returns only tool calls has those commands run in the execution's sandbox and their output fed back to the adapter as `tool_results` on the next turn. The loop is capped at 8 turns.

One sandbox is created per execution, lazily on the first tool call, and reused across turns. Usage accumulates across turns, so budgets are charged the whole execution.

## Why
The original interface was one-shot: prompt in, actions and tool calls out, tools executed afterward. That works for a scripted adapter, which already knows the answer, but it cannot work for a real model — an agent asked to "find the root cause and report it" must see what `grep` returned before it can decide anything. Under a one-shot interface a real model would have to guess, which makes the delegation scenario a fiction.

The cap exists because the failure mode of a model loop is not a crash but an unbounded bill. Eight turns is enough for the vertical slice and small enough that a looping model is a bounded cost.

## Consequences
`ModelRequest` gains `turn`, `tool_results`, `execution_id`, and the agent's `grants`; `ModelResponse` is unchanged in shape but "tool calls with no actions" now means "call me again". Adapters that return tools and actions together — including `ScriptedModelAdapter` — are called exactly once and behave as before, so this is backward compatible; all pre-existing contract tests passed unmodified.

Reaching the cap ends the execution with whatever actions were taken, possibly none. That is deliberately not a failure: the agent simply did nothing, which the observer already surfaces.
