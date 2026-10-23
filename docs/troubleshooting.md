# Troubleshooting

Start with `/footer status` (what is active, in detail), `/profile status` (the profile and what
it loaded), `/update status` (versions and channel) and `pi list` (what is registered).

## Install and update

**`pi` reports "No models available".** The kit does not choose a model. Run `/login`, or add an
API key or `models.json` as pi describes.

**`node packages/core/install.ts --channel latest` says there are no release tags.** `latest`
resolves to the newest `vX.Y.Z` tag on the public repository and none has been created yet. Use
`--channel next` (it follows `main`), or a branch or tag with `--git-ref`.

**"could not list release tags" or "Check network access to the repository".** The lookup did not
happen; nothing was changed. Check `git ls-remote https://github.com/SATUNIX/pi-system.git` works
from the same shell, then retry. Behind a proxy, configure git's proxy settings: pi and `/update`
use your git configuration.

**Every extension seems to load twice.** Two copies of the kit are registered (for example a
checkout and a release). `pi list` shows them. Run the installer once
(`node packages/core/install.ts --profile <name> --yes`); it keeps one registration and removes
the other.

**`/update` says a step failed.** `/update` checks the installed state after each step. The message
says what it expected and what it found (for example, the kit is still at the old commit), the run
stopped there, and pi was not reloaded. Fix the cause it names and run `/update` again. If the kit
was already replaced and only re-applying the profile failed, a second `/update` has nothing left
to do: the message says so and gives the version to go back to and the installer command that
re-applies the profile instead (`tests/kit-update-smoke.ts`). Without a terminal UI the same text
goes to standard error, prefixed `[update]`.

**The kit is "registered from a retired private source".** See [Migration](migration.md).

**Node or pi is too old.** The kit needs Node 22.19 or newer and pi 0.85.1 or newer. `node
--version` and `pi --version` show what you have.

## Profiles

**`/profile <name>` was rolled back.** A switch snapshots the settings files, runs the installer,
then judges the result by what is on disk (marker, profile, extension list, firewall settings),
not by the installer's exit code. On any mismatch it restores the snapshot and reloads the old
configuration. The message names the failing check. If restoring itself failed, the message names
the backup directory that holds the originals.

**A profile switch refuses to start.** The firewall settings are validated first: an unknown
mode or policy, an unparseable `firewall.json`, or an override that removes `tool-firewall`,
`secret-guard` or `protected-paths` stops the switch before anything is written. Fix the file the
message names.

## Context and compaction

**`/compaction status` says compaction is off.** pi's automatic compaction is a setting
(`compaction.enabled` in `settings.json`), and turning it off also turns off recovery from a full
context window. A run that fills the window then ends with a message that says so and how to
recover (`/compaction on`, or `/compress`). Sub-agents read the same settings.

**A run ended right after a compaction message.** Use a recent kit: `trigger-compact` no longer
compacts in the middle of a run, and it stands down when pi's own trigger is earlier.

## Approvals and the firewall

Every refusal carries exactly one label:

| Label | Meaning | What to do |
|---|---|---|
| `[HARD DENY]` | Policy forbids it. No approval or judge can override it. | Choose another way, or change the policy deliberately. |
| `[UNCERTAIN ...]` | The judge was unsure, the card timed out, or the console was unusable. Nothing ran. | Ask again and answer the card. |
| `[OPERATOR DECISION: denied]` | You (or a remembered decision) said no. | Nothing to fix. |
| `[AUTO-MODE BLOCK]` | Auto mode's judge blocked it with high confidence. | Review the reason; switch mode only if you disagree. |

`/firewall list` shows remembered approvals with their scope (action, workspace, directory,
session) and expiry, and `/firewall revoke <id>` removes one. A malformed approvals file is
ignored (never treated as an allow) and reported by `/firewall list` and on standard error; the
rejected file is kept next to it as `.rejected-<hash>`.

## Delegation

**"delegation refused".** The message names the reason. The common ones: the tier allows no
children (`/effort` to raise it), the request's budget is used up (children that failed or were
retried still count), or a required protection could not be located next to the kit. A child is
never started with weaker protection than its parent.

**A child exited with code 78 (EX_CONFIG).** Inside the child, `delegation-guard` found that a
required protection did not load, so it blocked every tool and exited. Reinstall the kit; this is
a broken installation, not a task failure.

## Status bar

**The bar is garbled or has odd symbols.** `/footer ascii on` uses plain characters;
`/footer light` shows less. The bar is fitted to the terminal width and drops lower-priority
segments as it narrows; `/footer status` prints everything it dropped.

## Web console

**401 or 403.** The console needs its token and a matching `Host`. Open the URL `/console` prints
(it has `#token=...` at the end); do not paste the token in a query string. See
[Web console](web-console.md).

## Unattended runs

**Unattended mode is not active.** Every condition has to hold at load time, and any failure
means the normal rules apply, with a warning on standard error and in `/firewall status`. See
[Autonomous runs](autonomy.md).
