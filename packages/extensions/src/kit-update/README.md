# kit-update

Tells you when something in your pi setup can be updated, and `/update` applies it.

It checks three things:

- **pi-system**: the kit, on the channel it is registered on. The channels are the same however
  the kit is delivered:
  - `latest`: the newest release (a stable release once one exists, otherwise the newest beta).
  - `next`: every commit on `main`.
  - an exact version such as `0.2.1-beta.0`: a pin, never moved on its own.

  With **git delivery** (the current setting, `packages/core/distribution.json`), a release is a
  `vX.Y.Z` tag of the kit's repository, checked with `git ls-remote` using your own git
  credentials, and `next` is the repository's `main` branch. With **npm delivery**, the
  channels are dist-tags of `@satunix/pi-system`. A local checkout is checked against its
  upstream branch.
- **pi** itself (`@earendil-works/pi-coding-agent`, from the npm registry).
- **Linked packages**: the other npm packages in your pi settings. A companion that the kit pins
  (`packages/core/sources.json`) is moved to the kit's reviewed pin when the kit changes it.
  Unpinned packages move to their latest release. Other pinned packages are listed but not moved.

## Commands

| Command | What it does |
|---|---|
| `/update` | Check now, then pick what to update from a list |
| `/update status` | Show installed and available versions |
| `/update all` | Update the kit, linked packages and pi, re-apply the profile, reload |
| `/update kit` / `pi` / `packages` | Update one part |
| `/update channel latest\|next\|X.Y.Z` | Switch the kit's channel, or pin a release. From a checkout, this installs the released kit instead |

Updates go through pi's own package manager (`pi update`, `pi install`). A new release on
`latest` re-points the kit's registration to the new tag; `next` is pulled. After the kit or a
companion changes, the recorded profile is re-applied with the kit's installer
(`--settings-only`), so extensions a new release adds to your profile load. A pi update needs a
restart of pi; everything else reloads in place. For a local checkout, `/update kit` runs
`git pull --ff-only`.

pi is updated only up to the version the kit's `package.json` pins for its test suite. A newer pi
is reported, not offered, because `pi update --self` always installs the newest pi (see
[Updates](../../../../docs/updates.md); `tests/kit-update-smoke.ts`).

If a kit release changes its delivery (for example from git to npm), `/update kit` moves the
install to the new delivery, keeping its channel and profile.

## Background check

At session start, at most once a day, the check runs in the background (a 5 second timeout per
registry lookup, 20 seconds for git; it never delays startup, and git is never allowed to prompt
for credentials). When something can be updated you get one notice, and the status bar shows
`updates: /update` until you update.

| Variable | Effect |
|---|---|
| `PI_KIT_UPDATE_CHECK=0` | Turn off the background check (`/update` still works) |
| `PI_KIT_UPDATE_CHECK_HOURS` | Hours between background checks (default 24) |
| `PI_KIT_DELIVERY` | `git` or `npm`: override the kit's delivery on this machine |
| `PI_SYSTEM_GIT_SOURCE` | Git source of the kit, e.g. `git:git@github.com:SATUNIX/luna` for SSH; a value that names a retired private source is ignored and reported |
| `PI_KIT_NPM_REGISTRY` | Registry to query (default `https://registry.npmjs.org`) |
| `PI_OFFLINE` | pi's offline switch: no background check |

State: `~/.pi/agent/pi-kit/update-check.json` (time of the last check, and its result).
