# Cycle 19 — Verify (run `luna-ux-01`, stream `ux`)

Cycle base `a014133e398a`. Targeted checks only; the host gate owns the full suite. All checks
below ran after `e4536f8`, the last code commit.

| Check | Result |
| --- | --- |
| `npm run smoke:command-menu` | PASS: `[command-menu-smoke] all 14 checks passed` |
| `npm run smoke:launch-screen` | PASS: `[launch-screen-smoke] all 11 checks passed` |
| `npm run smoke:control-center` | PASS: `[control-center-smoke] all 40 checks passed` |
| `npm run smoke:menu-settings` | PASS: `[menu-settings-smoke] all 4 checks passed` |
| `npm run smoke:cat-status` | PASS: `cat-status-smoke: 12/12 passed` |
| `npm run smoke:docs` | PASS: `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run test:typecheck` | PASS: exit 0 |
| `npm run test:lint` | PASS: exit 0, zero warnings |
| `npm run verify` | PASS: `[verify] All checks passed.` |

## Before/after evidence

**Item 1 — re-landed cycle 18 plus the stale assertion (`1bc4630`…`b42ede0`, repair `ec3bd1a`).**
The cycle-18 head reproduced the red gate: `smoke:menu-settings` failed with
`AssertionError: the Settings page shows "pi settings": pi settings  [/settings] | …`. The cause
was a stale expectation, not the code: cycle 18's `typedSuffix()` appends `  [/settings]` because
the row prefills `/settings `. `tests/menu-settings-smoke.ts:110` now pins the exact string
`"pi settings  [/settings]"`; the other three labels stay exact, so the test still proves the
rendered command rather than a substring. `smoke:menu-settings` 4/4 passes.

**Item 2 — focus-aware short-overlay trim (`f8a85ce`).** Restoring the pre-fix
`packages/extensions/src/control-center/hub.ts` trim makes the new case
`a very short overlay keeps the focused row when the cursor is not in the head` fail 1/40 at 4
rows (`cmd19` absent from the rendered lines); with the fix it passes 40/40. The case covers rows
4 and 3, moves focus with `\x1b[A`, asserts the focused row renders, the frame borders survive and
the line count stays within the row budget. The 5-row and taller output is unchanged
(`lines.length <= budget` returns the same list as before).

**Item 3 — per-session re-registration (`e4536f8`).** Restoring the old one-shot `curated` guard
from `e4536f8^` makes the new case
`a replacement session re-registers the curated menu and the launch header` fail 1/14 at
`tests/command-menu-smoke.ts:457` (`the replacement session gets its own curated provider`); with
the fix it passes 14/14 with two providers and two headers. The pre-existing single-session case
still passes, so setup does not double-register within one session: the handler runs once per
`session_start`, and pi emits that event after clearing the old provider and header.

## Independent review

The whole-diff reviewer subagent did not produce a verdict this cycle: four attempts started, and
each ended its turn after a single message without running the requested commands, so no report
was returned. The per-item negative runs above (old source restored, new test fails, fixed source
passes) plus the targeted-check table are the substitute proof, and the reviewer role is replaced
by the operator's host gate. This is recorded here rather than papered over.

## Diff and scope

`git diff --no-renames a014133e398a..HEAD` excluding `package-lock.json` and the cycle/run record
directories is 24,970 characters at `e4536f8`, the last code commit. The final record commit adds
the report, this file, the journal line and the two proposals, 30,553 characters in total. The
code diff stayed under the 30,000 stop-new-items line, and the total is under the 60,000 review
budget. No change to `autonomy/CHARTER.md`, operator control paths, `package.json` scripts,
dependencies, CI, credentials or release configuration. No test was weakened: the only assertion
edited for existing behaviour is the stale Settings label, which now pins the documented suffix
exactly.
dependencies, CI, credentials or release configuration. No test was weakened: the only assertion
edited for existing behaviour is the stale Settings label, which now pins the documented suffix
exactly.
