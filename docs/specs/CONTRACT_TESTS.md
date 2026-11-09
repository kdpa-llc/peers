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
6. **An app runs in an opaque origin that cannot act as the owner** (ADR 0006). App files are
   served only under `/apps/<token>/`, never from a session; every response there carries a
   CSP with `sandbox` and without `allow-same-origin`, `frame-ancestors` limited to Peers' own
   origins, and sources limited to that token's path plus granted origins. The API refuses
   requests with `Origin: null` or cross-site fetch metadata. (`tests/apps.test.ts`)
7. **An app reads only its own folder and the paths its manifest lists,** each through the
   path policy (#1). A token is bound to one app and one device and stops working when the
   device is revoked or after twelve hours. (`tests/apps.test.ts`)
8. **Internet access waits for the owner and is limited to what the owner allowed.** The grant
   lives in Peers' state, not the vault; origins a manifest adds later stay blocked until the
   owner allows them too. (`tests/apps.test.ts`)
