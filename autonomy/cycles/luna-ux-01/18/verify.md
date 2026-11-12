# Cycle 18 — Verify (run `luna-ux-01`, stream `ux`)

Cycle base `a014133e398a`. Targeted checks only; the host gate owns the full suite. All checks
below ran after `4d5686a`, the last non-record commit.

| Check | Result |
| --- | --- |
| `npm run smoke:control-center` | PASS: `[control-center-smoke] all 39 checks passed` |
| `npm run smoke:command-menu` | PASS: `[command-menu-smoke] all 13 checks passed` |
| `npm run smoke:docs` | PASS: `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run smoke:docs` after the record commit | PASS: same output after `139eea6` |
| `npm run smoke:cat-status` | PASS: `cat-status-smoke: 12/12 passed` |
| `npm run test:typecheck` | PASS: exit 0 |
| `npm run test:lint` | PASS: exit 0, zero warnings |
| `npm run verify` | PASS: `[verify] All checks passed.` |

## Before/after evidence

**Typed commands in the TUI and RPC (`e23b6f3`).** The new case fails on the pre-fix source:
restoring `packages/extensions/src/control-center/hub.ts` from `a014133` gives
`[control-center-smoke] 1/39 FAILED` at `the TUI and RPC show each row's typed command`. With the
fix it passes 39/39. The case pins RPC Autonomy `[/auto]` (legacy), RPC Session `[/compact]`
(editor pre-fill), TUI Autonomy `Approvals … [/auto]`, and TUI Doctor `Update … [/update status]`.
The second case pins that All commands keeps the exact `/auto` option (no duplicate suffix) and
that at width 20 the row name `Approvals` survives while `[/auto]` is cut; its wide-width sibling
assertion fails pre-fix, so the case as a whole is a regression test. `makeUi` only gained a
defaulted `renderWidth = 120` parameter; no existing assertion was weakened.

**Cat `alert` docs (`4d5686a`).** `custom-footer` calls `setResult` only at `index.ts:507`
(`denied`/`warning`), `:524` (`error`/`cancelled`/`success`) and `:534` (`warning`). No caller
passes `alert`, so it moved from the reachable-result table to the "Not covered" sentence with
`retrying` and `sleeping`. The animation table and priority list are unchanged.

## Independent review

A reviewer subagent that did not write the change read `git diff a014133e398a..HEAD` against
`autonomy/CHARTER.md` and the plan, checked the two test cases against the pre-fix code, and
re-ran the targeted checks. It returned **PASS** and left three non-blocking notes: the All
commands duplicate check covers RPC but not a TUI/print render; the narrow assertion alone would
pass pre-fix (paired with a wide assertion that fails); and a future control passing a legacy
value with a control character would have it deleted rather than rejected. The verdict is in
`review-implementation.md`.

## Record gate repaired

Adding the cycle report reddened `smoke:docs`: `autonomy/JOURNAL.md` had no `luna-ux-01/18`
entry, the same failure mode cycle 17 recorded. `139eea6` adds the entry and `smoke:docs` passes
again. The final pushed head must contain that commit; do not report a green `smoke:docs` from a
report-only commit without it.

## Diff and scope

`git diff --no-renames a014133e398a..HEAD` excluding `package-lock.json` and the cycle/run record
directories is 15,041 characters, under the 30,000 stop-new-items line and the 60,000 review
budget. No change to `autonomy/CHARTER.md`, operator control paths, `package.json` scripts,
dependencies, CI, credentials or release configuration. The only test-helper change is the
defaulted render width above; no test was weakened.
