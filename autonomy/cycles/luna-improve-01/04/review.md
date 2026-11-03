# Cycle 04 review — luna-improve-01

- Run: `luna-improve-01`, cycle 4 of 200
- Branch: `pi/luna-improve-01`
- Cycle base: `a385401` ("chore(autonomy): seed integration/luna")
- Mode: fix (operator steered, authoritative)

## Context

Cycle 03 ended `successful` on `origin/attempts/luna-improve-01/cycle-03` and was **not merged**
into `integration/luna`: its diff without lockfiles was 88149 characters, above the merge review's
60000-character budget. This branch starts at the same seed commit as cycle 03 (`a385401`) and
therefore did not have cycle 02's real fixes.

The operator's steering for this cycle is explicit and takes priority: stop waiting on
`npm run check:all` (the host gate runs it on the pushed head), make sure the branch carries the
two real cycle-02 fixes, run only their own smoke tests, write the report and end the session.

## Findings

### F-01 (confirmed) — web console hard-codes version `0.1.0`

- Evidence: `packages/web-ui/server/routes.ts` had a private `const VERSION = "0.1.0"` and
  `packages/web-ui/server/configinfo.ts` had its own copy; a grep of the tree shows the package
  version is `0.2.4-beta.11` (`package.json`). `/api/health` and `configInfo()` therefore reported
  a version that never tracked the package.
- Carry-over: fixed by cycle-02 commit `19e0758` (never merged). Missing on this branch
  (`git merge-base --is-ancestor 19e0758 HEAD` false).
- Fix applied here as `f766593`.

### F-02 (confirmed) — detached supervisor writes every log line twice

- Evidence: `packages/autonomy/lib/engine.ts`'s default log called both `store.log` (appends to
  `supervisor.log`) and `rt.log` (`console.log`), while `spawnSupervisor` in `cli.ts` redirects the
  detached child's stdout into that same `supervisor.log`. Every line was written once by the
  store and once by the console redirect. Foreground supervise was unaffected, which hid it.
- Carry-over: fixed by cycle-02 commit `a553328` (never merged). Missing on this branch.
- Fix applied here as `3f8ab1b`.

### Not selected this cycle

- The rest of cycle 03's carried work (npm-12 pack shape, hermetic `installDelegation`,
  namespace-aware firewall smoke, offline clean-install) is not re-applied: the operator scoped
  this cycle to the two named fixes and to ending on budget. They remain available on
  `origin/attempts/luna-improve-01/cycle-03`.

## Backlog checked

- B-001 (web-ui version) — confirmed, fixed here.
- B-002 (supervisor log) — confirmed, fixed here.

## Open items carried to the next cycle

- Cycle 03's remaining fixes on `origin/attempts/luna-improve-01/cycle-03`.
- Consolidation pass after any merge of newly carried code (charter "Cycle modes").
