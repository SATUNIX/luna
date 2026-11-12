# Cycle 06 — Review (run luna-ux-01, stream `ux`)

Base `8416c502acc4` (head of `stream/ux`). Area: TUI overlays, the `/` menu, launch screen,
animation and polish (V-01, V-02, V-03, V-05, V-09). Mode: **fix**.

## State at the start

- `git log --oneline 8416c502..HEAD` is empty; the branch starts on the stream head.
- The tree already contains records and accepted work from an earlier lineage (cycles 06-34 were
  squashed into `stream/ux` by `23725c2` and merged here). The live board for this cycle is the
  prompt's Assigned work: V-09 (one remaining clause), V-93, and the cycle-05 gate repair.
- Cycle 05 (V-09 generic provenance scan, wf-panel prune fallback, V-73) is on
  `origin/attempts/luna-ux-01/cycle-05`; its host gate was red (`check-all`,
  `smoke:redaction-corpus`), so it was not merged. Its review named the gate, a loose subagent pin,
  and the missing confirm-after-prune test as must-fix items.

## Gate (priority 0)

The two checks the previous cycle's gate failed are green here:

```text
$ npm run -s smoke:redaction-corpus
[redaction-corpus-smoke] all 6 checks passed          (exit 0)

$ npm run -s smoke:docs
[docs-smoke] OK: 14 documented commands ...           (exit 0)
```

The cycle-05 red was a host-load wall clock, not a code regression: the redaction corpus's check 4
measures a CPU budget, and the same tree passes locally. No test is changed for it. `smoke:docs`
is green because the `luna-ux-01/03` journal line it missed is already present at this base.

## V-09 — the one remaining clause (P2, evidence)

`tests/docs-smoke.ts:473-491` pins provenance for **one** vendored directory: it reads
`third_party/subagent/SOURCE.md` and requires a `2026-11-12` entry naming `wf-panel.ts` and
`23725c2`. The other eleven `packages/extensions/third_party/*/SOURCE.md` are never read, and they
have no bolded dated entry at all:

```text
$ grep -c '^ *- \*\*.*(20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]):' packages/extensions/third_party/*/SOURCE.md
.../subagent/SOURCE.md:26
(eleven other files: 0)
```

So a squash landing in any of those directories leaves its provenance log unpinned and the gate
stays green. The board acceptance is exactly a generic scan: read every `third_party/*/SOURCE.md`,
require at least one bolded `(YYYY-MM-DD)` entry, and keep the subagent pin on the entry that
names `wf-panel.ts`. The existing subagent case also picks the **first** `2026-11-12` entry, so a
reorder would pin the wrong bullet; it should select the entry that names `wf-panel.ts`.

## WorkflowPanel desync after `RunRegistry.prune()` (P2, defect)

`wf-panel.ts` decides the body from `current()` but the footer and key dispatch from `view`:

- `render()` line 790: `const run = this.view === "run" ? this.current() : undefined;`
- `footer()` lines 773-776: `if (this.view === "list") ... else` run legend.
- `press()` line 647: `if (this.view === "list") this.pressList(key); else this.pressRun(key);`

`RunRegistry.prune()` drops a finished run after enough newer ones. With that run open, the body
falls back to the list while the footer keeps the run legend, and the first `down` is consumed by
`pressRun`'s `!run` fallback instead of moving the list cursor. The cycle-03 proposal
`autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md` records this and is still
open; the existing test at `tests/workflow-panel-smoke.ts:410` covers a **save confirm** surviving
the prune, not the list fallback or the first key. Fix: one `inRun()` state for body, footer and
dispatch, leaving `view`/`confirm` untouched so a surviving confirm keeps its choices.

## V-93 — already done, verified

`36565d97` + `5f59714f` put `HIDDEN_CHARS`/`oneVisibleLine` in
`packages/core/shared/visible-text.ts`, registered it in `SHARED_COPIES`, and converted the four
call sites. `grep` finds one hand-written class literal. No re-open; verification runs the V-93
checks rather than editing them.

## Proposals checked

The open `luna-ux-01-03-workflow-panel-footer-after-prune.md` is fixed here. The other open ux
proposals (human-console multi-card focus theft, idle cat blink, hub typed command, workflow panel
height) are outside this cycle's assigned items or already implemented; they are not taken. No new
proposal is needed.
