# Modularity — the three avenues

## Core principle: identity = name, not location

Every extension has one stable `name` field in its `extension.json`. Profiles, the catalog, and the installer all key on that name. Where the code lives is a resolved implementation detail — you can move an extension between avenues without touching anything that refers to it.

## The three avenues

### 1. In-repo (`packages/extensions/src/<name>/`)

Extensions you author and iterate here. Edit and `/reload` — no reinstall needed.

```
packages/extensions/src/
  secret-guard/
    index.ts          ← pi loads this
    extension.json    ← metadata (schema-validated)
```

### 2. Vendored (`packages/extensions/third_party/<name>/`)

Upstream extensions you must modify (e.g. Windows fixes, API adaptations). Each folder has a `SOURCE.md` recording the upstream path, pin date, and your changes.

```
packages/extensions/third_party/
  git-checkpoint/
    index.ts
    extension.json
    SOURCE.md         ← upstream path + what you changed
```

### 3. External (`packages/core/sources.json`)

Other people's repos, or your own split-out repos — installed as pi package siblings, never copied into this repo.

```jsonc
// packages/core/sources.json
{
  "external": [
    {
      "name": "fancy-reviewer",
      "mode": "reference",
      "source": "git:github.com/someone/pi-fancy-reviewer@v2.1.0",
      "provides": ["fancy-reviewer"],
      "profiles": ["full"]
    }
  ]
}
```

- **reference**: installed as a sibling via `pi install git:…`. Updates independently.
- **bundle**: embedded in `dependencies` + `bundledDependencies` for reproducible deploys.

## Self-containment rule (hard)

At runtime an extension imports **only** `node:*` built-ins and the bundled `typebox` peer. No sibling imports, no `packages/core/lib/` imports. Enforced by `packages/core/verify.ts` — the build fails if violated.

This rule is what makes "extract to own repo" a 5-minute job. Because extensions can't import
each other, cross-extension invariants (e.g. secret-guard's protected paths staying a superset
of pentest-governance-domain's) are held instead by **`verify.ts` parity checks** and shared
on-disk contracts (`.pi/verdicts.json`, `.pi/recovery/sessions/<session id>/escalation.json`), never by imports. The
full list of enforced checks — each with a worked failure example — is in
[`WRITING_EXTENSIONS.md`](WRITING_EXTENSIONS.md).

## Splitting an extension into its own repo

```sh
npm run extract -- secret-guard
```

This copies `packages/extensions/src/secret-guard/` into a standalone-ready package, sets `homeRepo`, and prints next steps:

1. `git init` the new folder, push it to a git repository such as `pi-ext-secret-guard`
2. In `packages/core/sources.json`: add a reference entry, remove the in-repo folder
3. Profiles need no change — they still list the name `secret-guard`; the resolver finds it via `sources.json`

## Catalog

`packages/core/registry.ts` reads all three avenues and produces `docs/EXTENSIONS.md` + `docs/registry.json`. Run with:

```sh
npm run catalog
```
