# `main` repository ruleset

Settings to apply to `main` before this repository goes public, and the reasoning behind
each. Use a repository **ruleset**, not classic branch protection: the approved maintainer
bypass must cover every rule in one place. These are repository settings, not code — nothing
in the repo enforces them, so this file exists so the configuration is reviewable and
reproducible rather than living only in one person's memory of what they clicked.

Create the ruleset before removing or changing any existing protection. When a ruleset and
classic protection overlap, both are enforced.

## Ruleset target and bypass

- Enforcement status: **Active**
- Target: default branch, `main`
- Bypass actor: user **`moscaverd`**
- Bypass mode: **Always allow**

`moscaverd` is currently the sole maintainer, so this approved bypass prevents an accidental
lockout. It is a high-trust exception: use the normal pull-request path whenever possible,
and review the bypass list whenever maintainership changes. The exception is attached to
this user, not to the Admin role, so future administrators do not inherit it automatically.

## Required settings on `main`

**Require a pull request before merging**

- Required approvals: **1**
- Dismiss stale approvals when new commits are pushed: **on**
- Require review from Code Owners: **on** (see [`CODEOWNERS`](CODEOWNERS))

  A pull-request rule with one required approval or required Code Owner review cannot be
  satisfied by the sole maintainer on their own PR. The explicit `moscaverd` Always allow
  bypass is what makes this configuration operable while preserving the normal review rule
  for every other contributor.

**Require status checks to pass**

- Require branches to be up to date before merging: **on**
- Required checks:
  - `typecheck, tests, console`
  - `schema validation`

  Both come from [`workflows/ci.yml`](workflows/ci.yml). The schema job is listed separately
  on purpose: it installs no Node and validates `docs/specs/` independently, so it fails on a
  contract break even when the TypeScript still compiles (ADR 0011). Merging on the Node job
  alone would defeat that.

  `CodeQL` and `Review Dependencies` are deliberately **not** required. They are advisory —
  a scheduled scan and a moderate-severity gate — and making a scan that can be flaky or slow
  a merge blocker teaches people to bypass protection rather than to read the finding.

  There is now a harder reason too. **While this repository is private, neither can pass**,
  and both were observed failing on the first pull request that ran them:

  - `Review Dependencies` — *"Dependency review is not supported on this repository. Please
    ensure that Dependency graph is enabled along with GitHub Advanced Security."*
  - `CodeQL` — analysis itself succeeds; the **upload** fails with *"Code Security must be
    enabled for this repository to use code scanning."*

  Both are gated on GitHub Advanced Security, which a private repository does not have by
  default, and both hard-fail rather than degrading. Each job is therefore guarded to skip
  while private, so requiring them would block every merge on a check that is skipped by
  design. Revisit once the repository is public, where the dependency graph and code
  scanning are free — that is the point at which requiring them becomes a real choice rather
  than a foot-gun.

**Other**

- Require conversation resolution before merging: **on**
- Require linear history: **on** (allow squash and rebase merges) — the history reads as a sequence of decisions, and merge
  bubbles make `git log` a worse record of why things are the way they are
- Bypass is limited to the actor configured above; do not add broader bypass roles or teams
- Allow force pushes: **off**
- Allow deletions: **off**

## Repository security settings

Under Settings → Code security, enable these before the visibility change where GitHub makes
them available. Enable public-only controls immediately after the change and before
announcing or accepting contributions:

- **Private vulnerability reporting**: on — [`SECURITY.md`](../SECURITY.md) directs reporters
  there, so it has to exist
- **Dependency graph**: on
- **Dependabot alerts** and **security updates**: on
- **Secret scanning** and **push protection**: on
- **CodeQL**: on (configured by [`workflows/codeql.yml`](workflows/codeql.yml), not by the
  default setup — enabling both produces duplicate analyses)

## Why

The project's claims live in its contracts: the numbered invariants in
`docs/specs/CONTRACT_TESTS.md`, the ADRs, and the schemas. Those are only true because tests
assert them, so anything that can merge without running the tests can quietly make the
documentation false. Required checks are how a written invariant stays an actual one.

Code Owner review is scoped in `CODEOWNERS` to the places where a single nod is not enough —
the contracts, the control plane, and the trust boundary.

## Bypassing

There is no release pipeline and nothing to hotfix in production. The sole-maintainer bypass
exists for recovery from configuration lockout, not as the normal merge path. If a new use
appears, document it in the same pull request that changes the setting.

## Verifying

After applying, confirm with a throwaway branch:

1. Confirm the active ruleset targets `main` in Settings and through the repository ruleset
   API. With no second account, this is the available verification for the non-bypass path;
   repeat the direct-push test when a non-admin contributor exists.
2. Open a PR with a failing test → the checks fail. Do not merge it with the admin bypass.
3. Open a PR touching `docs/specs/` → Code Owner review is requested.
4. Confirm a green external PR cannot merge before approval.
5. Confirm `moscaverd` can bypass a deliberately failing throwaway rule, then remove that
   throwaway rule. **Always allow** means an admin direct push or force-push may bypass the
   ruleset; that is the explicit tradeoff approved for recovery.
