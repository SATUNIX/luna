# Installation

> Already installed and looking to update instead? See [Updates](updates.md). A first install is
> covered in [Getting started](getting-started.md); this page is the reference.

pi-system is one pi package. A **profile** chooses which of its extensions, skills and prompts
load; there are no separate packages per profile. It is delivered from its public git repository,
`github.com/SATUNIX/pi-system` (set in `packages/core/distribution.json`). This is a beta; see
[Beta status](beta.md).

## Requirements

- Node.js 22.19 or newer and npm (pi's own requirement)
- git
- pi 0.85.1 or newer (`npm install -g @earendil-works/pi-coding-agent`)

## The one install path

```sh
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/SATUNIX/pi-system@v0.2.4-beta.5
pi
```

pi clones the release into `~/.pi/agent/git/github.com/SATUNIX/pi-system`. On the first
interactive start the kit applies the `balanced` profile and asks for a `/reload`. Set
`PI_KIT_AUTO_PROFILE=<name>` to pick another profile, or `0` to leave the package unfiltered.

The repository is public, so no credentials are involved. pi runs `npm install --omit=dev` in
its copy of the kit, as it does for every git package; the kit has no runtime dependencies of
its own, so that step fetches nothing from the npm registry.

## The scripted installer

Use the installer when you want a specific profile chosen up front, a non-interactive install, or
project scope. It wraps `pi install` and pi's settings, and is idempotent:

```sh
git clone https://github.com/SATUNIX/pi-system.git
cd pi-system
node packages/core/install.ts --channel latest --profile balanced
```

Run it from the clone root: the installer path is relative to the current directory.

| Flag | Meaning |
|---|---|
| `--profile <name>` | One of the profiles in [Profiles](profiles.md). |
| `--channel latest\|next\|X.Y.Z` | Which release line to register (below). Implies git delivery. |
| `--git-ref <ref>` | Register an arbitrary branch, tag or commit (git delivery only). |
| `--mode local\|git\|npm` | `local` registers this checkout in place; `git` and `npm` register a released kit. |
| `--scope global\|project` | Global settings (default) or `.pi/settings.json` in the current repository. |
| `--only a,b` / `--all` | Specific extensions only, or everything. `--only` always adds the required base (`requiredProfileExtensions` in `packages/core/distribution.json`: `tool-firewall`, `protected-paths`, `delegation-guard`, `effort`, `session-helpers`) and warns about each one it adds (`tests/install-marker-smoke.ts`). |
| `--yes` | Accepted for scripts; the installer never prompts. |
| `--dry-run` | Print what would change; change nothing. |
| `--no-externals` | Skip companion packages such as `pi-lens`. |
| `--uninstall` | Remove the kit and the companions this installer registered. A companion you had already registered at the kit's pin before installing is not recorded, so uninstall leaves it (`tests/install-marker-smoke.ts`). |

An unknown flag, or a value flag such as `--profile` with no value, stops the installer with exit
code 1 and a usage line before anything changes (`tests/install-marker-smoke.ts`).

The installer keeps **exactly one** registered copy of the kit: registering a checkout replaces
a release install and the other way round, because two copies would load every extension twice.

`--scope project` writes only the project's `.pi/settings.json` and `.pi/.pi-kit.json`. The firewall
gate files, `<agent dir>/pi-kit/firewall.json` and `<agent dir>/pi-kit/security.json`, are
machine-global, so a project-scope install (and a `/profile` switch in a project install) leaves
them byte-identical. When the profile asks for a different firewall mode, policy or securityLevel
than those files hold, the installer prints a `WARN` naming the global file and the
`install.ts --scope global --profile <name>` run that applies it to every session
(`tests/install-marker-smoke.ts`, `tests/profile-transaction-smoke.ts`).

## Channels

| Channel | Install | Gets |
|---|---|---|
| `latest` (default) | `node packages/core/install.ts --channel latest --profile balanced` | The newest release tag (betas count until the first stable release exists) |
| `next` | `node packages/core/install.ts --channel next --profile balanced` | Every commit on `main` |
| pinned | `node packages/core/install.ts --channel <version> --profile balanced` | Exactly that release (tag `v<version>`) |

`latest` needs at least one `vX.Y.Z` tag on the repository. Until the first release is tagged the
installer stops with a message saying there are no release tags and suggests `--channel next`;
it never guesses. `/update channel <name>` switches later. See [Updates](updates.md#channels).

## Profiles

Exact per-profile extension lists and counts are generated in the
[capability matrix](capability-matrix.md) (do not hand-count them; they drift). Requirements:

| Profile | Requirements |
| --- | --- |
| `quick`, `balanced`, `long-horizon`, `lite` | Node, git, pi |
| `autonomous` | Node, git, pi. Unattended runs additionally need a container engine ([Autonomous runs](autonomy.md)) |
| `pentest` | Node, git, pi. Container deployment: `packages/container/README.md` |
| `self-improving` | Node, git, pi, Docker for memory services, optionally a second model (experimental) |

```sh
node packages/core/install.ts --channel latest --profile lite            # small local models
node packages/core/install.ts --channel latest --profile balanced --scope project
```

Inside pi, `/profile` switches profile in place and verifies the result. See [Profiles](profiles.md).

## Install modes

| Mode | Command | When |
| --- | --- | --- |
| Release from pi | `pi install git:github.com/SATUNIX/pi-system@vX.Y.Z` | Normal use; the profile is applied on first start |
| Release from the installer | `node packages/core/install.ts --channel <latest\|next\|X.Y.Z> --profile <name>` | You want the profile chosen up front or a scripted install |
| Local checkout (editable) | `node packages/core/install.ts --profile <name> --yes` | Developing the kit: pi loads the checkout in place, edit and `/reload` |
| Project auto-install | Ship `.pi/settings.json` in a repository | pi auto-installs on first trusted start |
| npm (not published yet) | `npx @satunix/pi-system --profile <name>` | Only once npm delivery is switched on ([Releasing](releasing.md#npm-publication-optional)) |

### From a checkout

```sh
git clone https://github.com/SATUNIX/pi-system.git && cd pi-system
npm ci --ignore-scripts
node packages/core/install.ts --profile balanced --yes

# Specific extensions only (the required base is added to them)
node packages/core/install.ts --only memory-local,verify-gate --yes
```

## Coming from the private GitLab source

Installs made from the earlier private GitLab source move by installing the public kit and running
its installer, which keeps your profile and hand edits and never contacts the old host; see
[Migration](migration.md).

## After install

1. Run `pi`.
2. `/reload` applies extension changes without restarting.
3. `pi list` shows the registered packages; `/kit` and `/footer status` show what is active.

## Web console

The optional web console is covered in [Web console](web-console.md): it is token-authenticated
and bound to loopback by default.

## Uninstall

```sh
# Removes the kit and the companions the installer registered (from the clone root):
node packages/core/install.ts --uninstall
```

The command auto-detects the install state marker: a project marker at
`<current dir>/.pi/.pi-kit.json` wins if it exists, otherwise the global marker at
`~/.pi/agent/.pi-kit.json` is used. Pass `--scope project` or `--scope global` to force one. After
a project-scope install, run it from the repository root so the project marker is found and
`pi remove ... -l` runs with the matching scope. A project uninstall deletes only the project
marker; the global marker is left untouched.

The same precedence is used by the runtime readers that resolve install state (`/update`,
`/profile`, `/console`).

## Memory backends (`self-improving` profile — experimental)

The kit ships a Qdrant vector store for the memory MCP backend:

```sh
# Start the Qdrant vector store (memory-mcp backend)
docker compose -f packages/container/mcp-servers/memory-mcp/docker-compose.yml up -d
```

`memory-mem0` (an **experimental** extension in the `self-improving` profile) additionally
needs an external mem0 REST server, which this repo does not ship. Point it at your own mem0
instance:

```sh
# Set env var (add to ~/.pi/agent/.env) — only if you run your own mem0 server
MEM0_API_URL=http://localhost:8000
```

## Environment variables

| Var | Extension | Default | Purpose |
| --- | --- | --- | --- |
| `PI_KIT_GUIDELINES_FILE` | guidelines | `GUIDELINES.md` | Path to guidelines file |
| `PI_KIT_TODO_FILE` | todo | `TODO.md` | Path to todo file |
| `PI_KIT_PROTECTED_PATHS` | protected-paths | — | Semicolon-separated protected paths (denylist) |
| `PI_KIT_WRITE_ALLOWLIST` | protected-paths | — | Semicolon-separated allowlist; blocks writes outside it (dream/print mode) |
| `PI_KIT_FIREWALL_POLICY` | tool-firewall | shipped default-deny policy | Path to a custom firewall policy JSON |
| `PI_KIT_FIREWALL_APPROVALS` | tool-firewall | `<agent dir>/pi-kit/firewall-approvals.json` | Where remembered approvals are stored ([Security](security.md)) |
| `PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS` | tool-firewall | `900000` | How long an approval card waits before the call is refused as uncertain |
| `PI_KIT_EFFORT_CONFIG` | effort | `<agent dir>/pi-kit/effort.json` | Saved effort default and limit overrides ([Effort](effort.md)) |
| `PI_KIT_AUTO_PROFILE` | session-helpers | `balanced` | Profile applied on the first interactive start; `0` disables |
| `PI_KIT_UPDATE_CHECK` | kit-update | on | `0` turns the background update check off ([Updates](updates.md#settings)) |
| `PI_KIT_MEMORY_DIR` | memory-local | `~/.pi/agent/memory-local` | Memory store directory |
| `PI_KIT_COMPACT_THRESHOLD_TOKENS` | trigger-compact | `100000` | Token count that triggers auto-compaction; locks out `/compact-threshold` when set. Without it, `/compact-threshold <amount>` (e.g. `500k`) persists to `~/.pi/agent/pi-kit/trigger-compact.json` |
| `PI_KIT_VERIFY_ON_TURN` | verify-gate | `0` | Set to `1` to run the check command after successful write/edit tools when the assistant finishes its tool sequence; projects without a verify script are skipped |
| `PI_KIT_VERIFY_CMD` | verify-gate | unset | Check command for `/verify`; overrides `scripts.verify` |
| `PI_KIT_VERIFY_REVIEW` | verify-gate | on | `0` turns off the independent completion reviewer in `/verify` and `verify_completion` |
| `PI_KIT_VERIFY_REVIEW_MODEL` | verify-gate | current model | Reviewer model as `provider/id` |
| `PI_KIT_VERIFY_REVIEW_TIMEOUT_MS` | verify-gate | `900000` | Reviewer timeout |
| `MEM0_API_URL` | memory-mem0 | — | mem0 REST service URL |
| `MEM0_API_KEY` | memory-mem0 | — | mem0 API key (if auth enabled) |
| `MEM0_USER_ID` | memory-mem0 | `pi-agent` | mem0 user/agent ID |
| `DUAL_REVIEW_MODEL` | dual-review | — | Second model name for reviewer agent |
| `PI_KIT_TASK_GRAPH_LEASE_MS` | task-graph | `3600000` | How long a `task_next` claim lasts without a `task_update`; an older claim returns to pending. `0` disables expiry |
| `PI_KIT_COST_INPUT_PER_MTOK` | custom-footer | — | Override input-token dollars per million tokens |
| `PI_KIT_COST_OUTPUT_PER_MTOK` | custom-footer | — | Override output-token dollars per million tokens |
| `PI_KIT_COST_CACHE_READ_PER_MTOK` | custom-footer | — | Optional cache-read dollars per million tokens |
| `PI_KIT_COST_CACHE_WRITE_PER_MTOK` | custom-footer | — | Optional cache-write dollars per million tokens |
| `PI_KIT_TIPS` | custom-footer | on | `0` hides usage tips on the working line |
| `PI_KIT_TODO_WIDGET` | custom-footer | on | `0` hides the todo checklist widget |

See `status-bar-and-costs.md` for `.pi-kit/costs.json`, fallback user config, and `/footer` commands.
