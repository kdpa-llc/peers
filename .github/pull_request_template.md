## What this changes

What is different after this PR for someone using Peers, and what was wrong before it. If it
fixes an issue, link it (`Fixes #123`).

## Why

The reasoning a reviewer cannot reconstruct from the diff.

## Checks

- [ ] No schema changed, **or** `docs/specs/*.json` was changed before the TypeScript that reads it
- [ ] No new cross-record rule, **or** it is a numbered entry in `docs/specs/CONTRACT_TESTS.md`
      and the test cites its number
- [ ] No decision worth recording, **or** there is an ADR in `docs/adr/`
- [ ] Nothing in code assumes an organising method (which folders have agents comes from the layout)
- [ ] The web client still never parses vault content as HTML

```
npm test
npm run typecheck
npm run build && npm run test:package
python3 scripts/validate-schemas.py
```

- [ ] These pass locally (and `npm run test:e2e` for UI changes)
- [ ] New behaviour has a test; a bug fix has a test that failed before it
