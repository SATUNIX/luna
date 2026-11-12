# Cycle 26 review — luna-core-01

Base `29eeab10123a` (head of `stream/core` after cycle 25). Mode chosen: **fix** (board item
PG-66 is a real framework defect; V-102 is a carried verification).

## Assigned board items

### PG-66 [P0] — rejected cycles accumulate until no cycle fits the review budget

Evidence from the steward: `luna-ops-01` has not merged since cycle 20 and its reviewed diff grows
monotonically (cycle 14 60,598 → 26 92,761 chars), every cycle gate-green, every one rejected with
"the diff without lockfiles and this run's record files (N characters) exceeds the merge review's
budget of 60000 ... Split the work across cycles".

Reconnaissance (read-only scout, `git` fixture + source trace; baseline
`npm run smoke:autonomy-selfimprove` all 43 pass) established the exact current behaviour:

- The host already resets. When a cycle is rejected, `mergeDecision`
  (`packages/autonomy/lib/templates/self-improve.ts:667-668`) refuses before any review model
  call; `closeCycle` never calls `gm.integrate` (`self-improve.ts:586-590`), so the integration
  branch is unchanged. The next `runStep` calls `gm.startCycleBranch`
  (`gitmirror.ts:285-289`) via `self-improve.ts:514`, which force-moves
  `refs/heads/<cfg.branch>` to `refs/heads/<integrationBranch>`. **The next cycle starts from the
  last merged head, not the rejected head.** Rejected commits are preserved as
  `refs/tags/<tagPrefix>cycle-NN` (`self-improve.ts:580`) and exported to the worker as
  `refs/heads/attempts/<run>/cycle-NN` (`self-improve.ts:515-517`).
- The accumulation is therefore the **worker re-landing prior rejected work**, which the prompt
  invites: `self-improve.ts:346-347` tells the next cycle to "carry over only a reviewable
  subset" (budget rejection) or "bring over what is sound" (other rejection). `start..sha` is
  integration..workerhead, so a worker that carries everything forward makes the measured diff
  `prior rejected work + current item`, growing each cycle.
- `cyclePrompt` renders a `DIFF_MEASURE` command (`self-improve.ts:336-338`) but nothing runs it
  while the worker is alive. The host measures only in `mergeDecision`, after the session is
  gone. So the worker learns it was over budget one full cycle later, and the run burns a cycle
  per rejection.

Root cause: there is **no in-cycle, pre-report probe**. Requirement (b) of the item ("the cycle's
pre-report check measures the diff it will submit so it can split before the review") is
unimplemented; requirement (a)'s reset/preserve half already holds.

A test that only asserts prompt text cannot distinguish a real probe
(`tests/autonomy-selfimprove-smoke.ts:1273-1286`). The fix is a host probe wired into the cycle
loop that measures the would-be reviewed diff while the worker is alive and steers it with the
measured number, with `mergeDecision` staying the fail-closed backstop.

### V-102 [P1] — V-10b UI strings, installer/helper output, test assertions, brand scope

Reconnaissance (read-only scout) found **no remaining edits**. The rename landed in cycle 22
(`85e93fa`); the whole-repository brand-smoke scope landed in `e19f880`/`f7554ce`. Spot checks:

- `kit-update/index.ts:782` already prints `Luna update status`; the `/update` description
  (`:1277`) and notes/labels already say Luna.
- `install.ts:595` already prints `[install] Luna`; `uninstall.ts:94` `[uninstall] Luna`;
  `gen-notices.ts:94` "Luna is distributed under the MIT license".
- `pi-kit-helper.sh`/`.ps1` headings and usage already say "…update Luna"; both `package.json`
  descriptions already say Luna; `gate.sh` comment already says Luna.
- `tests/kit-update-smoke.ts`, `tests/install-marker-smoke.ts:618`,
  `tests/kit-root-trust-smoke.ts:262,314` already assert the Luna strings.
- `tests/brand-smoke.ts` already walks the whole workspace from `WORKSPACE_ROOT`, including
  `packages/core`, `packages/extensions`, `packages/web-ui` and `tests`.
- Every remaining `pi[- ]system` in the named files is a documented identity token
  (`@satunix/pi-system`, `PI_SYSTEM_GIT_SOURCE`, legacy regexes, bin names) listed in
  `docs/branding.md`.

Verdict: V-102 is already satisfied on the base; the cycle runs its named smokes to prove it and
records it `done` (no code commit, as in cycle 23's V-10 re-verification).

## Notable non-items

- `-es` stemmer regression (`bus`/`buses`) remains unsolved (cycle 25): needs a lexicon or an
  operator trade-off. Out of scope this cycle.
- HANDOFF #1 firewall timing noise is out of stream; V-07/V-08 still need the operator's finding
  list.

## Checks this cycle will run

- `npm run smoke:autonomy-selfimprove` (PG-66 change), `npm run smoke:autonomy-run` if the
  runtime interface changes.
- `npm run smoke:brand`, `npm run smoke:kit-update`, `npm run smoke:install-marker`,
  `npm run test:typecheck`, `npm run smoke:docs`, targeted eslint.
- `git diff 29eeab10123a..HEAD -- . ... | wc -c` measured after every commit (stop at 30000).
