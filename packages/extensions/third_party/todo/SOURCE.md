# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/todo.ts`
- Date: 2026-06-17
- Changes:
  - Upstream stores state in session entries and uses `@earendil-works/pi-tui` + `@earendil-works/pi-ai` for the `/todos` UI widget.
  - Simplified: state is persisted in a `TODO.md` file in the project root (visible to humans, git-trackable).
  - Removed all TUI rendering and pi-ai imports.
  - The `todo` tool interface (list/add/toggle/clear) is preserved.
  - 2026-09-14: added `start`, `done`, `remove`, `add` with `items[]`, and an in-progress `[~]` state.
    Every action returns the full list with progress. `/todos` prints the list and the file path.
    The checklist widget lives in `custom-footer` (reads the same `TODO.md`).
  - 2026-10-15: typed for strict TypeScript (no behaviour change).
  - 2026-10-24: workspace state writes go through the generated `shared/safe-fs.ts`, which never follows a symbolic link under the workspace (`docs/security.md`, "Workspace file writes"; `tests/workspace-symlink-smoke.ts`).
