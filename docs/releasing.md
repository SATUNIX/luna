# Releasing

pi-system is delivered from its public git repository, `github.com/SATUNIX/pi-system`. pi
installs it straight from there, so **a pushed `vX.Y.Z` tag is the release**: there is no package
registry in between.

| Channel | What it is | How users get it |
|---|---|---|
| `next` | Every commit on `main` | Merging to `main` is enough |
| `latest` | The newest `vX.Y.Z` tag (the newest stable one once a stable release exists; betas until then) | Push a tag |
| `X.Y.Z` | One tag, pinned | Push a tag |

The delivery is one setting, `delivery` in `packages/core/distribution.json` (`git`). The
installer, `/profile` and `/update` read it.

Releasing is **manual and operator-run**. Nothing in this repository tags, publishes or creates a
release on its own, and the release workflow defaults to a dry run.

## Cutting a release

`main` is protected, so a release lands through a reviewed pull request on GitHub, never a direct
push:

```sh
# 1. Fetch the tags, then branch from main with a clean tree. Add a "## [0.2.4-beta.4]" section
#    to CHANGELOG.md and commit it.
git fetch --tags origin
git switch -c release/v0.2.4-beta.4 origin/main
# 2. Run the full gate, bump every package.json and the lockfile, commit, tag (local only).
#    The gate is `npm ci --dry-run`, `npm run check:all` (about eight minutes), the lockfile check and a
#    strict MkDocs build (`python -m pip install -r requirements-docs.txt` first; the script says so
#    before it starts if MkDocs is missing):
npm run release -- 0.2.4-beta.4
# 3. Push the branch and merge it into main through a reviewed pull request:
git push -u origin release/v0.2.4-beta.4
# 4. Once the release commit is on main, push the tag:
git push origin v0.2.4-beta.4
```

`release.ts` never pushes. It refuses to run:

- on a dirty tree, or without a CHANGELOG section;
- when the version is already tagged, or is not newer than the newest release tag in the clone
  (prerelease-aware: `0.2.4-beta.9 < 0.2.4-beta.10 < 0.2.4`), which is why step 1 fetches the
  tags;
- when the version is older than `package.json`'s.

`npm run release -- 0.2.4-beta.4 --dry-run` runs every gate without changing anything.

`--bump-only` syncs these without gates, commit or tag:

- the version fields;
- the README's version badge;
- the install pins in the README, `AGENTS.md` and `docs/`;
- the lockfile.

That prepares a release branch whose version change is reviewed on its own. After that branch
merges, `npm run release -- <version>` on main finds every version field already at the version,
so it only gates and tags. The first release, the version already in `package.json` before any
tag exists, works the same way. `tests/release-plan-smoke.ts` covers each of these cases, and
`tests/docs-smoke.ts` fails when a pin or the badge disagrees with `package.json`.

Users on `latest` see a new release the next time `/update` checks (at most a day later, or
straight away with `/update`). A tag is the release even if a later workflow fails: `/update`
reads tags. If a release turns out wrong, fix it forward: release a new version with the fix,
and say in its notes which release it replaces. Never move, delete or recreate a tag once it is
public. Pinned installs and `/update` would then see a different release under the same name,
which [Support](support.md) rules out.

## The release workflow

`.github/workflows/release.yml` adds two **optional** steps on top of a tag. It runs only when an
operator starts it from the Actions tab (`workflow_dispatch`); it never runs on a push, a tag or a
pull request.

| Job | Runs | Permissions | Side effects |
|---|---|---|---|
| `gate` | always | `contents: read` | none: the full CI gate for the same commit |
| `plan` | always | `contents: read` | **none**: plans the version and dist-tag, checks the tarball, runs `npm publish --dry-run`, previews the release notes in the run summary |
| `github-release` | only with `dry-run` unticked, from a `v*` tag | `contents: write` | creates the GitHub Release with the CHANGELOG notes |
| `npm-publish` | only with `dry-run` unticked **and** `publish-npm` ticked, from a `v*` tag | `id-token: write`, the `npm` environment | publishes `@satunix/pi-system` to npm |

`dry-run` defaults to **ticked**. The two jobs with side effects are guarded by an explicit
`inputs.dry-run == false` comparison, so any other event type, or an empty input, also means "no
side effects". `tests/release-workflow-smoke.ts` checks this structure and is run by `check:all`,
and it fails against a workflow that publishes on a dry run.

```mermaid
flowchart LR
    start([Operator starts the workflow]) --> gate[gate: the full CI checks]
    gate --> plan[plan: read-only dry run]
    plan --> q{dry-run unticked<br/>and a v* tag?}
    q -->|no| done([Nothing published or created])
    q -->|yes| rel[github-release: creates the Release]
    q -->|yes, and publish-npm ticked| npm[npm-publish: npm environment]
```

Recommended order for a release:

1. Land the release commit on `main` through a reviewed pull request (above), and wait for CI.
2. Push the tag (above).
3. Run the `release` workflow from the tag with the defaults (dry run) and read the `plan`
   summary: tarball contents, `npm publish --dry-run` output, release notes.
4. Run it again from the tag with **dry-run unticked** to create the GitHub Release. Leave
   `publish-npm` unticked unless npm publication has been set up (below).

## Repository settings (GitHub)

These are operator actions; the repository does not change its own settings.

- **Protect `main`**: require pull requests with **one approving review** and review from code
  owners (`.github/CODEOWNERS` maps the firewall, policies, installer, release tooling and
  security documents to the owner), the `ci` checks and the `security` checks; block force
  pushes. When a matrix job is renamed (a pi-compat lane, a profile), update the required check
  names with it, or the rule waits for a check that never runs.
- **Protect tags `v*`**: only the operator creates them.
- **Agent identity**: agents push and open pull requests as a separate non-admin bot account or
  GitHub App with contents and pull-request write access only, never as the owner. With one
  required approval, an agent cannot merge its own pull request.
- **Dependabot**: turn on alerts and security updates.
- **Code scanning and secret scanning**: enable them; `security.yml` uploads SARIF and runs
  gitleaks.
- **Actions**: allow only the pinned actions in use; workflow tokens default to read-only.

## What a release contains

The whole repository at the tag. pi runs `npm install --omit=dev` in its copy; the kit has no
runtime dependencies, so nothing is fetched from the npm registry. Companion packages (`pi-lens`,
`pi-readseek`) are separate pi packages from npm, registered by the installer at the kit's
reviewed pins in `packages/core/sources.json`.

`npm run smoke:package` (part of `check:all`) packs the repository exactly as `npm publish`
would, unpacks it and proves the copy works alone, and `smoke:clean-install` installs that copy
for every profile and starts the real pi with it.

## npm publication (optional)

npm delivery is built and tested but **not enabled, and the package is not published**. Git
delivery is the supported path. To enable npm as well, an operator needs to:

1. Have an npm account with two-factor authentication and the `satunix` organisation (it owns
   the `@satunix` scope).
2. Add a GitHub environment named `npm`.
3. Publish the first version by hand (`npm login`, then `npm publish --access public`), because
   npm only lets you attach a trusted publisher to a package that exists.
4. On npmjs.com, package settings, Trusted Publisher, GitHub Actions: organisation `SATUNIX`,
   repository `pi-system`, workflow `release.yml`, environment `npm`. Then set publishing access
   to "Require two-factor authentication and disallow tokens".
5. Set `"delivery": "npm"` in `packages/core/distribution.json` **only if** npm should replace
   git as the default; git delivery keeps working without it.

The npm channels are dist-tags: `latest` for releases, `beta` for prereleases once a stable release
exists, and `release-X.Y` for maintenance releases (`packages/core/publish-plan.ts`).

## Local checks

```sh
npm run check:all            # everything CI runs, including the delivery, update and install tests
npm run security:lockfile    # lockfile integrity
node packages/core/release-notes.ts 0.2.4-beta.0   # preview the notes for a release
```

## Where releases come from

Releases are cut on GitHub, the authoritative repository: the release branch, its pull request
and the tag all live there. The GitLab mirror only follows GitHub and is never released from.
See [repository topology](repository-topology.md).
