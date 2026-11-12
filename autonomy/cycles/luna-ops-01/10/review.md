# Cycle 10 review — luna-ops-01

Base: `4d795fe3ec5c` (head of `stream/ops`). Charter read, previous report read, handoff read.

## Assigned items checked against the code

**PG-20 — generator derives the journal line (P0).** Already implemented and merged by cycle 08, and
present at this base: `packages/core/journal.ts` is the generator CLI, `packages/core/lib/journal.ts`
has `journalLineFor`/`syncJournal`, `checkJournal` still fails hard on a missing entry
(`packages/core/lib/journal.ts:186`), the union-merge duplicate fixture exists
(`tests/docs-smoke.ts:635-665`, identical duplicates accepted, conflicting ones rejected), and
`packages/autonomy/prompts/cycle.md:35` names `node packages/core/journal.ts`. `node
packages/core/journal.ts --check` exits 0 at this base. The board's acceptance criterion is met by
the tree the next cycle builds on; the red PRs named in the board predate that fix on their own
branches, which is not a defect in this stream's head. No new code is needed; the cycle records it
as done and closes with the generator still the only way a line is written.

**PG-50 — bound concurrent acceptance gates per host (P0, rank 1).** Implemented by cycle 09, but
the acceptance criterion is only partly pinned and three review warnings are still open:

- Overlap is tested at the slot primitive (`tests/autonomy-lifecycle-smoke.ts:383`), not through
  three supervisors/Engines as the acceptance text requires; only one waiting Engine is tested
  (`tests/autonomy-selfimprove-smoke.ts:243`).
- `Engine.withGateSlot` calls `this.tick()` before the `try/finally`
  (`packages/autonomy/lib/engine.ts:377`); if it throws, `clockPaused` stays true and the phase
  stays `gate-wait`, so later minutes are never charged (scout confirmed; carried in HANDOFF).
- The same method pauses the clock before accruing the interval since the last tick, so active
  time immediately before a gate wait is silently dropped
  (`packages/autonomy/lib/engine.ts:375-383`).
- A `flock` failure that is not contention (permission error, `ENOLCK`, unsupported filesystem) is
  read as "busy" by `trySlot` (`packages/autonomy/lib/gate-slots.ts:37-56`) and
  `acquireGateSlot` loops forever (`:72-88`); only a missing binary fails loudly.
- `PI_AUTONOMY_GATE_SLOTS` is read by the runner and documented in `docs/autonomy.md:242`, but the
  `autonomy-run` manifest omits it (`packages/extensions/src/autonomy-run/extension.json:22`), so
  the generated `docs/reference.md` env table does not list it.

## Carried over in HANDOFF

**PG-46 — review a red-gate cycle.** Confirmed still present: `mergeDecision` returns at
`packages/autonomy/lib/templates/self-improve.ts:535` before `reviewCycle`, so a red cycle keeps
no review verdict or concerns and the next cycle only sees "acceptance checks failed" (the
cycle-05 cost evidence in cycle 08's report). The review bundle hard-codes "Gate green"
(`packages/autonomy/lib/review.ts:352`) and the system prompt says the checks already passed
(`:334`), so the bundle needs the real gate state when the review runs on a red cycle. This is a
carry-over (precedence 3), not an assigned board ID, so it is reported as an Item and not as a
`Board:` line.

## Other candidates (not taken this cycle)

- Missing proposal `autonomy/proposals/luna-ops-01-06-installer-cli-error-handling.md` cited by
  HANDOFF:64 and `autonomy/cycles/luna-ops-01/08/review.md`; the installer still throws a raw stack
  trace for a bad `--profile` (`packages/core/install.ts:415`). Recorded as a proposal for a later
  cycle rather than expanding this diff.
- `flock` remains a Linux `util-linux` dependency; stock macOS lacks it. Host-side and documented;
  not changed here.

## Mode

Fix mode. The assigned P0 is already met and verified; the work is to finish PG-50 against its own
acceptance text (end-to-end three-supervisor overlap, phase visibility, the clock/finally defects,
the non-contention lock failure, the env-table gap) and then take the carried PG-46 repair.
