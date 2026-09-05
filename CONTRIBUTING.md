# Contributing to Peers

Thanks for looking. This project has strong opinions and the opinions are the point — so the
most useful things to read before writing code are
[`PROJECT_CONSTITUTION.md`](PROJECT_CONSTITUTION.md), which is what the project refuses to
become, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), which is how the two layers fit
together.

## Getting set up

Requires **Node 22.6+** — the project uses `node:sqlite` and runs TypeScript through type
stripping, both of which need that version.

```bash
git clone https://github.com/kdpa-llc/peers
cd peers
npm install          # runtime SDK plus TypeScript development tooling

npm test             # contract + acceptance tests, fully deterministic
npm run typecheck
npm run peers -- run --scripted   # drive an organization with no API key
```

The test suite needs no API key, no network, and no wall-clock time: fixed clock, sequential
ids, scripted model adapter, in-memory SQLite. If a test of yours needs any of those things,
that is a signal worth examining before it is a problem worth solving.

Schema validation runs independently of the implementation:

```bash
pip install jsonschema
python3 scripts/validate-schemas.py
```

## The conventions that will trip you up

These are not style preferences. Each one exists because breaking it broke something.

**Schemas are the source of truth** (ADR 0011). `docs/specs/*.json` is authoritative; the
TypeScript in `src/domain/types.ts` mirrors it. Change the schema first, then the types. A
schema change that breaks the shapes the control plane emits should fail
`validate-schemas.py` even when the code still compiles — that is the whole point of keeping
that script dependency-free of the implementation.

**Cross-record rules are numbered.** Anything JSON Schema cannot express lives in
[`docs/specs/CONTRACT_TESTS.md`](docs/specs/CONTRACT_TESTS.md) as a numbered entry, and tests
cite the number they enforce. Add a numbered entry rather than an unreferenced assertion — an
invariant nobody can find is an invariant nobody maintains.

**No parameter properties.** `erasableSyntaxOnly` is on because the CLI runs through type
stripping. `constructor(private readonly x: T)` compiles and then does not run. Declare
fields explicitly.

**The control plane must not branch on agent id or task text.** This is the load-bearing one.
Behavior comes from the model's decisions, not from the platform; the moment
`controlPlane.ts` contains `if (agent.agent_id === ...)`, the project has quietly become the
workflow graph it exists to avoid. Grep it for agent-specific logic before adding any, and
read Constitution §2 and §3 first.

**Context is reconstructed, never accumulated** (Constitution §5). The control plane owns
prompt assembly precisely so an adapter cannot smuggle in a growing transcript. An adapter
may hold state within one execution; it must not carry any across executions.

**The inbox is a single write boundary.** `inbox.ts` derives routing fields from the `Task`,
so contract invariant #1 cannot be violated by construction. Do not write inbox rows anywhere
else, and treat the `Task` as authoritative over any denormalized routing copy (ADR 0010,
0012).

**Terminal execution records are immutable.** A delegation produces exactly one terminal
result — `deliverDelegationResult` throws on a second.

**Decisions get an ADR.** `docs/adr/`, sequentially numbered, short. If you find yourself
explaining a choice in a PR comment, it probably wanted an ADR instead.

## Deliberate omissions

So you do not add them assuming they were forgotten:

- **No linter or formatter.** The sibling repos in this org run ESLint, Prettier, husky, and
  commitlint. This one does not. It has one runtime dependency (the Anthropic SDK) and two
  development dependencies; adding a hundred-package tooling tree would cost more than the
  consistency is worth at this size. Match the surrounding code's style by reading it. If the
  project grows past the point where that works, adding the stack is a reasonable PR — with
  an ADR.
- **No build step, no bundler, no published package.** It runs from source.
- **No semantic-release.** Versioning is manual and there is nothing to publish yet.

## Pull requests

1. Branch from `main`.
2. Make the change, with tests. New behavior needs a test; a bug fix needs a test that would
   have failed before it.
3. Run `npm test`, `npm run typecheck`, and `python3 scripts/validate-schemas.py`.
4. Update the docs that are now wrong — a schema, an ADR, or `CONTRACT_TESTS.md` if the
   change touches a contract.
5. Open the PR against `main` and fill in the template.

CI runs the same commands you just ran, plus a management-console smoke test, so
a green local run should mean a green CI run.

### Commit messages

[Conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
`test:`, `refactor:`, `ci:`, `chore:`.

Say what changed and *why it was wrong before*. The subject line is the least interesting part
of a commit message; the body is where a reader six months from now finds out what you knew
that they do not.

### What makes a change easy to accept

- It has a test that fails without it.
- It cites the invariant, ADR, or contract-test number it upholds or adds.
- It does not widen the platform's knowledge of what agents are for.
- It says plainly what it did not do, and why.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/kdpa-llc/peers/issues/new/choose). For a bug,
the reproduction matters more than the description. For a feature, the problem matters more
than the proposed solution — this project has a fairly specific idea of what it is, and the
most valuable feature requests are the ones that describe a real friction rather than a
missing checkbox.

Security issues are different: see [`SECURITY.md`](SECURITY.md) and do not open a public
issue.

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
