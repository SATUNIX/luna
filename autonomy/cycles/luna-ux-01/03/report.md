Outcome: partial
Mode: fix

Board: V-01 done - re-landed the reviewed overlay frame and transcript dim: both kit TUI overlays now draw a theme-aware border and dim the transcript behind them, with tests.
Board: V-03 blocked - not started; re-landing V-01 already consumed the cycle's 30000-character diff budget, so it starts cycle 04 with the plan in 02/plan.md.

Item: V-01 overlay frame + transcript dim - ddf1c39 (implementation; cherry-pick of cycle-02 72d1f4c), c231372 (docs naming the smokes; cherry-pick of cycle-02 404b13a) - `npm run smoke:control-center` (28 checks) and `npm run smoke:workflow-panel` (14 checks), plus `npm run test:typecheck` and `npm run test:lint`.

## Why the test change is where it is

The new overlay cases live inside `tests/control-center-smoke.ts` and `tests/workflow-panel-smoke.ts`
rather than a new `smoke:overlay-frame` script, so the merge gate's `package.json` `scripts` set is
unchanged. The two smokes own those call sites. This is the justification the report format asks to
put near the top.

## What changed

Re-landed the cycle-02 V-01 commit pair onto this branch (they apply cleanly). The change adds
`packages/extensions/src/control-center/overlay-frame.ts` (byte-identical copy at
`packages/extensions/third_party/subagent/overlay-frame.ts`): `frameLines` draws a rounded
`theme.fg("border", …)` box with exact padding and returns content unframed below width 10;
`withOverlayFrame` shadows `compositeOverlays` on the one host instance to dim non-image base lines
while an overlay is open, guarded by `Symbol.for("pi-kit.overlay-frame.composite")`, restored on
`done` and `dispose`. The hub (`hub.ts` `tuiRenderer`) and the workflow panel (`wf-panel.ts`
`openWorkflowPanel`) both route their close callback through the wrapped `finish`; overlay options
are unchanged. `CHANGELOG.md` and `docs/control-center.md` describe it and name the smokes.

## The rejection reason

Cycle 02 was rejected by the host acceptance run (`check-all`, `check-all:smoke:web-console` exit 1),
not by review. The carried diff touches no `packages/web-ui/` code, no `package.json` scripts and no
lockfile, and `npm run smoke:web-console` passes standalone and from the branch worktree. The smoke
writes the repo-relative `packages/web-ui/.runtime/console.token` and starts a detached server; two
concurrent runs always fail with `PI_CONSOLE_TOKEN_FILE could not be read (ENOENT)`, while one
passes. That makes the smoke runner-order sensitive, which matches a red per-check contract entry
beside the aggregate run. Recorded as
`autonomy/proposals/luna-ux-01-03-web-console-smoke-shared-runtime.md` (outside the UX stream, not
fixed here).

## Left and known

- **V-03** is fully planned (`02/plan.md`) and validated (`02/review.md`): register `menu` primary
  with `kit`/`helpers` described `Alias of /menu`, pin and shortcut `menu`, rename the menu UI
  strings only, add the `Settings` page and its rows. It needs a cycle of its own.
- Carried proposals needing an operator decision: idle-cat blink
  (`luna-ux-01-01-idle-cat-blink.md`) and human-console multi-card focus theft
  (`luna-ux-01-01-human-console-multi-card-focus-theft.md`).
- Latent ≤3-character hidden-command reveal gap (`command-menu.ts:184`); V-03 removes it.

## Next cycle should know

Start with V-03 from `02/plan.md`; the branch now carries the overlay-frame precedent, so do not add
a third copy without a byte-identity test. No control files, `package.json` `scripts`,
`tool-firewall` sources or secrets were touched; the branch never ran `npm test` or
`npm run check:all`. The cycle diff is 31267 characters excluding lockfile and records.
