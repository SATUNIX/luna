# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/protected-paths.ts`
- Date: 2026-06-17
- Changes:
  - Changed from hardcoded array to env-var `PI_KIT_PROTECTED_PATHS` (colon-separated on Unix, semicolon on Windows)
  - Added `path.normalize` for Windows path comparison
  - Added `node:path` import (not needed upstream since it used string includes)
  - `provenance.origin` set to `"vendored"` in extension.json
  - Typed for strict TypeScript (no behaviour change)
  - A `write`/`edit` `path`, or a `bash` `command`/`cmd`/`script`, that is present (not null) but not a
    string is blocked with a reason naming the field instead of throwing (`tests/untrusted-input-guards-smoke.ts`)
  - Under both policies, git's `hooks/`, `config` and `info/` in the repository's git common directory
    are protected (for a linked worktree that is the main checkout's `.git`), and in a linked worktree the
    main checkout's own protected entries are protected too (`tests/workflow-worktree-smoke.ts`)
  - `<agent dir>/pi-kit/autonomy.json` (the per-model Memento opt-ins `/effort memento on` writes) is
    protected under both policies, so the agent cannot opt a model in itself (`tests/protected-paths-smoke.ts`)
