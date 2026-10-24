# Architecture

`pi-system` is one pi package, `@satunix/pi-system`. The repository root is the package: it declares its full resource set under the `pi` key in `package.json` (and a `files` allowlist for the npm tarball). Profiles, not separate packages, narrow what loads.

## The three avenues

| Avenue | Folder | Description |
|---|---|---|
| In-repo | `packages/extensions/src/<name>/` | Extensions you author and iterate here |
| Vendored | `packages/extensions/third_party/<name>/` | Adapted upstream extensions (with `SOURCE.md` provenance) |
| External | `packages/core/sources.json` | Other repos — installed as sibling packages via `pi install git:…` |

`packages/core/registry.ts` unifies all three into `docs/EXTENSIONS.md`. Profiles reference extension **names** — never paths — so moving an extension between avenues doesn't change anything that refers to it.

## Extension contract

Every extension:
- Lives in a single folder (`packages/extensions/src/<name>/` or `packages/extensions/third_party/<name>/`)
- Has a stable `index.ts` entry point
- Has an `extension.json` metadata file (validated by `packages/core/verify.ts`)
- Imports only `node:*` built-ins and the `typebox` peer — **no sibling imports, no `packages/core/lib`**

This self-containment rule is mechanically enforced by `packages/core/verify.ts` and is what makes `npm run extract -- <name>` a 5-minute job.

## Skills and prompts

Skills (`packages/kit/skills/*/SKILL.md`) are markdown instruction sets loaded by pi as context. Prompts (`packages/kit/prompts/*.md`) are invocable via `/` commands. Neither is TypeScript code — they are pure knowledge/behaviour documents.

## Profiles

Profiles (`packages/kit/profiles/*.json`) are lists of extension names, plus optional skill and prompt filters. The installer applies a profile by registering the kit with pi and writing `extensions` / `skills` / `prompts` filters on the kit's package entry in pi's settings. Profile files never change shape as extensions move between avenues. The `lite` profile uses `skills.only` / `prompts.only` allowlists for small models.

## Distribution

`packages/core/distribution.json` sets how the kit reaches users. Today it is **git**: pi installs the repository from the public GitHub repository, `latest` is the newest `vX.Y.Z` tag and `next` is `main`. **npm** (dist-tags of `@satunix/pi-system`, published from GitHub Actions with trusted publishing and provenance) is built and tested but not enabled; the package is not published. The installer, `/profile` and the `kit-update` extension (`/update`) all read the setting. See `docs/releasing.md` and `docs/updates.md`.

## Toolchain

Distribution facts have one owner each. `npm run -s distribution:inspect` derives identity,
runtime compatibility, delivery, capability metadata and profile contracts without creating
another manifest. [Support and compatibility](support.md) names those owners and the evidence
required before claiming support. `verify` and `smoke:distribution-contract` enforce mandatory
profile protections, contribution producers' required context assembler and unique declared tool
names within each profile.

`packages/core/` is the toolchain only — never imported at extension runtime:
- `install.ts` — installs the kit + profile, from a checkout or as a release (git or npm; also the package's `npx` entry point)
- `lib/distribution.ts` — reads `distribution.json`; git sources, release tags and channels
- `release.ts` / `release-notes.ts` — cut a release commit and tag (never pushes); write its notes (the GitHub Release itself is created by `.github/workflows/release.yml`)
- `pack-check.ts` — checks the npm tarball; `publish-plan.ts` / `snapshot-version.ts` pick the npm version and dist-tag; `lockfile-check.ts` checks lockfile integrity
- `verify.ts` — the static gate: schema + tsc + self-containment + collision + profile/manifest
  drift + stub quarantine + firewall policy + security parity + catalogue/matrix drift + docs
  nav. **Every check has a worked failure example in `WRITING_EXTENSIONS.md`.**
- `registry.ts` / `skills-catalogue.ts` / `capability-matrix.ts` — generate the catalogues
- `docs-nav-check.ts` — offline `mkdocs build --strict` stand-in; `check-mermaid.ts` — parses every Mermaid diagram
- `check-all.ts` — runs every check the repository defines, and fails on a test file no script runs (`lib/wiring.ts`)
- `lib/effort.ts` — the effort policy loader shared by the toolchain and the autonomy runner
- `eval/` — the offline behavioural fixture harness (`npm run eval`)
- `dream.ts` — offline dream-mode pass (allowlisted internal state only; it does not write `AGENTS.md`)
- `new-extension.ts` / `extract-extension.ts` — scaffolding helpers
- `lib/` — shared toolchain utilities

Static checks (`verify`) + behavioural checks (`eval`, `test:security`) + docs checks
(`smoke:docs`, `docs:check`) together form the release gate. See `WRITING_EXTENSIONS.md` for the
full check list and `docs/roadmap.md` for the current plan. [Concepts](concepts.md) defines the
tiers, layers and design rules the extensions follow.
