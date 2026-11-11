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

---

# Continuation — second session, cycle base `afecc1bbb33d`

- The prior batch above (`6accaa653a47..b33ed76`) is already merged into the new cycle base
  `afecc1bbb33d` (head of `stream/ux`). This session ran a fresh reconnaissance against the new
  base: one parallel `scout` plan of three agents (workflow run
  `2026-11-11T04-55-50-111Z-plan-c530`) covering the `/` command menu, the open human-console
  proposal, and the idle-cat blink proposal. Docs were treated as hypotheses; every candidate
  needed a reproduction.
- Mode: **fix** (a real `/` menu defect plus proposal triage). Assigned board: still none.
- `npm run smoke:command-menu` passes all 11 checks at the base, so the defect below is by
  construction not pinned.

## Confirmed finding

### C-1 (fix) — the curated `/` menu switches off after `/new`, `/resume` or `/fork` until `/reload`

`packages/extensions/src/control-center/index.ts:43-46`. `registerCommandMenu` guards its
`session_start` handler with a module-closure `curated` flag that is never reset:

```ts
let curated = false;
pi.on("session_start", (_event, ctx) => {
  if (curated) return;
```

On a session replacement pi emits `session_shutdown`, clears `autocompleteProviderWrappers` (so
the registered provider is dropped) and then emits a new `session_start` — but the extension module
is not re-imported, so `curated` is still `true` and the provider is never re-added. Verified in the
installed host: `agent-session-runtime.js:105-114` (`teardownCurrent`: `emitSessionShutdownEvent`
then `beforeSessionInvalidate`), `interactive-mode.js:358-369` + `:1898-1913`
(`resetExtensionUI` sets `autocompleteProviderWrappers = []`), and `agent-session-runtime.js:141`,
`:165`, `:211` (`sessionStartEvent` reason `resume` / `new` / `fork`). Repro (headless, load
control-center once): first `session_start` gives `providers: 1`; after `session_shutdown` +
wrapper reset + second `session_start`, `providers: 0`. Not pinned: `tests/command-menu-smoke.ts`
cache-busts and reloads the module per case, so it never exercises the closure across a replacement.

## Proposals triaged

- **human-console `inputHeld()` TOCTOU** (`autonomy/proposals/luna-ux-01-01-human-console-input-hold-race.md`)
  — **REFUTED.** The cited lines are off by one and the gap contains **no `await`**: `inputHeld()`
  (`human-console/index.ts:368`, `:438`) and the `ctx.ui.select`/`ctx.ui.confirm` inside
  `answerApproval`/`answerQuestion` run in one synchronous turn (`index.ts:223`, `:236`, `:187`),
  so no other holder can acquire input there. `showWhenFree` re-checks only because it actually
  waits (`core/shared/input-owner.ts:156-164,193-211`); these paths do not. No fix; mark the
  proposal closed. The scout found a different, real focus-theft weakness: `processPending`
  (`index.ts:487-501`) fires `void processOne(...)` for every pending file synchronously, so a
  second card opens over the first. That is a new, separate proposal, not this one.
- **idle-cat blink** (`autonomy/proposals/luna-ux-01-01-idle-cat-blink.md`) — **CONFIRMED dead at
  runtime.** `catView` (`custom-footer/index.ts:387-391`) passes `now - now` for any non-TRANSIENT
  state, so `renderCat("idle", 0)` is the only idle call ever made; the `=^-.-^=` blink in
  `cat.ts:36` is unreachable while `tests/cat-status-smoke.ts:95` asserts the table blinks and
  `docs/status-bar-and-costs.md:108-110` says it does not. Intent is split (commit `3a245e6` added
  the frame deliberately; the renderer and docs never followed). Deferred again: option (a) drive a
  timer contradicts the documented "nothing ticks while idle" and needs a new idle-clock and timer
  lifecycle; option (b) delete the frame removes a face the operator added. Neither is clearly the
  intended one, and this cycle's chosen fix is higher-value. Kept as a proposal needing an intent
  decision.

## Chosen for this session

1. C-1: reset `curated` on `session_shutdown` so the curated `/` menu survives a session
   replacement; add a smoke case that emulates pi's wrapper reset across two `session_start`s.
