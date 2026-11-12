# Cycle 30 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: V-91 done - the assigned narrow-terminal layout smoke, the todo-widget width fix and the dated SOURCE entry were already merged in cycle 29; this cycle re-verified every acceptance clause at base and finished the remaining width defect the review found.

Item: footer width parity for VS16/keycap emoji and tabs - 6c2d1c6 - `npm run smoke:tui-layout` 4/4; base `width.ts` fails with `todos@20: line 5 is 22 columns by pi-tui visibleWidth, limit 20`
Item: footer-text fixture for the same clusters plus regenerated notices - b7306ca - `npm run smoke:tui-layout` 4/4; base fails first at `wide footer light@20: line 0 is 22 columns by pi-tui visibleWidth, limit 20`

## Review

V-91 was the whole assigned board. It was already complete at the cycle base: `tests/tui-layout-smoke.ts`
exists, `smoke:tui-layout` is wired and 4/4, `renderTodoWidget` takes its width and
`updateTodoWidget` mounts a component, and `custom-footer/SOURCE.md` has the cycle 29 entry. The
three scouts therefore looked for real defects in the ux surfaces instead. Most earlier proposals
already ship: the non-run card input hold (cycle 12+), the workflow panel height budget (cycles
19-24), hub key validation (cycle 20). The one new finding with reproduced evidence was the width
module.

## What changed

`width.ts` counted a VS16/keycap emoji cluster as 1 column where pi-tui's `visibleWidth` counts 2,
and a tab as 0 where pi-tui counts 3. Every footer and todo line trusts that measurement, so `❤️`,
`⚠️`, `✔️`, `1️⃣` or a tab in a todo, cwd, branch, session name or chip made the line wider than
the computed width, letting pi-tui wrap it. `clusterWidth` now promotes a cluster containing
`U+FE0F` or `U+20E3` to 2 (zero-width-only clusters stay 0), and `codePointWidth` returns 3 for a
tab before the control-character rule.

`tests/tui-layout-smoke.ts` now asserts pi-tui's `visibleWidth` for every line of every surface in
addition to the module's own `displayWidth`, and both the todo and footer fixtures carry the
clusters and a tab. That turns the module/host divergence into a test failure, which the old
from-the-same-module measurement could not do. `SOURCE.md` has a dated cycle 30 entry and
`THIRD_PARTY_NOTICES.md` is regenerated.

## Left for later

- New proposal `autonomy/proposals/luna-ux-01-30-run-card-input-hold.md`: run approval cards never
  register an input hold, so `askToResume`/`ask_human` can open over a second live run card. Real
  V-02 focus theft, larger than this cycle's item; evidence and a suggested fix are in the file.
- Idle-cat blink is still a deliberate deferral (docs say it does not blink); unchanged.
- Full `get-east-asian-width` parity (regional indicators, Indic spacing marks) was not evidenced
  and is out of scope for this change.
- The plan's SOURCE-entry date said `2026-11-14`; the entry uses `2026-11-13`, consistent with
  cycle 29. No code or acceptance impact.
- Non-record diff is ~9.5 KB, below the 30,000 stop-new-work threshold.
