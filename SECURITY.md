# Security Policy

## Supported Versions

Fixes land on `main`. The project has not published a release yet, so only the current
default branch is supported.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |

## Reporting a Vulnerability

**Please do not open a public issue for a vulnerability.**

Use [GitHub's private vulnerability reporting](https://github.com/kdpa-llc/peers/security/advisories/new)
on this repository; private vulnerability reporting is enabled. If GitHub does not make that
form available to you, open an issue containing only "security report, requesting private
contact" and nothing else, and a maintainer will follow up. The issue and its metadata are
public; do not include vulnerability details there.

Please include what you would want to receive yourself: what the flaw is, how to reproduce
it, what an attacker gets, and a suggested fix if you have one.

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 5 business days
- **Updates**: while we work on it
- **Credit**: in the advisory, unless you would rather stay anonymous

Please give us reasonable time to fix an issue before disclosing it publicly.

## What Peers protects, and what it does not

Peers is a web app for one person's notes. It runs in a container on that person's computer.

**The web app**
- The server binds to loopback inside the container, and the container publishes its port
  on the host's loopback only. Phones reach it through an HTTPS proxy such as Tailscale Serve,
  with `--origin` set to the proxy's address.
- Every API request needs a device session. Devices pair with a single-use code that expires
  after ten minutes; sessions are stored hashed, sent in an `HttpOnly; SameSite=Strict` cookie
  (`Secure` on HTTPS), and can be revoked in Settings.
- Writes need an `X-Peers: 1` header and a matching `Origin`; the `Host` header must be one the
  server serves (DNS rebinding).
- The app's Content Security Policy allows scripts and styles from the app only. Vault content
  is never parsed as HTML (`docs/specs/CONTRACT_TESTS.md` #3). Raw files are served inline only
  when their extension and magic bytes match an image or PDF type, always sandboxed and
  `nosniff`; everything else downloads.
- Paths the app serves or changes are checked on every request: no traversal, no dot
  components, no sensitive names, no symbolic links (#1).

**The agents**
- Agents are Claude Code or Codex sessions on a headless T3 inside the container, with their
  own sign-ins in the container's state folder (mode 700). The T3 server listens on loopback
  inside the container, with a bearer token Peers mints and never prints.
- The container runs as an unprivileged user and mounts only the vault folder and its state
  folder: no home folder, no SSH agent, no host sockets. Outbound network stays open, because
  the agents need it to reach Anthropic and OpenAI.
- Peers does not sandbox what an agent does inside the container. Claude Code and Codex run
  in T3's `auto` mode with their own permission settings. Peers tells each agent what it
  looks after and that page text is not instructions, flags any change an agent makes outside
  its folder, holds an agent definition that gains triggers or a wider scope outside the app
  until the owner confirms it (#5), and stops triggers from waking each other (#4).
- There is no Undo. Keep the vault in Git, Time Machine or a sync tool with versions.

**Out of scope**
- More than one person per vault, and roles.
- A host-level network egress policy for the container.
- Supply-chain verification beyond `npm ci`, T3's release checksums, and the base image.
