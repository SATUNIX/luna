# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/custom-footer.ts`
- Date: 2026-06-17
- Changes:
  - **Vendored upstream (2026-06-17):** initial import of the upstream example; the changes below are Luna's.
  - Preserves the `custom-footer` extension id for compatibility while presenting it as the GitOps status bar in user docs.
  - Adds token totals, estimated cost, model id, git branch, context percentage, and `/footer status|reload`.
  - Reads pricing from `.pi-kit/costs.json`, `<agent dir>/pi-kit/costs.json`, or `PI_KIT_COST_*_PER_MTOK` environment overrides.
  - Removed all `@earendil-works/pi-tui` imports to preserve self-containment (own ANSI-aware width helpers).
- 2026-09-14 redesign:
  - Replaces the built-in footer through `ctx.ui.setFooter(factory)` with a colored 3-line bar
    (location + model, context bar + session tokens + run timer, status chips + todo progress).
    Session totals come from session entries. A render error falls back to one plain line.
    `/footer off` restores pi's built-in footer.
  - Working line: a 1 s ticker sets `setWorkingMessage` with the activity (tool, thinking,
    writing, or a rotating phrase), elapsed time, and ↑/↓ tokens for the current run.
  - Tips widget during runs (`/tips on|off`), filtered to loaded commands.
  - Todo checklist widget from `TODO.md` (`/footer todos on|off`).
  - UI settings persist in `<agent dir>/pi-kit/ui.json`.
- 2026-09-30 rewrite (public beta):
  - One renderer built from prioritised segments (`render.ts`): light, default and heavy differ in
    content, not just line count; narrow terminals drop the least important segment first, shorten
    long ones, and never drop a boundary or failure warning for telemetry. Widths are terminal
    columns (`width.ts`: wide characters, emoji clusters, combining marks, ANSI/OSC 8).
  - Shows the security level (requested → effective when raised, with a warning marker) beside
    the effort tier (and a pending change), unattended state (what the firewall enforces, never
    what the environment claims), compaction state and live/failed children, read from read-only
    registries their owners publish on globalThis (`data.ts`); costs are labelled measured,
    estimated or unknown (unknown is not zero); unknown context is `?`, not 0%.
  - No subprocess and no disk read per render: the branch comes from `.git/HEAD` at session start
    (or pi's footer data), session totals are incremental, todos are stat-cached, profile and firewall
    are read once per session. Stale in-flight chips are hidden once idle; failures never are.
  - Lifecycle: `session_shutdown` clears the ticker, widgets and hooks; a reload replaces, never adds.
  - Commands: invalid `/footer` and `/tips` arguments no longer toggle or mutate anything (the old
    fall-through toggled the bar); non-interactive sessions get text on stderr; `/footer status` is
    the accessible detail view of everything the bar drops; `/footer ascii on|off`.
  - The working line keeps run tokens and time; the footer no longer repeats them.
- 2026-10-01 cat status indicator:
  - `cat.ts`: a data-driven ASCII cat (animation table, state priority, frame arithmetic, tool-error
    classification); pure, printable US-ASCII, padded to a fixed width.
  - While a request runs the cat is pi's working indicator (`setWorkingIndicator`), re-set only when
    the resolved state changes; between requests the bar shows it, and a result plays once on a
    self-clearing timer. New hooks: `ui_prompt_start/end` (waiting for user) and
    `session_before_compact`, `session_compact`, `session_compact_failed` (crunching).
  - `/footer cat on|off`, saved in `ui.json`; `PI_KIT_CAT=0` forces it off.
- A pricing file that parses to something other than a JSON object is reported as unreadable and
  the bar keeps its prior pricing, the same path a parse error takes; it is never cast (nothing
  pins this).
- 2026-11-12 narrow-terminal hardening:
  - The todo checklist is handed to pi cut to the terminal's columns (`renderTodoWidget` takes an
    optional width), so a long item is truncated once instead of wrapped onto extra rows; an ASCII
    theme ends the cut with `...`.
  - In ASCII mode every generated ellipsis is ASCII too: the status bar's chip, alt-form and final
    fit cuts, the shortened path and the working line's tool phrase use the glyph set's `...`
    rather than the Unicode `…`. User-supplied text is untouched.
  - `toolPhrase` clips by display columns and whole graphemes (`truncateDisplay`), so an emoji at
    the 40-column cut is never split into a lone surrogate, and the automatic ISO/ANSI/TTY ASCII
    choice reaches the tool phrase, not only the explicit `/footer ascii` setting.
- 2026-11-13 cycle 29: per-render todo checklist width.
  - `updateTodoWidget` mounts the checklist as a component instead of a `string[]` cut once from
    `process.stdout.columns`, so pi calls `render(width)` with the terminal's current width each
    frame and a resize (or an early mount before the TUI knows its columns) no longer leaves long
    items wrapped. `renderTodoWidget` keeps its optional fifth `width` parameter.
- 2026-11-13 cycle 30: width parity for emoji presentation sequences and tabs.
  - `clusterWidth` promotes a cluster containing U+FE0F (VS16) or U+20E3 (keycap) to two columns,
    as pi-tui's `visibleWidth` counts emoji presentation sequences; clusters that are only
    zero-width stay at 0.
  - A tab measures three columns (`codePointWidth`), matching pi-tui's `graphemeWidth`.
  - Pinned by `tests/status-bar-smoke.ts`, which sweeps the footer at widths 20 to 120 and asserts
    `visibleWidth` fits, and keeps wide and emoji text in the Unicode bar.
- 2026-11-18 ASCII status chips.
  - `width.ts` adds `foldAscii(text, names)`, which replaces each grapheme cluster outside printable
    ASCII with its name, or `?`, and keeps ANSI sequences.
  - `statusChip` takes `glyphs` (`ascii`, `ellipsis`) in place of its `ellipsis` argument. In ASCII
    mode it prints `...` for the ellipsis, `*` and `o` for the filled and hollow circles, `-` for the
    middle dot and `?` for anything else, and truncates with `...`; `chipSeverity` still reads the
    text as sent, so a chip's colour is the same in both modes.
  - `renderFooter` folds every line of an ASCII bar the same way, so a path, branch, model or
    session name with non-ASCII text cannot reach a tty/iso/ansi/ascii terminal
    (`tests/status-bar-smoke.ts`, `asciiBarPrintsOnlyAscii`).
  - `commandArgs` takes the command argument as the string pi 1.4.0 and newer pass; the word-array
    form older pi passed is no longer accepted (`tests/cat-status-smoke.ts`, `tests/status-bar-smoke.ts`).
- 2026-11-19 repository text is filtered to one visible line.
  - The todo item text (`widgets.ts`), the branch, the project/cwd text and the session name
    (`render.ts`, in the bar and in `/footer status`) are repository-controlled and were printed as
    written, so an OSC 52 clipboard write, `ESC[2J`, a C1 CSI or a bidi override in `TODO.md` or
    `.git/HEAD` reached the terminal. Each now passes through `oneVisibleLine` from
    `shared/visible-text.ts` (a generated copy of `packages/core/shared/visible-text.ts`) before
    layout and width fitting; the theme's colour sequences are added afterwards. Fitting, priority
    and other extensions' status text are unchanged.
  - Pinned by `tests/status-bar-smoke.ts` (`hidesControlCharactersInRepositoryText`).
- 2026-11-24 narrow terminals keep a lone critical right-side chip.
  - `fitLine`'s final truncation only kept the right side when it had at least 12 columns of left
    context, and merged criticals only when there were two or more. A single priority-0 chip on
    the right (a blocked orchestrator, a failing status chip) was therefore dropped at about 37
    columns or less, against the module's never-drop-a-warning contract. With a critical segment on
    the right the left context is now cut to make room; when the warning alone is wider than the
    line the warning itself is cut rather than replaced by context. Lines without a critical
    right-side segment are unchanged.
  - Pinned by `tests/status-bar-smoke.ts` (`singleCriticalRightChipSurvivesNarrowWidths`, widths
    20 to 40).
