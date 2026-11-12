# Cycle 30 — Review (run `luna-ux-01`, stream `ux`)

Mode: **fix**. The assigned item V-91 is already satisfied on this branch, so the cycle takes the
best-evidenced defect the review found in the same surface (V-01/V-09 status-bar width).

## Starting state

- Branch `pi/luna-ux-01` at `fc5dc46`, cycle base `fc5dc465a56c`; no commits after the base.
- Cycle 29 closed V-91: `renderTodoWidget` gained a width parameter, `updateTodoWidget` mounts a
  component, and `tests/tui-layout-smoke.ts` covers six widths, both themes and all four surfaces.
- Re-checked the board's V-91 acceptance now: `tests/tui-layout-smoke.ts` exists (238 lines),
  `package.json` wires `smoke:tui-layout`, and `npm run smoke:tui-layout` is 4/4. Nothing remains.

## What the scouts checked

Three scouts read the current code, not the audit docs, and treated every open proposal as a
hypothesis:

- `autonomy/proposals/luna-ux-01-01-human-console-multi-card-focus-theft.md` — the non-run card
  path is fixed (`human-console/index.ts:466-478` takes `withInputHold` before the first await).
  But run-approval cards still open with only a local `openRunCards` counter (`:383-402`) that
  `askToResume` (`:347-357`) and `ask_human` (`:546-554`) never see, so the resume question can
  still open over a second live run card. Real, but larger than this cycle's chosen item; written
  up as `autonomy/proposals/luna-ux-01-30-run-card-input-hold.md`.
- `luna-ux-01-19-workflow-panel-height.md` — fixed: `wf-panel.ts:786-832` budgets from
  `tui.terminal.rows`, reserves the two frame rows and trims narration/phases/agents before the
  confirm block. `smoke:workflow-panel` is 20/20.
- `luna-ux-01-01-idle-cat-blink.md` — still a deliberate deferral: the docs state the resting face
  does not blink; only dead table frames and a misleading test message remain.
- Launch screen, `/` menu, overlay frame, pairing panel and the workflow list/run views: no new
  width, focus or lifecycle defect found in this pass.

## Chosen defect: the footer measures VS16/keycap emoji and tabs narrower than pi-tui renders them

`packages/extensions/third_party/custom-footer/width.ts:37-53` computes each grapheme cluster's
width from its code points. A variation selector (`U+FE0F`) and a keycap (`U+20E3`) count 0, so
`❤️`, `⚠️`, `✔️` and `1️⃣` measure 1 column where pi-tui's `visibleWidth` returns 2. A tab falls
into `\p{Cc}` and counts 0 where pi-tui allocates 3 columns. Reproduced (footer module vs pi-tui):

```
"❤️" footer: 1 pi-tui: 2
"⚠️" footer: 1 pi-tui: 2
"1️⃣" footer: 1 pi-tui: 2
"a\tb" footer: 2 pi-tui: 5
truncateDisplay("❤️"*11, 10) -> footer 10, pi-tui 19
```

The footer's whole guarantee is that every line is cut to the terminal's columns; an under-count
makes pi-tui wrap or slice the line, adding rows to a fixed-height bar. It affects todo text, cwd,
branch, session name, model and chip text. Existing tests miss it because their fixtures use only
`🚀` (a true `Emoji_Presentation` code point) and they measure with the module's own
`displayWidth`, so a divergence between that function and the host renderer cannot show up.

Charter fit: (1) reproduced with command output, (2) a regression fixture measured with pi-tui's
`visibleWidth` fails on base, (3) the docs already promise "emoji clusters take two columns", so
this makes the code match them, (5) one small self-contained change.

## Deferred

- Run-card input hold (proposal above).
- Idle-cat blink: needs an intent decision, unchanged from cycle 01.
- Any cleanup of unrelated files: not this cycle.
