# Working in this repository

**Read [`PROJECT_CONSTITUTION.md`](PROJECT_CONSTITUTION.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md) first.** The constitution is what the project refuses to
become; CONTRIBUTING lists the conventions that break things when ignored.

## Commands

```bash
npm install                    # one runtime dep (@anthropic-ai/sdk) + typescript, @types/node
npm test                       # contract + acceptance tests, fully deterministic
npm run typecheck
npm run peers -- run --scripted # drive an organization with no API key
npm run peers -- <cmd>         # management console; see README for the command list
python3 scripts/validate-schemas.py   # needs: pip install jsonschema
```

Requires Node 22.6+ (`node:sqlite`, `--experimental-strip-types`).

## Conventions

- **Schemas first.** `docs/specs/*.json` is the source of truth (ADR 0011). Change a schema
  before the TypeScript that mirrors it in `src/domain/types.ts`.
- **Cross-record rules live in `docs/specs/CONTRACT_TESTS.md`**, numbered #1–#30. Tests cite
  the number they enforce; add a numbered entry rather than an unreferenced assertion.
- **No parameter properties.** `erasableSyntaxOnly` is on because the CLI runs through type
  stripping — `constructor(private readonly x: T)` will not run. Declare fields explicitly.
- **Decisions get an ADR.** `docs/adr/`, sequentially numbered.
- **The control plane must not branch on agent id or task text.** Grep `controlPlane.ts` for
  agent-specific logic before adding any; see Constitution §2 and §3.
