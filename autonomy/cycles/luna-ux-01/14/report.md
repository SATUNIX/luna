# Cycle 14 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: improve
Board: PG-09 done - `pi-autonomy inbox` records owner answers and settles past-due cards into their recommended default, unblocking the linked board item, and `tests/autonomy-inbox-smoke.ts` pins the answered, expired and still-open cases.

Item: Add the owner inbox model, CLI command and smoke test for PG-09 - 370fe90, e06be41, 748202e, 34dfa0e - smoke:autonomy-inbox 5/5, smoke:autonomy-cli 16/16, smoke:autonomy-selfimprove 37/37, smoke:autonomy-review-inputs 21/21, smoke:wiring, smoke:docs, test:typecheck, test:lint

## What changed

A `blocked` steward-board item previously waited only for a person to rewrite `board.json`; the
board model had no question, deadline or recorded decision, so an owner request could stall a run
indefinitely.

This cycle adds a second host-owned control record, `control/inbox.json`, and a `pi-autonomy inbox`
command. A card holds a question, the recommended default, a deadline, an optional board item, an
optional answer and an optional outcome `{at, via, text}`. Every read settles cards whose deadline
has passed: the card records `via: "deadline"` and its default text, and the linked board item
moves `blocked` → `ready`. `--answer <card-id> --value <text>` records `via: "answer"` on the next
read, even before the deadline. An unanswered card before its deadline leaves the item `blocked`.
A recorded outcome is never rewritten, so reads are idempotent. The command is self-improve only
and record-only: it writes only `inbox.json` and, when an item unblocks, `board.json` (both atomic,
mode 0600), never run state or a control message.

The file format is validated like `board.json`: unknown keys and duplicate ids rejected, card ids
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, board ids `^[A-Z]+-[0-9]{1,4}$`, parseable deadlines, at most
50 cards, questions ≤ 500 characters, defaults/answers/outcomes ≤ 2000 characters, and a 2 MiB
input cap. A bare `inbox --run <run>` lists the cards as text; `--json` returns the structured
form; `--file` validates and replaces the cards without settling them.

`tests/autonomy-inbox-smoke.ts` covers three blocked board items and three cards: one answered, one
past due, one still open. It also pins idempotence, later answers, refusal without changing the
inbox, the oversized-answer guard, the board id in the listing, and that `state.json` is unchanged.
The root script `smoke:autonomy-inbox` is the single new-script exception. Docs, README and
CHANGELOG describe the command and cite the test.

## Review and fixes

The first independent review returned FAIL: a `--value` over 2000 characters was written and every
later read then rejected the inbox, wedging it. `748202e` rejects an oversized trimmed value before
any write and adds the regression case; it also shows the linked board id in the text listing,
allows the bare listing, and keeps same-file helper return types narrow enough for the self-scan.
The second independent review returned PASS. Its non-blocking warnings about the record-only claim
and the pre-deadline answer wording were covered by `34dfa0e`; the duplicate-board-link case is
left as per-card behaviour and noted in `verify.md`.

## Verification

`smoke:autonomy-inbox`, `smoke:autonomy-cli`, `smoke:autonomy-selfimprove`,
`smoke:autonomy-review-inputs`, `smoke:wiring`, `smoke:docs`, `test:typecheck` and `test:lint` all
pass on the final head. Full `check-all` is left to the host gate. The diff from `c97a9e60c923`
is 29,763 characters, under the stop-new-items line; no further item was started.

## Open

- Two cards may link the same board item today; settling either unblocks it while the other stays
  open. Per-card behaviour is documented; requiring all cards for an item to settle would be a
  later change.
- Expiry happens when the command is read; no engine loop timer settles cards in the background.
- Nothing pushed beyond `pi/luna-ux-01`; no tag, release or merge.
