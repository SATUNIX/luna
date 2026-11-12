# Cycle 28 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix** (consolidation after cycle 27's improve mode). Base `051d491a20b3`.
Board item: **V-09 [P3] — narrow-terminal and glyph-consistency hardening**, already merged as
two sub-items in cycle 27; this cycle repairs the two residual glyph defects found in the same
surfaces.

## Goal

The working line's tool phrase is cut on a grapheme and display-column boundary, never emitting
a lone surrogate or more than 40 columns, and it follows the same automatic ISO/ANSI/TTY ASCII
glyph choice as the footer and todo widget.

## Item 1 — clip `toolPhrase` by display columns (`widgets.ts`)

**Finding:** `clip` uses `v.length` / `v.slice`; an emoji at the boundary is split into a lone
surrogate and an ASCII `...` makes the result 42 columns.

**Change:** reuse the existing `truncateDisplay` helper from `width.ts`:
`truncateDisplay(v, n, ascii ? "..." : "…")`. This keeps the existing 40-column intent, keeps
whole grapheme clusters, and leaves plain ASCII strings cutting the same way (`39 chars + …`,
`37 chars + ...`). No new width helper.

**Proving checks (add to `tests/tui-layout-smoke.ts`, no existing assertion changed):**
- a bash command whose 40-column boundary is an emoji/ZWJ sequence produces a well-formed string
  (no unpaired surrogate), `displayWidth <= 40`, and still ends in the chosen ellipsis;
- the ASCII form of the same command ends in `...` and contains no `…`.

## Item 2 — automatic ASCII reaches the tool phrase (`index.ts`)

**Finding:** `footerGlyphs` selects ASCII for `iso`/`ansi`/`tty` themes, but
`tool_execution_start` passes only `settings.ascii`; the tool phrase stays Unicode on those
themes while the bar is ASCII, contradicting `docs/status-bar-and-costs.md`.

**Change:** resolve the effective ASCII flag from the current theme with the same
`footerGlyphs(theme, settings.ascii)` call the rest of the extension uses, and pass that to
`toolPhrase`. Keep `/footer ascii on` working unchanged.

**Proving checks (add a new case to `tests/status-bar-smoke.ts`):**

- with an `ansi-dark` theme and no `/footer ascii` setting, trigger `tool_execution_start` with
  a long bash command and assert `__footerDebug.workingText` contains `...` and no `…`;
- keep the existing explicit-setting case untouched.

## Docs

- `docs/status-bar-and-costs.md`: state that the working line's tool phrase follows the automatic
  ASCII theme rule and is cut in terminal columns.
- `packages/extensions/third_party/custom-footer/SOURCE.md`: dated entry for the two files.
- Regenerate `THIRD_PARTY_NOTICES.md` only if it changes (`node packages/core/gen-notices.ts`).

## Checks (targeted only — never `npm test` or `npm run check:all`)

`npm run smoke:tui-layout`, `npm run smoke:status-bar`, `npm run smoke:workflow-panel`,
`npm run smoke:remote-control`, `npm run smoke:docs`, `npm run test:typecheck`,
`npm run test:lint`, `npm run verify`.

## Out of scope

Footer priority/fitting logic, the cat, hub `SettingsList`, themes under `packages/kit/themes`,
web UI, Android, workflow-panel height, new widgets or animations, control paths,
`package.json` scripts, dependencies.

## Diff budget

Measure after each commit:
`git diff --no-renames 051d491a20b3..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`.
Stop new work at 30000; hard review limit 60000.
