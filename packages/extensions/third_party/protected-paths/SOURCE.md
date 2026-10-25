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
  - pi's autoload locations in the agent directory (extensions/, skills/, prompts/, themes/, npm/, git/,
    SYSTEM.md, APPEND_SYSTEM.md, the global context files, settings.json, models.json, auth.json,
    trust.json, .pi-kit.json), `~/.agents/skills`, the remote host's state directory
    (`PI_REMOTE_STATE_DIR`, else `<agent dir>/remote-control`) and the project's `.pi/.pi-kit.json` are
    protected under both policies (`tests/protected-paths-corpus-smoke.ts`)
  - bash write targets expand `~`, `$HOME` and `$PI_CODING_AGENT_DIR`; a target built at runtime whose
    literal tail names a protected entry is blocked; literal Node/Python/Ruby writers, copy and rename
    destinations and `ln -s` link targets are write targets (`tests/protected-paths-corpus-smoke.ts`)
  - bash write targets also include Perl `open` targets, the source of a hard link (`ln`) and of
    `cp -l`/`cp -s`, a `git clone` destination, the repository a working-tree git command names with
    `-C` or reaches by `cd`, `tar -x -C`, `unzip -d`, `7z -o` and `rsync` destinations, and a
    relative target after `cd <dir>` (`tests/protected-paths-corpus-smoke.ts`)
  - when a bash command runs inline interpreter code with a write-capable call, every path the program
    names is a write target: an absolute or `~` literal (including one wrapped in `expanduser`), and the
    literal parts of a path composed at runtime (`Path.home()/"…"`, a join call with a runtime argument,
    `homedir() + "/…"`, an interpolated string, a literal after `chdir`) under the home directory, `~/.pi`
    and the agent directories (`tests/protected-paths-corpus-smoke.ts`)
  - a bash command that runs an interpreter on inline code, mentions an agent-configuration segment and
    has any write- or exec-capable call is blocked whatever path it builds, by the shared fail-closed rule
    in `shared/inline-guard.ts` (a generated copy of `packages/core/shared/inline-guard.ts`, also used by
    tool-firewall; `tests/protected-paths-corpus-smoke.ts`)
