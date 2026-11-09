# ADR 0007 — App servers run in bubblewrap, inside the container

## Status
Accepted.

## Context
App pages (ADR 0006) can read the vault and show it, but some tools need to keep data or run
code: an expense log, a habit tracker, a script that turns notes into a chart. Agents can
write that code; the question is where it runs and what it can reach. The container (ADR 0004)
already keeps everything away from the host, but inside it Peers' state folder holds the
agents' Claude and Codex sign-ins, T3's data and the device sessions. App code written by an
agent must not reach them.

## Decision
1. **A manifest names a server.** `"server": "server.py"` (or `.ts`, `.js`) in `peers.app.json`
   (`docs/specs/app.schema.json`): an HTTP server listening on `$PORT`. The app's pages call it
   under `_api/` on their capability path; Peers proxies those requests.
2. **Only after the owner allows it.** Like network access, the grant lives in Peers' state, and
   the app's bar asks for it: "run its server in a sandbox, with internet access". Every proxied
   request checks the grant as it is now; taking it back stops the server and ends the app's
   tokens.
3. **bubblewrap, inside the container.** The image installs `bubblewrap`. Each server runs with
   its own user, process, IPC, UTS and cgroup namespaces; `/usr` and `/etc` read-only; its app
   folder read-only at `/app` and its `data/` folder writable at `/app/data`; a private `/tmp`;
   a clean environment; and no `/proc`. The container's `/proc` cannot be mounted afresh
   inside it, and binding it would expose other processes' roots and environments, so there is
   none. The server never sees `/vault` or `/state`.
4. **The vault through the data API.** A server reads notes the way its pages do: `$PEERS_API`
   is the same `_peers/` API with a token of its own, so the app's `reads` and the path policy
   apply to it too (CONTRACT_TESTS #7). It writes only in `$PEERS_DATA`; those changes are
   credited to the app in "changed since you last looked".
5. **On demand.** A server starts when its app opens or on its first request, stops after ten
   idle minutes, restarts when a file in its folder outside `data/` changes, and at most four
   run at once. Three exits within a minute stop restarts until the owner restarts it from the
   app's bar, which also shows its output; the log is kept in the state folder, and agents are
   told where.
6. **No sandbox, no server.** Outside a system where bubblewrap works (macOS, or a CI runner
   that forbids user namespaces) servers do not start. `PEERS_APP_SANDBOX=off` runs them
   unsandboxed for development and tests only.
7. **The proxy keeps Peers' rules.** Peers answers the CORS preflight itself, sends no cookie,
   origin or forwarded headers on, strips `Set-Cookie`, CSP and CORS headers from the answer, and
   keeps the frame's own CSP and CORS headers (ADR 0006). Bodies up to 10 MB, 60 s per request.

## Consequences
- Servers share the container's network: they can reach the internet and the container's
  loopback services, which all need their own tokens (Peers, T3). An offline server would need
  its own network namespace and a Unix socket for the proxy; that is follow-up work.
- There are no per-server memory or CPU limits beyond the container's own.
- Python servers use the standard library or files in the app folder; there is no package
  install step. Node servers get Node's built-in TypeScript type stripping.
