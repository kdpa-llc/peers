# ADR 0015 — A Real Model Is the Default; the Script Is the Opt-In

## Status
Accepted

Supersedes the adapter-selection half of [ADR 0014](0014-claude-model-adapter.md).

## Decision
The management console runs against `ClaudeModelAdapter` by default. `--scripted` selects
`ScriptedModelAdapter` instead. The previous `--live` flag is gone.

`@anthropic-ai/sdk` moves from `optionalDependencies` to `dependencies`, because the default
path now requires it. The demo entry point (`src/cli/demo.ts`, `npm run demo`) is removed, and
the scripted scenario it shared with the tests moves from `src/demo/` to `src/scripted/`.

## Why
ADR 0014 added a real model adapter but left the scripted one as the default, so the platform
shipped with `--live` as the way to opt into reality. That is the wrong way round for a project
whose entire claim is that behavior comes from the model rather than the platform. An
organization of agents that cannot reason is not demonstrating the thesis; it is replaying a
recording of it. Someone cloning the repository and running `npm run peers -- run` should see
agents decide, not a script re-enact decisions someone already made.

The `--live` name made this worse by implying the model path was an experimental mode attached
to a working product, when it is the product.

Making the SDK a real dependency follows from the same reasoning. "Zero runtime dependencies"
was a genuine property, but it was only true because the thing the project exists to do was
opt-in. The honest version is one runtime dependency, which is still a defensible number.

## Why the scripted adapter stays
Removing it entirely was considered and rejected. It is not a demo; it is the test double that
makes the whole control plane verifiable:

- The contract and acceptance suites inject it through `tests/helpers.ts`. Without it they would need a funded API
  key, would cost money on every pull request, and would stop being reproducible — the suite
  would no longer be able to assert that a specific sequence of decisions produces a specific
  sequence of events.
- CI's management-console check spans two processes against a file-backed database and asserts
  on exact timeline lines. That assertion is only meaningful against fixed decisions.
- Constitution §2 says behavior must come from the model rather than the platform. The cheapest
  proof of that is swapping the adapter and observing the organization behave differently while
  the control plane is untouched. Deleting one of the two adapters removes the ability to
  demonstrate the claim at all.

So the scripted adapter is retained as test infrastructure and as an offline inspection mode,
and is no longer presented as a way to *use* the project.

## Consequences
`npm run peers -- run` now costs money and requires `ANTHROPIC_API_KEY`. Anyone wanting the
previous keyless behavior passes `--scripted`, which CI does for exactly that reason.

`npm run demo` no longer exists. The scenario it printed is still exercised end to end by
`tests/e2e/prototype.test.ts`, so nothing is untested by its removal; what is lost is a
one-command way to watch the whole thing print, which `npm run peers -- run --scripted`
followed by `timeline` reproduces.

The README can no longer claim zero runtime dependencies.
