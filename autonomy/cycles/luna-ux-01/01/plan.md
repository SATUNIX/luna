# Cycle 01 — Plan (run luna-ux-01, stream `ux`)

- Mode: **fix** — the assigned DE-101 items are confirmed defects and a security gap.
- Base: `5fda5d526514`, branch `pi/luna-ux-01`.
- Budget: ~$5 model spend, ~3 h. Two bounded items, each finished and verified.

## Goal

Harden the surfaces the landing review named: the control-centre hub removes every control,
format and default-ignorable character from what it displays under a length bound, and the owner
inbox validates strict ISO deadlines, refuses an answer/outcome that would rewrite or smuggle a
decision, sanitises its text listing, and the remote-control wrapper keeps the rest of a word it
cannot fit on one line.

## Item DE-98 — CHANGELOG and QR fixture

No work: already satisfied at the base (see `review.md`). The report records it as `done` with the
evidence, and the acceptance gate re-checks `smoke:docs` and the five entries.

## Item DE-101a — control-centre display filter

Justification (charter 1, 5): `docs/control-center.md:92-96` admits that the hub removes only
colour/cursor CSI, OSC and APC; an alternate-screen sequence, a reset, a C1 CSI (`U+009B`) or a
bidi override in a page title, Doctor/Security/Help row or header still reaches the terminal, and
the strip runs on an unbounded repository-controlled string.

### Change

1. In `packages/extensions/src/control-center/hub.ts` add a local whole-class filter with the same
   classes as `HIDDEN_CHARS` in `packages/autonomy/lib/notebook.ts`
   (`\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}`), applied after the existing pi-tui strip where
   the header, page titles and informational rows are produced. Keep tab/newline semantics out of
   display text (display rows are one line). Cap the filtered text at a fixed maximum (500
   characters) so a repository-controlled title cannot be unbounded.
2. Use the one filter for `informationalPage`, `headerLine`, `pageTitle` and `typedCommand`, so
   there is no second ad-hoc character class.
3. `docs/control-center.md`: replace the admitted limitation with the whole-class filter and the
   bound, and name the test.

### Proof — `tests/control-center-smoke.ts`

Extend the existing "header and informational rows strip terminal control sequences" case (or add
one beside it) with a header/title/row value containing an alternate-screen sequence
(`\u001b[?1049h`), a reset (`\u001b[0m`), a C1 CSI (`\u009b2J`) and a bidi override (`\u202e`),
plus a >500-character value. Assert none of those characters survive, the visible text remains, and
the result is bounded. Run `npm run -s smoke:control-center`.

## Item DE-101b — owner inbox and remote wrap

Justification (charter 1, 4, 5): six confirmed gaps named in `review.md` (deadline parsing,
settled-card answer, listing text, uploaded settled cards, word continuation).

### Change

1. `packages/autonomy/lib/board.ts`: export the strict `ISO_TIMESTAMP` validator (or a small
   `isIsoTimestamp`) and use it from `inbox.ts` so a deadline requires a date, time and `Z` or
   explicit offset, and must also parse.
2. `packages/autonomy/lib/inbox.ts`: use the shared validator for `deadline`; refuse `answer` and
   `outcome` in an uploaded inbox (`readInboxFile` / `validateInbox` with an upload flag), so a
   file cannot pre-settle a card.
3. `packages/autonomy/cli.ts`: `--answer` on a card that already has an outcome throws
   `CliError("refused", ...)` naming the card; the text listing collapses card fields through the
   same `HIDDEN_CHARS` one-line treatment `lib/store.ts` uses.
4. `packages/extensions/src/remote-control/index.ts` `wrap()`: when a wide grapheme cannot fit the
   current room, carry the whole remaining word to the next line instead of dropping it; a word
   that cannot fit any line is still split at the last possible cell.
5. `docs/autonomy.md` and `docs/remote-control.md`: deadline format, refusal of uploaded answers,
   settled-card refusal, sanitised listing, and the wrap remainder.

### Proof

- `tests/autonomy-inbox-smoke.ts`: cases for an offset-less/`Date.parse`-only deadline refused,
  `--answer` on a settled card refused with the card id and exit 3, an uploaded card with
  `answer`/`outcome` refused, and a listing whose `question`/`default` contains control and bidi
  characters showing them collapsed.
- `tests/tui-layout-smoke.ts` (or the remote-control smoke): an offer whose fingerprint has a wide
  grapheme at the wrap boundary keeps every remaining grapheme; no line exceeds the width.
- Run `smoke:autonomy-inbox`, `smoke:tui-layout`, `smoke:remote-control`.

## Checks

Derive with `node packages/core/check-all.ts --for-changed=...` after the edits and run the named
scripts. Expected: `smoke:control-center`, `smoke:autonomy-inbox`, `smoke:tui-layout`,
`smoke:remote-control`, `smoke:docs`, `test:typecheck`, `test:lint`. Never run `npm test` or
`npm run check:all`.

## Order

DE-101a, then DE-101b (one `workflow_run` with an implementer and a gated reviewer per item).
DE-98 is recorded, not implemented.
