# Proposal — harden the owner inbox deadline and re-block edges

Run `luna-ux-01`, cycle 15. Evidence gathered while re-landing PG-09; not changed this cycle
because the diff was already at the 30,000-character stop-new-items line.

## 1. Validate the deadline format instead of any `Date.parse` string

`packages/autonomy/lib/inbox.ts:46-48` accepts anything `Date.parse` understands and stores it
verbatim; settlement parses it again at `inbox.ts:104`. Under `TZ=America/New_York`:

```text
"2026-11-12T00:00:00Z" -> 2026-11-12T00:00:00.000Z
"2026-11-12"           -> 2026-11-12T00:00:00.000Z (UTC)
"2026-11-12T00:00:00"  -> 2026-11-12T05:00:00.000Z (host local)
"12/11/2026"           -> 2026-12-11T05:00:00.000Z (US order)
```

A steward writing a plausible non-UTC deadline gets a card that settles hours or a month off and
silently unblocks a board item. Suggested change: require an ISO-8601 timestamp with `Z` or an
explicit offset (or normalise to UTC on write, like `outcome.at`), reject the rest, and pin each
accepted and rejected form in `tests/autonomy-inbox-smoke.ts`. `docs/autonomy.md` already advises
an explicit offset, so the code should enforce it.

## 2. Give a settled card an explicit release instead of a permanent unblock

`applyOutcomes` (`inbox.ts:112-125`) runs over every card with an outcome on every read, so a board
item re-blocked with `board --file` is flipped back to `ready` on the next `inbox` read. This is
also the crash-recovery path (inbox written, board write lost), so applying only the current call's
`decided` cards is not enough. Suggested change: record a per-card unblock marker (for example an
`appliedAt` on the outcome) so each card unblocks its item once, or give the card an explicit
release outcome, and document the transition. Add a regression test that re-blocks an item after
settlement and reads the inbox again.

`docs/autonomy.md` now documents the current invariant and the manual workaround, so this is a
usability change, not a documentation gap.

## 3. Serialise concurrent inbox writes

`packages/autonomy/cli.ts:567-597` reads `inbox.json` and `board.json`, then rewrites one or both
with no control-file lock. Atomic rename prevents torn files but not lost updates: two concurrent
`--answer` calls or `--file` racing `--answer` can drop one answer and its board unblock. Suggested
change: a small dedicated control-file lock (the run lock is held by the supervisor) or an explicit
single-operator limitation in the docs. Add a test that runs two answers against one run.

## 4. Strip control characters from the text listing

`packages/autonomy/cli.ts:599-602` interpolates card `question`, `default`, `outcome.text` and
`deadline` into terminal output unchanged. Embedded newlines can forge a `board:` line and ANSI
escapes pass through, while the rest of the repository strips control characters (for example
`packages/autonomy/lib/notebook.ts:121-129`). Low impact because cards are operator-authored, but
it is the default output path; reuse the existing sanitiser and test a card containing a newline
and an escape sequence.
