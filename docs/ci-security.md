# CI security

GitHub Actions validates every pull request and every push to `main` of the authoritative
repository through `.github/workflows/`. Because every pushed branch is public at once, clones
also run a local pre-push leak scan before anything leaves the machine
([Repository topology](repository-topology.md#every-pushed-branch-is-public)). Releases are
operator actions ([Releasing](releasing.md)).

## Workflows

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml` | push to `main`, pull requests, and as a reusable gate | `check:all` (verify, eval, every smoke and security suite, profile checks, the packed-tarball check and the clean install), lockfile integrity, the strict docs build, every profile on Linux and Windows, the pi-compat matrix at the supported floor and the last pi 0.x release (both must pass), and the Android build with Gradle wrapper validation; `ci-complete` succeeds only when every other job did (`tests/workflow-policy-smoke.ts` checks it needs them all) |
| `security.yml` | push to `main`, pull requests, weekly, and as a reusable gate | CodeQL, Semgrep, gitleaks, dependency checks, OSV-Scanner, dependency review (pull requests), zizmor |
| `scorecard.yml` | push to `main`, weekly | OpenSSF Scorecard supply-chain rating, published; it fails nothing |
| `scorecard-thresholds.yml` | weekly, manual | Runs Scorecard again without publishing and fails when a gating check scores below its floor in `.github/scorecard-thresholds.json` |
| `release.yml` | manual (`workflow_dispatch`) only | Dry-run plan by default; creates a GitHub Release, and optionally publishes to npm, only when an operator unticks `dry-run` from a `v*` tag. See [Releasing](releasing.md) |
| `dependabot.yml` | weekly | Grouped updates with a 7-day cooldown for actions, npm (the root and the MCP servers under `packages/container/mcp-servers/`), pip (`requirements-docs.txt`), the container base image, the memory-mcp compose service and the Android Gradle build; pi minor releases and TypeScript majors are left to hand review |

`check:all` is the single definition of "the checks": it enumerates every `smoke:*` and `test:*`
script in `package.json`, plus `verify`, `eval`, `docs:check`, `docs:mermaid` and a `profile:check`
run per profile. It also fails on a test file that no script runs or that asserts nothing
(`smoke:wiring`), so a green run cannot hide a suite that is not running.

## Checks

| Area | Tool | Blocks on | Config |
|---|---|---|---|
| SAST | CodeQL, `security-extended` queries, JavaScript/TypeScript and Actions | A failed analysis fails the `codeql` job; alerts block a merge only through the declared code-scanning merge protection ([Gating](#gating)) | `.github/codeql/codeql-config.yml` |
| SAST | Semgrep: `p/javascript`, `p/typescript`, `p/nodejs`, `p/secrets`, `p/owasp-top-ten` | ERROR severity; results of every severity are uploaded, and suppressed ones are listed in the job summary | `.semgrepignore` |
| Secrets | gitleaks over the full git history | Any finding | `.gitleaks.toml` (allowlists for synthetic fixture lines, each bound to named files) |
| Secrets, private data | `packages/core/prepush-scan.ts` as a local pre-push hook, and the `leak-scan` pull-request job in `security.yml` with the same rules | Private hosts, home paths, private addresses, key and token shapes, private review and roadmap item IDs, private paths in the pushed commits; a match admitted only by an exception the same commits add; an exceptions change mixed with other files | `packages/core/leak-scan-exceptions.json`; `tests/prepush-scan-smoke.ts` |
| Secrets | GitHub secret scanning and push protection | A push containing a secret | repository settings |
| Dependencies | `npm audit`, at the root and in every other lockfile `lockfile-check --list` reports | High or critical | triage in [Vulnerability management](vulnerability-management.md) |
| Dependencies | `npm audit signatures` | A dependency with a missing or invalid registry signature or attestation | |
| Dependencies | OSV-Scanner | Known vulnerabilities (OSV database) in every manifest it recognises in the tree: every npm lockfile and `requirements-docs.txt`; a scanner error fails the job | `security.yml` (`--recursive`) |
| Dependencies | Dependency review (pull requests) | A new dependency with a high-severity advisory | `security.yml` |
| Lockfile | `packages/core/lockfile-check.ts` | A package resolved from anywhere but the npm registry, a missing sha512 hash, or an unreviewed install script; `--list`, which the per-lockfile audit loops walk, fails when it finds no lockfile (`tests/lockfile-check-smoke.ts`) | allowlist in the script |
| Workflows | zizmor | Template injection, over-broad permissions, credential persistence, cache poisoning, unpinned actions | |
| Workflows | `tests/workflow-policy-smoke.ts`, in `check:all` (the private lineage's pipeline has its own structure test from the same list) | A gate that fails open: `continue-on-error` (one reviewed advisory flag), `allow_failure` in any form but `false` (including `exit_codes:`), or a shell idiom that hides a failure (a command or-ed with `true`, `:`, `exit 0` or `echo`, or `set +e`) | `tests/ci-fail-open.ts` |
| Package | `packages/core/pack-check.ts` | A missing required file, a leaked private file, an oversize tarball, a profile that does not resolve from the tarball | |
| Install | `tests/clean-install-smoke.ts` | The packed tarball failing to install for a profile, or the real pi failing to load it | |
| Release | `tests/release-workflow-smoke.ts` | A release workflow that could publish or create a release on a dry run | |

## Hardening in the workflows

- Every action is pinned to a full commit SHA (with the version in a comment); Dependabot bumps
  them.
- The default token is read-only (`permissions: contents: read`); a job that needs more asks for it
  itself. Only the release jobs get `contents: write` (to create a GitHub Release) or
  `id-token: write` (npm trusted publishing), and only behind the explicit `dry-run == false` guard.
- `actions/checkout` never persists credentials.
- `npm ci --ignore-scripts` everywhere: no dependency lifecycle script runs in CI.
- The release jobs use no dependency cache and only act on a tag whose commit is on `main` and
  matches `package.json`. The npm publish job names the `npm` environment; that environment's
  protection rules are a repository setting ([Repository settings](#repository-settings)).
- Scanner binaries are either pinned container images or downloads verified against a pinned
  SHA-256.

## Gating

What each control does when it finds something. The "Blocks a merge to `main` (declared)" column
is the declared target: the `main` ruleset in `.github/expected-settings.json` lists the job's
check, so once that ruleset is applied a merge waits for it. It is not a statement about the live
repository. GitHub enforces only the settings an administrator has applied, so until the owner
applies the declared ruleset ([Operator checklist](operator-checklist.md#repository-settings-github)),
a "Yes" there may not block anything today; the maintainers' read-only drift check compares the
live ruleset with the file ([Repository settings](#repository-settings)). The release
column is the `gate` and `security` jobs of `release.yml`, which run the whole of `ci.yml` and
`security.yml` for the release commit (`tests/release-workflow-smoke.ts`). The owner triages
everything that reaches the Security tab ([Vulnerability management](vulnerability-management.md)).

| Control | Fails its job | Blocks a merge to `main` (declared) | Blocks a release | Reaches the Security tab |
|---|---|---|---|---|
| `check:all`, docs build, every profile on Linux and Windows, both pi-compat lanes, Android build | Yes | Yes, through the required `ci-complete` | Yes | No |
| CodeQL (`codeql` job) | When the analysis fails | Yes (`codeql`, and the code-scanning `CodeQL` check for new alerts in changed lines) | Yes | Yes, every alert |
| Semgrep | ERROR severity | Yes (`semgrep`) | Yes | Yes, every unsuppressed result |
| gitleaks, full history | Any finding | Yes (`gitleaks`) | Yes | No |
| Leak scan of a pull request's commits | Any finding | Yes (`leak-scan`, pull requests only) | No: it runs on pull requests only. A release pull request is held to it like any other: when the release changes the scan exceptions, it fails until a separate exceptions-only pull request has merged ([Releasing](releasing.md#releases-that-change-scan-exceptions)) | No |
| `npm audit`, `npm audit signatures`, `lockfile-check`, every lockfile | High or critical advisory, bad signature, lockfile rule | Yes (`dependencies`) | Yes | No |
| OSV-Scanner, whole tree | Any known vulnerability, or a scanner error | Yes (`osv-scanner / osv-scan`) | Yes | Yes |
| Dependency review | A new dependency with a high-severity advisory or a licence outside the allowlist | Yes (`dependency-review`, pull requests only) | No | No |
| zizmor | Any finding not ignored in `.github/zizmor.yml` | Yes (`zizmor`) | Yes | Yes |
| Code-scanning merge protection | n/a | Declared (`code_scanning` in the ruleset): an open alert at or above the threshold for CodeQL, Semgrep OSS, OSV-Scanner or zizmor blocks the merge | No | n/a |
| Scorecard (`scorecard.yml`) | Never | No | No | Yes, only there |
| Scorecard thresholds (`scorecard-thresholds.yml`) | A gating check below its floor | No: it runs weekly, so a new advisory turns the scheduled run red without blocking unrelated merges | No | No |
| Dependabot alerts and security updates | n/a | No: an update pull request is gated like any other | No | Yes |
| GitHub secret scanning and push protection | n/a | Blocks the push itself | n/a | Yes |
| Pre-push leak hook | Refuses the push locally | No: `--no-verify` skips it, which is why `leak-scan` repeats it | No | No |

Whether a "Yes" or "Declared" entry in that column is enforced is a repository setting
([Repository settings](#repository-settings)): the column describes `.github/expected-settings.json`,
not the live ruleset.

## Scorecard and OSV

OSV-Scanner is a gate: it scans every manifest in the tree (`--recursive`), and the reusable
workflow it is pinned to fails the job when the scanner itself errors, so a crash is never a
pass. `tests/scan-coverage-smoke.ts` keeps every lockfile and manifest inside what OSV and
Dependabot see.

OpenSSF Scorecard is a posture rating, not a test. `scorecard.yml` exits successfully whatever
the score and publishes its result; several of its checks (fuzzing, code review history,
maintenance, the OpenSSF badge) describe the repository rather than a change, and can fail with
no CI job behind them. Making it a required check would block unrelated pull requests on a
score. Instead, `scorecard-thresholds.yml` runs it weekly against floors for the checks that a
change can move (`Vulnerabilities`, `Dangerous-Workflow`, `Token-Permissions`,
`Pinned-Dependencies`); a check that cannot be scored fails. Raising a floor is routine; lowering
one is a reviewed change with its reason in `.github/scorecard-thresholds.json`. Nothing tests the
threshold script itself.

## Fail-closed scanners

A scanner or check that cannot do its job fails; it never reports a pass over nothing.

- `check:all` exits 2 on a `--skip` name that is no check (`tests/check-all-npm-smoke.ts`) or when
  everything is skipped (`packages/core/check-all.ts`; nothing tests that case), and fails on a
  test no script runs or that asserts nothing (`tests/wiring-smoke.ts`).
- `lockfile-check --list` fails when it finds no lockfile, and the audit loops capture its output
  with a checked assignment before looping (`tests/lockfile-check-smoke.ts`,
  `tests/scan-coverage-smoke.ts`).
- OSV-Scanner fails on a scanner error (above).
- No gating step uses `continue-on-error` (one reviewed exception: the advisory flag of a pi-compat
  matrix lane, which is `false` on every lane), `|| true`, `|| :`, `|| exit 0`, `|| echo` or
  `set +e` (`tests/workflow-policy-smoke.ts`, from the shared list in `tests/ci-fail-open.ts`).
- `ci-complete` treats any result but `success` of a job it needs, including `skipped` and
  `cancelled`, as a failure.

## Manifest coverage

Every dependency manifest the repository tracks is watched and scanned: each npm lockfile, pip
requirements file, Gradle build, Dockerfile or Containerfile, and compose file that pulls a
registry image has a Dependabot entry for its ecosystem and directory; OSV scans the whole tree;
and every npm lockfile is one `lockfile-check --list` reports, which is the list the audit loops
walk. `tests/scan-coverage-smoke.ts` fails when a manifest is added without that coverage. The
policy for what may be added, and how updates are adopted, is in
[Supply chain](supply-chain.md#update-policy).

## Suppression policy

Every suppression is listed with its reason in `packages/core/scan-suppressions.json`, and
`tests/suppression-inventory-smoke.ts` fails on an unlisted one and on a listed one that no longer
exists. `.github/CODEOWNERS` gives the inventory, `.gitleaks.toml`, `.semgrepignore`, the CodeQL
configuration and `.github/zizmor.yml` to the owner.

| Kind | Allowed for | Not allowed |
|---|---|---|
| `// nosemgrep: <rule-id>` | One line of shipped code that a rule misreads, with the full rule ID as Semgrep reports it (a shortened name suppresses nothing) and a comment saying why the code is safe | A bare `nosemgrep`; suppressing a true finding |
| `.semgrepignore` | Whole trees that are not shipped code (`docs/`, `tests/`, build output) | Any shipped source file |
| `eslint-disable-next-line <rule> -- <reason>` | One line, with a reason; counts against a ceiling (`tests/typescript-coverage-smoke.ts`) | File-wide disables; disabling the security bans to ship code |
| The TypeScript expect-error directive | Tests only, proving a runtime check refuses a wrong type | `@ts-ignore` anywhere |
| CodeQL `paths-ignore` and query filters | Test trees and generated output; a query switched off names its one known site | Ignoring a shipped path |
| gitleaks `[[allowlists]]` | Synthetic fixture lines, bound to named files with `condition = "AND"` | A path-only or pattern-only allowlist |
| `zizmor: ignore[...]` and `.github/zizmor.yml` | A finding that is the purpose of the step, with a comment | Template injection or credential persistence |
| Leak-scan exceptions (`packages/core/leak-scan-exceptions.json`) | A synthetic fixture line, pinned by the SHA-256 of the match and of the line, in a pull request of its own, releases included (`tests/prepush-scan-smoke.ts`; [Releasing](releasing.md#releases-that-change-scan-exceptions)) | Adding the exception and the content it admits in one pull request |
| `INSTALL_SCRIPT_ALLOWLIST` in `packages/core/lockfile-check.ts` | An install script that has been read, with a one-line summary | An unread script |

Semgrep's suppressed results are taken out of the uploaded SARIF, so a reviewed suppression does
not reopen as an alert, and every one of them is listed in the job summary, so none is
invisible. Adding or removing a Semgrep rule pack is a change to `security.yml`, reviewed like any
other.

## Allowed actions

The repository lets workflows run only GitHub's own actions and the third-party actions listed
SHA-exact in its settings; `.github/expected-settings.json` (`actions.patterns_allowed`) mirrors
that list. `tests/pin-allowlist-smoke.ts` fails when a workflow uses a third-party SHA the list
does not name, or the list keeps one nothing uses. To bump a third-party action:

1. Read the new release and its diff, and find the full commit SHA of the tag (and of any action
   it calls, which `actions.indirect` records).
2. An administrator adds the new SHA to the repository's allowed actions **first**, keeping the
   old one, so pull requests on either version can run.
3. In one pull request, change the `uses:` line (SHA with the version in a comment) and
   `actions.patterns_allowed`, replacing the old SHA. `tests/pin-allowlist-smoke.ts` passes only
   when both agree.
4. After it merges, the administrator removes the old SHA from the settings.

Dependabot proposes action bumps weekly with a 7-day cooldown; its pull request fails
`smoke:pin-allowlist` until the expected file is updated, which is what makes step 2 deliberate.

## Repository settings

Workflows cannot change repository settings, and nothing in this repository does.
`.github/expected-settings.json` is the declared policy; an administrator applies it in GitHub,
which is where it is enforced, and then changes the file in a reviewed pull request. A maintainer
drift check compares the live settings with the file using read-only requests; it needs an
administrator's login, because several settings are visible only to administrators. The
[Operator checklist](operator-checklist.md) lists the steps.

| Setting | Field in `.github/expected-settings.json` | What depends on it |
|---|---|---|
| Review on `main`: one approval, code-owner review, approval of the last push, stale reviews dismissed, threads resolved | `rulesets[main].rules.pull_request` | No change reaches `main`, the `next` channel, without a person; `.github/CODEOWNERS` paths need the owner |
| Required checks, strict | `rulesets[main].rules.required_status_checks` | The [Gating](#gating) table's "Blocks a merge to `main` (declared)" column, once applied |
| Code-scanning merge protection | `rulesets[main].rules.code_scanning` | Security-tab alerts blocking a merge |
| Force push and deletion blocked on `main` | `rulesets[main].rules.non_fast_forward`, `rulesets[main].rules.deletion` | History of the `next` channel |
| Owner bypass only through a pull request | `rulesets[main].bypass_actors` | Nobody pushes to `main` directly |
| Release tags created only by the owner | `rulesets[release-tags]` | The `latest` channel ([Releasing](releasing.md)) |
| Allowed actions, SHA pinning required | `actions` | [Allowed actions](#allowed-actions) |
| Read-only default token; Actions cannot approve pull requests | `workflow_permissions` | Least privilege for every job |
| Approval for fork pull-request workflows | `fork_pr_approval_policy` | Untrusted workflows do not run unreviewed |
| Secret scanning, push protection, non-provider patterns, validity checks | `security_and_analysis` | The push-protection row in [Gating](#gating) |
| Dependabot alerts and security updates | `vulnerability_alerts`, `security_and_analysis` | Alerts on `main` ([Vulnerability management](vulnerability-management.md)) |
| The `npm` environment: required reviewer, `v*` tags only | `environments.npm` | The optional npm publish in `release.yml` |

These are not in the file and are set once: the dependency graph (`dependency-review` fails
without it), code scanning (the SARIF uploads), and private vulnerability reporting (the route
`SECURITY.md` gives). `scorecard.yml` publishes its result to the OpenSSF Scorecard service
(`publish_results: true`); set that to `false`, or remove the workflow, if that is not wanted.

## Running the checks locally

```sh
npm run check:all
npm run security:lockfile
npm audit signatures && npm audit --audit-level=high
gitleaks git --redact .                          # https://github.com/gitleaks/gitleaks
semgrep scan --config p/javascript --config p/typescript --config p/nodejs --config p/secrets --config p/owasp-top-ten
zizmor .github/workflows                          # pipx install zizmor
```

## What CodeQL and zizmor leave out

Both read a config file, so the exclusions are reviewed with the code and stay narrow.

**CodeQL** (`.github/codeql/codeql-config.yml`, read by the `init` step of the `codeql` job):

- *Paths ignored*: the test suites (`tests/`, `packages/*/tests/`, `packages/*/scripts/`, `packages/core/eval/`), the built
  `site/` and `node_modules/`. The tests do on purpose what the queries look for (fake upstreams that write what they receive,
  a probe that turns certificate checks off to test a TLS tunnel, temp files, synthetic credentials), and none of it is in the
  package or the git install's runtime path. Everything that ships stays in scope.
- *Queries switched off*, each with one known site and a reason in the file:
  `js/insufficient-password-hash` (a SHA-256 of an environment variable's name, and a fingerprint of a random provider key that
  an in-container probe compares against; neither is a stored password),
  `js/file-access-to-http` (the web console's authenticated probe sends the console's own token to the console's own address) and
  `js/http-to-file-access` (the web console's agent editor writes the agent file its authenticated user asked for, under a
  validated name inside the agents directory). Switching a query off hides a new instance of it too, so revisit these when
  either site changes.

**zizmor** (`.github/zizmor.yml` and one inline comment):

- `adhoc-packages` on the `pi-compat` install step in `ci.yml`: installing a pi version outside the lockfile is what that job is
  for. The version is a literal from the job's matrix and reaches the command through an environment variable.
- `self-repository` on the release workflow's `uses: ./.github/workflows/ci.yml`: the `./` form is the one GitHub documents for a
  reusable workflow in the same repository.

No test pins these exclusions: the `codeql` and `zizmor` jobs apply them, and a change to either file shows in the diff.

## Not run in CI

The container-boundary probe for autonomous runs (`packages/autonomy/tests/boundary-probe.ts`)
and the container capability scripts under `packages/container/capability/tests/` need a
container engine and are run by the operator. `check:all` lists them as manual-only, with the
reason, in `packages/core/lib/wiring.ts`. Windows is exercised by the per-profile install check
only; the full suite runs on Linux.

## Adding an allowlist entry

Follow the [Suppression policy](#suppression-policy), and add the entry to
`packages/core/scan-suppressions.json` in the same change:

- **gitleaks**: add an `[[allowlists]]` block to `.gitleaks.toml` with `condition = "AND"`, the
  named file in `paths` and a regex matching the exact fixture line in `regexes`.
- **Semgrep**: prefer an inline `// nosemgrep: <rule-id>` with the full rule ID as Semgrep reports
  it (for example `typescript.react.security.react-insecure-request.react-insecure-request`) and a
  comment explaining why the code is safe; use `.semgrepignore` only for whole trees that are not
  shipped code.
- **Install scripts**: read the script, then add the package to `INSTALL_SCRIPT_ALLOWLIST` in
  `packages/core/lockfile-check.ts` with a one-line summary of what it does.
