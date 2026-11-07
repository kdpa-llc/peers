# Peers: product and UX design

Status: current as of ADR 0005, November 2026.

## 1. The idea in one paragraph

Peers is a notes vault (Markdown or Emacs Org) where agents write the pages and you steer
them. Any folder, or a single page, can have its own agent with its own instructions, memory
and triggers; a PARA vault (Projects, Areas, Resources, Archive) gets one per project and area. You read a page, mark what you want
changed (select text, circle a region, draw an arrow, drop a pin, or just say it in chat),
and the bot that owns the page makes the change. Bots can read the whole vault and each
other's conversations, and writing `@Finances` in any chat sends that message to Finances too.
Bots are Claude Code or Codex sessions on a T3 that Peers runs for them, signed in with their
own accounts. The app is a web app that runs on your Mac, opens in any browser including your
phone, and installs as a desktop app.

## 2. Principles

1. **Bots write, you steer.** There is no text editor in the main flow. Your tools are
   reading, marking, chatting and choosing who does what.
2. **One responsibility, one bot.** A bot owns a folder. Ownership decides who answers a
   note on a page, who runs on that folder's triggers, and whose memory holds what was
   learned there.
3. **Files are the truth.** The vault is a normal folder of markdown files that opens in
   Obsidian. App state lives outside it; only each bot's `.bot.json` and `.bot/MEMORY.md`
   sit in its folder.
4. **Every change is visible.** Bots edit files directly. What changed since you last looked
   is marked on the page, in the tree and on Today. There is no Undo or history in Peers:
   keep the vault in git, Time Machine or a sync tool with versions.
5. **Fast and quiet.** No spinners where a status dot will do. No web fonts. No framework.
   Everything reachable from ⌘K.
6. **Phone is a first-class client.** Many owners run Peers on a computer and work from a phone. Every
   flow works with a thumb, and drawing works with a finger.

## 3. Vocabulary

| Term | Meaning |
| --- | --- |
| Vault | The folder Peers opens. |
| PARA root | One of `Projects`, `Areas`, `Resources`, `Archive` at the top of the vault. Numbered variants (`1. Projects`, `01-Projects`) are recognised. `Inbox` is an optional fifth root. |
| Agent home | A folder or a single page that has its own agent. The vault's layout says which (ADR 0005). |
| Layout | `.peers/layout.json`: which folders and pages have agents, what is paused, generated or hidden. PARA is a preset. |
| Front page | A folder's `index`, `README`, `main` or `Overview` page, or its folder note. Opening the folder shows it. |
| Bot | The agent that owns a container. Shown with an avatar and the container's name. |
| Vault bot | One extra bot that owns the vault root and `Inbox`. Your general assistant. |
| Page | A file shown in the middle pane: markdown, image or PDF. |
| Note | One mark on a page plus your instruction. Queued notes are sent in a batch. |
| Conversation | One chat with a bot. A bot has as many as you like; notes and triggers start their own. |
| Bot engine | The headless T3 Peers starts. Each bot is a T3 project; each conversation a T3 thread. |
| Trigger | A rule that wakes a bot without you: a schedule or a file change. |

## 4. Layout

```
┌──────────────┬────────────────────────────────────────┬───────────────────────┐
│ ⌕ Search  ⌘K │ Projects / Website Relaunch        ⋯  │ (W) Website Relaunch ⚙│
│              │                                        │ Project bot · Idle    │
│ ☀ Today      │  Launch plan                           │ ✎ Tighten timeline ▾ 2│
│ ⇣ Inbox   3  │  Written by Website Relaunch · 2m      │              [+ New]  │
│              │                                        │                       │
│ PROJECTS     │  ┃ Changed since you looked · by bot   │  you: tighten the     │
│ ● Website R. │  ┃ Launch moves to 14 March…           │  timeline…            │
│ ● Q1 Tax   ! │                                        │                       │
│ ○ Kitchen    │  ## Milestones                     ①   │  bot: Done. I moved   │
│ AREAS        │  - [x] Copy freeze                     │  three dates…         │
│ ○ Health     │  - [ ] QA pass                     ②   │                       │
│ ○ Finances   │                                        │                       │
│ RESOURCES    │      ╭───────────────────────────╮     │                       │
│ ARCHIVE    ▸ │      │ ↖ ✎ ▭ ↗ ⌫ 💬 │ Send 2 notes│     │ [Launch plan.md] ...  │
│ ⚙  ◐        │      ╰───────────────────────────╯     │ Ask Website Relaunch… │
└──────────────┴────────────────────────────────────────┴───────────────────────┘
```

Widths: tree 248 px (resizable 200 to 360, collapsible with ⌘\\), page fluid with a 720 px
reading measure, bot panel 380 px (resizable 320 to 520, collapsible with ⌘⇧\\). Collapsed
panes leave a 44 px rail with icons.

### 4.1 Left: the tree

- **Search** field at the top opens the palette (⌘K).
- **Today**: the home view (section 7).
- **Inbox**: the layout's inbox, a folder (with a count) or a single page. The vault agent
  triages it.
- **Sections**: each top-level folder without an agent (Projects, Areas, Resources in a PARA
  vault) is a section header with a `+` (new folder with an agent); a header whose folder has a
  front page opens it. Folders and pages with an agent show the agent's avatar and name, and
  on the right one status mark:
  - no mark: idle;
  - teal pulsing dot: working;
  - amber dot: needs you (waiting for an approval, a definition to review);
  - red dot: last run failed;
  - grey dot: paused.
- **Archive** (the layout's archive folder) is collapsed by default; what is in it shows a paused
  agent. Everything else at the top level is listed under **Vault**.
- Rows expand to show files. Opening a folder also opens its front page. Files that changed
  since you last opened them show a small teal dot, whoever changed them. Generated content
  shows a lock.
- Right-click (long-press on phone) on a folder or page: New page, New folder, Give this folder
  (or page) an agent, or for one that has an agent: Chat, Run now, Agent settings, Move to
  archive or Restore, Remove agent. On a file: Open, Move to, Delete.
- Moving a folder keeps its agent. Drag and drop is left for later.

### 4.2 Middle: the page

**Header**: breadcrumb (`Projects / Website Relaunch / Launch plan.md`) and an overflow menu.
Under the title, one meta line: `Written by Website Relaunch · 2 min ago`. The author is the
bot that most likely made the last change (one that was working at the time), `you` for your
own moves, or `outside Peers` when another program changed the file.

**Body** for markdown: a reading view. Serif text face at 18 px with 1.6 line height on desktop
and 17 px on phone, measure 68 to 72 characters, sans-serif headings. Front matter shows as
small property chips under the title. Wikilinks navigate. Embedded images and PDFs from the
vault render inline. Remote images are blocked and show a "Remote image blocked · Load" chip,
because a bot could otherwise leak data through an image URL.

**Body** for images: fit to width, zoom with pinch or ⌘ scroll.

**Body** for PDFs: pages render one under another, lazily, with a page number pill.

**Changed since you last looked**: when a page changed after you last opened it, a chip at the
top says `Changed since you last looked · by Website Relaunch · 5 min ago` (or `New since you
last looked`), each changed block gets a 3 px teal bar in the left margin, and removed text
shows as a thin red tick with "3 lines removed" on hover. A change a bot made outside its own
folder adds an `outside its folder` tag. Opening the page counts as looking: the marks stay
while you read and are gone the next time. `Hide` clears them at once. If the page changes
again while it is open, the marks show the newest change.

**The tool pill** floats 20 px above the bottom edge of the page pane, centred. Four tools,
because the pen already draws circles, boxes and underlines:

| Tool | Key | What it does |
| --- | --- | --- |
| Read | V | Default. Select text to get the Ask bubble. |
| Pen | P | Freehand ink: circle, box, underline, strike, write a word. Strokes made within 700 ms of each other form one mark; then the note popover opens. |
| Arrow | A | Drag from one place to another ("move this here", "this belongs to that"). |
| Eraser | E | Tap a mark or a queued note to remove it. |

The right end of the pill shows the queue and its recipient: `Send 2 notes to Website
Relaunch` (teal), and a ✕ to discard them. With an empty queue the button is hidden.

**One sending rule everywhere**: in the Ask bubble and the note popover, Enter sends this note
together with any notes already queued on the page. `Add to batch` (button, or ⌥Enter) queues it
instead. Shift+Enter is a new line. ⌘Enter with focus outside a text field sends the queue.

**Ask bubble**: selecting text in Read mode shows a small bubble above the selection with a
text field `Ask Website Relaunch to…` and three quick chips: `Rewrite`, `Shorten`, `Explain`.

**Note popover**: after a mark, a popover anchored to it shows what the mark resolved to (for
example `Line 14 · "March 6"` or `Lines 12-19 · 2 paragraphs`) so a wrong target is obvious
before sending, a text field, quick chips (`Rewrite`, `Shorten`, `Expand`, `Make a table`,
`Delete this`, `Check facts`), and the buttons `Add to batch` and `Send`. Esc removes the mark.
Each queued note shows a numbered pin in the right margin, level with its mark. Queued notes are
saved as drafts at once, so a reload or a phone suspending the page loses nothing.

**Note states** (pin colour and a label in the pin's tooltip): draft (outline), sent (filled
teal), working (teal with a moving ring), applied (green check: the text it marks changed),
answered (green speech mark: the bot replied without changing the marked text), unresolved
(amber: the page changed and the mark no longer points at one place; redraw it), failed (red,
with the reason).

**Images and PDFs** are reference material. Marks on them ask a question or ask for notes; the
bot answers in chat or writes a companion page `<file> notes.md` next to the file. The bot never
edits the image or PDF itself.

**Empty page**: a new page has only a title. The body shows "Tell Website Relaunch what this
page is for" with a text field. Submitting sends a chat message with the page attached.

### 4.3 Right: the bot

**Following**: the panel shows the bot that owns the open page. Opening a page in another
container switches bots. A pin button keeps the current bot fixed while you browse; the header
then shows `Pinned`. Each bot remembers which conversation you had open.

**Header**: avatar, name, then a status line: `Project bot · Idle · next run 08:00`, `Working…`,
`Waiting for approval in T3`, `Last run failed`, `Paused`. Buttons: Run now (▶, starts a
conversation) or Stop (■) while working, Pin, Settings (⚙), Hide.

**Conversations**: under the header, a bar shows the open conversation's title, a count of the
bot's other conversations with new replies, and `+ New`. The title opens the list: every
conversation, newest first, with an icon for where it came from (chat, notes, trigger,
@mention, manual run), its state and time, bold when it has a new reply, and Archive in its
menu. A message sent from `New` starts a conversation titled from its first words. Notes and
each trigger start conversations of their own.

**Chat only.** Memory, Triggers and Setup are used rarely, so they live on the bot's settings
page in the middle pane (⚙ in the header, the tree menu, Today, or ⌘K "<bot> settings"), with
sections Instructions and model, Memory, Triggers. The sections below describe that page.

**Chat**:
- Your messages are right-aligned bubbles; under one sent with the page open, a small chip names
  the page. Bot messages are plain text rendered as markdown, with the avatar on the first of a
  run. Wikilinks in replies open pages.
- A batch of notes appears as one card, `2 notes on Launch plan`, with Open page; each note's
  outcome shows on its pin.
- A trigger's prompt appears as a card; the bot's answer follows.
- While a bot works, a live line says `Working…` and its reply fills in as it is written.
- A failed run says why (`The run failed: usage limit reached`).
- The composer: autosizing text field, Enter sends, Shift+Enter is a newline. Above it, context
  chips: the open page (on by default, click to remove) and the current selection if any.
- **@mentions**: typing `@` opens a bot picker. `@Finances can we afford the oven?` goes to the
  bot you are talking to and to Finances, as a new conversation of its own; a toast offers to
  open it. Finances' copy shows where it came from and links back; the bot you were talking to
  is told Finances will answer.

**Memory**: the bot's memory is a page in its folder, `.bot/MEMORY.md`. The bot reads it at the
start of every conversation and adds one short line when it learns something lasting
("remember that…"). The settings page shows it rendered, with Edit.

**Triggers**: one row per trigger, written as a sentence: `Every weekday at 08:00 · Prepare
today's brief`, `When a file changes in Inbox/ · Triage it`, `Every 2 hours · Heartbeat`. Each
row has an on/off switch and the next run time. `+ Add trigger` opens an inline form: When
(Every day at…, Every weekday at…, Every N hours, Every week on…, When files change in…) and
Do (a text field). Each trigger keeps one conversation, so its runs are in one place.

**Setup**:
- Name and avatar colour. The name is what you write after `@`.
- Instructions: the bot's standing instructions, given to it at the start of every
  conversation. Rendered markdown with an Edit button.
- Model: Claude (Claude Code) or Codex (ChatGPT), the model, and its effort level, listed from
  what the bots' T3 offers. "Vault default" is the first option. New conversations use the new
  choice.
- Can write: `This folder` (default), `This folder and Resources`, `Whole vault`. The bot is told
  to stay inside; changes it makes elsewhere are flagged on Today.
- Can read: always the whole vault and the saved conversations.
- Pause triggers.

## 5. Flows

### 5.1 First run
1. `npm run vault -- ~/Vault` (or `peers vault ~/Vault`). Peers starts its own T3 and prints a
   local URL with a one-time pairing token.
2. If the folder is empty, Peers creates `Inbox`, `Projects`, `Areas`, `Resources`, `Archive`
   and a `Welcome.md`; `--demo` copies the demo vault in instead.
3. If the folder has PARA roots, Peers creates one bot per container and the vault bot.
4. The bots sign in once with their own accounts: Claude Code and Codex logins kept in
   `~/Library/Application Support/Peers/agents/`, separate from yours, so bot conversations
   never show up in your own T3, Claude Code or Codex. Settings shows whether each is ready.
   `--scripted` runs a demo engine instead, with a "Demo mode: bots are scripted" banner.
5. To use it from the phone, run `tailscale serve --bg 4777` once, start the vault with
   `--origin https://<mac>.<tailnet>.ts.net`, run `peers pair`, open the HTTPS address on
   the phone and type the 6-character code.

### 5.2 New project
1. Click `+` next to Projects (or ⌘K "New project").
2. A sheet asks for a name and one sentence: "What is this project about?".
3. Peers creates the folder and its bot and starts a conversation "Set up <name>" with the
   sentence and the instruction "Set up this project: write an Overview page and a first plan."
4. The bot writes `Overview.md`; the tree shows it as new.

### 5.3 Ask about a selection
1. Select a sentence. The Ask bubble appears.
2. Type "make this friendlier" and press Enter.
3. A conversation "Notes on Launch plan" opens in the bot pane with a note card; the pin turns
   teal and then shows the working ring.
4. The bot edits the paragraph; the page refreshes in place, the paragraph gets a teal bar and
   the chip says what changed, and the note turns applied.

### 5.4 Circle and batch
1. Press P, circle a list. The popover shows `Lines 9-13 · list` and opens; type "turn into a
   table with owners" and press ⌥Enter (or `Add to batch`). Note 1.
2. Press A, drag an arrow from a paragraph to a heading; type "move under this heading".
   Note 2.
3. Click `Send 2 notes to Website Relaunch`. One message goes to the owning bot with both
   notes, their anchors, and a sketch of each mark, in a new conversation.
4. When the run finishes, the chat shows one reply, each note shows its own outcome, and the
   page marks what changed.

### 5.5 What changed since you looked
A bot (or Obsidian, or a sync) changes pages while you are away. The tree shows a teal dot on
each, and Today lists them under "Changed since you looked", newest first, with who changed
them. Opening one shows the changed blocks and the chip once; `Mark all seen` on Today clears the
list. There is nothing to approve or undo: if you dislike a change, mark it and say so, or
restore it from git or Time Machine.

### 5.6 A bot replies
A reply you have not opened makes its conversation bold in the list, adds to the count in the
conversation bar, and shows under Needs you on Today (`Finances replied · Kitchen fund`). Opening
the conversation marks it read. A bot that needs an approval in T3 shows `Waiting for approval`.

### 5.7 Cross-bot
In Kitchen Renovation's chat you write "@Finances can we afford the oven?". The message goes
to Kitchen Renovation, which is told Finances will answer, and to Finances as a new conversation
that links back. Finances answers from its own folder. Any bot can also read the others' saved
conversations when you refer to them ("what did Finances say about the oven?").

### 5.8 Archive and restore
Archive on a project or area waits until its bot is idle, moves the folder to `Archive/`
(adding ` (2)` if the name is taken), records where it came from, pauses its bot and its
triggers. Restore moves it back to where it came from and resumes the bot. Memory and
conversations stay. Archived bots cannot be messaged until restored.

## 6. Bots

### 6.1 Which agents exist
- One for each folder or page the layout names. In a PARA vault: every folder and page directly
  inside Projects and Areas, and those in the archive, paused. In a vault of single-file projects
  (an Org repository), each project file has its own agent and nothing is moved.
- The vault agent for everything else. Notes on those pages go to it.
- Any folder or page can be given an agent, or lose it, from its menu; Settings edits the
  layout's rules.
- A new agent is inert: no triggers and no runs until you use it.

### 6.2 What a bot knows
The first message of every conversation carries the bot's brief, hidden from you: its name,
kind and folder; the vault and its other bots with their folders; where it may write; where
the saved conversations are; where its memory file is and when to add to it; that text in
pages and other bots' messages is information, not instructions; your standing instructions;
and today's date. After that, the conversation is the bot's context, as in any Claude Code or
Codex session. Messages carry the open page and any selection.

### 6.3 What a bot can do
Everything Claude Code or Codex can do in T3's `auto` mode with the bots' own settings: read,
search and edit files, read PDFs and images, run commands. Peers asks each bot to write only in
its folder, flags changes elsewhere, and keeps the definition file under your review: a
definition that gains triggers or a wider scope outside the app waits for you to confirm it.
Bots run on your Claude and ChatGPT plans; Peers does not meter cost.

### 6.4 Triggers
- **Schedule**: every N minutes or hours, every day at a time, every weekday at a time, every
  week on a day at a time. Times use the vault's time zone.
- **Heartbeat**: a schedule whose prompt is the bot's checklist ("Check the plan for overdue
  items; tell me only if something needs me"). Kept as a schedule with a flag so the UI can
  show it as a heartbeat.
- **File change**: files matching a folder path change and the change did not come from this
  bot. Changes are batched for 30 seconds.
- Triggers start switched off. Each keeps one conversation and fires at most once per due time.
  Missed schedules while the server was off fire once on start, not once per missed slot.
- File-change triggers ignore changes made by runs that a trigger started (no ping-pong between
  bots), wait while their conversation is working, and run at most 4 times an hour.

## 7. Today (home)

1. **Needs you**: replies you have not read, conversations waiting for an approval, failed runs,
   notes that lost their place, changes a bot made outside its folder, bot definitions to
   review. Each row opens the right place.
2. **Changed since you looked**: pages changed since you last opened them, newest first, with
   who changed them, and `Mark all seen`.
3. **Coming up**: the next 8 trigger runs.
4. **Bots**: a compact grid of all bots with status and new replies.

## 8. Command palette (⌘K)

One input, results grouped: Pages (fuzzy match on path), Bots, Commands, and "Search text
for …" which runs full-text search. Commands: New project, New area, New resource, New page
here, Run bot, Pause bot, Open Today, Toggle theme, Toggle left pane, Toggle bot pane,
Switch provider for all bots. Arrow keys move, Enter opens, ⌘Enter opens in the bot pane
when the result is a bot.

## 9. Keyboard

| Key | Action |
| --- | --- |
| ⌘K | Palette |
| ⌘\\ | Toggle tree |
| ⌘⇧\\ | Toggle bot pane |
| ⌘J | Focus the chat composer |
| V P A E | Page tools (when focus is not in a text field) |
| Enter (in a note field) | Send this note and the queued ones |
| ⌥Enter (in a note field) | Add to batch |
| ⌘Enter (outside fields) | Send queued notes |
| Esc | Cancel the current mark, close popovers, back to Read |
| G then T | Go to Today |

## 10. Look

### 10.1 Themes
Day, Night and System (default). Both themes use the same structure; only tokens change.

| Token | Day | Night |
| --- | --- | --- |
| `--bg` (page) | `#FAF9F6` | `#0F1216` |
| `--panel` (tree, bot) | `#F3F1EC` | `#151A20` |
| `--surface` (cards, popovers) | `#FFFFFF` | `#1B2129` |
| `--text` | `#1F2328` | `#E6E8EB` |
| `--muted` | `#6B6F76` | `#9AA1AA` |
| `--line` (hairlines) | `#E4E1DA` | `#262D36` |
| `--accent` (teal) | `#0E7C7B` | `#3FB8B4` |
| `--attention` (amber) | `#B7791F` | `#E8A33D` |
| `--danger` | `#C2412D` | `#F07A5F` |
| `--ink` (default pen) | `#0E7C7B` | `#5ED1CC` |

Contrast: body text on `--bg` is at least 12:1 in both themes; muted text at least 4.5:1.

### 10.2 Type
System fonts only, so nothing downloads: `-apple-system, "SF Pro Text", system-ui` for UI;
`"New York", "Iowan Old Style", ui-serif, Georgia, serif` for page text; `ui-monospace, "SF
Mono", Menlo` for code. UI text 13 px, small labels 11.5 px with 0.02 em tracking, page titles
32 px semibold sans.

### 10.3 Shape and depth
Radii 6 px (controls), 10 px (cards, popovers), 999 px (pill). Hairline borders. One shadow for
floating things: `0 8px 24px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06)` in Day, a darker
variant in Night. No gradients except the avatar tint.

### 10.4 Bot avatars
A rounded square for areas, a circle for projects, a hexagon for the vault bot. Fill is the
bot's colour at 16% opacity with the initial in the full colour. Colours come from a fixed
set of eight hues chosen by a hash of the bot id, editable in Setup.

### 10.5 Motion
Following the KDPA motion rules: nothing pops; fades at least 150 ms with
`cubic-bezier(0.25,0.1,0.25,1)`; popovers scale from 0.98 and fade in 160 ms; panes collapse
with a 200 ms width transition; tab switches are instant; the working dot pulses with a
1.6 s opacity loop and stops under Reduce Motion. No view transitions for navigation on
iPhone.

## 11. Phone

Below 820 px wide the app becomes one pane with a bottom tab bar: **Vault** (tree and Today),
**Page**, **Bot**. The tab bar respects the home-indicator safe area. Opening a page switches to
the Page tab. The tool pill sits above the tab bar and shrinks to icons. A finger scrolls the
page in Read mode and draws in a draw tool. The note popover becomes a bottom sheet. On the Page tab, a bot sheet
peeks above the tool pill (avatar, status, one-line composer: "Tell Health what to change…"),
as in the phone mockup; dragging it up shows the chat, and it hides while you draw. The Bot
tab shows the bot pane with its conversation bar. On iPhone, adding the app to the Home Screen gives a
full-screen app with no Safari bars.

On the phone the tool pill shows the active tool, a tool picker, and the send control, all at
least 44 px. While you mark or type a note, the bot sheet stays collapsed. Change marks stay
while the page is open, so switching to the Bot tab never hides them.

Between 820 and 1180 px the layout drops the tree into an overlay (opened from the header) and
keeps page and bot side by side. A separate tablet design is left for later.

Pairing a phone: open the HTTPS address, type the 6-character code from `peers pair` (or
from Settings on a paired device). Each paired device appears in Settings and can be removed.
Adding the app to the Home Screen keeps the session because pairing happens inside the app.

## 12. Desktop app

The web app is installable: Chrome and Edge show "Install", Safari on macOS has "Add to Dock".
The installed window has no browser UI and keeps its own window size. A service worker caches
the app shell so the window opens instantly; data always comes live from the server. A native
wrapper (Tauri) is a later option if we need a menu bar item or global shortcuts.

## 13. Accessibility

Every tool has a text label in its tooltip and an `aria-label`. All flows work by keyboard,
including marking: in Read mode, select text with the keyboard and press ⌘Enter to open the
note popover. Focus rings are 2 px accent outlines. Status is never colour alone: each dot has
a tooltip and a screen-reader label. Reduce Motion turns pulses and slides into fades.

## 14. Copy rules

Short labels, sentence case, verbs on buttons (`Send 2 notes`, `New`, `Run now`). The bot
is named, never "the AI". Errors say what happened and what to do: "The run failed: usage
limit reached. Try again after the limit resets, or switch this bot to Codex in its settings."

## 15. Out of scope for v1

- Real-time collaboration between several people.
- A rich text editor.
- Undo and version history inside Peers (use git, Time Machine or a sync tool).
- Approving T3 runtime requests from the vault (they show as "waiting").
- Sync between machines (use iCloud Drive, Syncthing or git on the vault folder; the app
  state stays on one Mac).
- Voice mode beyond system dictation.
- Graph view.

## 16. Open questions

- **Links between projects, areas and resources.** Today they are linked by the wikilinks and
  file links in pages. Options: a `related:` list in each front page that the tree and agents
  read, or backlinks computed from links and shown under the page.
- **Tasks.** Org vaults already have tasks (TODO, NEXT, WAITING); Markdown vaults have
  checkboxes. Today could list next actions and deadlines across projects.
