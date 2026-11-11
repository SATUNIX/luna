# Cycle 01 — Plan (run luna-ux-01, stream `ux`)

- Mode: **fix** (defects F-1 and F-2 from `review.md`; no board items, no HANDOFF).
- Base: `6accaa653a47`. Branch: `pi/luna-ux-01`.
- Budget: ~$5, ~3 h. Two small items in one extension; highest-value first.

## Goal

Fix the two confirmed, evidenced defects in the custom-footer status bar and todo widget, each with
a regression test that fails at the base, and keep the docs that describe them accurate.

## Item 1 — critical-warning merge prints twice (F-1)

- Justification (charter 1, 4): a reproduced rendering bug in the status bar; the narrow-terminal
  case is where boundary warnings matter most. Code contradicts its own comment.
- Change: in `packages/extensions/third_party/custom-footer/render.ts` `fitLine`, hoist the
  `placed` flag out of `replace` so the merged `"<first> +N"` segment is placed once across both
  `l` and `r`; all other priority-0 segments are dropped. No other behaviour changes.
- Proof: extend `tests/status-bar-smoke.ts` (the `criticalWarningsOutliveTelemetryWhenNarrow`
  area) with an assertion that the merged summary appears exactly once on the default line at a
  narrow width, with a right-hand critical chip present. It must fail on the base code (which
  prints it twice).
- Checks: `npm run smoke:status-bar`; `npm run test:typecheck`; `npm run test:lint`.
- Docs: none needed (the doc already says the rest are counted).

## Item 2 — `/footer ascii on` misses the todo checklist (F-2)

- Justification (charter 1, 3): persisted setting is documented to affect the todo widget and does
  not; keyboard-only terminals keep getting Unicode glyphs.
- Change: give `renderTodoWidget` an `ascii` parameter/option and pass `settings.ascii` from
  `updateTodoWidget` (`packages/extensions/third_party/custom-footer/index.ts:275`), so
  `footerGlyphs(theme, ascii)` is used. Backward compatible: default keeps current behaviour.
- Proof: extend `tests/status-bar-smoke.ts` (or `tests/cat-status-smoke.ts` where the widget is
  exercised) with an assertion that `renderTodoWidget(items, theme, { ascii: true })` output is
  printable ASCII only, while the default still uses the Unicode glyphs. Must fail at the base
  (no ascii parameter exists / no effect).
- Checks: `npm run smoke:status-bar`; `npm run smoke:cat-status`; `npm run test:typecheck`;
  `npm run test:lint`.
- Docs: `docs/status-bar-and-costs.md` already claims the todo widget is ASCII; verify the wording
  and adjust only if the implementation differs from the claim.
- Shipped signature: for backward compatibility the ascii flag is a trailing positional parameter
  (`renderTodoWidget(items, theme, max = 8, ascii = false)`), not the `{ ascii }` options object
  sketched above. No caller outside the widget's own update path exists, and the existing `max`
  parameter keeps its position.

## Checks that prove the cycle

- Targeted smokes for every changed file: `npm run smoke:status-bar`, `npm run smoke:cat-status`.
- `npm run test:typecheck`, `npm run test:lint` (repo is strict TS).
- Independent `reviewer` subagent on `git diff 6accaa653a47..HEAD` against `autonomy/CHARTER.md`.
- Never `npm test` or `npm run check:all` (host gate runs the full suite).

## Out of scope (recorded, not taken)

- Idle-blink dead code (`cat.ts:36` vs `index.ts:387-391`): ambiguous intent, deferred.
- human-console `inputHeld()` TOCTOU: proposal for the owner.

---

# Plan — second session, cycle base `afecc1bbb33d`

- Mode: **fix**. Prior batch is merged into the base; this session takes the C-1 defect from the
  continuation review. Budget ~$5, ~3 h; one small item in one file plus its test.

## Goal

Keep the curated `/` menu active for the whole session, including after `/new`, `/resume` and
`/fork`, with a regression test that fails at the base.

## Item C-1 — curated `/` menu lost on session replacement

- Justification (charter 1, 3, 4): a reproduced TUI/`/`-menu defect. The hidden-command filter is
  documented (`docs/control-center.md:88-124`) as always active in the TUI; after the first session
  replacement it silently stops until `/reload`, so every kit command reappears in the `/` menu.
  The wrapper is dropped by pi (`interactive-mode.js:1913`) but the extension is not re-imported.
- Change: in `registerCommandMenu` (`packages/extensions/src/control-center/index.ts`), register a
  `session_shutdown` handler that sets `curated = false`, so the next TUI `session_start`
  re-registers the provider. No other behaviour changes; the in-session duplicate guard is kept.
- Proof: add a case to `tests/command-menu-smoke.ts` that loads control-center once, fires
  `session_start` (TUI), asserts one provider, emulates pi's replacement (fire `session_shutdown`,
  clear `providers`, fire `session_start` again) and asserts one provider again; also assert two
  `session_start`s without a shutdown still yield one provider. Must fail at the base (second
  registration yields zero providers).
- Checks: `npm run smoke:command-menu`; `npm run test:typecheck`; `npm run test:lint`.
- Docs: none change — `docs/control-center.md` already says the filter is TUI-only and always on.

## Checks that prove the session

- `npm run smoke:command-menu` (the changed file's smoke), `npm run test:typecheck`,
  `npm run test:lint`.
- Independent `reviewer` subagent on `git diff afecc1bbb33d..HEAD` against `autonomy/CHARTER.md`.
- Never `npm test` or `npm run check:all` (host gate runs the full suite).

## Out of scope (recorded)

- human-console proposal refuted; new `processPending` multi-card focus-theft proposal to be filed.
- idle-cat blink still needs an intent decision (proposal kept open).
