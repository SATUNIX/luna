# Profiles

Luna ships as one package. A **profile** chooses which of its
extensions pi loads and which of its skills and prompt templates are listed. Switching profile
changes pi's settings, not what is installed, so it takes effect immediately and is reversible.

## The profiles

The generated [capability matrix](capability-matrix.md) has the exact extension list and count
for each profile.

| Profile | Use when | Needs |
| --- | --- | --- |
| `balanced` | Daily coding (the default) | Node, pi |
| `long-horizon` | Longer planning and checkpoint workflows, and set-and-walk-away operation once you have validated the session | Node, pi, live-session validation first for unattended runs |
| `engagement` | A security engagement, with the Conductor root orchestrator | Node, pi |
| `self-improving` | Every extension and supporting service | Node, pi, Docker for the memory services (experimental) |
| `lite` | Quick tasks, small local models and low-context sessions: the leanest set | Node, pi |

The `engagement` and `self-improving` profiles pin `/engagement` (start, status, phase) in the command menu;
see [Engagement commands](security.md#engagement-commands) for how it differs from `/engagement:status`.

Only profiles whose definition says `"memento": true` (`long-horizon`) let a model be opted in to Memento mode. Outside them, the
allowance is 0 and `/effort memento on` is refused ([Effort](effort.md#memento-mode),
`tests/memento-optin-smoke.ts`).

## Switching

Inside pi:

```text
/profile              pick from a list (shows what each would add or remove)
/profile lite         switch directly
/profile status       what is loaded, and how it differs from the closest profile
```

From a shell:

```sh
# A release install: run the installer of pi's own copy of Luna
node ~/.pi/agent/git/github.com/SATUNIX/luna/packages/core/install.mjs --profile lite --yes --settings-only
# A checkout registered in place
node packages/core/install.ts --profile lite --yes
```

Hand edits survive profile switches: the first switch after you edit your settings offers to save
them to `~/.pi/agent/pi-kit/overrides.json`, which is applied on top of every profile. An override
that removes `tool-firewall`, `secret-guard` or `protected-paths` stops the switch; one that removes
another extension every profile requires (`delegation-guard`, `effort`, `session-helpers`) is
ignored with a warning (`tests/profile-safety-smoke.ts`).

Those three are the mandatory protections. Every shipped profile loads `tool-firewall` and
`protected-paths`; `secret-guard` loads in `balanced` and `long-horizon`, and each other profile
records why it goes without it in `packages/core/lib/protection-coverage.ts`. `npm run profile:check`
fails a profile that drops a mandatory protection without a recorded exemption
(`tests/profile-protections-smoke.ts`).

## The lite profile

`lite` is for small local coding models. It loads:

- safety guardrails (`tool-firewall`, `protected-paths`), git checkpoints and todo
- the verification gate and verifier board, context sieve and progress guard
- the GitOps status bar (`custom-footer`) and session helpers
- `compress`, `save`, `trace-ledger`, `caveman` (terser conversational output)
- `goal-core` (`/goal` and the unattended ceiling). Lite registers no subagent, workflow or
  orchestrator: they cost about 3,100 characters of tool text in every request and a small model
  rarely delegates, so they belong to the larger profiles
- `pi-readseek`, a companion package for cheap hash-anchored read/edit/grep and code maps
- `skill-router`, so the model can reach the allowlisted skills that are hidden from the system
  prompt (`disable-model-invocation`) through `skill_search` and trigger hints

It carries its own compaction settings (`reserveTokens` 4096, `keepRecentTokens` 6000, the profile's
`settings` block) in place of pi's 16384-token default reserve, which would compact almost every turn on
a 32k window; `tests/eval-footprint-smoke.ts` pins the values and that a bad value is rejected.

It lists only the small-model skills (see the [skills catalogue](skills-catalogue.md#lite-profile-subset))
and the four `code-*` prompt templates. These allowlists are the profile's `skills.only` and
`prompts.only` fields in `packages/kit/profiles/lite.json`. Lite loads no memory extension, so it
does not list the `memory` skill.

Every kit prompt template takes an optional argument: `/code-plan add retry to fetchUser` puts
the text after the command into the prompt, and `/code-plan` alone falls back to a default such
as "the current task".
A profile that lists hidden skills must load `skill-router`, and a prompt shown outside `engagement`
calls the `pi_system_governance` MCP tools only when that server is available
(`tests/prompt-arguments-smoke.ts`).

## Companion packages

Some profiles use npm packages that are not part of Luna (`pi-lens`, `pi-readseek`). The
installer registers them as their own pi packages, at the exact version Luna has reviewed
(`packages/core/sources.json`). `/update` moves them when a Luna release changes a pin.
`pi-lean-ctx` is in no profile: it is opt-in, registered by `install.ts --all` only when its
`lean-ctx` binary is on `PATH`, and its extra shell and edit tools sit outside the firewall's shell
and secret classification (see [Supply chain](supply-chain.md)).

`auto-commit-on-exit` is also in no profile, off by default (`enabledByDefault: false`) and marked
`experimental`: it runs `git add` and `git commit` on session shutdown outside the firewall, so it
commits only when an operator adds it, by listing it under `extensions.add` in
`<agent dir>/pi-kit/overrides.json` (which keeps the rest of the profile) or in a profile's
`include`. When it runs it stages the
working tree with `<cwd>/.pi/` excluded, so save snapshots, compaction copies and audit logs stay
out of git history (`tests/shutdown-hook-gating-smoke.ts`); credential-looking paths (the secret-guard
signatures) are excluded from the staged set too (`tests/shutdown-hook-gating-smoke.ts`).

`git-checkpoint` is how a session is made undoable without committing anything. When a turn starts and
the working tree has changed, it records a snapshot as a commit under
`refs/luna/checkpoints/<session>/<n>`, built in a private index: your branch, index and `git stash list` are
not touched, credential-looking paths and `.pi/` are never copied into it, and ignored files are not
included. A checkpoint always covers the whole repository, even when pi is launched from a subdirectory. `/checkpoints` lists them; `/undo [n]` shows the files it would delete, restore or recreate,
and on a yes puts the working tree back (the state it replaced is kept at `refs/luna/undone/<session>`).
`/fork` restores through the same path. The newest 20 are kept per session (`PI_KIT_CHECKPOINT_MAX`) and
other sessions' refs are dropped after 14 days (this session's own never are). Not covered: changes outside the repository, a restore
of a credential file (it is never snapshotted, so an agent's edit to one cannot be undone), and a
repository whose `git` cannot run (no checkpoint is taken and nothing is reported)
(`tests/git-checkpoint-smoke.ts`).

## Profile file format

Profiles live in `packages/kit/profiles/<name>.json`:

| Field | Meaning |
| --- | --- |
| `include` | Extensions to load: kit extensions by name, plus companion packages from `sources.json` |
| `skills.excludeCategories` / `skills.exclude` | Kit skills to hide, by category or name |
| `skills.only` / `prompts.only` | Allowlists: hide every kit skill or prompt not listed |
| `prompts.exclude` | Prompt templates to hide |
| `firewall` | Tool-firewall default `mode` (`manual`/`auto`) and `policy` (`coding`/`engagement`) |
| `securityLevel` | The [security level](security-level.md) the profile installs: `guarded` for `engagement`, `balanced` for the rest |
| `settings` | pi settings the profile installs. `compaction` (`enabled`, `reserveTokens`, `keepRecentTokens`, each a positive integer) is the one block read today; `lite` sets `reserveTokens` 4096 and `keepRecentTokens` 6000 so a 32k window is not compacted every turn (`tests/eval-footprint-smoke.ts`) |
| `experimental` | Allows experimental extensions in the profile |
| `memento` | `true` lets a model be opted in to Memento mode under this profile |
| `pinnedCommands` | Slash commands the control-center command menu pins because the profile is defined by them |

`npm run verify` cross-checks every extension's `profiles` field against these files.
