# Contributing

## Layout

- `packages/core/` — runtime + CLI + schemas + policies.
- `packages/extensions/src/<name>/` — first-party extensions you author here.
- `packages/extensions/third_party/<name>/` — adapted upstream extensions, each with a `SOURCE.md`.
- `packages/kit/` — skills, prompts, profiles, themes, agents, workflows.
- `packages/web-ui/` — the web console. `packages/autonomy/` — the autonomous run engine.
  `packages/container/` — the container deployment.
- `tests/`, `docs/` — the suite and the documentation.

## Branch strategy

- `main` — `npm run check:all` green. Every commit on `main` is the `next` channel.
- Feature branches and draft pull requests carry unreleased work; nothing is released from them.
- Releases are tags `vX.Y.Z` (or `vX.Y.Z-beta.N`) cut by an operator with
  `npm run release -- <version>`; a pushed tag becomes the `latest` channel. See `docs/releasing.md`.

## Checks

`npm run check:all` is the single definition of "the checks". It enumerates them from
`package.json` — every `smoke:*` and `test:*` script, plus `verify`, `eval`, `docs:check`
and a `profile:check` pass per profile — and fails with a summary of every
failure rather than stopping at the first. Run it before proposing a change; CI runs the
same command, so a new `smoke:*` script is covered without editing a workflow.

Smoke tests must be hermetic. Call `isolateKitEnv()` from
`packages/core/eval/harness.ts` before loading the extension under test, then set only the
variables that test needs; the gate must pass with the operator's `PI_KIT_*` environment
present (an ambient `PI_KIT_FIREWALL_POLICY`, for example, otherwise overrides the shipped
policy and changes the decision under test).

Faster loops while working: `npm run verify` (structure, catalogues, parity, nav),
`npm run eval` (offline fixtures), and the single `npm run smoke:<name>` for the area you
changed. Documentation changes additionally want
`python -m mkdocs build --strict`, which is the one gate that needs Python.

## TypeScript standard

Every source file is strict TypeScript, and `check:all` keeps it that way
(`smoke:typescript-coverage`: no new JavaScript, every `.ts` file type-checked and linted).

- **How it runs.** Node (>=22.18) strips the types and runs `.ts` directly: in a checkout, a
  git-delivered install and the containers. Only the npm artefact is compiled
  (`npm run build:npm`, `internal/docs/adr/0001-typescript-runtime-and-npm-artefact.md`), and the
  browser code is compiled into the committed `packages/web-ui/public/js` and `mobile/` by
  `npm run build:web` (`internal/docs/adr/0002-browser-code-compiled-with-tsc.md`; edit
  `packages/web-ui/src/`, never the generated `.js`).
- **Erasable syntax only** outside the extensions: no `enum`, `namespace`, parameter properties or
  `import =`. Use `import type` for type-only imports, and name the `.ts` file in relative imports.
- **Type projects.** Each package has a `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride` and `noImplicitReturns`; `npm run
  test:typecheck` runs them all. A new directory of code joins a project and the `LINTED` list in
  `eslint.config.ts`.
- **Lint.** `npm run test:lint` (typescript-eslint `strictTypeChecked`, type-aware) with zero
  warnings: no `any`, no unsafe use of untyped values, no floating promises, and security bans
  (no `shell: true`, no `exec`/`execSync`, no `vm`, no `eval`/`new Function`, no HTML sinks such
  as `innerHTML`). An `eslint-disable` needs `-- <reason>` and counts against a ceiling.
- **Untrusted data is `unknown`.** JSON from files, the network, child processes, models, the
  browser and the command line is checked before use: `packages/core/lib/guard.ts` for structured
  data (`parseJsonAs`, `object`, `string`, `Infer<>`), `typeof` for scalars. Never cast it: outside
  `tests/`, the lint gate refuses a direct cast of `JSON.parse` output or of an awaited `.json()`
  body (`tests/typescript-coverage-smoke.ts`); a cast of a value bound first is left to review. A field
  of the wrong type is refused, never converted with `String()`. Look tables up by own keys
  (`Map`, `Object.hasOwn`), never `obj[input]`.
- **No escape hatches:** no `as unknown as`, no non-null `!`, no `@ts-ignore`. A deliberate wrong
  type in a test uses `@ts-expect-error` with a comment saying what runtime check it proves.
- Shared shapes are defined once next to their schema and imported, never redeclared.

## Per-extension contract

1. One folder per extension: `packages/extensions/src/<name>/` or `packages/extensions/third_party/<name>/`.
2. Entry point: `index.ts` at the folder root.
3. Metadata: `extension.json` sibling, validated against `packages/core/schema/extension.schema.json`.
4. **Self-containment (hard rule):** import only `node:*` built-ins and the `typebox` peer. No
   sibling imports, no `packages/core/lib` imports. Cross-extension contracts go through a
   registry on `globalThis` (`Symbol.for("pi-kit.*")`). `npm run verify` enforces this mechanically.
5. `README.md` per extension explaining what it does and what it needs.

## Avenues

| Avenue | Folder | Use when |
| --- | --- | --- |
| First-party | `packages/extensions/src/<name>/` | You author and iterate it here |
| Third-party | `packages/extensions/third_party/<name>/` | You must modify upstream (add `SOURCE.md`) |
| External | `packages/core/sources.json` | Someone else's repo, reference or bundle |

Profiles reference extension names, not paths — so relocation never changes a profile.

## Splitting an extension to its own repo

```sh
npm run extract -- <name>
```

## Updating the catalog

```sh
npm run catalog
```

`docs/EXTENSIONS.md`, `docs/skills-catalogue.md`, and `docs/capability-matrix.md` are generated;
do not hand-edit them.

## Pull requests

GitHub (`SATUNIX/pi-system`) is the authoritative repository: fork or branch, then open a pull
request against `main`. `main` needs one approving review, plus the owner's review for the paths
in `.github/CODEOWNERS` (CI, release tooling, the installer, profiles, policies, the firewall and
the other security extensions, and the security documents). The GitLab copy is a read-only
mirror; do not open merge requests there. See [repository topology](docs/repository-topology.md).

Every pushed branch is public at once. Before your first push, install the leak scan:

```sh
node packages/core/prepush-scan.ts install
```

It refuses a push whose commits carry a private host name, a home-directory path, a private
address, a key or token shape, or a file under `internal/`, `reviews/` or `examples/engagement/`
(`tests/prepush-scan-smoke.ts`).
