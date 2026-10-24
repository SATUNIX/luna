# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/handoff.ts`
- Date: 2026-06-17
- Changes:
  - Upstream generates a handoff prompt via a live model call (`complete()` from @earendil-works/pi-ai).
  - Simplified: `/handoff <note>` appends a timestamped entry to HANDOFF.md (no model call).
  - The LM-powered version (session summary + prompt generation) is TODO in a future extension revision.
  - Removed @earendil-works/pi-agent-core and @earendil-works/pi-ai imports.
  - Create notes exclusively and append through an open descriptor to avoid path-check races.
    New notes use mode 0600. Native no-follow rejects final-component symlinks on supporting
    platforms; Windows does not provide that native protection. Regression coverage:
    `smoke:handoff`.
  - Typed for strict TypeScript (no behaviour change).
