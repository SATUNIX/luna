# branch-lab

Worktree and branch manager for isolated pi sessions. Provides tools to create, list, switch, discard, and merge git branches so risky or experimental tasks run in isolation from the main working tree.

Leases are stored in `PI_KIT_BRANCH_LEASES_FILE` or `.pi/branch-leases.json`. `PI_KIT_MAX_BRANCHES` overrides the maximum number of concurrent branches. Worktrees are created under a per-user directory in the system temp directory, `pi-kit-<uid>/pi-branch-lab/<repo key>/<taskId>`; `pi-kit-<uid>` is created with mode 0700, and one that is a symbolic link, not a directory or owned by another user is refused (`tests/branch-lab-smoke.ts`), where the repo key is the first 12 hex characters of the SHA-256 of `git rev-parse --show-toplevel`, so two repositories can lease the same `taskId` (`tests/branch-lab-smoke.ts`). At session start, leases whose worktree directory no longer exists (for example after a reboot clears the temp directory) are dropped from the lease file; their `pi/<taskId>` branches are kept (`tests/branch-lab-smoke.ts`).

Tools:

- `branch_create({ taskId, baseBranch? })`
- `branch_list({})`
- `branch_switch({ taskId })`
- `branch_discard({ taskId, force? })`
- `branch_merge({ taskId, strategy? })`

`branch_discard` refuses when the worktree has uncommitted changes or the branch has commits
that `HEAD` does not contain, unless `force: true` is passed; a discard removes the worktree
and deletes the `pi/<taskId>` branch. The shipped firewall policy pins `branch_discard` to
`ask`, so every discard, forced or not, needs operator approval. `branch_merge` accepts only
the `ort`, `recursive`, `resolve`, `ours`, or `subtree` strategy and rejects any other value
before git runs (`tests/branch-lab-smoke.ts`).

`taskId` accepts 1-80 letters, numbers, dots, underscores, or dashes. `baseBranch`
accepts a real git ref or commit (for example `origin/main`, `feature/my-branch`,
`release/1.2`, or a 40-char SHA): it may contain `/` and `.` inside components, but
must be at most 200 characters, may not start with `-`, contain whitespace or any of
`~ ^ : ? * [ \`, contain `..` or `//`, end with `/`, `.`, or `.lock`, or use a path
component that starts or ends with `.`.
