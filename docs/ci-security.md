# CI security

GitHub Actions validates every pull request and every push to `main` of the authoritative
repository through `.github/workflows/`. Because every pushed branch is public at once, clones
also run a local pre-push leak scan before anything leaves the machine
([Repository topology](repository-topology.md#every-pushed-branch-is-public)). Releases are
operator actions ([Releasing](releasing.md)).

## Workflows

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml` | push to `main`, pull requests, and as a reusable gate | `check:all` (verify, eval, every smoke and security suite, profile checks, the packed-tarball check and the clean install), lockfile integrity, the strict docs build, every profile on Linux and Windows, and the pi-compat matrix (floor must pass; the newest release looked at is advisory) |
| `security.yml` | push to `main`, pull requests, weekly, and as a reusable gate | CodeQL, Semgrep, gitleaks, dependency checks, OSV-Scanner, dependency review (pull requests), zizmor |
| `scorecard.yml` | push to `main`, weekly | OpenSSF Scorecard supply-chain rating |
| `release.yml` | manual (`workflow_dispatch`) only | Dry-run plan by default; creates a GitHub Release, and optionally publishes to npm, only when an operator unticks `dry-run` from a `v*` tag. See [Releasing](releasing.md) |
| `dependabot.yml` | weekly | Grouped updates with a 7-day cooldown for actions, npm (the root and the MCP servers under `packages/container/mcp-servers/`), pip (`requirements-docs.txt`), the container base image, the memory-mcp compose service and the Android Gradle build; pi minor releases and TypeScript majors are left to hand review |

`check:all` is the single definition of "the checks": it enumerates every `smoke:*` and `test:*`
script in `package.json`, plus `verify`, `eval`, `docs:check`, `docs:mermaid` and a `profile:check`
run per profile. It also fails on a test file that no script runs or that asserts nothing
(`smoke:wiring`), so a green run cannot hide a suite that is not running.

## Checks

| Area | Tool | Blocks on | Config |
|---|---|---|---|
| SAST | CodeQL, `security-extended` queries, JavaScript/TypeScript and Actions | Code-scanning alerts (branch protection) | `security.yml` |
| SAST | Semgrep: `p/javascript`, `p/typescript`, `p/nodejs`, `p/secrets`, `p/owasp-top-ten` | ERROR severity | `.semgrepignore` |
| Secrets | gitleaks over the full git history | Any finding | `.gitleaks.toml` (a line-level allowlist for synthetic test fixtures only) |
| Secrets, private data | `packages/core/prepush-scan.ts` as a local pre-push hook (not CI) | Private hosts, home paths, private addresses, key and token shapes, private paths in the pushed commits | `packages/core/leak-scan-exceptions.json`; `tests/prepush-scan-smoke.ts` |
| Secrets | GitHub secret scanning and push protection | A push containing a secret | repository settings |
| Dependencies | `npm audit` | High or critical | triage in [Supply chain](supply-chain.md) |
| Dependencies | `npm audit signatures` | A dependency with a missing or invalid registry signature or attestation | |
| Dependencies | OSV-Scanner | Known vulnerabilities (OSV database) in every manifest it recognises in the tree: `package-lock.json`, the MCP server lockfiles and `requirements-docs.txt` | `security.yml` (`--recursive`) |
| Dependencies | Dependency review (pull requests) | A new dependency with a high-severity advisory | `security.yml` |
| Lockfile | `packages/core/lockfile-check.ts` | A package resolved from anywhere but the npm registry, a missing sha512 hash, or an unreviewed install script | allowlist in the script |
| Workflows | zizmor | Template injection, over-broad permissions, credential persistence, cache poisoning, unpinned actions | |
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
- The release jobs use no dependency cache, run in the protected `npm` environment where they
  publish, and only act on a tag whose commit is on `main` and matches `package.json`.
- Scanner binaries are either pinned container images or downloads verified against a pinned
  SHA-256.

## Repository settings the workflows depend on

Workflows cannot switch these on, and nothing in this repository changes them; someone with
administrator rights sets them once (Settings, Code security).

| Setting | Needed by | Without it |
|---|---|---|
| **Dependency graph** | `dependency-review` (pull requests) | The job fails at once with "Dependency review is not supported on this repository" |
| **Code scanning** (SARIF upload) | CodeQL, Semgrep, OSV-Scanner, zizmor and Scorecard results | The upload step fails, or the results have nowhere to go |
| **Secret scanning and push protection** | the "GitHub secret scanning" row above | A pushed secret is not blocked at the push |
| **Private vulnerability reporting** | `SECURITY.md`, which asks reporters to use it | Reporters have no private channel |
| **Branch protection on `main`** with the checks above as required | the whole gate | A red check does not stop a merge |
| **The `npm` environment and npm trusted publisher** | the optional npm publish in `release.yml` | The publish job cannot run (by design, nothing else is affected) |

`scorecard.yml` publishes its result to the OpenSSF Scorecard service (`publish_results: true`) on
pushes to `main` and weekly. Set that to `false`, or remove the workflow, if that is not wanted.

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

- **gitleaks**: add a regex matching the exact fixture line to `.gitleaks.toml` with a comment
  naming the file. Never allowlist a whole file or path.
- **Semgrep**: prefer an inline `// nosemgrep: <rule-id>` with the full rule ID as Semgrep reports it (for example `typescript.react.security.react-insecure-request.react-insecure-request`; a shortened name suppresses nothing) with a comment explaining why the code
  is safe; use `.semgrepignore` only for whole trees that are not shipped code.
- **Install scripts**: read the script, then add the package to `INSTALL_SCRIPT_ALLOWLIST` in
  `packages/core/lockfile-check.ts` with a one-line summary of what it does.
