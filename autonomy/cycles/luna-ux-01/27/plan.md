# Cycle 27 plan

Board item: **V-09 [P3] — narrow-terminal and glyph-consistency hardening**, two ordered
sub-items. Mode: improve. Base: `897ff52bce9c`.

## Goal

Every line rendered by the status bar, the todo checklist, the `/workflows` panel and the remote
pairing panel fits widths 20, 32, 40, 60, 80 and 120 columns, including wide-character and emoji
input; ASCII mode emits no non-ASCII character that Luna generated. One new deterministic smoke,
`smoke:tui-layout`, proves it and fails on the base.

## Item 1 — footer and todo checklist glyph/width consistency

**Change**
- `custom-footer/render.ts`: accept an `ellipsis` argument in `fitLine` and `statusChip`; pass
  `glyphs.ellipsis` through every generated cut (chips, alt forms, final fit and the last-resort
  truncation). The default stays `…`, so non-ASCII themes are unchanged.
- `custom-footer/widgets.ts`: `renderTodoWidget(items, theme, max, ascii, width?)` cuts each line
  to `width` columns with `truncateDisplay`, using `...` from the glyph set when ASCII is on.
- `custom-footer/index.ts`: read `process.stdout.columns` at mount time and pass a positive,
  finite width to the widget. No width leaves the old full-text behaviour (pi wraps it).
- `SOURCE.md` entry for the touched vendored directory; docs sentence on the cut.

**Proving checks**
- `smoke:tui-layout` status bar: all densities at every width with ASCII, wide and ANSI input;
  ASCII lines match `^\p{ASCII}*$`.
- Same smoke todo checks: long ASCII and CJK/emoji items fit every width; ASCII output is ASCII.
- Negative: revert the two source files to base and the smoke fails with a non-ASCII character
  and a 50-column todo line.

## Item 2 — pairing panel column wrapping

**Change**
- `remote-control/index.ts`: `wrap` measures with pi-tui `visibleWidth` and cuts long words with
  `sliceByColumn(..., true)`, so a CJK word or emoji cluster is never split and never overflows.
- Declare the already-used pi peer `@earendil-works/pi-tui` in `extension.json` (`piPeers`); no
  new dependency.
- Extend the pairing-panel part of `smoke:tui-layout` with a long CJK fingerprint word and a QR
  code, at every width with ANSI styling.

**Proving checks**
- `smoke:tui-layout` pairing panel fits every width, keeps the narrow-terminal size note, and
  still emits the QR code on a wide terminal.
- Negative: base `wrap` produced a 22-column line at width 20.
- `smoke:remote-control` (existing pairing layouts) stays green.

## Verification

- `npm run smoke:tui-layout`, `npm run smoke:status-bar`, `npm run smoke:workflow-panel`,
  `npm run smoke:remote-control`, `npm run smoke:docs`.
- `npm run test:typecheck`, `npm run test:lint`, `npm run verify` (targeted to changed files;
  never `npm test` or `npm run check:all`).
- Host gate `/opt/autonomy/gate.sh` runs on the pushed head; the host owns the full suite.
- Diff budget: measure `git diff 897ff52bce9c..HEAD` after each commit and stop taking new work
  once it exceeds 30000 characters (review limit 60000).

## Out of scope

Footer priority/fitting logic, the cat, control-center hub `SettingsList`, themes under
`packages/kit/themes`, web UI, Android, workflow-panel height, new widgets or animations.
