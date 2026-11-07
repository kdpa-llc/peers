# Peers: technical design

Status: current as of ADR 0005, November 2026. Read [PRODUCT.md](PRODUCT.md) first. In the
code, agents are still called bots.

## 1. Decision summary

| Question | Decision | Record |
| --- | --- | --- |
| Where do agents run? | On a headless T3 Code server that Peers starts and owns. The vault is one T3 project; each conversation is a T3 thread, run by Claude Code or Codex. | ADR 0003, 0005 |
| Whose sign-in? | The bots' own Claude Code and Codex config folders, signed in once. Nothing appears in the owner's own T3, Claude Code or Codex history. | ADR 0003 |
| Where do files live? | A normal folder. App state outside it, in the user data directory. | ADR 0001 |
| Which folders have agents? | Any folder or single page the vault's layout names; PARA, one per top-level folder and wiki are presets. | ADR 0005 |
| How are agents defined? | `.peers/agents/<id>.json` with the path it looks after; memory next to it. | §4, §9 |
| How do bots edit files? | Directly, with Claude Code's or Codex's own tools. Peers records who changed what and marks it for the owner until they have looked. No Undo, no staged writes. | ADR 0003 |
| Web stack | Plain TypeScript ES modules, no framework, no bundler; the server strips types with `node:module`. Own markdown parser that never produces HTML. | ADR 0002 |
| Desktop app | Installable PWA. | §12 |
| Where does the backend run? | In one Linux container (`peers up`) that sees only the vault and its state. `peers serve` runs it in-process, inside the container and for development. | ADR 0004 |
| Phone | Loopback server behind Tailscale Serve (HTTPS), paired devices. | §13 |
| Live updates | Server-sent events with epoch and sequence; resync on gaps. | §11 |

## 2. Repository layout

```
src/vault/
  t3/runtime.ts          start `t3 serve` with its own data folder, port, token and the bots' homes
  t3/client.ts           T3 HTTP reads and WebSocket RPC (orchestration protocol 2)
  engine.ts              BotEngine interface; T3Engine; DemoEngine (deterministic, no network)
  conversations.ts       conversations per bot, briefs, @mentions, unread, saved transcripts
  messages.ts            brief, page context and notes blocks; what the owner sees of them
  files.ts               file tracking, attribution, "changed since you last looked"
  annotations.ts         notes: drafts, anchoring, send, outcomes
  triggers.ts            schedules and file-change triggers
  schedules.ts           slot arithmetic in a time zone
  layout.ts              layouts, presets, path patterns, front pages
  bots.ts                agents: homes, definitions, ownership, write scope
  vault.ts paths.ts      tree, PARA roots, ownership, path policy
  markdown.ts            shared parser (server tests and browser)
  scripted.ts            the demo bot's recognisable edits
  signin.ts              the bots' Claude and Codex sign-ins, relayed to Settings
  box.ts                 `peers`: build and run the container
  app.ts                 composition root
  server.ts cli.ts       HTTP, SSE, auth, static client; `peers serve`, `pair`, `login`
src/cli/main.ts          the `peers` command
container/Containerfile  the image: vault server, T3, Claude Code, Codex
web/                     the client (§12)
examples/vault/          demo vault
```

## 3. Vault and state on disk

```
<vault>/                       any folder of Markdown and Org notes, in any organisation
  .peers/vault.json            { "id": "vault-…" }
  .peers/layout.json           which folders and pages have agents (§4.1)
  .peers/agents/<id>.json      one agent: the path it looks after, name, instructions, model, triggers
  .peers/agents/<id>.memory.md that agent's memory, a page it reads and adds to

~/Library/Application Support/Peers/<vault-id>/   (Linux: $XDG_DATA_HOME/peers/<vault-id>)
  vault.db                     vault tables, WAL mode
  t3/                          the embedded T3's data (one project, all threads, settings)
  seen/<sha256>                pages as the owner last saw them
  note-pages/<sha256>          pages as they were when notes were sent, until the outcome is known
  attachments/<id>.png         note sketches
  conversations/<agent>/*.md   every conversation as text, for agents to read
  settings.json                owner, time zone, default model, origin

~/Library/Application Support/Peers/agents/{claude,codex}/   the agents' sign-ins (chmod 700)
```

`--state-dir` overrides the vault state; `--agent-homes` or `PEERS_AGENT_HOMES` the sign-ins.
In the box (ADR 0004) all of it lives under the mounted `/vault` and `/state`.

**Ignored**: dot files and folders (except `.peers/layout.json` and `.peers/agents/*.json`,
which the watcher follows), symlinks, files over 20 MB.

**Kinds**: `.md`, `.markdown` and `.org` pages; `.png .jpg .jpeg .gif .webp` images; `.svg`
images (served sandboxed, never inlined); `.pdf`; `.txt`, `.csv`, `.json` as plain text;
everything else a download card.

## 4. Agents (ADR 0005)

### 4.1 Layout (`layout.ts`, `docs/specs/layout.schema.json`)

```json
{
  "preset": "para",
  "agents": ["projects/*.org", "areas/*.org", "archive/*.org", "Clients/*"],
  "exclude": [],
  "paused": ["archive/**"],
  "inbox": "inbox.org",
  "archive": "archive",
  "readonly": ["views/**"],
  "hidden": ["raw", "scripts"],
  "rules": ["AGENTS.md"]
}
```

Patterns are vault-relative; `*` matches within a segment and `**` any depth. A pattern ending
in `.md`, `.markdown` or `.org` matches pages, any other folders. `paused`, `readonly` and
`hidden` apply to a path when it or a parent folder matches.

**Suggested on first open** (`suggestLayout`): PARA when there are Projects or Areas folders
(any case, numbered or not): their folders and pages, and those in the archive (paused), get
agents; an Inbox folder or `inbox.md`/`inbox.org` is the inbox. Otherwise one agent per
top-level folder. An empty vault gets the PARA folders. Either way: a folder whose front page
says it is generated and not to be edited is read-only; tool folders (`scripts`, `tests`,
`emacs`, `node_modules`) and source folders (`raw`, or more than 1,000 files) are hidden;
`AGENTS.md` and `CLAUDE.md` at the root are rules.

**Front pages** (`frontPage`): a folder's `index`, `README`, `main` or `Overview` page, or its
folder note `<folder>/<folder>`, as `.md`, `.markdown` or `.org`. A front page never becomes an
agent of its own.

### 4.2 Agents (`bots.ts`)

- **Homes**: the root (the vault agent), and every folder or page the layout's `agents`
  patterns match, minus `exclude`, hidden paths and front pages. A folder named like a page
  agent's page (`projects/trip/` next to `projects/trip.org`) holds that page's attachments
  and belongs to its agent.
- **Ownership**: a path belongs to the page agent whose page or attachment folder it is, else
  to the nearest folder agent above it, else to the vault agent. An agent inside a paused path
  does not answer; the vault agent does.
- **Definitions** (`docs/specs/bot.schema.json`) are `.peers/agents/<id>.json`, with `path`.
  Created with triggers off and a name from the front page's title (up to 48 characters) or the
  folder or file name. A `.bot.json` (and `.bot/MEMORY.md`) from before ADR 0005 moves there.
  A definition whose path is gone is matched to an unclaimed home with the same name (a folder
  moved outside Peers); otherwise Today lists it as lost.
- **Bindings**: `vault_bots` records each id's path and its last accepted definition.
  **Review** (CONTRACT_TESTS #5): a definition with an unseen id that carries enabled triggers
  or a wide write scope, or a known one changed on disk to add them, gets `needs_review`; its
  triggers stay off until the owner confirms it. Changes made through the app are accepted.
- **Giving and removing**: "Give this folder an agent" adds the literal path to `agents`;
  "Remove agent" removes it, or adds it to `exclude` when a pattern matched. The definition,
  memory and conversations stay and return with the same id.
- **Archive**: "Move to archive" moves the folder (or the page and its attachment folder) into
  the layout's `archive` and records `archived_from`; Restore moves it back.
- `provider` is `claude` or `codex` (older `claude-code` and `openai` are read as those).
  `paused` stops triggers; the owner can still talk to the agent.

### 4.3 Write scope

| Agent | `folder` (default) | `vault` |
| --- | --- | --- |
| Folder agent | its folder | everything |
| Page agent | its page and its attachment folder | everything |
| Vault agent | everything no other agent looks after | everything |

Claude Code and Codex enforce their own permission modes, not Peers' scopes. Peers states the
scope in every brief, and every change an agent makes elsewhere is flagged on Today and on the
page ("outside its folder"). See §13.

### 4.4 Path policy (`paths.ts`), for every file the app serves or changes

1. Relative, normalised, no `..`, no NUL or control characters, at most 512 bytes.
2. No component starts with `.` (covers `.bot.json`, `.peers`, `.git`, `.obsidian`).
3. No component is a sensitive name (`.env*`, keys, `credentials*.json`, `*.pem`, …).
4. No existing component on disk is a symbolic link (`lstat` each component).

## 5. The bot engine (`engine.ts`, `t3/`)

**Runtime.** `T3Runtime` finds the `t3` CLI (`PEERS_T3_BIN`, the version an installed T3
service runs, the newest installed version, or `t3` on PATH) and starts
`t3 serve --base-dir <state>/t3 --port <free port> --host 127.0.0.1 --no-browser <vault>`.
The child gets a clean environment: every `CLAUDE*`, `CODEX*`, `T3*`, `AI_AGENT`, `ANTHROPIC*`,
`OPENAI*` and `MCP_*` variable is dropped, and `T3CODE_HOME` points at its own data. Before
start, `userdata/settings.json` is merged so `providerInstances.claudeAgent` and `codex`
use the bots' homes (`config.homePath`); other settings are kept. A bearer token is minted
with `t3 auth session issue --ttl 12h --token-only` and re-minted after 10 hours. Projects are
added with `t3 project add`.

**Client.** `T3Client` reads over HTTP (`/api/orchestration/shell`,
`/threads/:id/bounded`, header `x-t3-orchestration-protocol: 2`) and sends commands over the
WebSocket RPC at `/ws` (ticket from `/api/auth/websocket-ticket`): `orchestration.launchThread`,
`orchestration.dispatchCommand` (`message.dispatch` with `queue_after_active`, `run.interrupt`,
`thread.archive`), `server.getConfig`, and the `orchestration.subscribeShell` stream. The
socket answers pings, acknowledges chunks, reconnects with backoff (0.5 to 15 s) and re-opens
its subscriptions; a request in flight when it drops fails.

**Engine.** `BotEngine` is what the app uses: `ensureProject`, `launch`, `send`, `interrupt`,
`archive`, `threads`, `messages`, `onThread`, `models`, `providers`. `T3Engine` keeps a cache of
thread summaries from the shell snapshot and `thread.updated` chunks (partial updates merge
into what is known) and maps T3 status to `working | idle | failed | waiting` (`waiting` = a
pending approval). Runs use runtime mode `auto`. Models and their effort levels come from
`server.getConfig` (`providers[].models[].capabilities.optionDescriptors`, option `effort` for
Claude and `reasoningEffort` for Codex); an effort a model lacks falls back to one it has.

**Project.** The vault is one T3 project rooted at the vault, registered on first use and
recorded in `vault_meta`. Every agent's threads live in it, so every agent's working directory
is the vault root, and moving a folder does not touch T3; the brief says what each agent looks
after (ADR 0005).

**Demo engine.** `DemoEngine` stands in for T3 in demo mode (`--scripted`), tests and the
browser journey. Notes get the recognisable edits in `scripted.ts`; "remember …" adds a line to
the memory file; anything else gets an honest demo reply. A message sent while a run is going
queues behind it, as in T3.

## 5a. The box: everything in one container (`box.ts`, `container/Containerfile`, ADR 0004)

`peers up [dir]` runs the vault server, T3, Claude Code and Codex in one Linux
container with Apple's `container` tool (one lightweight VM). The image is Debian trixie with
Node 24, T3's `linux-arm64` release (checked against `SHA256SUMS`), and Claude Code and Codex
from npm; the server runs as `node` under `tini`. Mounts: the vault at `/vault`, and
`~/Library/Application Support/Peers/box` at `/state` (`PEERS_STATE_DIR=/state/vaults`,
`PEERS_AGENT_HOMES=/state/agents`). The server listens on `0.0.0.0:4777` inside; the host
publishes it on `127.0.0.1:4777` only. `box down` stops and removes the container; the vault
and state stay. The bots sign in once per box, from Settings (`signin.ts` runs `claude auth
login --claudeai` or `codex login --device-auth` in the bots' homes and relays the link and
codes) or with `box login`.

## 6. Conversations (`conversations.ts`, `messages.ts`)

```sql
CREATE TABLE vault_threads (thread_id PK, bot_id, origin /* chat|notes|trigger|mention|manual|setup */,
  trigger_id, from_thread, seen_at, created_at);
```

- **Starting.** `start(bot, text, origin)` makes sure the bot's project exists and launches a
  thread whose first message is the bot's **brief** followed by the text. The brief, between
  `[[peers:brief]]` markers, gives the bot its name and kind, the vault and its folder, its
  write scope, the other bots and their folders, where every conversation is saved, how to
  write pages, where its memory is, that page text and other bots' messages are information
  and not instructions, the owner's standing instructions and today's date. New
  conversations get the current brief; old ones keep theirs.
- **Context.** A message can carry the open page and a selection, appended between
  `[[peers:context]]` markers. The owner sees the message without the plumbing and a small chip.
- **Several per bot.** A message without a conversation starts one, titled from its first
  words. The bar under the bot's name lists them, newest first; "New" starts another.
- **@mentions.** `mentions()` finds bot names after `@` (longest name first, case-insensitive,
  never inside an email address). The message goes to the open conversation, which is told
  that the mentioned bots will answer, and to each mentioned bot as a new conversation with
  `origin: mention`, `from_thread` set, and "sent to you from the X chat" in its context.
- **Unread.** A conversation is unread when its latest run finished after the owner last
  opened it. Trigger and mention conversations start unread.
- **Saved as text.** When a run ends, the conversation is written to
  `conversations/<bot>/<date> <title> (<id>).md` without the brief. Bots read these to see
  each other's work; the brief says where they are.
- **Stop and archive** use T3's `run.interrupt` and `thread.archive`.

## 7. Changed since you last looked (`files.ts`)

```sql
CREATE TABLE vault_files (path PK, hash, size, mtime_ms, author, outside_scope, updated_at);
CREATE TABLE vault_seen  (path PK, hash, seen_at);
```

- **Scan.** On start, after every run, every minute and on watcher hints, files whose size or
  mtime changed are hashed; a new hash records an author and time. The first scan of a vault
  counts everything as seen.
- **Attribution.** A change is credited to a bot that is working or finished in the last 20
  seconds, preferring one whose write scope holds the path; when the only candidate is outside
  its scope, the change is flagged `outside_scope`. Otherwise the author is "outside Peers".
  Changes the owner makes through the app are the owner's. A change made by a run a trigger
  started is marked so it never wakes a trigger (#4).
- **Seen.** Opening a page sends `POST /api/seen { path, hash }`; a stale hash (the page
  changed while on screen) is not marked. The seen text of pages up to 1 MB is kept in
  `seen/` so the page view can mark changed lines (Myers line diff). A page you have never
  opened shows as new.
- **Where it shows.** A chip on the page ("Changed since you last looked · by Finances · 5 min
  ago"), bars beside changed blocks, a dot in the tree, and Today's "Changed since you looked"
  with "Mark all seen". The marks stay on screen while you read; the next visit is clean.

## 8. Notes (`annotations.ts`)

`docs/specs/annotation.schema.json`.

- **Drafts** are created when a mark is made and updated as the instruction changes.
- **Targets**: text selections give a quote and the lines of the blocks they touch. Pen marks
  sample the stroke with `caretPositionFromPoint`; arrows resolve both ends. The popover shows
  the resolved target. Pen and arrow marks attach a PNG sketch.
- **Send** (`POST /api/annotations/send { path, keys[], idempotency_key }`) re-anchors each
  note against the current file. A note anchors when its quote, prefix and suffix match exactly
  once; otherwise it becomes `unresolved` and stays out of the batch. The rest go to the page's
  bot as one message between `[[peers:notes]]` markers, with ids, lines, quotes, instructions
  and the sketch's path, in a new conversation "Notes on <page>". The owner sees "2 notes on
  Launch plan" with a link. Repeating the key returns the first result.
- **Outcomes.** When that conversation's run ends after the notes were sent, each note is
  `applied` if the lines it marks changed against the page as it was when sent, `answered`
  otherwise (and always for images and PDFs), or `failed` with the run's error.

## 9. Memory

Each agent's memory is `.peers/agents/<id>.memory.md` in the vault. The brief tells the agent
where it is, to read it at the start of a conversation, and to add one short line when it
learns a lasting fact or preference. The settings page shows it rendered, with Edit. It is a
plain file, so it syncs and versions with the vault.

## 10. Triggers (`triggers.ts`)

```sql
CREATE TABLE vault_triggers (bot_id, trigger_id, pending, first_pending_at, fired, last_slot,
  PRIMARY KEY (bot_id, trigger_id));
```

- Each trigger keeps one conversation (`origin: trigger`); its runs land there.
- **Schedules** fire once for their latest slot (#2): the slot is recorded before the run is
  sent, a new schedule starts from now, and after days off one catch-up run fires.
- **File triggers** batch changes for 30 seconds, ignore changes their own bot made and changes
  any trigger-started run made, wait while their conversation is working, and run at most four
  times an hour (#4).
- Paused, archived and needs-review bots fire nothing; pending changes for them are dropped.
- The dispatcher ticks every second.

## 11. HTTP API and events

All `/api` routes need a session (§13). Writes need `X-Peers: 1` and a matching Origin.

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Vault, settings, engine and provider status, bots, server epoch and event seq |
| `GET /api/tree` | The tree without hidden paths; agents by path; front pages; read-only paths; inbox and archive; paths changed since you looked |
| `GET /api/file?path=` | Content, hash, author, and the change since you looked |
| `POST /api/seen`, `POST /api/seen/all` | Mark a page, or everything, as seen |
| `GET /api/raw?path=` | Bytes (allowlisted types only, sandboxed) |
| `POST /api/folders { parent, name, brief?, agent? }`, `/api/folders/archive`, `/api/folders/restore` | New folder (with an agent by default); archive and restore a folder or page with an agent |
| `POST /api/files/move`, `/api/files/delete` | The owner's file operations |
| `GET /api/bots/:id`, `PATCH /api/bots/:id` | Definition and status |
| `POST /api/bots/:id/run`, `/stop` | Run now (a new conversation), stop its runs |
| `GET /api/bots/:id/threads` | Its conversations (`?archived=1` for archived ones) |
| `POST /api/bots/:id/messages` | `{ text, thread_id?, context?, client_key }` → `{ thread_id, mentioned[] }` |
| `GET /api/threads/:id` | The conversation, its messages and its notes |
| `POST /api/threads/:id/read`, `/stop`, `/archive` | |
| `GET`, `PUT /api/bots/:id/memory` | The memory file |
| `GET /api/models` | Models and effort levels the bots' T3 offers |
| `GET /api/providers`, `POST /api/providers/:provider/login`, `/code`, `/cancel` | The agents' Claude and Codex sign-ins |
| `GET`, `PUT /api/layout` | The vault's layout |
| `POST /api/bots { path }`, `DELETE /api/bots/:id` | Give a folder or page an agent; remove it |
| `GET/POST/DELETE /api/annotations`, `POST /api/annotations/send` | Notes |
| `POST /api/attachments` | Sketch upload (PNG, 2 MB) |
| `GET /api/today`, `GET /api/search?q=` | Home, search |
| `PATCH /api/settings` | Owner, default model |
| `POST /api/pair` (no session) | Exchange a pairing code for a device session |
| `POST /api/pairing-codes`, `GET /api/devices`, `DELETE /api/devices/:id` | Devices |
| `GET /api/events` | Server-sent events |

**Events**: `id: <epoch>:<seq>`. Types: `file.changed`, `tree.changed`, `thread.updated`,
`bots.changed`, `annotation.updated`, `seen.changed`, `today.changed`, `state.changed`. The
server keeps the last 1,000. A `Last-Event-ID` from another epoch or older than the buffer gets
`resync`; the client reloads state. The client also resyncs on `visibilitychange`, and polls a
conversation every 1.5 s while its bot is working, so replies appear as T3 writes them.

## 12. Web client

- **Modules**: `web/**/*.ts` served as JavaScript after `stripTypeScriptTypes`, cached by mtime.
  The browser also loads `/src/vault/markdown.ts`. `tsconfig.web.json` checks the client.
- **Structure**: `lib/` (dom, icons, store, api, events, markdown → DOM, time), `ui/` (tree,
  page, notes and ink, bot pane, bot settings, today, settings, palette, pairing). Nodes are
  built with `h()`; nothing assigns HTML (#3, scanned by a test).
- **Bot pane**: the bot's name and status; a bar with the open conversation's title, a count
  of other conversations with new replies, and New; the conversation; the composer with page
  and selection chips and `@` completion. Settings, memory and triggers are a separate page.
- **Ink**: an SVG layer over the page content; touch scrolls unless a draw tool is active.
- **PDF**: `pdfjs-dist`, served from `/vendor/pdfjs/`, loaded only when a PDF opens.
- **PWA**: manifest, icons, service worker caching the shell (network-only for `/api`).

## 13. Security

- **Bind** `127.0.0.1` only. Phone: `tailscale serve --bg 4777` and
  `peers up <vault> --origin https://<mac>.<tailnet>.ts.net`.
- **Sessions**: the first local open uses a one-time URL token printed at start. Other devices
  pair with a 6-character code (single use, 10 minutes). Sessions are random ids stored hashed,
  in `HttpOnly; SameSite=Strict` cookies, `Secure` on https; listed and revocable.
- **Request checks**: Host must be the bound address or the configured origin (DNS
  rebinding). Writes need `X-Peers: 1` and a matching Origin. `X-Forwarded-*` only from loopback.
- **CSP**: `default-src 'self'`, no inline script or style, `frame-ancestors 'none'`.
- **Raw files**: extension allowlist confirmed by magic bytes; others download; always
  `nosniff` and `sandbox`.
- **The embedded T3** listens on loopback with its own data and a bearer token Peers mints and
  never prints; its environment carries nothing from the session that started Peers.
- **Bot authority**: bots are Claude Code or Codex sessions in T3's `auto` mode, with their own
  sign-ins. They can read the vault and the saved conversations, and edit files; what they may
  do beyond that is decided by those tools' permission settings in the bots' homes, not by
  Peers. Peers' controls are the brief (scope, untrusted text), flags on changes outside a
  bot's folder, review of definitions that gain automation (#5), and triggers that cannot
  wake each other (#4). There is no Undo: keep the vault in git, Time Machine or a sync tool
  with versions.
- **Limits**: JSON bodies 1 MB, sketches 2 MB, messages 20,000 characters.

## 14. Performance targets

| Metric | Target |
| --- | --- |
| Start on a 5,000-file vault (excluding T3 start) | under 1.5 s |
| Embedded T3 ready | under 10 s |
| Shell first paint (local) | under 300 ms |
| 2,000-line page parse and render | under 50 ms |
| SSE event to screen | under 100 ms |

## 15. Testing

Deterministic unit and contract tests (fixed clock, temp dirs, manual watcher, demo engine
with no delay), the recorded T3 shapes as fixtures, and one browser journey.

- `t3`: recorded shell, chunk and bounded projection map to conversations; states; models and
  effort options from a server config; clean environment; provider settings merge; RPC errors.
- `messages`: brief hidden from the owner, context chips, notes round-trip, mentions.
- `conversations`: several per bot, brief only in the first message, unread, @mentions with
  hand-over, saved transcripts, memory file, stop, failures on Today.
- `files`: baseline counts as seen, changed lines, stale seen refused, attribution and
  outside-scope flags, the owner's moves and archives are not changes.
- `notes`: anchoring, idempotent send as one message, applied vs answered, failure.
- `schedules`: slot arithmetic across DST, once per slot, one catch-up, one conversation per
  trigger; file triggers batch, skip own and trigger-run changes, cap per hour; review rules.
- `server`: sessions, Host, Origin, header, raw sandboxing, SSE resync, conversations over the
  API, seen marking.
- `client-static`, `markdown`, `paths`.
- `npm run test:e2e` (Playwright): desktop Chromium and phone WebKit with the demo engine.
- Package smoke test runs the vault from the packed install.
- A live check against a real embedded T3 is run by hand before releases (ADR 0003).

CONTRACT_TESTS: #1 path policy, #2 schedules once per slot, #3 no HTML parsing, #4 trigger
loops, #5 definition review.
`layout` and `org` tests cover layouts, presets, page agents, ownership, front pages, giving
and removing agents, archive and restore, and Org parsing and anchoring.

## 16. Follow-up work

- Approve T3 runtime requests from the vault (today they show as "waiting" on Today).
- Stream replies token by token over the thread subscription instead of polling.
- Continue a conversation after its bot's folder moved.
- Web Push for "needs you"; SQLite FTS5 search; tasks and links between projects, areas and
  resources (PRODUCT.md §16).
