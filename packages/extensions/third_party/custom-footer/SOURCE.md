# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/custom-footer.ts`
- Date: 2026-06-17
- Changes:
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
  - Shows the effort tier (and a pending change), unattended state (what the firewall enforces, never
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
