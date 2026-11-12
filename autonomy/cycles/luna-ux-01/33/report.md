# Cycle 33 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: DE-98 done - the seven `## [Unreleased]` CHANGELOG entries and the 25-row pairing QR
fixture landed in cycle 32 (`7cf9075`) and were re-verified against HEAD; no further change needed.

Item: DE-98 release record verification - 7cf9075 (cycle 32) - `npm run smoke:tui-layout` 4/4 and
`npm run smoke:docs`; a scout matched every entry to its code (workflow panel, Security Effective,
todo width, pairing wrap, toolPhrase/ASCII, column cuts, width parity) and confirmed `size = 25`.

Item: run-card input hold for the resume question and `ask_human` (V-02) - 1a34f8f, 0892553 -
`npm run smoke:firewall-workflow-approvals` (new case 2g) and `npm run smoke:firewall-overlay-queue`
(36 checks, case 24d's two-card pin plus new case 24e); fresh independent reviewer `VERDICT: PASS`.
The second commit is the Unreleased CHANGELOG entry for the user-visible fix.

## What changed

- `packages/extensions/src/human-console/index.ts`: new bounded `waitForRunCards()` over the local
  `runCardHolder()` counter, used by `askToResume` and `ask_human` before they take the shared hold;
  both re-check `inputHeld() ?? runCardHolder()` inside the show callback, fail closed at their own
  deadline, and emit one notice naming the open workflow card. Run cards still take no global hold,
  so the broker's two outstanding prompts per run are unchanged.
- `tests/firewall-workflow-approvals-smoke.ts` case 2g: answer the 11th distinct approval while the
  broker's 12th card is open; no resume question until that card closes, then the No-first question.
- `tests/firewall-overlay-queue-smoke.ts` case 24e: an `ask_human` behind the broker's two run cards
  times out with no third card and exactly one wait notice.
- `docs/security.md`: the input-owner paragraph now says the resume question and `ask_human` wait
  behind open run cards within their own timeout and fail closed at the deadline.

## Left for later

- The reviewer's first round correctly failed the change because the `ask_human` half had no test;
  case 24e and the one-shot notices were added before the PASS. Only style/coverage niceties remain
  (a possible second notice if a run card appears after the wait, and an up-to-1 s poll latency).
- New proposal `autonomy/proposals/luna-ux-01-33-ui-json-settings-clobber.md`: `/footer` and `/tips`
  rewrite the shared `ui.json` from a six-field projection, dropping `hubKey`, `commandMenu`,
  `launchScreen` and `reducedMotion`. Real data-loss defect, but below the carry-over fix; not
  implemented this cycle.
- Still deferred from the handoff: idle-cat blink needs an intent decision; older pre-range ux
  changes and non-TUI changes still lack Unreleased entries.
- Proposal 30 is now implemented by this cycle; its file is marked closed.
- No package script, profile, charter or control path changed. No full suite was run by design; the
  host gate owns it.
