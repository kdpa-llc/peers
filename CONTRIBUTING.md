# Contributing to Peers

Thanks for looking. Read [`docs/design/PRODUCT.md`](docs/design/PRODUCT.md) for what Peers is
for and [`docs/design/TECHNICAL.md`](docs/design/TECHNICAL.md) for how it is built.

## Getting set up

Requires **Node 22.13+**: Peers uses `node:sqlite` without a runtime flag and runs TypeScript
through Node's type stripping.

```bash
git clone https://github.com/kdpa-llc/peers
cd peers
npm install

npm test                                        # deterministic: demo engine, fixed clock, temp folders
npm run typecheck                               # server and web client
npm run dev -- /tmp/vault --demo --scripted     # the server in this process, scripted agents
npm run peers -- up /tmp/vault --demo           # the real thing, in a container (macOS 26+)
```

The browser journey (`npm run test:e2e`) drives the app in desktop Chromium and phone WebKit.
Playwright is not a dependency of this repository: install `playwright-core` anywhere and set
`PEERS_PLAYWRIGHT` to that folder.

The test suite needs no account, no network and no wall-clock time. Agents in tests are the
demo engine (`DemoEngine` in `src/vault/engine.ts`); the T3 client is checked against shapes
recorded from a live T3 (`tests/fixtures/`). When T3's protocol changes, record new fixtures
from a live run and update `src/vault/t3/`. A live check against a real T3 with signed-in
agents is a manual step before a release.

Schema validation runs independently of the implementation:

```bash
pip install jsonschema
python3 scripts/validate-schemas.py
```

## The conventions that will trip you up

**Schemas first.** `docs/specs/*.json` (agent definitions, notes, layouts) is the source of
truth; change a schema before the TypeScript that reads it.

**Cross-record rules are numbered.** Rules JSON Schema cannot express live in
[`docs/specs/CONTRACT_TESTS.md`](docs/specs/CONTRACT_TESTS.md) as numbered entries, and tests
cite the number they enforce.

**No parameter properties.** `erasableSyntaxOnly` is on because the CLI and the web client run
through type stripping. `constructor(private readonly x: T)` compiles and then does not run.
Declare fields explicitly.

**The web client never parses vault content as HTML** (CONTRACT_TESTS #3, ADR 0002). Build DOM
with `h()` from `web/lib/dom.ts`; a test scans `web/` for `innerHTML` and its relatives.

**No organising method in code** (ADR 0005). Which folders and pages have agents comes from
the vault's layout. Folder names like Projects or Areas only appear in the presets that
suggest a layout.

**Agents are reached only through `BotEngine`** (ADR 0003). The T3 engine and the demo engine
implement it; app code never talks to T3 directly.

**Decisions get an ADR** in `docs/adr/`, numbered in sequence.

## Releasing

Releases go to npm as [`peers-vault`](https://www.npmjs.com/package/peers-vault) from GitHub
Actions with npm trusted publishing, so no npm token is stored anywhere:

```bash
npm version patch          # or minor / major: bumps package.json and tags vX.Y.Z
git push --follow-tags     # the Release workflow checks, publishes with provenance, and creates the GitHub release
```

Update `CHANGELOG.md` before tagging.

## Pull requests

- Keep each change focused, with tests that cite the rule they enforce.
- `npm test`, `npm run typecheck`, `npm run build` and `npm run test:package` pass locally.
- Describe what changes for someone using Peers.

By contributing you agree that your work is released under the [MIT License](LICENSE).
