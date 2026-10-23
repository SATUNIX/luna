# Pi System

`@satunix/pi-system` is a capability layer for the [pi coding agent](https://github.com/earendil-works/pi):
extensions, skills, prompts, themes and agent definitions in one pi package, with **profiles** that
choose what loads. This is a beta; read [Beta status](beta.md) first.

Use this guide if you want to:

- install the kit and choose a profile, including `lite` for small local models
- choose how hard the agent works and how much it delegates ([Effort](effort.md))
- understand what the tool firewall does and does not protect ([Security model](security.md))
- keep pi, the kit and linked packages up to date ([Updates](updates.md))
- run long tasks unattended in a container ([Autonomous runs](autonomy.md))
- read the status bar, or configure model pricing ([Status bar and costs](status-bar-and-costs.md))
- build your own extension ([Writing extensions](WRITING_EXTENSIONS.md))

## Fast choices

| Need | Use |
|---|---|
| Small local model or tight context | the `lite` profile |
| Daily coding with the standard guardrails | the `balanced` profile (the default) |
| Long-running work with checkpoints, a task graph and delegation | the `long-horizon` profile |
| A task that should keep going without you | [Autonomous runs](autonomy.md) |
| Container deployment for security engagements | `packages/container/README.md` |

## Plain terms

- The **kit** is the one package, installed from `github.com/SATUNIX/pi-system`.
- A **profile** chooses which of the kit's extensions, skills and prompts load. Switch with `/profile`.
- A **channel** is what you follow: `latest` (release tags), `next` (`main`), or a pinned version.
- **Effort** is a per-task dial (E1 to E5) for depth of work and delegation. It is not a
  permission and not a model setting.
- The **catalogue** is the generated library of extensions in this repository.

## Start here

1. [Getting started](getting-started.md), then [Installation](INSTALL.md) for the reference.
2. Pick a profile in [Profiles](profiles.md); see [Concepts](concepts.md) for the vocabulary.
3. Read the [Security model](security.md), especially what it does not claim.
4. Something wrong? [Troubleshooting](troubleshooting.md).
5. Coming from the private GitLab source? [Migration](migration.md).

## Searching the docs

```sh
python3 -m pip install --user -r requirements-docs.txt
npm run docs:serve
```

Open the local MkDocs URL and use the search box. Diagrams are Mermaid fenced blocks: GitHub
renders them, and the local site shows them as code. `npm run docs:mermaid` checks that every
diagram parses.

Prefer a scripted tool over typing the raw commands? See `packages/core/helpers/README.md` for
install, setup, configure and update scripts (bash and PowerShell).
