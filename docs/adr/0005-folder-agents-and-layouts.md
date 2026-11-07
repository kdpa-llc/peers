# ADR 0005 — Any folder or page can have an agent; PARA is a layout

## Status
Accepted.

## Context
A first design gave one agent to each folder directly under `Projects/` and `Areas/` (the PARA
method) and a vault agent to everything else, which hard-coded PARA: fixed tree sections,
folders created as "projects" or "areas", a fixed archive. People organise notes in many
ways: wikis, lists of clients or courses, and Org repositories that keep each project in a
single `.org` file with an index file per folder and generated views next to the notes.

## Decision
1. **A layout says which folders and pages have agents**, in `.peers/layout.json`: path
   patterns for `agents` (folders, or pages when the pattern ends in `.md` or `.org`),
   `exclude`, `paused` (an archive), `readonly` (generated content), `hidden`, an `inbox` folder
   or page, an `archive` folder, and `rules` files every agent follows
   (`docs/specs/layout.schema.json`).
2. **Presets, not rules in code.** On first open Peers writes a suggested layout: PARA when it
   finds Projects or Areas folders, one agent per top-level folder otherwise, PARA folders for
   an empty vault. It marks folders whose front page says they are generated as read-only,
   hides tool folders and very large source folders, and lists `AGENTS.md` and `CLAUDE.md` as
   rules. The owner edits the layout in Settings or by hand.
3. **The vault agent** always exists and looks after everything no other agent does.
4. **A path belongs to the nearest agent**: a page's own agent, the agent of a page whose
   same-named folder holds it (attachments), or the nearest folder's agent. Paused agents do
   not answer; the vault agent does.
5. **Front pages**: a folder's `index`, `README`, `main` or `Overview` page, or its folder note
   (`<folder>/<folder>.md`), in Markdown or Org. Opening the folder shows it; it never becomes
   an agent of its own; the agent's name is its title (up to 48 characters) or the folder's or
   file's name.
6. **Definitions live in `.peers/agents/<id>.json`** with the path they own, memory in
   `.peers/agents/<id>.memory.md`, because a single page cannot hold a dot file. An agent
   whose folder moved outside Peers is found again by name; otherwise Today reports it.
7. **Giving and taking agents** is a layout change: "Give this folder an agent" adds the path;
   "Remove agent" removes it, or excludes it when a pattern matched. The definition, memory
   and conversations stay and come back with the same id.
8. **All agents share one T3 project rooted at the vault**, so every agent's working
   directory is the vault root and moving a folder does not touch T3.
9. **The tree** shows the folders as they are: top-level folders without an agent become
   sections (their front page opens from the heading), and folders and pages with agents show
   their avatar.

## Consequences
- A PARA vault looks and works the same; other organisations work without code changes.
- A vault of single-file projects opens as it is, so tools that read it (an editor's agenda)
  keep working.
- `.peers/` holds the layout and agents and travels with the vault; Obsidian and Emacs ignore it.
