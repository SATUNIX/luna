# Cycle 15 — Review (run `luna-ux-01`, stream `ux`)

Base `c97a9e60c923`; previous cycle 14 attempt on `origin/attempts/luna-ux-01/cycle-14`.

## State of the branch and the blocked cycle 14

Cycle 14 was not merged: the host gate reported `check-all` and `check-all:smoke:docs` failed. The
work itself is sound and review-approved (two reviews, FAIL then PASS), so this cycle starts with
work precedence 0: repair the red gate and re-land the reviewed work.

**Root cause (reproduced).** Cycle 14 added `autonomy/cycles/luna-ux-01/14/report.md` but no entry
in `autonomy/JOURNAL.md`. `packages/core/lib/journal.ts:96-130` requires one journal line per report
on the branch, and `tests/docs-smoke.ts:518` fails on the mismatch. With the cycle 14 report copied
onto this branch and no journal line:

```
$ node tests/docs-smoke.ts
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
  'report with no journal entry: luna-ux-01/14; add: - luna-ux-01/14 | Board: PG-09 | successful | <summary>'
```

`smoke:docs` is the only failing check the attempt's own verify could not see, because the verify
ran before `report.md` existed. `check-all` runs `smoke:docs` among its checks, so the same missing
line explains both failing gate jobs. No other check fails on the re-landed head:
`smoke:autonomy-inbox` 5/5, `smoke:autonomy-cli` 16/16, `smoke:autonomy-selfimprove` 37/37,
`smoke:autonomy-review-inputs` 21/21, `smoke:wiring` OK, `test:typecheck` and `test:lint` exit 0.

## Assigned item

PG-09 (owner inbox) is the cycle 14 work. Re-landing it through the cycle 15 workflow with the
journal repair satisfies its acceptance: `tests/autonomy-inbox-smoke.ts` has an answered card, a
past-due card that returns its default and writes the decision record, and an unanswered,
non-expired card that leaves its board item `blocked`.

## Scout findings against the re-landed code

Checked `packages/autonomy/lib/inbox.ts`, the `inbox` command in `packages/autonomy/cli.ts`,
`tests/autonomy-inbox-smoke.ts` and `docs/autonomy.md`.

1. **Doc drift (fixed this cycle).** `docs/autonomy.md:610` says an answer records `via: "answer"`
   "on the next read", but `cli.ts:590-596` settles in the same `--answer` call and
   `tests/autonomy-inbox-smoke.ts:96-102` pins that. The sentence is wrong; it is corrected with
   the deadline-format and re-block invariants the same section omits.
2. **Deadline parsing is lax (documented limitation, not changed).** Validation accepts any
   `Date.parse`-able string, so `2026-11-12T00:00:00` is read in host-local time and `12/11/2026`
   is accepted in US order (`packages/autonomy/lib/inbox.ts:46-48,104`). Tightening validation
   changes the accepted format, which is a new item, not a gate repair; the docs now say to use an
   ISO-8601 deadline with `Z` or an explicit offset. Proposal follows if wanted.
3. **A settled card keeps re-applying its unblock (documented invariant).** `applyOutcomes`
   (`inbox.ts:112-125`) runs over every settled card on every read, so a re-blocked board item is
   flipped back to `ready`; this is also the crash-recovery path when the inbox write lands and the
   board write does not. Changing it needs a per-card marker; docs now state the invariant.
4. Low, not fixed: concurrent `inbox` invocations can lose an answer (two-file read-modify-write
   with no control lock), and the text listing prints card strings raw. Both need new behaviour and
   tests; recorded here rather than added to an almost-full diff.

## Decision

Mode: **fix**. The cycle has one job: restore a green gate and re-land the reviewed PG-09 work,
with the small documentation corrections the review found. The diff is already 29,763 characters
from base before records, so no second item is started.
