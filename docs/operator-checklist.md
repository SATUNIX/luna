# Operator checklist

Actions only the repository owner takes. An agent must not take any of them: agents never change
repository or account settings, push tags, publish, or merge ([Releasing](releasing.md)). Several
controls in [Security controls](security-controls.md) depend on these settings being in place,
and no test in this repository can see them. Record the result of each change (the settings'
JSON) as evidence.

## Repository settings (GitHub)

`.github/expected-settings.json` is the declared policy: each item below is a field there. Apply
the setting in GitHub first, then change the file in a reviewed pull request; never the other way
round.

- [ ] **`main` ruleset**: pull requests with one approving review, code-owner review, approval of
  the last push, stale reviews dismissed, review threads resolved; force pushes and deletion
  blocked; the owner may bypass only through a pull request (`rulesets[main].rules.pull_request`,
  `bypass_actors`).
- [ ] **Required checks** on `main`: exactly the `required_status_checks` list, bound to the
  GitHub Actions app (and the CodeQL check to code scanning), with the strict
  up-to-date policy. `ci-complete` stands for every job in `ci.yml`, so a new CI job needs no
  ruleset change.
- [ ] **Code-scanning merge protection**: the `code_scanning` rule with the thresholds listed for
  CodeQL, Semgrep OSS, OSV-Scanner and zizmor.
- [ ] **Release tags**: only the owner creates, updates or deletes `v*` tags (`rulesets[release-tags]`).
- [ ] **Actions**: only selected actions, SHA pinning required, and exactly the
  `actions.patterns_allowed` list; the default workflow token read-only, and Actions unable to
  approve pull requests (`workflow_permissions`). Bump procedure:
  [CI security](ci-security.md#allowed-actions).
- [ ] **Fork pull requests** need approval to run workflows for all external contributors
  (`fork_pr_approval_policy`).
- [ ] **Security and analysis**: secret scanning, push protection, non-provider patterns, validity
  checks, Dependabot alerts and Dependabot security updates (`security_and_analysis`,
  `vulnerability_alerts`), and private vulnerability reporting for `SECURITY.md`.
- [ ] **The `npm` environment**, before any npm publication: a required reviewer and a deployment
  policy for `v*` tags (`environments.npm`). Bind the npm trusted publisher to it
  ([Releasing](releasing.md#npm-publication-optional)).
- [ ] **Bot and App identities**: each has only the permissions its job needs, is not a bypass
  actor, and cannot approve pull requests. Agents push as such an identity, never as the owner.
- [ ] **Stray branches**: review and delete branches nobody owns.

Before each release, compare the live settings with `.github/expected-settings.json` using the
maintainers' read-only drift check, run with an administrator's login, and keep its JSON output
with the release.

## Release credentials and publication

Releases are prepared directly in GitHub `SATUNIX/luna`, the only repository
([Releasing](releasing.md#cutting-a-release)). The GitLab mirror and private-lineage export
pipeline are archived.

- [ ] **Agent forge credentials are least privilege**: contents and pull-request write access
  only, no administration or runner scopes, and never an administrator's token. Administrators
  use two-factor authentication.
- [ ] **Only the operator tags and publishes.** Review the release branch through a pull request,
  then run the manual release workflow first as a dry run
  (`tests/release-plan-smoke.ts`, `tests/release-workflow-smoke.ts`).

## Each release

The release steps are in [Releasing](releasing.md#cutting-a-release). In addition:

- [ ] The release pull request had a human approval and every required check passed.
- [ ] If the release changes the scan exceptions, an exceptions-only pull request was
  reviewed entry by entry and merged first; the release
  branch was then updated from `main` and its `leak-scan` re-ran and passed. `leak-scan` is never
  bypassed or made optional for a release
  ([Releasing](releasing.md#releases-that-change-scan-exceptions)).
- [ ] The release workflow ran first as a dry run, and its plan was read.
- [ ] Open Dependabot and code-scanning alerts were triaged
  ([Vulnerability management](vulnerability-management.md)), and the risk-acceptance register is
  current.

## Remote control and the consoles

- [ ] Bind the remote host to `tailscale` or `loopback` (`PI_REMOTE_BIND`) unless every-interface
  access is needed ([Remote control](remote-control.md#settings)).
- [ ] Turn on the app lock on each linked phone; it is off by default.
- [ ] Review `/remote devices` from time to time and revoke phones you no longer use.

## After an incident

Follow [Incident response](incident-response.md); rotating a leaked credential always comes first.
