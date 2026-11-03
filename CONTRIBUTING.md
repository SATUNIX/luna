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

`npm run check:all` is the single definition of "the checks"; `npm test` runs the same command. It enumerates them from
`package.json` — every `smoke:*` and `test:*` script, plus `verify`, `eval`, `docs:check`
and a `profile:check` pass per profile — and fails with a summary of every
failure rather than stopping at the first. Run it before proposing a change; CI runs the
same command, so a new `smoke:*` script is covered without editing a workflow.

Smoke tests must be hermetic. Call `isolateKitEnv()` from
`packages/core/eval/harness.ts` before loading the extension under test, then set only the
variables that test needs; the gate must pass with the operator's `PI_KIT_*` environment
present (an ambient `PI_KIT_FIREWALL_POLICY`, for example, otherwise overrides the shipped
policy and changes the decision under test).

`npm run coverage` runs the same checks with line, branch and function coverage measured and
prints a summary ([CI security](docs/ci-security.md#test-coverage)).

Faster loops while working: `npm run verify` (structure, catalogues, parity, nav),
`npm run eval` (offline fixtures), and the single `npm run smoke:<name>` for the area you
changed. Documentation changes additionally want
`python -m mkdocs build --strict`, which is the one gate that needs Python.

## TypeScript standard

Every source file is strict TypeScript, and `check:all` keeps it that way
(`smoke:typescript-coverage`: no new JavaScript, every `.ts` file type-checked and linted).

- **How it runs.** Node (>=22.18) strips the types and runs `.ts` directly: in a checkout, a
  git-delivered install and the containers. Only the npm artefact is compiled
  (`npm run build:npm`), because Node does not strip types under `node_modules`, and the browser
  code is compiled into the committed `packages/web-ui/public/js` and `mobile/` by
  `npm run build:web`, because browsers do not run TypeScript (edit `packages/web-ui/src/`, never
  the generated `.js`).
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

## Tests

Every change that adds or changes behaviour adds or extends an automated test in `tests/`, in the
same pull request:

- **New functionality** gets a test that exercises it through its real entry point (the
  extension's event handler, command, tool or exported function), wired as a `smoke:*` or `test:*`
  script in `package.json` so `check:all` runs it. `check:all` fails on a test file no script
  runs or that asserts nothing (`smoke:wiring`).
- **A bug fix** gets a regression test that fails before the fix and passes after it.
- **A security fix** follows the stricter rule under "Security standard" below.
- Name the test in the pull request description (the template asks for it). A pull request that
  changes behaviour without a test is not merged; documentation-only and test-only changes are
  exempt.

Where an input space is too large to list, add a property to one of the fuzz tests
(`tests/fuzz-*-smoke.ts`, [CI security](docs/ci-security.md#property-based-fuzzing)).

## Security standard

Every change also follows the [secure development standard](docs/security-standard.md): file
writes through the safe-write helper, temporary files and modes, regular-expression safety, the
one redaction table, network clients, child processes, untrusted data, dependency adoption,
suppressions and the review rules. Each rule names the lint rule or test that enforces it. The
[threat model](docs/threat-model.md) says why, and [security controls](docs/security-controls.md)
lists every control with its test and CI job. A security fix lands with a regression test that
uses a harmless command in place of anything destructive, and fixes the whole class of the
problem, not only the instance reported.

## Per-extension contract

1. One folder per extension: `packages/extensions/src/<name>/` or `packages/extensions/third_party/<name>/`.
2. Entry point: `index.ts` at the folder root.
3. Metadata: `extension.json` sibling, validated against `packages/core/schema/extension.schema.json`.
4. **Self-containment (hard rule):** import only `node:*` built-ins and the `typebox` peer. No
   sibling imports, no `packages/core/lib` imports. Cross-extension contracts go through a
   registry on `globalThis` (`Symbol.for("pi-kit.*")`). `npm run verify` enforces this mechanically.
5. `README.md` per extension explaining what it does and what it needs. The extensions that
   predate this rule are listed in `packages/core/verify.ts` (`EXTENSIONS_WITHOUT_README`); verify
   fails for any other extension without one, and the list only shrinks. Until an older extension
   has its README, its summary is in [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) and its commands,
   tools and environment variables are in [`docs/reference.md`](docs/reference.md).

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

`docs/EXTENSIONS.md`, `docs/skills-catalogue.md`, `docs/capability-matrix.md` and
`docs/reference.md` are generated; do not hand-edit them. `npm run verify` fails when one is stale.

## Pull requests

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

GitHub (`SATUNIX/luna`) is the only repository: fork or branch, then open a pull
request against `main`. The `main` ruleset declared in `.github/expected-settings.json` requires
one approving review, the owner's review for the paths in `.github/CODEOWNERS` (CI, release
tooling, the installer, profiles, policies, the firewall and the other security extensions, the
tests and the security documents), approval of the last push, resolved review threads and every
required check; GitHub enforces it ([CI security](docs/ci-security.md#repository-settings)). The
author of a pull request, person or agent, never approves it. The GitLab mirror and private-lineage
export pipeline are archived; do not open merge requests there. See
[repository topology](docs/repository-topology.md).

Every pushed branch is public at once. Before your first push, install the leak scan:

```sh
node packages/core/prepush-scan.ts install
```

It refuses a push whose commits carry a private host name, a home-directory path, a private
address, a key or token shape, a private review or roadmap item ID (`SR`, `R`, `P`, `M` or `D`,
a hyphen and a number: describe the item instead), or a file under `internal/`, `reviews/` or `examples/engagement/`
(`tests/prepush-scan-smoke.ts`).
