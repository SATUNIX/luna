# Cycle 19 review — luna-ops-01 (ops stream)

Charter read in full. Precedence at start: (0) gate green at `7694025d90d1`, (1) no upstream
conflict (integration head is `a7cb461f`, ancestor of HEAD), then board item **PG-52** (P1).
Cycle 18 was a fix cycle and closed successful; the run branch remains non-promotable and the
re-land branch `pi/luna-ops-01-reland` exists (handoff).

## PG-52 [P1] — a cycle's own verify list omits checks the gate runs

**Evidence the item is real and unfixed.** The board item is confirmed against the code:
- `packages/core/check-all.ts:196` `checkNames()` only *enumerates* the `smoke:*` / `test:*` /
  exact check scripts from `package.json`. Nothing maps a changed path to the checks that cover
  it.
- `packages/core/lib/wiring.ts:60` `scriptTargets()` maps script -> test file (the inverse of what
  is needed) and `packages/autonomy/lib/review.ts:214,237` map/classify critical paths; neither
  selects checks for a diff.
- A repo-wide search for `checksForChangedPaths|CHANGED_PATH_CHECKS|--for-changed` found only
  prose in cycle-15 records — no implementation. `git diff 7694025d90d1..HEAD` is empty, so there
  is no competing change.
- Cycle 15 recorded PG-52 as **blocked** (not started), and the handoff marks it "the next assigned
  item, owed", naming the addition point: a table plus `--for-changed=<path>` beside `checkNames()`,
  consumed from `cyclePrompt()` (`packages/autonomy/lib/templates/self-improve.ts:243-302`).

**Why it matters.** Two consecutive cycles (luna-fleet-01/04, luna-guard-01/03) were rejected by
gate checks their own verify list never ran; the worker honestly wrote "targeted checks cover every
changed file" and was still red. A cycle that cannot see its own red is wasted (VISION: agent
efficacy).

**Acceptance (from the board item), restated for this cycle.**
1. Given a fixture diff touching `packages/extensions/third_party/subagent/SOURCE.md` and
   `packages/extensions/third_party/subagent/workflow-tools.ts`, the cycle's verify plan includes
   `verify`, `smoke:new-extension`, `smoke:eval-footprint` and `smoke:subagent-roles-isolation`.
2. A diff touching only docs includes `docs:check` and no tool-text check.
3. The report/verify record states the run/skipped split.
4. The mapping is **data** (a table), not prose.

**Root cause / fix.** The cycle's verify list is left to worker judgement with no host-derived
mapping from changed files to checks. Fix: a data table of path globs -> check names, a pure
selector `checksForChangedPaths()`, a `--for-changed=` mode on `check-all.ts`, and a cycle prompt
that requires deriving the list from the diff and recording which checks ran and which were
skipped.

**Candidate/consolidation checks.** No other open board item. The proposal backlog
(`autonomy/proposals/`) holds only deferrals (V-04 doc sweep, flake, PG-53) that are not this
stream's assigned work. Cycle 18's change was itself a re-land/sync, already consolidated in
cycle 18's fix pass; nothing new to consolidate. No new defect found within budget.
