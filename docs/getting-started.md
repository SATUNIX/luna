# Getting started

Luna is one pi package. You install it once, then a **profile** chooses which of its
extensions load. It is delivered from its public git repository, `github.com/SATUNIX/luna`:
releases are `vX.Y.Z` tags and the `next` channel follows `main`.

This is a **beta**. See [Beta status](beta.md) for what that means.

## 1. Requirements

- Node.js **22.19 or newer** (pi's own requirement) and npm
- git
- pi itself:

```sh
npm install -g @earendil-works/pi-coding-agent
```

Luna supports pi **0.85.1 and newer**; the version it is tested against is pinned in
`package.json` (currently 1.4.0). See [Supply chain](supply-chain.md#pi-versions).

## 2. Install Luna

```sh
pi install git:github.com/SATUNIX/luna@v0.4.0-beta.0
```

pi clones the release into `~/.pi/agent/git/github.com/SATUNIX/luna` and runs
`npm install --omit=dev` there, as it does for every git package. Luna has one runtime
dependency, `quickjs-wasi` (pinned), so this step fetches it from the npm registry.

To follow `main` instead of a release, leave the tag off:
`pi install git:github.com/SATUNIX/luna`. Switching channels later is
`/update channel latest|next|trunk|X.Y.Z` (`trunk` is the opt-in canary that follows the
integration branch).

### Choosing the profile up front

With a bare `pi install` the first interactive start applies the `balanced` profile and asks for
`/reload`: pi lets only a command, not a start-up hook, reload itself, so that one reload stays. The
installer below applies the profile before pi starts, so it needs none (`tests/clean-install-smoke.ts`). To pick another
profile before starting, or to script the install, use the installer from a clone:

```sh
git clone https://github.com/SATUNIX/luna.git
cd luna
node packages/core/install.ts --channel latest --profile lite
```

`--channel latest` needs at least one release tag; until the first tag exists the installer stops
with a message saying so, and `--channel next` follows `main`. The installer keeps exactly one copy
of Luna registered, so this replaces a `pi install` copy rather than adding a second one.

## 3. Start pi

```sh
pi
```

The first time pi starts in a folder it asks whether to trust it (pi's own prompt: trusting lets
the project's `.pi/` settings and extensions load). If pi warns `No models available`, run
`/login` to sign in to a provider or add an API key; Luna works with any provider pi supports.
Until you send a first prompt, the launch screen carries a short first-run card (how to get a model,
including `/llama` for a local one, and one prompt to try); it is shown until then and never again
(`tests/control-center-smoke.ts`). With no model configured Luna stays quiet about the context
window: it warns only for a model that reports none (`tests/compaction-state-smoke.ts`).

Then:

- `/menu` opens the control centre.
- `/footer status` confirms the status bar is active and shows every detail it drops when narrow.
- `/effort` shows how hard the agent is set to work ([Effort](effort.md)). The default is
  E3 Standard.
- `/profile` shows and switches the profile ([Profiles](profiles.md)).

## 4. Profiles at a glance

| Profile | Good for |
|---|---|
| `balanced` | Daily coding with verification and context helpers (the default) |
| `long-horizon` | Multi-hour work with task graph, branches and delegation, and [unattended runs](autonomy.md) |
| `engagement` | Authorised security engagements: strict firewall, scope and rules of engagement |
| `self-improving` | Research setup with Docker-backed memory (experimental) |
| `lite` | Quick tasks, small local models and short contexts |

Switch inside pi with `/profile` (a picker) or `/profile <name>`. The switch is verified and rolled
back if anything fails; nothing is reinstalled. The exact contents are in the generated
[capability matrix](capability-matrix.md).

## 5. Staying up to date

Once a day Luna checks in the background whether pi, Luna or a linked package can be
updated, and tells you. Run `/update` to apply updates. Every step is verified afterwards, and a
failed step is reported as failed. See [Updates](updates.md).

## Working on Luna itself

Register a checkout in place instead: edits take effect on `/reload`.

```sh
git clone https://github.com/SATUNIX/luna.git && cd luna
npm ci --ignore-scripts
node packages/core/install.ts --profile balanced --yes
```

`CLAUDE.md` and `CONTRIBUTING.md` (both in the repository root) describe the development workflow.

## If something goes wrong

See [Troubleshooting](troubleshooting.md).
