# CLAUDE.md: working conventions for developing this repository

This file is for people and agents working **on** `pi-system`. It is distinct from `AGENTS.md`,
which is what the *shipped pi agent itself* reads about installing and using the kit. Put
guidance for the shipped agent in `AGENTS.md`, guidance for contributors here, and anything a
user needs in `docs/`. pi loads only the first of `AGENTS.md` and `CLAUDE.md`, so a pi agent
working here never sees this file unless it reads it: the safety rules below are repeated in
`AGENTS.md` under "Maintaining this repository", and `tests/docs-smoke.ts` checks they stay there.

## Repo conventions

- Run `npm run verify` and `npm run test:security` before considering any change to
  `packages/core/`, `packages/extensions/` or `packages/kit/` done. `npm run check:all` is the
  single definition of "all the checks" and is what CI runs.
- Run tests through their npm scripts (`npm run smoke:<name>`), not `node tests/x.ts`: the scripts
  put `node_modules/.bin` (and so `pi`) on `PATH`. Smoke tests must be hermetic: call
  `isolateKitEnv()` from `packages/core/eval/harness.ts` before loading the extension under test.
- A new test file must be named by a `smoke:*` or `test:*` script. `check:all` fails on a test no
  script runs (`packages/core/lib/wiring.ts`).
- Follow the existing commit-message convention (see recent `git log`): finding, root cause, fix
  and verification in the body, not just a one-liner.
- Treat any roadmap, audit or review summary as a hypothesis to verify against the code, not as
  ground truth. Stale audit documents are how this repository accumulated wrong claims.
- Keep patches scoped. Do not run a repo-wide formatter, and do not "tidy" files you were not
  asked to change: whitespace churn over unrelated files makes the real diff unreviewable.
- Never commit on another agent's behalf, and never push to a protected branch.
- **GitHub (`SATUNIX/pi-system`) is the authoritative repository, and it is public**: every
  pushed branch is published at once. Develop on a branch and open a pull request there; the
  GitLab copy is a read-only mirror. Install the pre-push leak scan in every clone you push from
  (`node packages/core/prepush-scan.ts install`, `docs/repository-topology.md`) and never skip it
  with `--no-verify`. An agent never approves or merges its own pull request. Keep private notes,
  review evidence and scratch work out of the repository.
- **Releasing is an operator action.** An agent may prepare a release branch and a draft pull
  request. It must not create or push a tag, publish a package, image or release, merge a pull
  request, or change repository or account settings. See `docs/releasing.md`.
- All code is strict TypeScript; follow "TypeScript standard" in `CONTRIBUTING.md`. Run
  `npm run test:typecheck` and `npm run test:lint` before considering a code change done, and
  `npm run build:web` after editing `packages/web-ui/src/` (commit the regenerated `.js` with it).
  Do not add JavaScript files, `any`, casts of untrusted data, or `eslint-disable` without a reason.
- Never touch the operator's real pi installation or credentials when testing: use temporary
  `HOME` and `PI_CODING_AGENT_DIR` directories, as `tests/clean-install-smoke.ts` does.

## Documentation rules

Documentation here describes **what the code does now**. These rules keep it that way:

1. **Current behaviour only.** No status banners, dated "as of" claims, sprint or work-unit ids, or
   plans in a page that describes behaviour. Plans belong in `docs/roadmap.md` and
   `docs/future-work.md`; history belongs in git and `CHANGELOG.md`.
2. **One home per fact.** Link to it instead of restating it. Generated pages
   (`docs/EXTENSIONS.md`, `docs/skills-catalogue.md`, `docs/capability-matrix.md`,
   `THIRD_PARTY_NOTICES.md`) are never hand-edited: run `npm run catalog` and
   `node packages/core/gen-notices.ts`.
3. **A claim about behaviour names the test that pins it**, or says plainly that nothing does.
4. **Diagrams are Mermaid** in fenced blocks, and `npm run docs:mermaid` must pass.
5. **No private hosts, addresses, accounts, e-mail addresses or machine paths**, and no
   secret-like strings other than the synthetic fixtures the tests already use. Retired private sources are recognised by source fingerprints in
   `packages/core/distribution.json`, never published as private hostnames.
6. **Links stay inside `docs/`.** A link to a path outside `docs_dir` (for example
   `../packages/...`) aborts `python -m mkdocs build --strict`, which CI runs; keep such
   references as code spans.
7. **Australian English**: behaviour, colour, organisation, licence (noun), customise, artefact.
8. Say what is **not** covered. A limitation belongs in the page that describes the feature, and
   the release-wide ones in `docs/beta.md`.

For documentation changes also run `python -m mkdocs build --strict` and `npm run docs:check`.

## Dependencies

- `devDependencies` pin the pi version the whole suite is tested against; `peerDependencies`
  state the floor. CI's `pi-compat` matrix runs the suite at the floor and at the newest release
  looked at. Widening either is a reviewed change with evidence, not a Dependabot bump.
- Companion packages in `packages/core/sources.json` are pinned exactly and reviewed. Verify a
  candidate against its tarball (and, if it loads into pi, in a real TUI with a scratch agent
  directory) before adopting it, and record the review in `sources.json`.

## Autonomous runs

`packages/autonomy` runs the kit's own agent unattended inside a container boundary. Its design
and operator steps are in `docs/autonomy.md`; changes to the boundary, the run contract or the
approval rules need their tests updated in the same change.
