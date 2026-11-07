# Instructions for AI agents

## Installing Peers for someone

1. Check the requirements: macOS 26+ on Apple silicon with Apple's `container` tool
   (`container system status` succeeds; `container system start` if it is installed but
   stopped), Node.js 22.13+, and `git`.
2. `git clone https://github.com/kdpa-llc/peers.git && cd peers && npm install`
3. Ask which folder holds their notes (or use `~/Peers Vault` and add `--demo` for a tour).
   Run `npm run peers -- up "<folder>"`. The first run builds the container image, which
   takes a few minutes.
4. Hand the person the printed `http://127.0.0.1:4777/?pair=…` link. They open it and sign the
   agents in under Settings → Bots (Claude shows a link and asks for a code back; Codex shows a
   device code). You cannot do this step for them.
5. `npm run peers -- status` confirms it is running; `npm run peers -- logs` shows why when not.

Do not copy credentials into the container, and do not change the person's own Claude Code
or Codex configuration: the agents' sign-ins are separate on purpose.

## Working on this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short:

- `npm test`, `npm run typecheck`, `npm run build`, `npm run test:package` must pass.
  `npm run test:e2e` drives the app in a browser (it needs `playwright-core`).
- Schemas in `docs/specs/` come first; cross-record rules are numbered in
  `docs/specs/CONTRACT_TESTS.md` and tests cite the number they enforce.
- No parameter properties (`erasableSyntaxOnly`): the CLI and the web client run through type
  stripping. Declare fields explicitly.
- The web client never parses vault content as HTML: build DOM with `h()`.
- Peers has no built-in organising method: which folders have agents comes from the vault's
  layout, never from folder names in code.
- Decisions get an ADR in `docs/adr/`, numbered in sequence.
