# ADR 0003 — Agents run on an embedded headless T3

## Status
Accepted.

## Context
Agents need real tool use (read and edit files, search, read PDFs and images), long-running
sessions, and the owner's existing Claude or ChatGPT subscriptions rather than metered API
keys. T3 Code runs Claude Code and Codex sessions behind an orchestration server (`t3 serve`)
with projects, threads, runs and a WebSocket RPC, and its data folder, port and providers'
config folders are all configurable. Owners want agent sessions kept apart from their own
Claude Code, Codex and T3 history, and do not want an Undo or save step: agents just edit.

## Decision
1. **Peers starts its own T3**: `t3 serve` with a data folder in the vault's state, a free
   loopback port, a minted bearer token, and an environment that carries nothing from the
   process that started Peers.
2. **The agents have their own sign-ins.** T3's `claudeAgent` and `codex` providers point at
   config folders that belong to Peers. Settings signs them in: it runs the login inside Peers'
   environment and relays the link and codes.
3. **A conversation is a T3 thread.** Each conversation's first message carries the agent's
   brief (what it looks after, its front page, its memory file, the other agents, the vault's
   rules, the date), hidden from the owner.
4. **Several conversations per agent; @mentions.** A message without a conversation starts
   one. `@Name` also sends the message to that agent as a new conversation that links back;
   the agent you were talking to is told the other will answer.
5. **Agents edit files directly.** No staging and no Undo. Peers tracks hashes and authors and
   marks what changed since the owner last looked.
6. **Agents read each other through files**: every conversation is saved as text in the
   state folder, and the brief says where.
7. **Triggers stay in Peers**: schedules and file triggers send to one conversation per trigger,
   with a loop guard and an hourly cap (CONTRACT_TESTS #4).
8. **A demo engine** with the same interface runs demo mode, tests and the browser journey.

## Consequences
- Agents get Claude Code's and Codex's full tool use and the owner's subscriptions; Peers does
  not meter cost.
- Peers does not enforce where an agent writes: Claude Code and Codex apply their own
  permission settings. Peers states the scope in the brief, flags changes outside it, and
  reviews definitions that gain automation (CONTRACT_TESTS #5). ADR 0004 bounds the damage.
- No Undo: the vault should live in Git, Time Machine or a sync tool with versions.
- T3's RPC protocol is not a published API; recorded shapes are test fixtures, and a live check
  runs before releases.
