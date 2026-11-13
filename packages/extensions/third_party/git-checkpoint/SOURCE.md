# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/git-checkpoint.ts`
- Date: 2026-06-17
- Changes:
  - **Vendored upstream (2026-06-17):** initial import of the upstream example; the changes below are Luna's.
  - **Rewritten (2026-11-13):** the upstream `git stash create` per turn (tracked files only, held in memory) is replaced by a working-tree snapshot built in a private index and stored as a commit under `refs/luna/checkpoints/<session>/<n>`, so the branch, index and stash are never touched. Credential paths (the secret-guard signatures) and `.pi/` are left out; a turn that finds the tree unchanged adds nothing; the set is bounded (`PI_KIT_CHECKPOINT_MAX`, default 20) and another session's refs expire after 14 days (the current session's never do). The snapshot is always of the whole repository, taken from its top directory, so a launch from a subdirectory cannot restore committed work outside it. Adds `/checkpoints` and `/undo` (diff first, the replaced state kept at `refs/luna/undone/<session>`); `/fork` restores through the same path. Uses `execFile` with an argument array (an environment is needed for the private index, which `pi.exec` cannot pass). Upstream's `session_before_fork` prompt is kept.
  - `provenance.origin` set to `"vendored"`
