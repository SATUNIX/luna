# Helpers

Scripted install/setup/configure/update tooling for `pi-system`, as a
thin wrapper around the commands documented in
[`docs/INSTALL.md`](../../../docs/INSTALL.md), [`docs/profiles.md`](../../../docs/profiles.md),
and [`docs/updates.md`](../../../docs/updates.md). These scripts do not replace that
documentation — read it first if you want to understand what a command
actually does; use these scripts to run it.

Two equivalent scripts, one per shell:

| Script | Shell |
|---|---|
| `pi-kit-helper.sh` | bash (Linux, macOS, WSL, Git Bash) |
| `pi-kit-helper.ps1` | PowerShell (Windows, or PowerShell 7+ on any OS) |

Both expose the same five commands and behave the same way.

## Usage

```sh
# bash
packages/core/helpers/pi-kit-helper.sh [command]
```

```powershell
# PowerShell
packages\core\helpers\pi-kit-helper.ps1 [-Command <name>]
```

Run with no command/argument for an interactive menu.

## Commands

| Command | What it does |
|---|---|
| `status` | Checks for `node`, `git`, and `pi` on `PATH`; reports the repo's branch and uncommitted-file count; reports whether pi's global settings exist. |
| `install` | Interactively installs this checkout with a chosen profile (including `lite`) and scope. It always previews with `--dry-run` first and asks for confirmation before applying. |
| `configure` | Scaffolds `~/.pi/agent/.env` from `.env.example` if it does not already exist, and optionally appends a `PI_KIT_FIREWALL_POLICY` override. Never overwrites an existing `.env`. |
| `update-kit` | Refuses to run if the working tree has uncommitted changes (asks you to commit or stash first). Otherwise runs `git pull`, then reinstalls with `node packages/core/install.ts --profile <chosen> --yes`. For a release install (git tag or `main`), use `/update` inside pi instead. |
| `update-pi` | Installs the pi version the kit is tested against (the exact `@earendil-works/pi-coding-agent` pin in the kit's `package.json` `devDependencies`), with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<version>`, and prints the resulting version. It refuses when the pin is not an exact version, and never installs `latest` (`tests/helper-smoke.ts`). |

## What these scripts intentionally do not do

- They never run `git pull`, `install.ts`, or `uninstall.ts` with force flags,
  and never touch an existing `.env`.
- `update-kit` will not proceed over a dirty working tree — this matches the
  rest of the repo's convention of never silently discarding uncommitted work.
- They do not replace `npm run verify` / `npm run test:security` — run those
  yourself after any change to `kit/` or `extensions/`, per
  [`CLAUDE.md`](../../../CLAUDE.md)'s repo conventions.
- They do not manage the `pi-system` container deployment —
  that lives in the sibling repo; see its own docs.

## Uninstalling

Not wrapped here — run directly, since it is a one-time/rare operation:

```sh
node packages/core/uninstall.ts --scope global --dry-run   # preview
node packages/core/uninstall.ts --scope global --yes       # apply
```
