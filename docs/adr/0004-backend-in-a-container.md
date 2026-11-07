# ADR 0004 — The whole backend runs in one container

## Status
Accepted.

## Context
With ADR 0003 the agents are Claude Code and Codex sessions in a T3 that Peers starts. Run
directly on the computer, that is a tree of processes running as the owner, able to reach
everything the owner can: other folders, credentials, SSH agents, other apps' data. Owners
want the agents bounded to their notes, and one thing to start and stop.

Apple's `container` tool runs each Linux container in its own lightweight virtual machine on
macOS 26 and later. T3 Code publishes a self-contained Linux build, and Claude Code and Codex
install from npm on Linux.

## Decision
1. **One image** (`container/Containerfile`): Debian with Node, T3's Linux release checked
   against the release's `SHA256SUMS`, Claude Code and Codex from npm, and the compiled app.
   It runs as an unprivileged user under `tini`.
2. **The container sees two folders**: the vault at `/vault` and Peers' state at `/state`
   (the database, T3's data, saved conversations, the agents' sign-ins). Nothing else is
   mounted; no SSH agent, host sockets or nested virtualization.
3. **The web port is published on the host's loopback only.** Phones reach it through an
   HTTPS proxy on the host, such as Tailscale Serve.
4. **`peers up [dir]`** builds the image when missing, starts the container, waits for the
   server and prints a one-time link. `down`, `status`, `logs`, `pair`, `build` and `login`
   cover the rest. `peers serve` runs the server in-process, inside the container and for
   development.
5. **The agents sign in from Settings**, inside the container, once per state folder.

## Consequences
- What an agent can touch is bounded by the virtual machine: the vault, the state folder and
  the network. A misbehaving agent can damage the vault but not the rest of the computer.
- File changes made on the host may reach the watcher inside late; a periodic scan picks them
  up within a minute.
- Only Apple's `container` is supported today; Docker and Podman, and a published image, are
  follow-up work.
