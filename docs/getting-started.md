# Getting started

pi-system is one pi package. You install it once, then a **profile** chooses which of its
extensions load. It is delivered from its public git repository, `github.com/SATUNIX/pi-system`:
releases are `vX.Y.Z` tags and the `next` channel follows `main`.

This is a **beta**. See [Beta status](beta.md) for what that means.

## 1. Requirements

- Node.js **22.19 or newer** (pi's own requirement) and npm
- git
- pi itself:

```sh
npm install -g @earendil-works/pi-coding-agent
```

The kit supports pi **0.85.1 and newer**; the version it is tested against is pinned in
`package.json` (currently 1.3.0). See [Supply chain](supply-chain.md#pi-versions).

## 2. Install the kit

```sh
pi install git:github.com/SATUNIX/pi-system@v0.2.4-beta.5
```

pi clones the release into `~/.pi/agent/git/github.com/SATUNIX/pi-system` and runs
`npm install --omit=dev` there, as it does for every git package. The kit has no runtime npm
dependencies of its own, so this reads nothing beyond git.

To follow `main` instead of a release, leave the tag off:
`pi install git:github.com/SATUNIX/pi-system`. Switching channels later is
`/update channel latest|next|X.Y.Z`.

### Choosing the profile up front

The first interactive start applies the `balanced` profile and asks for `/reload`. To pick another
profile before starting, or to script the install, use the installer from a clone:

```sh
git clone https://github.com/SATUNIX/pi-system.git
cd pi-system
node packages/core/install.ts --channel latest --profile lite
```

`--channel latest` needs at least one release tag; until the first tag exists the installer stops
with a message saying so, and `--channel next` follows `main`. The installer keeps exactly one copy
of the kit registered, so this replaces a `pi install` copy rather than adding a second one.

## 3. Start pi

```sh
pi
```

The first time pi starts in a folder it asks whether to trust it (pi's own prompt: trusting lets
the project's `.pi/` settings and extensions load). If pi warns `No models available`, run
`/login` to sign in to a provider or add an API key; the kit works with any provider pi supports.

Then:

- `/kit` prints the command cheatsheet.
- `/footer status` confirms the status bar is active and shows every detail it drops when narrow.
- `/effort` shows how hard the agent is set to work ([Effort](effort.md)). The default is
  E3 Standard.
- `/profile` shows and switches the profile ([Profiles](profiles.md)).

## 4. Profiles at a glance

| Profile | Good for |
|---|---|
| `quick` | Basic safety, todo, checkpoints and memory |
| `balanced` | Daily coding with verification and context helpers (the default) |
| `long-horizon` | Multi-hour work with task graph, branches and delegation |
| `autonomous` | Long-running sessions and [unattended runs](autonomy.md) |
| `pentest` | Authorised security engagements: strict firewall, scope and rules of engagement |
| `self-improving` | Research setup with Docker-backed memory (experimental) |
| `lite` | Small local models and short contexts |

Switch inside pi with `/profile` (a picker) or `/profile <name>`. The switch is verified and rolled
back if anything fails; nothing is reinstalled. The exact contents are in the generated
[capability matrix](capability-matrix.md).

## 5. Staying up to date

Once a day the kit checks in the background whether pi, the kit or a linked package can be
updated, and tells you. Run `/update` to apply updates. Every step is verified afterwards, and a
failed step is reported as failed. See [Updates](updates.md).

## Working on the kit itself

Register a checkout in place instead: edits take effect on `/reload`.

```sh
git clone https://github.com/SATUNIX/pi-system.git && cd pi-system
npm ci --ignore-scripts
node packages/core/install.ts --profile balanced --yes
```

`CLAUDE.md` and `CONTRIBUTING.md` (both in the repository root) describe the development workflow.

## If something goes wrong

See [Troubleshooting](troubleshooting.md).
