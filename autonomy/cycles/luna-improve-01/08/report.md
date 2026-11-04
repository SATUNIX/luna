# Cycle 08 report — luna-improve-01

Outcome: successful
Mode: fix

- Run: `luna-improve-01`, cycle 8 of 200
- Branch: `pi/luna-improve-01`
- Cycle base: `69afbd4` ("docs(autonomy): record cycle 07 — runtime-lock closure, delegation env
  restore, B-007 proposal"), the pushed head at the start of this cycle. This clone has no
  `integration/luna` ref; every prior cycle names `a385401` as the seed and builds forward, so the
  range `integration/luna..HEAD` is taken as `BASE..HEAD`.
- Documents: `review.md`, `plan.md`, `verify.md` in this directory
- Cycle status: completed

## What this cycle is

Fix mode. The previous cycle left no carried code work and the backlog had no open in-bounds item
(B-001..B-006 and B-008 `done`; B-007 an operator `proposal` for the release pipeline). A
read-only review of the git-source handling found one confirmed correctness bug, taken as B-009:

`parseGitSource()` in `packages/core/lib/distribution.ts:143-148` stripped a leading `git:`
whenever the source started with those four characters. A bare `git://host/owner/repo` URL also
starts with `git:`, so the prefix branch ran, left `//host/owner/repo`, failed the protocol regex
and returned `null`. The regex on line 148 deliberately admits the `git:` scheme and the function
comment says pi writes "a protocol URL", so the bare form was meant to parse. The kit's `/profile`
matcher (`packages/extensions/src/session-helpers/index.ts:311` `gitSourceKey`) already accepted
it, and `tests/profile-command-smoke.ts:330` asserts that, so core
(`isKitGitSource`, `sourcesReferSamePackage`, `validatePreviousSources`) disagreed with the kit's
own matcher. Charter priority 3 (correctness).

## Commits (`git log BASE..HEAD`, oldest first)

- `4cbe38c` fix(distribution): parse a bare git:// source as git, not a git:-prefixed path
- `7b0af8f` docs(autonomy): record cycle 08 — accept a bare git:// kit source
- follow-up: docs(autonomy): note the read-only /gate limitation in cycle 08 records

## Diff stat

`git diff BASE..HEAD --stat` at the final pushed head:

```text
 autonomy/BACKLOG.md                          |   1 +
 autonomy/cycles/luna-improve-01/08/plan.md   |  87 +++++++++++++++++++++++++
 autonomy/cycles/luna-improve-01/08/report.md | 104 ++++++++++++++++++++++++++++
 autonomy/cycles/luna-improve-01/08/review.md |  71 +++++++++++++++++++++
 autonomy/cycles/luna-improve-01/08/verify.md |  82 ++++++++++++++++++++++++
 packages/core/lib/distribution.ts            |   2 +-
 packages/extensions/src/kit-update/index.ts  |   2 +-
 tests/distribution-smoke.ts                  |   3 +
 tests/kit-update-smoke.ts                    |   2 +-
 9 files changed, 351 insertions(+), 3 deletions(-)
```

The only code change is a one-line guard in each of `packages/core/lib/distribution.ts` and
`packages/extensions/src/kit-update/index.ts`, plus the two test additions and this cycle's
records. No `autonomy/CHARTER.md`, operator control path, `package.json` script, dependency,
`.github/` or `packages/web-ui/` change.

## Item completed and verification

**B-009 — `parseGitSource()` rejects a bare `git://` protocol URL, `4cbe38c`.** The guard is now
`const hasPrefix = trimmed.startsWith("git:") && !trimmed.startsWith("git://");` so the protocol
branch parses the URL (host, path, ref, key) instead of returning `null`. Only inputs starting
with `git://` change behaviour; every other form is untouched. The same guard was applied to the
duplicate parser in `packages/extensions/src/kit-update/index.ts:188`.

- `tests/distribution-smoke.ts` deep-equals
  `parseGitSource("git://github.com/SATUNIX/luna")` to
  `{ repo: "git://github.com/SATUNIX/luna", ref: null, key: "github.com/satunix/luna" }`; it fails
  on the pre-fix code (returns `null`).
- `tests/kit-update-smoke.ts:236` adds the bare `git://` form to the list that must satisfy
  `isKitGitSource === true`; it fails on the pre-fix code (`null` → `false`).
- `node tests/distribution-smoke.ts` — 14/14; `node tests/kit-update-smoke.ts` — 40/40;
  `npm run test:typecheck`, `npm run test:lint`, `npm run verify` exit 0.

## Acceptance checks

- `npm run check:all` — **203/203 check runs passed** in 440.2s (exit 0).
- The umbrella `/opt/autonomy/gate.sh` cannot run in this session's clone: it writes under
  `/gate`, and `/` is read-only here. Its steps were run individually on the pushed head and all
  pass: `check:all` 203/203, `test:security` exit 0, `mkdocs build --strict` exit 0, `gitleaks`
  no leaks. The supervisor runs the umbrella gate itself. See `verify.md` "Reference gate".
- Detail in `verify.md`.
- Independent `reviewer` subagent on `git diff BASE..HEAD` against the charter: **Verdict: PASS**,
  no must-fix items. It confirmed only `git://`-prefixed inputs change, the test fails without the
  fix, no protected path/script/dependency changed, and the core helpers now agree with the
  already-fixed `/profile` matcher.
- Detail in `verify.md`.

## What was left and why

- `getExternalByProfile()` (`packages/core/lib/sources.ts:42`) is dead exported code (priority 6);
  a removal is cosmetic and was deferred to keep this cycle to one logical change.
- `eval/run.ts:21` silently ignores a trailing `--category` with no value (low); deferred.
- The installer's project-settings writes do not go through `safe-fs`; the docs do not claim the
  installer is covered and it needs a design decision, so it was not taken.
- B-007 remains an operator proposal (release pipeline); not touched.

## For the next cycle

- B-009 is closed and regression-tested. The next work in charter order is the next evidenced fix;
  B-007 waits on the operator.
- Environment trap unchanged: `/opt/npm-cache` is read-only in this container; use a writable copy
  (`cp -a /opt/npm-cache /tmp/npm-cache`) for any local check that runs `npm pack`/`npm ci`.
