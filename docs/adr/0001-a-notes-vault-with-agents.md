# ADR 0001 — A notes vault where agents write and the owner steers

## Status
Accepted. Amended by ADR 0003 (agents on T3), ADR 0004 (one container) and ADR 0005 (any
folder can have an agent).

## Context
People keep notes in plain folders (Obsidian vaults, Org directories) and increasingly ask AI
agents to keep them current. Chat tools lose the structure; editors leave the owner doing the
writing. The owner wants agents that each look after part of the notes, write the pages, and
take instructions from marks on those pages and from conversation, from a computer or a phone.

## Decision
1. **The vault is a normal folder.** Pages are Markdown or Org files that open in Obsidian or
   Emacs. Peers adds only `.peers/` (an id, the layout, agent definitions and memory).
2. **App state lives outside the vault**, in the user data directory: what the owner has seen,
   notes, conversations as text, the agents' runtime data. The vault can be synced or kept in
   Git without a live database inside it.
3. **Agents write, the owner steers.** The main flow has no editor: the owner reads, marks,
   chats and chooses who does what.
4. **One web app** for desktop and phone, installable as an app, served by a local server and
   reached from the phone through an HTTPS proxy with device pairing.

## Consequences
- Files stay the source of truth; any editor can change them, and Peers notices.
- Everything Peers knows besides the files can be rebuilt or lost without losing notes.
