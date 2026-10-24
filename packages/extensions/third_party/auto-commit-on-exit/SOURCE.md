# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/auto-commit-on-exit.ts`
- Date: 2026-06-17
- Changes:
  - Upstream uses `pi.exec("git", [...])`, which is cross-platform
  - Stages with `git add -A -- . ":(exclude).pi"` instead of `git add -A`, so kit artefacts under `<cwd>/.pi/` are never committed
  - In no profile and `enabledByDefault: false`: opt-in only
  - `provenance.origin` set to `"vendored"`
  - Typed for strict TypeScript (no behaviour change)
