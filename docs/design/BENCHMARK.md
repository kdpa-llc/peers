# Benchmark: what we take from whom

Peers mixes four product types: a markdown vault, an AI page editor, an annotation
tool, and a team of long-lived bots. Each type already has a product that solved part of it
well. This page records the part we copy, the part we leave, and why. The goal is to reuse
their lessons instead of relearning them.

Research date: 6 Nov 2026. Sources are listed at the end.

## Summary table

| Need | Best existing answer | What we take | What we leave |
| --- | --- | --- | --- |
| Files you own | Obsidian | Plain markdown folders on disk; `[[wikilinks]]`; `> [!note]` callouts; dot folders hidden; quick switcher | Editing-first UI; plugin sprawl |
| PARA tree | PARA Workflower, Periodic PARA (Obsidian plugins) | Accept numbered folder names (`1. Projects`, `01-Projects`, `Projects`); archive and restore by moving the folder; one index note per project | Fixed folder names; README-per-project as a hard rule |
| One bot per responsibility | OpenClaw | Per-bot instructions, long-term memory, heartbeat checklist, scheduled jobs, and tools to list, read and message other sessions | Memory as free-form files that grow forever; one long session transcript |
| Select text and ask | ChatGPT Canvas | Selection bubble with an instruction field; edits scoped to the selection; comments in the margin | Free typing in the document |
| Point at the thing | Codex in-app browser comment mode, Agentation | Numbered pins; every note carries a structured anchor plus a screenshot; several notes sent as one batch | DOM selectors (our anchors are markdown source lines) |
| Draw and send | tldraw Make Real and tldraw AI docs | Send the picture and the structured data together; follow-ups carry the current source with the new marks | An infinite canvas |
| Batch feedback | GitHub pull request review | Queue notes, then "Send 3 notes" as one request; each note resolves when the bot finishes | Line-by-line diff as the main view |
| See what the bot changed | Google Docs suggestions, Cursor diffs, Notion page history | Changed blocks get a bar until you have looked; history from Git or the sync tool | Accept/reject for every edit before it lands (too slow for agent-written pages) |
| Agents with triggers | Notion Custom Agents (Notion 3.3) | "When X, do Y" trigger rows; a model per agent; agents that run without a prompt | Cloud-only, credit-billed runs |
| Fast, calm UI | Linear | ⌘K for everything; status dots; dense but quiet lists; optimistic updates | Issue-tracker vocabulary |
| Reading typography | Things 3, Craft, Capacities | Serif reading face, wide margins, object-like page headers | Block editors |
| PDFs as first-class | Heptabase | Open PDFs in the same pane; mark a region; the mark becomes the note's anchor | Whiteboards |
| Pen tools | Apple Freeform, GoodNotes, Notability | Floating tool pill; pen, highlighter, shapes, eraser; finger draws only in draw mode; pencil pressure | Page templates, handwriting search |
| Robust anchors | Hypothesis, W3C Web Annotation | TextQuoteSelector (`exact`, `prefix`, `suffix`) plus a position hint; refuse to anchor rather than guess | Full W3C JSON-LD envelope |
| Web and desktop from one codebase, usable from a phone | T3 Code | One web app; install it as an app; run on the Mac, use from the phone | Electron for v1 |

## Notes per product

### Obsidian
A vault is a folder of markdown files. Obsidian keeps its own state in a dot folder and
hides dot folders from the tree. People already have vaults, so compatibility is a feature:
a Peers vault must open in Obsidian without damage, and an Obsidian vault must open in Peers.
We render the syntax Obsidian users write most (wikilinks, embeds `![[x.png]]`, callouts,
tags, task lists, highlights `==x==`, YAML front matter). We do not copy the editor, because
in Peers the bots write.

### PARA plugins for Obsidian
PARA Workflower adds commands to create Projects, Areas and Resources and to archive and
restore items while keeping folder structure. Periodic PARA expects numbered folders like
`1. Projects`. Lesson: people number their PARA folders in several ways, and archiving is a
move, not a flag. Peers recognises the four roots by name pattern when it suggests a layout,
and implements Archive and Restore as moves that keep the agent attached.

### OpenClaw
Each OpenClaw agent has a workspace with `AGENTS.md` (operating instructions, loaded every
session), `SOUL.md` (persona), `MEMORY.md` (long-term memory, private sessions only), daily
memory logs, and `HEARTBEAT.md` (a short checklist for scheduled heartbeat runs, kept short
to save tokens). Non-default agents get their own workspace. Cross-agent work uses
`sessions_list`, `sessions_history` and `sessions_send`; cron jobs can run in the main
session or in an isolated one with fresh context.

What we copy: the shape of an agent (instructions + memory + heartbeat + scheduled jobs),
agents reading each other's sessions, and messaging another agent (in Peers, `@Name`).

What we change: memory is a plain page in the vault (`.peers/agents/<id>.memory.md`) the
agent reads and adds to, and every conversation is saved as text so other agents can read it.

### ChatGPT Canvas
You highlight text, or use the block comment icon, and an input opens for instructions.
Feedback can appear as comments beside the text with an Apply button. Selecting first limits
the change to that selection. We copy the selection bubble and the scoping rule: a note
anchored to three lines asks the bot to change those lines and leave the rest alone.

### Codex in-app browser and Agentation
Codex's comment mode turns comments on a rendered page into instructions and attaches a
screenshot and the DOM element. Agentation (MIT) lets you click elements, select text or draw
an area, and produces a markdown packet with selectors, element paths and bounding boxes
that any agent can read. Lesson: an annotation is useful to an agent only when it carries a
precise target. Our target is the markdown source: file path, line range, quoted text with
prefix and suffix, and the content hash the note was made against.

### tldraw Make Real
The canvas exports the selected region as an image for a vision model. tldraw's AI docs
recommend sending the visual and structured data together, because the image shows layout
and the data gives exact text and positions. Follow-up requests include the previous output
alongside the annotated image. We copy all three: crop PNG for drawn marks, structured
anchors, and the current page source.

### GitHub pull request review
"Start a review" queues comments and sends them together. This fits agent edits: one bot
run that applies five notes is cheaper and more coherent than five runs. The toolbar shows
"Send 3 notes"; each note shows queued, working, done or failed.

### Google Docs, Cursor and Notion history
Agents edit faster than people review. Approving every edit before it lands is too slow,
so edits land at once and stay easy to see: changed blocks are marked until you open the
page again, the tree and Today list what changed, and version history comes from the tool the
vault already lives in (Git, Time Machine, a sync service).

### Notion Custom Agents
Notion 3.3 (Feb 2026) added agents that run on schedules or on events such as a new database
row, with a model choice per agent. We copy the plain trigger sentence ("Every weekday at
08:00, prepare today's brief") and the per-agent model. We do not copy cloud billing; agents
run on the owner's own Claude or ChatGPT plan.

### Linear
Linear is the reference for "fast and good-looking": keyboard first, ⌘K palette, quiet
status dots, no spinners where an optimistic update works. Peers follows the same rules:
no web fonts, no framework, server-sent events instead of polling, and every action
reachable from ⌘K.

### Things 3, Craft, Capacities
Calm reading: a serif text face, a 68 to 72 character measure, large page titles and
light metadata. Pages in Peers are read far more often than they are written, so the middle
pane is a reading view.

### Heptabase
Heptabase treats PDFs as first-class objects with native annotation. Peers opens PDFs in
the page pane with the same mark tools; a mark records the page number and a region, and the
bot gets the crop as an image.

### Freeform, GoodNotes, Notability
A floating pill toolbar works with mouse, trackpad, finger and pencil. Finger strokes
scroll the page unless a draw tool is active, so reading on a phone never draws by
accident. Pencil input uses pressure for stroke width.

### Hypothesis and W3C Web Annotation
A TextQuoteSelector stores the exact quote plus a prefix and suffix. Hypothesis ranks
candidate matches by quote, prefix and suffix similarity and by distance from the expected
position. Some tools return nothing rather than a bad match, because a misplaced anchor is
worse than a missing one. Peers stores `exact`, `prefix`, `suffix` and a line hint, and the
note shows "page changed, anchor lost" instead of guessing.

### T3 Code
T3 Code runs as a web app and as a desktop app from one codebase, usable from a phone while a
computer does the work. Peers follows the same model, and runs its agents on T3 itself: the
computer runs the vault server and the agents; any browser, phone included, is the client;
installing the web app gives a desktop window without Electron.

## What nobody did, so we design it

1. **An agent per folder, created by the vault's layout.** In a PARA vault every project and
   every area gets an agent the moment its folder or file exists; other organisations name
   their own folders. The agent moves with the folder, pauses when it is archived and wakes
   when it is restored.
2. **Ink as instructions on agent-written text.** Annotation tools exist for PDFs and web
   pages, and AI editors exist for text, but drawing on an agent-written markdown page and
   having the owning bot apply the marks is new. The anchor format (source lines, quote,
   hash, crop) is our own.
3. **What changed since you last looked.** Agents edit directly; Peers remembers the version
   of each page you last saw and marks the difference until you have looked.

## Sources

- OpenClaw agent workspace: https://docs.openclaw.ai/concepts/agent-workspace
- OpenClaw session tools: https://docs.openclaw.ai/es/concepts/session-tool
- OpenClaw anatomy (third party): https://agento.host/blog/openclaw-agent-anatomy
- ChatGPT Canvas help: https://help.openai.com/en/articles/9930697-what-is-the-canvas-featue-in-chatgpt-and-how-do-i-use-it
- PARA Workflower: https://community.obsidian.md/plugins/para-workflower
- Periodic PARA: https://github.com/haozileung/obsidian-periodic-para
- tldraw Make Real story: https://tldraw.dev/blog/make-real-the-story-so-far
- tldraw AI integrations: https://tldraw.dev/docs/ai
- Codex release coverage (comment mode): https://www.digitalapplied.com/blog/openai-codex-for-almost-everything-release-guide
- Agentation listing: https://sourceforge.net/projects/agentation.mirror/
- Notion 3.3 Custom Agents: https://alternativeto.net/news/2026/2/notion-3-3-launches-custom-agents-for-autonomous-team-automation
- Hypothesis anchoring issue: https://github.com/hypothesis/product-backlog/issues/1022
- Apache Annotator selectors: https://annotator.apache.org/docs/api/modules/dom.html
- T3 Code discussion on file handling: https://github.com/pingdotgg/t3code/discussions/6832
- Obsidian Copilot agent mode: https://community.obsidian.md/plugins/copilot
- Capacities vs Tana: https://fabric.so/comparison/capacities-vs-tana
