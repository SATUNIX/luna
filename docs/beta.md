# Beta status

Pi System `0.2.4-beta.0` is the first public beta. It is complete enough to install and use every
day, and tested enough that we can say what has and has not been shown to work. It is not a stable
release: interfaces such as the run contract and the approvals file are versioned but may still
change in a later beta, and there are gaps in what has been verified. This page lists them
plainly.

## What "beta" means here

- Install, update, migration, profiles, effort control, delegation governance, the tool firewall
  and its approvals, the web console and the status bar are implemented, documented and covered
  by automated tests.
- Breaking changes can still happen between betas. They are listed in the changelog and in
  [Migration](migration.md).
- Only the latest release receives fixes.

## Supported environment

| | Supported | Notes |
|---|---|---|
| Node.js | 22.19 or newer | pi's own minimum; CI uses Node 22 |
| pi | 0.85.1 to 0.87.1 | The suite is pinned to 0.87.1; 0.85.1 is the floor and runs the whole suite in CI. 0.99.1 is run in CI as advisory only |
| Operating system | Linux | Every profile is also install-checked on Windows in CI; the full suite and interactive use are not. macOS has not been tested |
| Delivery | `git` | `pi install git:github.com/SATUNIX/pi-system@v0.2.4-beta.0`. The npm package is not published |

## What has been verified, and how

| Layer | What it shows | What it does not show |
|---|---|---|
| `npm run verify` | Manifests, profiles, catalogues and policy parity are consistent; extensions are self-contained; the type-check passes | Behaviour |
| Deterministic suites (`npm run check:all`) | Each feature's behaviour against fakes, including the tool firewall, approvals, delegation governance, effort ledger, profile transactions, update verification, web console security, footer rendering and the autonomous run engine | That a real provider or container behaves the same |
| Clean install with the real pi runtime (`smoke:clean-install`) | The packed release installs for every profile into an empty home, and the real pi loads all of it with no extension error | A conversation with a model |
| Real container engine (`smoke:autonomy-container`) | The autonomous runner's boundary on Docker 29 in a disposable sandbox: internal network, hardened workers, the relay and egress proxy, git plumbing, acceptance in clean containers, cleanup | Rootless Podman, a real model provider, long runs |
| Real-terminal spot checks | The status bar in a real terminal, and each candidate companion package loading in a real pi | Long sessions |
| Hosted CI | The same suite on GitHub's runners, at the pi floor, and (advisory) the newest pi | |

The counts and results for the release commit are in the release notes for `v0.2.4-beta.0`.

## What has not been verified

The detail, and who can close each item, is in [Future work](future-work.md#verification-that-was-not-possible-for-this-release).
In short:

- **No real model provider was used.** The effort prompts, the auto-mode judge, the completion
  reviewer and delegation quality are tested with deterministic fakes. Try a representative task at
  a couple of effort tiers before relying on them.
- **The autonomous runner has not made a full run against a real model provider**, and its
  container test used Docker, not the default rootless Podman. Run the boundary probe on your own
  engine and start with a small budget before an unattended run ([Autonomous runs](autonomy.md)).
- **The web console has not been run in a browser**, so the Content-Security-Policy is untested.
- **pi remote, the Android app for [remote control](remote-control.md), has been run on an
  emulator only**, not on a physical phone.
- **Windows, macOS and Node 24** are not covered beyond what is stated above.

## Known limitations

- The tool firewall is a **guard rail, not a sandbox** ([Security model](security.md)).
- Effort is a **cost and behaviour policy, not a security boundary** ([Effort](effort.md)).
- `secret-guard` is opt-in; `pi-lean-ctx` is opt-in and outside the firewall's shell
  classification ([Supply chain](supply-chain.md)).
- A profile switch restores the settings it changed; it cannot undo a package that `pi install`
  already fetched ([Future work](future-work.md#profiles-and-compaction)).
- `latest` needs a release tag. Until the first release is tagged, use `--channel next`.

## Reporting problems

Open an issue with the output of `/footer status`, `/profile status` and `/update status`, and the
steps to reproduce. For a suspected bypass of the safety boundary, follow `SECURITY.md` and report
privately.
