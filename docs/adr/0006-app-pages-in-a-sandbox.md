# ADR 0006 — App pages run in a sandboxed frame

## Status
Accepted.

## Context
Pages are Markdown or Org, rendered into text and elements, and HTML in them stays text (ADR
0002). People also want views that a page cannot be: a dashboard of every project's
deadlines, a chart of a budget, a small tool. Agents can write those as web pages. But agents
write what they read, and anything the browser runs on the Peers origin runs as the owner: it
could message agents, edit files and add agents. A prompt-injected agent that writes one
script would own the vault.

## Decision
1. **What an app is.** Any `.html` file is an app page. A folder with a `peers.app.json`
   (`docs/specs/app.schema.json`) is an app: its `entry` (default `index.html`) opens when
   you open the folder, and its manifest can ask for more. Apps are files in the vault, so
   agents build them, Git syncs them, and Obsidian and Emacs ignore them.
2. **An opaque-origin frame.** The middle pane shows an app in an `<iframe sandbox>` without
   `allow-same-origin`, and every app response also carries a CSP `sandbox` directive, so the
   app runs in a unique origin even when opened directly. It cannot read the session cookie,
   storage or the Peers page, and its requests to Peers are cross-site, so the `SameSite=Strict`
   session cookie never goes with them. The API also refuses `Origin: null` and cross-site
   fetch metadata outright.
3. **A capability path, not a session.** Opening an app asks the API (with the session) for a
   random token bound to that app and device. The frame loads from `/apps/<token>/…`: the app's
   own files, and under `_peers/` a read-only data API (files, folder listings, parsed pages,
   tasks with deadlines, change events) and a small helper script. The token dies after twelve
   hours, with its device, and when the server restarts.
4. **What an app reads.** Its own folder and the patterns in `reads`, each path through the
   path policy (CONTRACT_TESTS #1). A single `.html` file without a manifest reads its folder.
5. **The network is off until the owner allows it.** The CSP lets an app load and connect
   only within its own `/apps/<token>/` path. Origins listed in `network` are added once the
   owner allows them in the app's header. The grant is stored in Peers' state, not the vault,
   so a manifest edit cannot grant itself; a manifest that asks for more opens with the old
   grant and asks again.
6. **The page can ask, not act.** Through `postMessage` an app can open a vault page in Peers,
   or propose a message to the folder's agent, which the owner confirms before it is sent.
7. **Spelled-out origins.** CSP source lists name the origin the browser used, from the Host
   and forwarded headers Peers already checks, plus the token path. WebKit does not match
   `'self'` from a sandboxed document, and the path keeps an app away from `/api`.

## Consequences
- ADR 0002's rule stands for the Peers client: it never parses vault content as HTML
  (CONTRACT_TESTS #3). Vault HTML runs only in the frame, loaded by URL, never `srcdoc`.
- With the network off, an app can still leak through channels CSP does not cover, such as
  WebRTC. The guarantees are that an app cannot act as the owner or reach Peers' state; the
  network rule is defence in depth. Agents themselves can reach the internet from the
  container (ADR 0004), so apps add no new way out for an agent.
- Inline scripts and `eval` are allowed inside the frame, so ordinary frameworks and
  libraries work. Agents are told to keep libraries as files in the app folder.
- Server code for apps, which can store data, is ADR 0007.
