# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Apps in the vault** (ADR 0006). Any `.html` page, or a folder with a `peers.app.json`,
  opens as a web app in a sandboxed frame with an opaque origin: no cookies, no Peers API, and
  only the vault paths it lists. Its `_peers/peers.js` helper reads files, folder listings,
  parsed Markdown and Org pages, and tasks with deadlines, and follows changes. Sites it asks
  for stay blocked until the owner allows them. Agents are told how to build one, and the demo
  vault has a projects board.
- **App servers** (ADR 0007). A manifest's `server` (Python or Node) runs on demand once the
  owner allows it, under bubblewrap inside the container: its folder read-only, its `data/`
  folder writable, no access to the vault or Peers' state except through the data API. The
  app bar shows its state and output. The demo vault has an expense log with a Python server.
- `/api` refuses requests from opaque origins and other sites outright.

### Changed

- **A calmer, clearer interface.** Today opens with the date and a one-line summary, groups
  what needs you and what changed into lists, shows "all clear" when there is nothing, and
  lists agents by where they work, with a state only when something is happening. Archived
  agents fold away.
- The chat box is one field with @ and send inside it; an empty conversation offers a few
  starting points that fill the box without sending.
- The demo notice is one line, says it once, and can be closed (a small "Demo" pill stays).
- The phone's third tab is "Chat" with the agent's avatar; the sidebar's controls move to its
  top; rows are thumb-sized; agents list in one column.
- Toasts rise in and sink out and stack at most three; pages show a placeholder while they
  load and fade in once; tree rows have a "⋯" menu on hover; Settings is grouped into cards.
- The interface says "agent" everywhere (it said "bot" in places). Muted and amber text now
  meet 4.5:1 contrast. Motion is specified in docs/design/MOTION.md.

- Toasts are calmer in the night theme and show one at a time; your own messages line up
  with their time; note conversations are named by their first note; pane headers share one
  height and hairline; Org headings sit one size below the page title; search shows clean
  matches with the query in bold and leaves out apps' own files; an app's status sits in the
  page header; pen marks stay dark on PDFs and images at night.

### Fixed

- A page's title no longer shows twice when the page starts with the same heading.
- The chat box's hint no longer wraps and gets cut off.
- The pairing screen fits narrow phones.
- Between 820 and 1180 px wide, the page column was empty and the tree could not be opened.
- On a phone, selects no longer overflow their card, and "Hide chat" no longer shows where it
  does nothing.

## [0.1.0] - 2026-11-07

First version of Peers as a notes vault with agents, published to npm as `peers-vault`.

### Added

- **Folder agents and layouts** (ADR 0005). Any folder or single page can have an agent; the
  vault's `.peers/layout.json` says which, as path patterns, with paused, generated, hidden,
  inbox, archive and rules entries. PARA, one agent per top-level folder, and wiki are presets
  suggested on first open. Front pages (`index`, `README`, `main`, `Overview`, folder notes) open
  with their folder and name its agent.
- **Agents on an embedded T3** (ADR 0003): Claude Code or Codex, signed in with their own
  accounts from Settings; several conversations per agent; `@mentions`; conversations saved as
  text for other agents to read; memory in `.peers/agents/`; schedules and file triggers with
  loop guards.
- **One container for the whole backend** (ADR 0004): `peers up`, `down`, `status`, `logs`,
  `pair`, `login`, `build`, with Apple's `container` tool.
- **Pages**: a reading view for Markdown (Obsidian conventions) and Emacs Org (task states,
  priorities, tags, drawers, planning lines), images and PDFs; marks (select, pen, arrow) that
  become notes for the page's agent, with per-note outcomes; "changed since you last looked"
  marks on pages, in the tree and on Today.
- **Web app** (ADR 0002): plain TypeScript modules, day and night themes, a phone layout, an
  installable PWA, device pairing for HTTPS phone access.
