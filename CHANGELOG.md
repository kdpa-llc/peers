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
