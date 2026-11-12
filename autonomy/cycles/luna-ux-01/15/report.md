# Cycle 15 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix
Board: PG-09 done - `pi-autonomy inbox` records owner answers and settles past-due cards into their recommended default, unblocking the linked board item; the cycle 14 red journal gate is repaired.

Item: Re-land the reviewed PG-09 owner inbox with a green gate - 264249c, 4a3ce49, 679ebf9, c294bc6, 60cb393 - smoke:autonomy-inbox 5/5, smoke:docs, smoke:autonomy-cli 16/16, smoke:autonomy-selfimprove 37/37, smoke:autonomy-review-inputs 21/21, smoke:wiring, test:typecheck, test:lint

## Why cycle 14 was rejected

Cycle 14's code was sound and reviewed, but its `report.md` had no `autonomy/JOURNAL.md` entry.
`packages/core/lib/journal.ts:96-130` requires one line per report and `tests/docs-smoke.ts:518`
fails on the mismatch; `check-all` runs `smoke:docs`, so both gate jobs failed. The attempt's verify
could not see it because it ran before `report.md` existed. With the report present and no journal
line, `node tests/docs-smoke.ts` reproduced `report with no journal entry: luna-ux-01/14`. This
cycle re-lands the four reviewed commits unchanged and adds the missing line in `60cb393`.

## What PG-09 now does

A `blocked` steward-board item used to wait only for a person to rewrite `board.json`; the board
model had no question, deadline or recorded decision. The new host-owned `control/inbox.json` and
`pi-autonomy inbox` command add cards holding a question, recommended default, deadline, optional
board item, optional answer and optional outcome `{at, via, text}`.

Every read settles a card whose deadline has passed: it records `via: "deadline"` with the default
and moves the linked item `blocked` → `ready`. `--answer <card-id> --value <text>` records the
owner's text with `via: "answer"` in the same call, even before the deadline. An unanswered,
non-expired card leaves its item `blocked`; a recorded outcome is never rewritten, so reads are
idempotent. The command is self-improve only and record-only: it writes only `inbox.json` and, when
an item unblocks, `board.json`, atomically at 0600, and never run state or a control message.

`tests/autonomy-inbox-smoke.ts` pins the answered, past-due and still-open cards, idempotence, a
later answer, refusal without changing the inbox, the 2000-character answer guard, and that
`state.json` is untouched. `package.json` gained only the one `smoke:autonomy-inbox` script.

## Documentation correction

The first review found the corrected draft's re-block advice wrong: `applyOutcomes` only sets
`ready`, so neither a new card nor `--file` alone re-blocks an item. `60cb393` states the real
procedure (drop the settled card with `inbox --file`, then set the item `blocked` with
`board --file`), says `--answer` records immediately, and states the deadline guidance (use `Z` or
an explicit offset; an offset-less value is host-local).

## Verification

Two independent reviewers returned PASS on this head; the first documentation draft returned FAIL
and was fixed. Targeted checks: `smoke:docs`, `smoke:autonomy-inbox`, `smoke:autonomy-cli`,
`smoke:autonomy-selfimprove`, `smoke:autonomy-review-inputs`, `smoke:wiring`, `test:typecheck` and
`test:lint` all pass. Diff from base excluding records is 30,169 characters, under the review
budget; no second item was started past the 30,000 stop-new-items line.

## Left for later

`autonomy/proposals/luna-ux-01-15-inbox-deadline-and-reblock.md` records four evidenced edges:
lax `Date.parse` deadline validation (offset-less values are host-local), the permanent re-unblock
after settlement, unserialised concurrent inbox writes, and raw card strings in the text listing.
All need new behaviour and tests, so they are proposals rather than this cycle's work.
