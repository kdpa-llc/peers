# Releasing Peers

Peers is package-ready but **not publish-enabled**. `package.json` deliberately contains
`"private": true`, and the repository has no workflow that can publish to npm or create a
GitHub release. This is a safety gate, not unfinished packaging.

## Preview the artifact

Every pull request packs the project, installs that tarball into a clean temporary consumer,
imports the public API, and invokes the installed `peers` executable. Run the same check
locally with:

```bash
npm run typecheck
npm test
npm run test:package
npm pack --dry-run
```

The manual **Package preview** workflow performs the same verification and attaches the
resulting `.tgz` as a seven-day workflow artifact. It has read-only repository permission,
receives no npm credential, and cannot publish.

Published artifacts are compiled ESM rather than raw TypeScript. `npm run peers` still runs
the source directly for a quick contributor loop; `npm pack` runs `npm run build` and includes
only `dist/`, the cross-platform executable shim, the contract specifications, the JSON
examples, the README, the license, and package metadata.

## Gates before the first publish

Complete all of these in a reviewed pull request before removing `"private": true`:

1. Confirm the `kdpa-llc` npm organization exists, the release identity belongs to it, and
   `@kdpa-llc/peers` is the intended available package name. A package-name lookup alone does
   not prove permission to publish under the scope.
2. Decide the release identity. If using the existing organization `NPM_TOKEN`, grant this
   repository selected access only after confirming that the token can publish the npm
   scope. Prefer npm trusted publishing when it can be configured for the package.
3. Add an `npm` GitHub environment with required reviewers. Put any npm credential there,
   not in a repository file or a pull-request-capable job.
4. Add the release workflow described below and test its validation path without publishing.
5. Remove the private-package assertion from `scripts/package-smoke.mjs`, change
   `"private"` to `false`, update `SECURITY.md`'s supported-version table, and update every
   pre-publish status statement in this file, `README.md`, and `CHANGELOG.md`.
6. Merge those changes through the normal protected-branch pull-request path.

## Intended release flow

Use a reviewed version commit followed by a tag; do not let release automation write a
version commit directly to protected `main`.

1. Open a pull request that updates `version` in both `package.json` and `package-lock.json`
   and records user-visible changes.
2. Merge only after required checks pass.
3. Create `v<version>` on that exact `main` commit. A release job must reject a tag whose
   version differs from `package.json` or whose commit is not contained in `main`.
4. In an npm-protected environment, run `npm ci`, typecheck, tests, schema validation, and
   `npm run test:package`; then publish once with `npm publish --access public --provenance`.
5. Create the GitHub release from the already-published tag only after npm confirms the
   package version exists.

That ordering avoids the branch-protection failure caused by tools that generate and push a
release commit during `prepare`. It also makes every version-changing commit pass through the
same review and status checks as other code. npm publishing cannot be rolled back cleanly, so
the workflow must fail before `npm publish` whenever any precondition is uncertain.
