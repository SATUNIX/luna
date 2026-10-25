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
| `gate` | always | `contents: read` | none: the whole of `ci.yml` for the same commit |
| `security` | always | `contents: read`, `security-events: write`, `actions: read` | none beyond SARIF uploads: the whole of `security.yml` for the same commit |
| `plan` | always | `contents: read` | **none**: plans the version and dist-tag, checks the tarball, runs `npm publish --dry-run`, previews the release notes in the run summary |
| `github-release` | only with `dry-run` unticked, from a `v*` tag | `contents: write` | creates the GitHub Release with the CHANGELOG notes |
| `npm-publish` | only with `dry-run` unticked **and** `publish-npm` ticked, from a `v*` tag | `id-token: write`, the `npm` environment | publishes `@satunix/pi-system` to npm |

`dry-run` defaults to **ticked**. The two jobs with side effects are guarded by an explicit
`inputs.dry-run == false` comparison, so any other event type, or an empty input, also means "no
side effects". `plan` waits for both `gate` and `security`, so the release gate is every check
CI runs for the commit, the security scans included. `tests/release-workflow-smoke.ts` checks
this structure and is run by `check:all`, and it fails against a workflow that publishes on a dry
run or plans without the security gate.

```mermaid
flowchart LR
    start([Operator starts the workflow]) --> gate[gate: the full CI checks]
    start --> sec[security: the security workflow]
    gate --> plan[plan: read-only dry run]
    sec --> plan
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

The settings a release depends on are declared in `.github/expected-settings.json` and described,
field by field, in [CI security](ci-security.md#repository-settings). They are operator actions:
the repository does not change its own settings, and whether GitHub enforces what the file
declares is a setting a test cannot see. The [Operator checklist](operator-checklist.md) lists
them with every other operator-only step. In short:

- `main` needs a pull request with one approving review, code-owner review for the paths in
  `.github/CODEOWNERS`, approval of the last push, and every required check; force pushes and
  deletion are blocked, and the owner bypasses only through a pull request. When a matrix job is
  renamed, `ci-complete` still stands for every `ci.yml` job, so the ruleset need not change.
- Only the owner creates, updates or deletes `v*` tags.
- Agents push and open pull requests as a non-admin bot identity or GitHub App with contents and
  pull-request write access only, never as the owner, and are not bypass actors. With one required
  approval, an agent cannot merge its own pull request.

## Release rules

- **Publish what was reviewed.** A release is a tag on a commit that reached `main` through a
  reviewed pull request; `release.ts` refuses a dirty tree, and the release workflow only acts on a
  tag whose commit is on `main` and matches `package.json` (`tests/release-plan-smoke.ts`,
  `tests/release-workflow-smoke.ts`). When npm publication is enabled, the npm job runs in the
  `npm` environment, whose required reviewer and `v*` tag policy are declared in
  `.github/expected-settings.json`.
- **The release gate is every check.** `gate` and `security` run the whole of `ci.yml` and
  `security.yml` for the tagged commit before `plan`.
- **Fix forward.** A tag is never moved, deleted or recreated once public (above).
- **Tags are not signed.** Release tags are annotated but carry no signature, and `/update` does not
  verify one; the tag rules and the review on `main` are the controls. Signing is planned
  ([Future work](future-work.md#releases-and-repository-governance)).
- **No branch-namespace rule.** Anyone with write access can create a branch of any name; nothing
  is released from a branch, and only tags are releases.
- **The authoritative forge is GitHub** ([Repository topology](repository-topology.md)).

## What a release contains

The whole repository at the tag. pi runs `npm install --omit=dev --legacy-peer-deps` in its copy,
which fetches the kit's one runtime dependency from the npm registry ([Supply chain](supply-chain.md), "What
installing the kit pulls in"). Companion packages (`pi-lens`,
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
A release whose content is exported from the private development lineage arrives as a draft pull
request on a `release/<tag>` branch and is reviewed like any other
([Repository topology](repository-topology.md#how-a-release-reaches-this-repository)).

## Releases that change scan exceptions

The `leak-scan` pull-request check reads `packages/core/leak-scan-exceptions.json` from `main`,
never from the pull request, and fails any pull request that changes that file together with other
files ([CI security](ci-security.md#gating)). A new exception is therefore reviewed on its own
and lands before the content it admits. A release pull request gets no exemption: the publication
job's bot is not a bypass actor, and the check is not relaxed for `release/*` branches.

When an exported release changes the exceptions file, the publication job opens two draft pull
requests instead of one:

1. **`release/<tag>-exceptions`**: `main` plus only the exceptions change. Its `leak-scan` passes.
2. **`release/<tag>`**: the release, stacked on that exceptions commit. Its body says
   **Blocked by** and links the exceptions pull request. Its `leak-scan` fails with
   `changed together with other files` for as long as the exceptions commit is not on `main`.

The owner then:

1. Reviews every changed entry in the exceptions pull request against the content it admits in
   the release pull request, and merges it with **a merge commit**, not squash or rebase, so the
   exceptions commit reaches `main` unchanged.
2. Updates the release branch from `main` (GitHub's "Update branch"; the strict required-checks
   policy asks for it anyway). That push re-runs `leak-scan`, which now reads the new exceptions
   from `main` and no longer sees an exceptions change in the release pull request.
3. Marks the release pull request ready and merges it once every required check passes.

The publication job never overwrites a branch. Re-running it reuses both branches and both pull
requests when they hold exactly what it would push, and refuses otherwise. If the exceptions pull
request was squashed or rebased by mistake, the release branch still carries the original
exceptions commit and keeps failing `leak-scan`: delete the `release/<tag>` branch (which closes
its pull request) and re-run the publication job, which rebuilds the release on `main` without an
exceptions change. A release that leaves the exceptions file alone opens only `release/<tag>`, on
`main`.
