# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/dirty-repo-guard.ts`
- Date: 2026-06-17
- Changes:
  - Upstream uses `ctx.ui.select()` for interactive prompt; kept but with fallback to block when `!ctx.hasUI`
  - No functional changes needed for Windows (pi.exec handles cross-platform git calls)
  - `provenance.origin` set to `"vendored"`
  - Typed for strict TypeScript (no behaviour change)
