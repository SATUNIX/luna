# Cycle 04 report — luna-improve-01

Outcome: successful
Mode: fix

- Run: `luna-improve-01`, cycle 4 of 200
- Branch: `pi/luna-improve-01` (to be pushed by this cycle)
- Cycle base: `a3854019e198922c7582b8d68949a3a6d36b895b` ("chore(autonomy): seed integration/luna")
- Documents: `review.md`, `plan.md`, `verify.md` in this directory
- Cycle status: completed

## What was done

Operator-steered fix cycle. Cycle 03's full change was over the merge review's budget (88149
characters) and so was not merged; this cycle takes the two real cycle-02 fixes the operator named,
puts them on a small reviewable diff, proves each with its own smoke test, and ends without waiting
on the full gate.

### Item 1 — web console reports the real package version (commit `f766593`, from cycle-02 `19e0758`)

- Finding: `/api/health` and `configInfo().app.version` returned the hard-coded `0.1.0` while the
  package is `0.2.4-beta.11`. Root cause: `packages/web-ui/server/routes.ts` and
  `packages/web-ui/server/configinfo.ts` each declared their own `const VERSION = "0.1.0"`, never
  updated when the package version moved.
- Fix: both import and call `kitVersion()` from `./remote-version.ts`, which already resolves the
  root `package.json` version.
- Test: `tests/web-ui-api-smoke.ts` drives `GET /api/health` and `configInfo()` and asserts each
  equals the root package version and is not `0.1.0` (fails before the fix: `0.1.0` vs
  `0.2.4-beta.11`).
- Verified: `npm run smoke:web-ui-api` exit 0.

### Item 2 — detached supervisor writes each log line once (commit `3f8ab1b`, from cycle-02 `a553328`)

- Finding: a detached run's `supervisor.log` held each engine log line twice. Root cause: Engine's
  default log called both `store.log` (appends to `supervisor.log`) and `rt.log` (`console.log`),
  while `spawnSupervisor` starts the detached child with stdout redirected into that same
  `supervisor.log`; every line was appended once by the store and once by the console redirect.
  Foreground supervise (stdout a terminal) was unaffected, which hid it.
- Fix: `RunStore.log` stays the single writer; `defaultEngineLog(store, rt)` echoes to `rt.log`
  only when stdout is not the log file, via `fsutil.stdoutIsFile` (compares `fstat(1)` with
  `stat(path)` on dev+ino). The direct `rt.log(...)` calls in `lib/cycle.ts` still reach
  `supervisor.log` through the redirect and are not lost.
- Test: `tests/autonomy-cli-smoke.ts` spawns a child with stdout redirected to the log, calls
  `defaultEngineLog` once, and asserts the line appears exactly once.
- Verified: `npm run smoke:autonomy-cli` exit 0 (15/15 checks).

## Changes carried from cycle 02

- `a553328` was cherry-picked cleanly as `3f8ab1b`.
- `19e0758` was cherry-picked as `f766593`; its edits to the cycle-02 `plan.md`/`review.md` records
  (which do not exist on this branch) were dropped, leaving only the code and test files.

## What was left and why

- The rest of cycle 03's carried work (npm-12 `npm pack --json` object shape, hermetic
  `installDelegation`, namespace-aware firewall smoke, offline clean-install) is **not** re-applied
  here: the operator scoped this cycle to the two named fixes and to ending on budget. All of it
  remains pushed on `origin/attempts/luna-improve-01/cycle-03` and should be picked up next.
- `npm run check:all` was deliberately not run in-session, per operator steering (the host gate runs
  it on the pushed head).

## For the next cycle

- Start by running the host gate / `npm run check:all` on this head. The two changed areas are
  green under their own smokes.
- Then continue with cycle 03's remaining fixes, one logical change per commit, keeping each
  cycle's diff under the merge-review budget.
- See `HANDOFF.md` for environment notes.
