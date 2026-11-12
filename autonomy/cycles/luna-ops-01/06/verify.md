# Cycle 06 — Verify (run luna-ops-01, stream `ops`)

Base `70650a313022`; branch `pi/luna-ops-01`; HEAD `7da244a8` at verification time.

## Changed-path plan

`node packages/core/check-all.ts --for-changed="$( { git diff --name-only 70650a313022; git
ls-files --others --exclude-standard; } | tr '\n' ',')"` planned 12 paths and selected the seven
checks below. The remaining 213 checks were SKIPPED by that plan, including `smoke:redaction-corpus`
(its changed files are not in this cycle); it was run separately for DE-105.

## Planned checks

RAN `npm run -s docs:check` — exit 0; nav entries exist, internal links resolve.
RAN `npm run -s smoke:check-all-npm` — OK; includes the coverage arg splitter, `--report` and
`--jobs` guards, `--coverage-out=.`/`..`/filesystem-root refusals, stale-file clearing and retained
raw data.
RAN `npm run -s smoke:docs` — exit 0; 14 documented commands, 62 relative links, 97 shipped pages.
RAN `npm run -s smoke:workflow-policy` — 5 checks, 48 mutations caught; both measure-only jobs,
shard/count agreement, hidden-file cache upload, `if: always()` uploads and merge, timeout floor.
RAN `npm run -s test:lint` — exit 0.
RAN `npm run -s test:typecheck` — exit 0.
RAN `npm run -s verify` — exit 0; all checks passed.
RAN `npm run -s smoke:redaction-corpus` — all 6 checks; DE-105 check 5 passes linear and 10x-slower
fake-clock probes and rejects the quadratic one.
RAN `npm run -s smoke:release-workflow` — 11 checks passed; release still gates on the whole
`ci.yml`, including the now-sharded coverage lane.

Not run: `npm test` and `npm run check:all` (explicitly forbidden; each takes 10+ minutes; the host
gate runs them).

## DE-105 stress evidence

20 runs of `smoke:redaction-corpus` under two busy cores: 20/20 passed. Under four busy cores,
it failed in 5 of 20 runs, but the failures were in check 4 (real-timing
`assertSubQuadratic`, "quadratic growth suspected"), not check 5 (injected fake clock). Check 5 never
failed. This confirms DE-105's deterministic guard and isolates the residual as real-timing check 4,
which cannot be made load-independent without changing what it measures. Recorded in the report as
a residual, not claimed green under four busy cores.

## Coverage merge proof

Two local shard runs with `--coverage-out` each kept one `coverage-*.json`; both files copied into one
directory and `node packages/core/coverage.ts --report <dir>` exited 0, printing overall 34.4% /
48.1% / 31.0% and per-file rows (for example `guard.ts` 29.7%). This exercises the same
`--report` path that `coverage-merge` runs after downloading all four artifacts.

## Diff and scope

`git diff --no-renames 70650a313022..HEAD` excluding lockfiles and cycle/run records: 50123
characters, over the 30000-character new-item budget, so no post-board item was started. No
`package.json` scripts, `autonomy/CHARTER.md`, operator control path, secret or lockfile changed.
`git diff --check 70650a313022..HEAD` is clean.

## Review

Independent reviewer subagent, given the full diff and the prior defect list, ran
`smoke:workflow-policy` and `smoke:check-all-npm` itself. Previous five findings are fixed; no
critical defects or goal gaps remain. Final verdict: `VERDICT: PASS`. One warning (a
workflow-policy mutation for the removed coverage job lazy-matches to `docs-build`) is test-precision
only and does not change the product or coverage of the rule.
