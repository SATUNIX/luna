# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/plan-mode/index.ts` + `utils.ts`
- Date: 2026-06-17
- Changes:
  - Upstream uses `@earendil-works/pi-tui` for widget rendering (Key, progress widget) and `@earendil-works/pi-ai`/`@earendil-works/pi-agent-core` for message parsing.
  - Simplified to single index.ts with no external deps.
  - Core functionality preserved: `/plan` toggle, read-only tool restriction via `before_agent_start`, `--plan` flag.
  - Dropped: progress widget, [DONE:n] step markers, plan step extraction from messages (requires pi-ai parsing).
  - TODO: restore plan-step extraction and TUI progress widget in future revision.
  - 2026-09-24: the plan-mode notice is written as a context-sieve contribution under
    `.pi/ctx-contributions/sessions/<session-id>/plan-mode.json` (flat directory when pi exposes no
    session id), matching the other producers (B-005).
  - 2026-10-15: typed for strict TypeScript (no behaviour change).
