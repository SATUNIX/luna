# Cycle 01 — Review (run luna-ux-01, stream `ux`)

- Branch: `pi/luna-ux-01`, cycle base `6accaa653a47` (head of `stream/ux`).
- Mode: **fix** — the review found real, evidenced defects inside the stream area.
- Stream area: TUI overlays, the `/` menu, launch screen, animation and polish.
- Board: **no assigned items** (contract `objective.backlog` is empty). Precedence starts at (3)
  HANDOFF; `autonomy/runs/luna-ux-01/HANDOFF.md` does not exist yet, so this is the run's first
  cycle and the review starts from discovered defects (4).

## Method

Direct reconnaissance of the stream's surfaces, then one parallel scout plan of three `scout`
agents (workflow run `2026-11-11T03-42-21-254Z-plan-0cfd`), each told to treat the docs as
hypotheses and to give `file:line` evidence and whether a test pins the behaviour. All three
permitted smokes pass at the base (`smoke:control-center`, `smoke:firewall-overlay-queue`,
`smoke:cat-status`, `smoke:status-bar`), so the findings below are by construction not pinned.

## Confirmed findings

### F-1 (fix) — the status bar prints the merged critical-warning summary twice

`packages/extensions/third_party/custom-footer/render.ts:213-224`. `fitLine` collapses several
priority-0 warnings into one `"<first> +N"` segment when the line is too narrow. Its `replace`
helper declares `let placed = false` **inside the function body**, so the flag is fresh for each
call: `replace(l)` and `replace(r)` each insert a copy of `merged`. Reproduced at the base
(width does not matter; the right-hand status chip is also priority 0):

```text
$ node --input-type=module -e '... renderFooter(state, plain, 40, "default")'
● w │ on main │ /w            p │ m │ E3
! UNATTENDED +3          ! UNATTENDED +3
```

The line shows the same summary twice and the `+3` count also folds in the right-hand critical.
The comment says "name the first and count the rest". A narrow terminal is exactly when the
boundary warning matters. Not pinned: `tests/status-bar-smoke.ts` matches `/UNATTENDED[^\n]*\+\d/`
without counting occurrences.

### F-2 (fix) — `/footer ascii on` does not reach the todo checklist

`packages/extensions/third_party/custom-footer/index.ts:275` calls
`renderTodoWidget(cache.todos, theme)`, and `widgets.ts:14` calls `footerGlyphs(theme)` with no
`forceAscii`. `render.ts:118` already accepts `forceAscii`, and `render.ts:338` passes
`state.ascii` for the bar, but the todo widget never gets the setting. So the persisted
`/footer ascii on` (and `state.ascii`) switches the bar to `> | = -` while the checklist keeps
emitting `▸ ✔ ☐ █ ░`. Docs claim otherwise: `docs/status-bar-and-costs.md:18`
(`/footer ascii on|off  plain characters instead of symbols`) and the Themes section. Not pinned:
`tests/status-bar-smoke.ts` `asciiFallback` only exercises the bar and the theme name, not the
setting on the widget.

## Checked and set aside

- **Idle blink frame is dead code** (`cat.ts:36` has `=^-.-^=`, `tests/cat-status-smoke.ts:95`
  asserts it, but `index.ts:387-391` passes elapsed 0 for idle so it never renders; the docs say
  the resting face does not blink). Real contradiction, but changing animation frames or the doc
  is cosmetic/ambiguous about intent; recorded for a later cycle, not taken here.
- **`frameAt` returns `""` for `NaN`/`Infinity`** (`cat.ts:96-100`): not reachable from any caller
  (`now - since` is always finite). No change.
- **RPC value sub-dialog timeout returns `"back"`** (`hub.ts:282`) vs the doc's "a timeout closes
  the hub": latent (no shipped `values` row sits on a subpage) and navigating to parent does not
  hold the session. No change.
- **Weakening confirm passes no dialog timeout** (`hub.ts:153`): lower confidence that pi's select
  does not settle on Esc; not taken.
- **human-console `inputHeld()` TOCTOU** (`human-console/index.ts:367,438`): narrow window,
  separate extension outside `ux`'s immediate fix set; proposed, not taken.

## Items chosen for this cycle

1. F-1: fix the double merge in `fitLine`; add a test that counts the summary occurrences.
2. F-2: thread the ASCII setting into `renderTodoWidget`; update the doc that already claims it.
