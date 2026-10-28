# Migration

## From the former public repository name

The public repository is now `github.com/SATUNIX/luna`. `git.previousSources` in
`packages/core/distribution.json` retains the previous public location. An existing registration
moves to the current source with `/update kit`, keeping its `latest`, `next` or pinned channel and
profile. Profile-only switches retain the existing registration; an explicit installer channel
moves it to the current source. These paths are pinned by `tests/distribution-smoke.ts` and
`tests/kit-update-smoke.ts`; `tests/distribution-contract-smoke.ts` checks the shipped metadata.
The npm package name remains `@satunix/pi-system`.

## From the private GitLab source

Before the public beta the kit was delivered from a private GitLab project
(recognised by source fingerprints, so private hostnames are not shipped).
Those are **retired sources**. They are listed in `packages/core/distribution.json` under
`git.legacySources`, and an install still registered from one is migrated to
`github.com/SATUNIX/luna`.

### How an existing install moves

An install registered from the retired source keeps running the code in **that checkout**, and that
code predates public delivery: it only knows its old remote and cannot move itself. So the move
starts from the public kit. Neither route contacts the retired host.

**Route 1: install the public kit, then run its installer (works from any install).**

```sh
pi install git:github.com/SATUNIX/luna          # follows main until the first release tag exists
node ~/.pi/agent/git/github.com/SATUNIX/luna/packages/core/install.mjs \
  --profile <your profile> --yes --settings-only --capture-overrides
```

(Once a release is tagged, `pi install git:github.com/SATUNIX/luna@v0.2.4-beta.11` pins it.) The
installer sees the retired registration and:

- **registers the public source and removes the retired one**, so the kit is not loaded twice
  (`pi list` shows what is registered), and **verifies** the result;
- keeps the **channel** the install was on (`next` stays `next`; a release or a pin becomes
  `latest`, because a private tag does not exist publicly);
- keeps your **profile**, and with `--capture-overrides` saves hand edits you made to the kit's
  settings entry (extensions or skills added or removed) into
  `<agent dir>/pi-kit/overrides.json` first, so they are applied again after the move. Overrides
  that already exist are left as they are.

**Route 2: from inside pi, once the retired checkout holds this release's code.** If you brought
this release into that checkout yourself (for example into a private mirror), `/update` recognises
the retired registration, reports it, and `/update kit` performs the same move after you confirm. It
never runs `git ls-remote` against the retired host. A local checkout whose `origin` is a retired
source is likewise never contacted or pulled: `/update status` says so and points here.

**What does not work:** running `/update` or the installer from a retired checkout that has *not*
been brought forward. That is the old code.

A `PI_SYSTEM_GIT_SOURCE` that still names a retired source (the earlier SSH instructions told you to
export one) is **ignored with a warning** by this release's code. Unset it. To use SSH with the
public repository, set `PI_SYSTEM_GIT_SOURCE=git:git@github.com:SATUNIX/luna`.

Pinned by `tests/kit-update-smoke.ts` (detection, no contact with the retired host, no pull) and
`tests/distribution-smoke.ts` (the installer's source selection, channel and hand-edit capture).
The move has been exercised against local fixtures and a stand-in `pi`, not against the real public
repository, because no release tag exists yet.

### Before the first public release is tagged

`latest` resolves to the newest `vX.Y.Z` tag on the public repository. Until the first tag exists
there is nothing for `latest` to resolve to, and the installer stops with a message saying so
instead of guessing: Route 1 above installs the unpinned source, which follows `main` (channel
`next`). Run `/update channel latest` once a release exists.

### If something is left behind

After a manual `pi install`, two copies of the kit can be registered until the installer runs; the
installer removes every kit registration except the one it is registering. `pi list` shows what is
registered. `/update status` shows the source and channel the kit follows.

## Breaking changes in 0.2.4-beta.0

- **Source**: the kit installs from `github.com/SATUNIX/luna`. Scripts that hard-coded the
  private GitLab URL need updating.
- **Node and pi**: Node.js 22.19 or newer and pi 0.85.1 or newer (the peer range moved from
  `>=0.76.0`). Older pi versions are not tested.
- **Approvals are scoped**: a remembered "allow" now applies to the exact action in the workspace,
  directory and session where you gave it, and expires. Approvals learned in one repository no
  longer run unasked in another, so some commands you had stopped being asked about will ask
  again. See [Security](security.md#approvals).
- **Approval cards time out**: an unanswered card is refused as uncertain after 15 minutes
  (`PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS`) instead of waiting forever.
- **Web console needs a token**: `/console` prints a URL containing a one-time token, and requests
  without it are refused. See [Web console](web-console.md).
- **Optional companions changed**: `pi-lean-ctx` is no longer in any profile (it is opt-in, see
  [Supply chain](supply-chain.md)), and `pi-impact-analyzer` and the unused `pi-subagents`
  reference were removed. `pi-lens` and `pi-readseek` are unchanged.
- **Removed**: the `roles/` contracts and `packages/role-runner` (they targeted a private
  platform), the GitLab pipeline and release script, and historical design and review documents.
  Git history keeps them.
- **Footer**: `/footer` now has `light`, `default` and `heavy` layouts. `/footer <anything else>`
  is rejected instead of toggling the bar.
- **Profile switching is transactional**, and an unsafe firewall configuration (an unknown mode or
  policy, an unparseable `firewall.json`, an override that removes a mandatory protection) now
  fails before anything is written instead of being silently replaced.

See `CHANGELOG.md` in the repository root for the complete list.
