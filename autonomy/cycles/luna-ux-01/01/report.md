# Cycle 01 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Board: DE-98 done - verified at the cycle base that `CHANGELOG.md` already carries all five merged ux entries and `tests/tui-layout-smoke.ts` already uses a 25-row QR fixture, so no repair was needed.
Board: DE-101 done - the six control-centre and owner-inbox hardening fixes are implemented, documented and pinned by tests that fail on the base source.

Item: cycle review and plan - `7f7e7cb` - proven by `npm run -s smoke:docs` (the records/journal consistency gate); the review records the base evidence for DE-98 and the six DE-101 defects with file:line.
Item: DE-101a - filter every control and format code point from hub display text - `c56acda` - proven by `npm run -s smoke:control-center` (45/45; with the base `hub.ts` restored the new alternate-screen, reset, C1 CSI, bidi and 500-character cases fail).
Item: DE-101b - strict inbox deadlines, settled-card refusal, sanitised listing, uploaded answer/outcome refusal and the wrap remainder - `922e732` - proven by `npm run -s smoke:autonomy-inbox` (7/7) and `npm run -s smoke:tui-layout` (4/4); at base the offset-less and date-only deadlines, uploaded decisions, settled-card answer and raw listing pass or exit 0, and `remote.wrap` does not exist.
Item: DE-101b documentation link - `4e2938e` - proven by `npm run -s docs:check`, `npm run -s smoke:new-extension` and `npm run -s verify`; the first version of the deadline sentence was parsed as a markdown link.
Item: review follow-up - CHANGELOG entries, remote-control wrap documentation, outcome-timestamp and page-parent sanitising - `834963d` - proven by `npm run -s smoke:autonomy-inbox` (7/7), `npm run -s smoke:control-center` (45/45), `npm run -s docs:check` and `npm run -s verify`.
Item: review warnings - both offset signs documented and the page-parent filter pinned - `c638796` - proven by `npm run -s smoke:control-center` (45/45) and `npm run -s docs:check`.

## What changed

- `packages/extensions/src/control-center/hub.ts`: one `displayText()` runs pi-tui's strip, removes every `Cc`, `Cf` and `Default_Ignorable_Code_Point` character, trims and caps at 500 code points. It now covers the header, page titles and parents, informational rows (label/value/command/description) and typed commands.
- `packages/autonomy/lib/board.ts`: exports `isIsoTimestamp()`, the strict ISO check already used for board timestamps.
- `packages/autonomy/lib/inbox.ts`: card deadlines use `isIsoTimestamp()`; `readInboxFile(..., true)` refuses an uploaded `answer` or `outcome`; `readInbox` still accepts the existing host file.
- `packages/autonomy/cli.ts`: `--answer` on a card that already has an outcome throws `CliError("refused", ...)` naming the card and exits 3; the text listing collapses question/default/outcome text and the outcome timestamp to one visible line.
- `packages/extensions/src/remote-control/index.ts` and `wrap()`: when a wide grapheme does not fit the continuation indent, the indent is dropped and the grapheme is retried whole on the next line; only a grapheme wider than the whole line is skipped.
- Docs: `docs/control-center.md`, `docs/autonomy.md`, `docs/remote-control.md` and six `CHANGELOG.md` Unreleased entries describe the new behaviour and name their tests.
- Tests: `tests/control-center-smoke.ts` (alternate screen, reset, C1 CSI, bidi, 500-character cap, page parent), `tests/autonomy-inbox-smoke.ts` (7 cases including strict deadlines, uploaded decisions, settled refusal, sanitised listing and host outcome timestamp) and `tests/tui-layout-smoke.ts` (`wrap("abc🚀", 2, 1)` keeps every grapheme within 2 columns).

## Notes

- The cycle diff is 35,617 characters, past the 30,000 stop-new-work line but under the 60,000 review cap; no new items were started after that measurement.
- No change to `autonomy/CHARTER.md`, operator control paths, or any `package.json` `scripts`.
- Only targeted checks were run; `npm test` and `npm run check:all` were never run.
