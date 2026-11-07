# Contract tests

Rules that JSON Schema cannot express. Each has a number; the tests that enforce it cite it.

1. **Every vault path the app serves or changes obeys the path policy.** No traversal, no
   component starting with a dot (`.peers`, `.git`, `.obsidian`), no sensitive name, no
   symbolic link in any component, checked on every request. (`tests/paths.test.ts`,
   `tests/server.test.ts`)
2. **A schedule fires at most once per slot.** The slot is recorded before its run is sent; a
   new schedule does not fire for slots before it existed; after time off, one catch-up run
   fires, not one per missed slot. (`tests/schedules.test.ts`)
3. **The web client never parses vault content as HTML.** No file under `web/` uses
   `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `DOMParser`, `createContextualFragment`,
   `srcdoc`, `document.write`, `eval` or `new Function`. (`tests/client-static.test.ts`,
   `tests/markdown.test.ts`)
4. **Triggers cannot wake each other forever.** A file change made by a run a trigger started
   never fires a file trigger; a trigger ignores its own agent's changes, waits while its
   conversation is working, and runs at most four times an hour. (`tests/schedules.test.ts`)
5. **Automation a definition gains outside the app waits for the owner.** An agent definition
   (`.peers/agents/<id>.json`) with an unseen id that carries enabled triggers or a wide write
   scope, or a known one changed on disk to add them, is marked `needs_review`, and its
   triggers do not fire until the owner confirms it. (`tests/schedules.test.ts`)
