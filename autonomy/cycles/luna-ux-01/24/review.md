# Cycle 24 — Review (run `luna-ux-01`, stream `ux`)

Base: `5e6b7a7b0f7f` (head of `stream/ux`, cycle 23 report recorded). Working tree clean, no
unpushed commits at the start.

## Inputs read

- `autonomy/CHARTER.md` in full.
- `autonomy/cycles/luna-ux-01/23/report.md` and `verify.md`; `git log --oneline 5e6b7a7b0f7f..HEAD`
  (empty beyond the base).
- `autonomy/runs/luna-ux-01/HANDOFF.md` (cycle 23 leftovers).
- This run's proposals under `autonomy/proposals/luna-ux-01-*.md`.
- No board items were assigned this cycle.

## Findings, with evidence

### F1 (defect, consolidation of cycle 23) — `/workflows` still exceeds the framed cap below 7 rows

Cycle 23 bounded the list view and the confirm fallback, but the fixed block itself is never
clamped. Reproduced with the real modules (`/tmp/wf-edge-check.ts`, throwaway, repo untouched):

```
list view, 14 runs:  rows=4 cap=3 maxLines=1 body=4 framed=6 (+3)
                     rows=5 cap=4 maxLines=2 body=4 framed=6 (+2)
                     rows=6 cap=5 maxLines=3 body=4 framed=6 (+1)
                     rows=7 cap=6 maxLines=4 body=4 framed=6 (0)
save confirm that survived registry pruning (view stayed "run"):
                     rows=4..7 body=5 framed=7 (+4..+1 versus caps 3..6)
```

Root cause: `WorkflowPanel.render` (`packages/extensions/third_party/subagent/wf-panel.ts:752-800`)
reserves `fixed` rows (`1 + 1 + note + confirm/footer + 1`, or `4 + note` for the list) and gives
the middle the remainder, but nothing removes fixed rows or clamps the composite when `maxLines`
is smaller than the fixed block. The cycle-23 handoff listed exactly these two edges as
pre-existing, and the evidenced range then was 8–20 rows; the panel is still clipped below that.

### F2 (documentation accuracy) — proposal 18 is stale: implemented and already pinned

`autonomy/proposals/luna-ux-01-18-short-overlay-drops-focus.md` is still `proposed`, but the code
already handles it and a test already pins it. `hub.ts:404-410` (the `focus` branch) keeps the
focused row when the slice would hide it (`f8a85ce`, cycle 19). `tests/control-center-smoke.ts`
has the dedicated case "a very short overlay keeps the focused row when the cursor is not in the
head": it moves focus to `cmd19` and renders at 3 and 4 terminal rows, asserting the focused
label and both borders. The earlier read of only the neighbouring 8/10/24-row case missed it.
A real-module repro at 8/7/6/5/4/3 rows agrees (`→ /cmd19` and both borders at every height).
Only the proposal's status line is wrong; no test change is needed. This is priority 6
(documentation that does not match the code).

### Checked, no action

- `/menu`, launch screen and the animation/cat code: no new evidenced defect found in the review
  pass; open proposals (idle-cat blink, inert Settings value rows, Work page lab group, hub
  `ctx.mode` fallback, `TRUNK_CHANNEL` alias) remain proposals, unchanged.
- No control paths or `package.json` scripts are touched by F1/F2.

## Mode

**Fix mode**: F1 is a reproduced overlay-clipping defect (stream area: TUI overlays), F2 is a test
gap plus stale proposal evidence. Both sit in the stream's area and outrank proposals.
