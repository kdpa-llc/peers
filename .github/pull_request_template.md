## What this changes

What is different after this PR, and what was wrong before it. If it fixes an issue, link it
(`Fixes #123`).

## Why

The reasoning a reviewer cannot reconstruct from the diff. If this was a judgment call, say
what you weighed.

## Type of change

- [ ] Bug fix
- [ ] New capability
- [ ] Breaking change to a contract (schema, ADR, or numbered contract test)
- [ ] Documentation
- [ ] Tests
- [ ] CI / tooling

## Contracts

- [ ] No schema changed, **or** `docs/specs/*.json` was changed *before* the TypeScript that
      mirrors it (ADR 0011)
- [ ] No new cross-record rule, **or** it is a numbered entry in `docs/specs/CONTRACT_TESTS.md`
      and the test cites its number
- [ ] No decision worth recording, **or** there is an ADR in `docs/adr/`
- [ ] This does not make the control plane branch on agent id or task text
- [ ] This does not let any adapter carry conversation state across executions
      (Constitution §5)

## Verification

```
npm test
npm run typecheck
python3 scripts/validate-schemas.py
```

- [ ] All three pass locally
- [ ] New behavior has a test; a bug fix has a test that failed before it
- [ ] Docs updated if this changed a contract — a schema, an ADR, or `CONTRACT_TESTS.md`

## What this does not do

Anything you deliberately left out, and why. Reviewers should not have to guess whether an
omission was a decision or an oversight.
