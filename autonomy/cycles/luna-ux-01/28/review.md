# Cycle 28 — Review (run `luna-ux-01`, stream `ux`)

Board: **V-09 [P3] — narrow-terminal and glyph-consistency hardening**, the two ordered
sub-items from cycle 27. Base `051d491a20b3` (head of `stream/ux`).

## State inherited

Cycle 27 already merged both V-09 sub-items (`84fd8df`, `dd11dd9`, completed by `5eb4d82`):
`renderFooter` and `renderTodoWidget` cut in display columns with the theme's ellipsis, and
`pairPanel` wraps by display columns. `tests/tui-layout-smoke.ts` pins all four surfaces at
widths 20-120 with ASCII, CJK and emoji input. The previous report and handoff are clear that
the board item was finished; cycle 27's mode was **improve**, so this cycle starts with the
charter's required consolidation pass over what it changed.

Targeted run on the base:

```
npm run smoke:tui-layout        PASS (4 checks)
npm run smoke:status-bar        PASS (25)
npm run smoke:workflow-panel    PASS (20)
npm run smoke:remote-control    PASS (16)
npm run smoke:docs              PASS
```

## Findings (consolidation)

### F1 — `toolPhrase` cuts a bash command by code units and splits an emoji

`packages/extensions/third_party/custom-footer/widgets.ts:49` clips the command with
`v.length > n ? v.slice(0, n - 1) + ellipsis : v`. An emoji at the cut boundary is a surrogate
pair, so the slice can keep one half. Reproduced on the base:

```
$ node --experimental-strip-types -e "import('./packages/extensions/third_party/custom-footer/widgets.ts').then(...)"
"Running \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ud83d…\`"
```

The output contains the lone high surrogate `U+D83D` before the ellipsis; a terminal draws a
replacement glyph, and the clip also exceeds the intended 40 columns once an ASCII `...` is
appended (42). This is the same glyph-consistency defect V-09 fixed elsewhere; cycle 27's
`toolPhrase` change only threaded the ASCII ellipsis, it did not change the cut itself.

### F2 — the automatic ASCII glyph set does not reach the tool phrase

`footerGlyphs` (`render.ts:118-124`) chooses ASCII automatically for an `iso`/`ansi`/`tty`
theme, and the docs say that mode uses keyboard-only characters (`docs/status-bar-and-costs.md`
line 205). The footer and the todo widget go through `footerGlyphs(theme, …)`, but the
`tool_execution_start` call site (`index.ts:505`) passes only `settings.ascii`, which is false
unless `/footer ascii on` was run. On an `ansi-dark` theme the working line therefore ends a
clipped command in `…` while the bar around it is ASCII. The docs promise the ASCII theme's
working line uses `...`; the code does not.

Both are small, in the V-09 surface, and have tests that can fail on the base.

## Checked and set aside

- The four TUI renderers already fit widths 20-120; the cycle-27 smoke covers them, and a
  parallel scout pass found no further overflow or row-budget defect in `wf-panel.ts` or
  `pairPanel`.
- `wrap()` in `pairPanel` still drops an unfittable wide grapheme at widths 2-3; cycle 27
  accepted this as bounded and it is outside the assigned width set (20+).
- Open proposals (idle-cat blink, hub edge cases, `TRUNK_CHANNEL`, inbox deadlines,
  `workflow-hooks` timers) are either decided or outside this cycle's assigned item; no new
  proposal is needed for F1/F2.
- No control path, charter or `package.json` script needs to change: both improvements use
  existing smokes (`smoke:tui-layout`, `smoke:status-bar`).

## Mode

**Fix** — consolidation of the cycle-27 improvement. The two items are repaired in place rather
than extended.
