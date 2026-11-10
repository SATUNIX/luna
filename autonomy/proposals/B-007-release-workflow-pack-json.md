# Proposal B-007 — fix the release workflow's `npm pack --json` parsing for npm 12

Status: closed in the backlog (B-007, `dropped`) and handed to the operator. The release workflow is
operator-owned: the charter puts release pipelines out of bounds for an agent cycle, and the path is
protected for agents in this sandbox. The proposal keeps the finding, evidence and patch; no in-repo
check executes that parser (`grep -rn "pack.json" tests packages/core` returns nothing), so an
agent cannot verify a change. This status records neither a fix nor a confirmation that the workflow
is still broken.

## Finding

`.github/workflows/release.yml`, step "Reproducible tarball" (id `pack`), writes the result of
`npm pack ./dist/npm --ignore-scripts --json` to `pack.json`, then reads it at lines 136 and 138:

```yaml
node -e 'const p=require("./pack.json")[0]; console.log(`- tarball: \`${p.filename}\`, ...`)'
node -e 'const p=require("./pack.json")[0]; console.log(`tarball=${p.filename}`); console.log(`integrity=${p.integrity}`)' >> "$GITHUB_OUTPUT"
```

Under npm 12 the `--json` output is an object keyed by package name, not the npm ≤ 11 array, so
`require("./pack.json")[0]` is `undefined`.

## Evidence

Environment: Node `v26.12.1`, npm `12.2.1` (this repository's toolchain, per `HANDOFF.md`).

```text
$ npm pack --dry-run --json --ignore-scripts | head -c 40
{
  "@satunix/pi-system": {
```

```text
$ npm pack --dry-run --json --ignore-scripts > /tmp/pack.json
$ node -e 'console.log(require("/tmp/pack.json")[0].filename)'
TypeError: Cannot read properties of undefined (reading 'filename')
```

The same npm-12 shape is already handled inside the repository: `packReports()` in
`packages/core/build-npm.ts` normalises both shapes, and `tests/clean-install-smoke.ts` pins it.

## Root cause

The workflow was written for npm ≤ 11. The repository now packs under npm 12 (the same change that
required `packReports()` for `smoke:package` and `smoke:clean-install`), so the workflow's inline
parser is stale.

## Impact

The `node -e` step throws before writing `tarball=`/`integrity=` to `$GITHUB_OUTPUT`. The `plan`
job fails, so the `github-release` and `npm-publish` jobs that consume
`needs.plan.outputs.tarball`/`integrity` never receive their inputs. In other words, the npm 12
upgrade silently broke the release pipeline. No in-repo check catches it:
`tests/release-workflow-smoke.ts` only pattern-matches the workflow text (it sees the output names),
it never executes the parser.

## Proposed patch (smallest)

Replace both `require("./pack.json")[0]` expressions with a shape-tolerant first value:

```yaml
node -e 'const p=Object.values(require("./pack.json"))[0]; console.log(`- tarball: \`${p.filename}\`, ...`)'
node -e 'const p=Object.values(require("./pack.json"))[0]; console.log(`tarball=${p.filename}`); console.log(`integrity=${p.integrity}`)' >> "$GITHUB_OUTPUT"
```

`Object.values(...)[0]` returns the single report under npm 12 and the first element under npm ≤ 11.

Alternative: reuse the in-repo helper, e.g. `node packages/core/print-pack.ts` or an inline import of
`packReports()` from `packages/core/build-npm.ts`, so the workflow and the smokes share one parser.

## Why this is a proposal and not a cycle change

`.github/workflows/release.yml` is a release pipeline, which the charter's "Out of bounds" list
forbids an improvement cycle from editing. The code fix is small and low-risk, but the operator must
make it (or authorise it).

## Suggested follow-up

Add a line to `tests/release-workflow-smoke.ts` that runs the workflow's `pack.json` parser against a
synthetic npm-12 object, so the workflow and `packReports()` cannot drift apart again.
