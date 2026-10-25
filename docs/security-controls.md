# Security controls

This catalogue lists every security control in this repository, where it lives, the test that
pins it, the npm script that runs that test, the CI job that runs the script and the required
check that job reports to. The [threat model](threat-model.md) names the control for each trust
boundary by its ID here, and the [secure development standard](security-standard.md) says which
controls a change has to keep green.

How to read the columns:

- **Code** is the file that implements the control (the first one, where there are several).
- **Test** is the file that fails when the control stops working. "None" means nothing in this
  repository tests it, and the row says what does enforce it.
- **npm script** is the script that runs the test. `check:all` runs every `smoke:*` and `test:*`
  script, so any row with a script here runs in the `verify` job of `ci.yml`.
- **CI job** is `<workflow>:<job>` under `.github/workflows/`.
- **Required check** is the status-check context the `main` ruleset in
  `.github/expected-settings.json` requires. `ci-complete` succeeds only when every job of
  `ci.yml` succeeded. "No" means the job runs but no required check depends on it. Whether GitHub
  enforces what that file declares is a repository setting, not something a test can see
  ([CI security](ci-security.md#repository-settings)).

`tests/security-docs-smoke.ts` (`npm run smoke:security-docs`) reads this table and fails when a
named file, test, script, workflow job or required check does not exist, or when a required
check is not one `.github/expected-settings.json` declares.

## Agent boundary (the kit)

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-01 | Shell commands are parsed into effects; a construct the parser does not model, or a wrapper option it does not know, is opaque and never runs unasked | `packages/extensions/src/tool-firewall/shell.ts` | `tests/firewall-shell-smoke.ts` | `smoke:firewall-shell` | `ci.yml:verify` | `ci-complete` |
| C-02 | What bash really executes is a parsed segment or reported as opaque (an exec-trace oracle over a benign corpus) | `packages/extensions/src/tool-firewall/shell.ts` | `tests/firewall-exec-oracle-smoke.ts` | `smoke:firewall-exec-oracle` | `ci.yml:verify` | `ci-complete` |
| C-03 | An unknown executable is medium, not low; agent CLIs are recognised by identity, including path launches and moved homes | `packages/extensions/src/tool-firewall/classify.ts` | `tests/firewall-shell-smoke.ts` | `smoke:firewall-shell` | `ci.yml:verify` | `ci-complete` |
| C-04 | Writes to anything pi autoloads without a trust prompt, and the operator-authority files, are safety-control changes, including from inline interpreter code that names one next to a write-capable call as a literal, an `expanduser`-wrapped literal or one of the common home-relative compositions the corpus tests; secret ones are credential reads. A coarse, fail-closed rule shared with C-06 also rates high inline code run by a listed interpreter family (Python, Node and its TypeScript aliases, Deno, Bun, Perl, Ruby, PHP, Lua, awk, R, Julia, JVM, Swift, Elixir/Erlang, Lisp and others; `docs/security.md` item 12 has the full lists), including behind the listed wrappers (`env`, `sudo`, `timeout`, `xargs`, `npx`, `pnpm exec`, `uvx`, `pipx run` and others) and inside `sh`/`bash`/`zsh`/`dash`/`ksh`/`mksh`/`fish`/`ash`/`busybox sh` command lines and here-strings and `eval`, and behind a command word that is a variable, substitution or glob (`$PY`, `pytho?`), after reserved words and grouping (`{`, `!`, `if`/`then`, `while`/`do`, `coproc`) and with no-space redirects (`python3<<<'…'`) or pipes that also carry stderr, when the command text mentions an agent-configuration segment or a distinctive tail such as `agent/settings.json` next to any write- or exec-capable call (it may over-block such code; that is intended). A parse-free backstop applies the same rating to any command line that mentions agent configuration, has a write- or exec-capable word and names a listed interpreter, shell or wrapper anywhere as a word (also next to shell metacharacters, through glob characters or quotes); it over-blocks a single command line that combines all three, such as a script run or a commit message, which is intended fail-closed behaviour. Residual risk: a path computed entirely at runtime with no distinctive segment or tail in the command text, an unlisted interpreter or wrapper whose name is not in the command text, or code run from a script file, is not recognised and can be rated low or medium; approval prompts and the sandbox and container profiles are the boundary there | `packages/extensions/src/tool-firewall/classify.ts`, `packages/core/shared/inline-guard.ts` | `tests/firewall-autoload-smoke.ts`, `tests/firewall-shell-smoke.ts` | `smoke:firewall-autoload`, `smoke:firewall-shell` | `ci.yml:verify` | `ci-complete` |
| C-05 | Every path-like tool parameter is path-checked | `packages/extensions/src/tool-firewall/classify.ts` | `tests/firewall-path-fields-smoke.ts` | `smoke:firewall-path-fields` | `ci.yml:verify` | `ci-complete` |
| C-06 | protected-paths blocks writes to control files as a second layer, from the same write corpus, including plain `touch`, `truncate`, `rm`, `unlink`, `chmod` and `chown` on one, and inline interpreter code that names one in the literal or common home-relative spellings the corpus tests; the fail-closed inline rule shared with C-04 also blocks inline code run by the same listed interpreter families, wrappers and shells when it mentions an agent-configuration segment or distinctive tail next to any write- or exec-capable call (it may over-block such code; that is intended), and the shared parse-free backstop blocks any command line that mentions agent configuration, has a write- or exec-capable word and names a listed interpreter, shell or wrapper anywhere, over-blocking a script run or commit message that combines all three (intended fail-closed behaviour). Residual risk: a path computed entirely at runtime with no distinctive segment or tail in the command text, an unlisted interpreter or wrapper whose name is not in the command text, or code run from a script file, is not recognised and not blocked; approval prompts and the sandbox and container profiles are the boundary there | `packages/extensions/third_party/protected-paths/index.ts`, `packages/core/shared/inline-guard.ts` | `tests/protected-paths-corpus-smoke.ts` | `smoke:protected-paths-corpus` | `ci.yml:verify` | `ci-complete` |
| C-07 | The firewall sees the exact object that will execute, and decides parallel calls before any runs | `packages/extensions/src/tool-firewall/index.ts` | `tests/firewall-preauth-smoke.ts` | `smoke:firewall-preauth` | `ci.yml:verify` | `ci-complete` |
| C-08 | Approvals are scoped to the action, workspace, directory and session, expire, and can be revoked | `packages/extensions/src/tool-firewall/approvals.ts` | `tests/firewall-approvals-smoke.ts` | `smoke:firewall-approvals` | `ci.yml:verify` | `ci-complete` |
| C-09 | Unattended mode counts contract provenance only in the initial user namespace, and fails closed elsewhere | `packages/extensions/src/tool-firewall/unattended.ts` | `tests/firewall-unattended-smoke.ts` | `smoke:firewall-unattended` | `ci.yml:verify` | `ci-complete` |
| C-10 | Human-console answers carry an HMAC over the request digest and decision; only the interactive console creates the key | `packages/extensions/src/human-console/console-auth.ts` | `tests/human-console-auth-smoke.ts` | `smoke:human-console-auth` | `ci.yml:verify` | `ci-complete` |
| C-11 | Every child agent starts with its parent's protections and fails closed when one is missing | `packages/extensions/src/delegation-guard/index.ts` | `tests/delegation-guard-smoke.ts` | `smoke:delegation-guard` | `ci.yml:verify` | `ci-complete` |
| C-12 | Every profile loads the mandatory protections, or records why not | `packages/core/lib/protection-coverage.ts` | `tests/profile-protections-smoke.ts` | `smoke:profile-protections` | `ci.yml:verify` | `ci-complete` |
| C-13 | secret-guard blocks secret files, secret content and shell commands that leak them | `packages/extensions/src/secret-guard/index.ts` | `tests/secret-guard-smoke.ts` | `smoke:secret-guard` | `ci.yml:verify` | `ci-complete` |
| C-14 | The shipped firewall policy is default-deny, and its destructive patterns cover the pentest gate's | `packages/core/verify.ts` | `packages/core/verify.ts` | `verify` | `ci.yml:verify` | `ci-complete` |

## Secure development helpers

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-15 | Workspace state writes never follow a committed symbolic link | `packages/core/shared/safe-fs.ts` | `tests/workspace-symlink-smoke.ts` | `smoke:workspace-symlink` | `ci.yml:verify` | `ci-complete` |
| C-16 | Generated copies of the shared helpers match their source | `packages/core/gen-shared.ts` | `tests/redaction-corpus-smoke.ts` | `smoke:redaction-corpus` | `ci.yml:verify` | `ci-complete` |
| C-17 | One linear secret-redaction table for everything the kit stores | `packages/core/shared/redact.ts` | `tests/redaction-corpus-smoke.ts` | `smoke:redaction-corpus` | `ci.yml:verify` | `ci-complete` |
| C-18 | A regular expression from repository content is checked before it is compiled | `packages/core/shared/safe-regex.ts` | `tests/skill-routing-smoke.ts` | `smoke:skill-routing` | `ci.yml:verify` | `ci-complete` |
| C-19 | Lint bans: no shell spawning, `exec`, `vm`, `eval`, HTML sinks, raw extension writes, non-literal `RegExp` or casts of parsed JSON outside reviewed allowlists | `eslint.config.ts` | `tests/typescript-coverage-smoke.ts` | `test:lint` | `ci.yml:verify` | `ci-complete` |
| C-20 | Untrusted JSON is checked by guards before use | `packages/core/lib/guard.ts` | `tests/untrusted-input-guards-smoke.ts` | `smoke:untrusted-input-guards` | `ci.yml:verify` | `ci-complete` |
| C-21 | Records built from untrusted keys use a null prototype | `packages/extensions/src/tool-capture/store.ts` | `tests/tool-capture-smoke.ts` | `smoke:tool-capture` | `ci.yml:verify` | `ci-complete` |
| C-22 | A restored settings file is written through an exclusive 0600 temporary file under a random name, never briefly readable by others | `packages/core/lib/profiles.ts` | `tests/profile-transaction-smoke.ts` | `smoke:profile-transaction` | `ci.yml:verify` | `ci-complete` |
| C-23 | Shared temporary roots are per user, mode 0700, and a link or foreign owner is refused | `packages/extensions/src/branch-lab/index.ts` | `tests/branch-lab-smoke.ts` | `smoke:branch-lab` | `ci.yml:verify` | `ci-complete` |
| C-24 | A network client refuses to send a credential over plain HTTP to a non-loopback host and caps response size | `packages/extensions/src/memory-mem0/index.ts` | `tests/memory-mem0-smoke.ts` | `smoke:memory-mem0` | `ci.yml:verify` | `ci-complete` |
| C-61 | An install marker never chooses the installer `/profile` and the first-run auto-profile run, or the web UI server `/console` and the remote-control host spawn: a `kitSource` that is relative, resolves inside the workspace or is not a kit by package name is ignored with a warning | `packages/core/shared/kit-source.ts` | `tests/kit-root-trust-smoke.ts` | `smoke:kit-root-trust` | `ci.yml:verify` | `ci-complete` |

## Consoles and remote control

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-25 | The web console needs a bearer token and checks host, origin and content type | `packages/web-ui/server/security.ts` | `tests/web-ui-security-smoke.ts` | `smoke:web-ui-security` | `ci.yml:verify` | `ci-complete` |
| C-26 | The web console refuses unsafe bind combinations | `packages/web-ui/server/security.ts` | `tests/web-ui-bind-policy-smoke.ts` | `smoke:web-ui-bind-policy` | `ci.yml:verify` | `ci-complete` |
| C-27 | Session spawn and resume values are validated | `packages/web-ui/server/validate.ts` | `tests/web-ui-spawn-validate-smoke.ts` | `smoke:web-ui-spawn-validate` | `ci.yml:verify` | `ci-complete` |
| C-28 | Linking a phone needs the one-time code, a person at a terminal and the typed device-ID suffix; a second claim is refused; a planted device is suspended | `packages/web-ui/server/remote-host.ts` | `tests/remote-host-smoke.ts` | `smoke:remote-host` | `ci.yml:verify` | `ci-complete` |
| C-29 | The terminal judgement, address scopes, contest and phone-answer record, as units | `packages/web-ui/server/remote-host.ts` | `tests/remote-pairing-controls-smoke.ts` | `smoke:remote-pairing-controls` | `ci.yml:verify` | `ci-complete` |
| C-30 | Each dialog a phone answers is audited with device, session, tier and choice, and attributed at the terminal | `packages/extensions/src/remote-control/index.ts` | `tests/remote-control-extension-smoke.ts` | `smoke:remote-control` | `ci.yml:verify` | `ci-complete` |

## Autonomous runs and containers

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-31 | Every container run is re-checked before it executes: no privilege, sockets, host namespaces or unlisted images | `packages/autonomy/lib/containment.ts` | `tests/autonomy-boundary-smoke.ts` | `smoke:autonomy-boundary` | `ci.yml:verify` | `ci-complete` |
| C-32 | Worker egress goes only to contract-listed hosts through a validating proxy | `packages/autonomy/lib/egress-proxy.ts` | `tests/autonomy-egress-smoke.ts` | `smoke:autonomy-egress` | `ci.yml:verify` | `ci-complete` |
| C-33 | The self-improve merge review never judges a cycle by inputs the cycle wrote, and rejects a diff it cannot read in full | `packages/autonomy/lib/review.ts` | `tests/autonomy-review-inputs-smoke.ts` | `smoke:autonomy-review-inputs` | `ci.yml:verify` | `ci-complete` |
| C-34 | The gate's held-out overlay is copied without following the worker's links | `packages/autonomy/lib/check-runner.ts` | `tests/autonomy-gate-overlay-smoke.ts` | `smoke:autonomy-gate-overlay` | `ci.yml:verify` | `ci-complete` |
| C-35 | Workflow scripts run in a QuickJS sandbox whose module digest is pinned | `packages/extensions/third_party/subagent/wf-sandbox.ts` | `tests/workflow-sandbox-smoke.ts` | `smoke:workflow-sandbox` | `ci.yml:verify` | `ci-complete` |
| C-36 | Every compose file binds loopback, requires a credential on published services, drops capabilities and mounts no engine socket | `tests/compose-policy-smoke.ts` | `tests/compose-policy-smoke.ts` | `smoke:compose-policy` | `ci.yml:verify` | `ci-complete` |
| C-37 | Container images and their tool installs agree with their pins | `packages/container/Dockerfile` | `tests/container-static-smoke.ts` | `smoke:container-static` | `ci.yml:verify` | `ci-complete` |

## Supply chain

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-38 | Every lockfile resolves from the npm registry with sha512 hashes and only reviewed install scripts | `packages/core/lockfile-check.ts` | `tests/lockfile-check-smoke.ts` | `security:lockfile` | `security.yml:dependencies` | `dependencies` |
| C-39 | `npm audit` (high and critical) and `npm audit signatures` over every lockfile | `.github/workflows/security.yml` | `tests/scan-coverage-smoke.ts` | `smoke:scan-coverage` | `security.yml:dependencies` | `dependencies` |
| C-40 | OSV-Scanner over every manifest in the tree, failing closed when the scanner errors | `.github/workflows/security.yml` | `tests/scan-coverage-smoke.ts` | `smoke:scan-coverage` | `security.yml:osv-scanner` | `osv-scanner / osv-scan` |
| C-41 | Every dependency manifest has a Dependabot entry and is one the audit loops walk | `.github/dependabot.yml` | `tests/scan-coverage-smoke.ts` | `smoke:scan-coverage` | `ci.yml:verify` | `ci-complete` |
| C-42 | A pull request adding a dependency with a high-severity advisory or a licence outside the allowlist fails | `.github/workflows/security.yml` | None | None | `security.yml:dependency-review` | `dependency-review` |
| C-43 | Companion installs run with lifecycle scripts off and match their pinned integrity | `packages/core/install.ts` | `tests/companion-integrity-smoke.ts` | `smoke:companion-integrity` | `ci.yml:verify` | `ci-complete` |
| C-44 | The shipped runtime dependencies are the documented ones, pinned exactly | `package.json` | `tests/clean-install-smoke.ts` | `smoke:clean-install` | `ci.yml:verify` | `ci-complete` |
| C-45 | The packed tarball holds every required file and no private one | `packages/core/pack-check.ts` | `packages/core/pack-check.ts` | `smoke:package` | `ci.yml:verify` | `ci-complete` |
| C-46 | The Android Gradle wrapper jar is the one Gradle publishes | `.github/workflows/ci.yml` | None | None | `ci.yml:android` | `ci-complete` |

## Scanning and secrets

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-47 | CodeQL `security-extended` over JavaScript, TypeScript and the workflows | `.github/codeql/codeql-config.yml` | None | None | `security.yml:codeql` | `codeql`, `CodeQL` |
| C-48 | Semgrep community rules, failing on ERROR severity; suppressed results listed in the job summary | `.github/workflows/security.yml` | None | None | `security.yml:semgrep` | `semgrep` |
| C-49 | gitleaks over the full git history, with allowlists bound to named files | `.gitleaks.toml` | `tests/suppression-inventory-smoke.ts` | `smoke:suppression-inventory` | `security.yml:gitleaks` | `gitleaks` |
| C-50 | The leak scan refuses private hosts, home paths, private addresses, key shapes, private review and roadmap item IDs and private paths, locally and on every pull request | `packages/core/lib/leak-scan.ts` | `tests/prepush-scan-smoke.ts` | `smoke:prepush-scan` | `security.yml:leak-scan` | `leak-scan` |
| C-51 | zizmor over the workflows | `.github/zizmor.yml` | None | None | `security.yml:zizmor` | `zizmor` |
| C-52 | Every suppression of a scanner or linter finding is listed with its reason | `packages/core/scan-suppressions.json` | `tests/suppression-inventory-smoke.ts` | `smoke:suppression-inventory` | `ci.yml:verify` | `ci-complete` |

## CI and repository governance

| ID | Control | Code | Test | npm script | CI job | Required check |
|---|---|---|---|---|---|---|
| C-53 | No gate fails open: no `continue-on-error`, failure-hiding shell idiom or unlisted environment | `tests/ci-fail-open.ts` | `tests/workflow-policy-smoke.ts` | `smoke:workflow-policy` | `ci.yml:verify` | `ci-complete` |
| C-54 | Every third-party action SHA is one the declared allowed-actions list names, and the list keeps no unused SHA | `.github/expected-settings.json` | `tests/pin-allowlist-smoke.ts` | `smoke:pin-allowlist` | `ci.yml:verify` | `ci-complete` |
| C-55 | Every CI, release and security control file is owned in CODEOWNERS | `.github/CODEOWNERS` | `tests/codeowners-coverage-smoke.ts` | `smoke:codeowners-coverage` | `ci.yml:verify` | `ci-complete` |
| C-56 | Every test file is run by a script and asserts something | `packages/core/lib/wiring.ts` | `tests/wiring-smoke.ts` | `smoke:wiring` | `ci.yml:verify` | `ci-complete` |
| C-57 | The release workflow is a dry run unless an operator unticks it from a tag, and its gate runs both the CI and the security workflows | `.github/workflows/release.yml` | `tests/release-workflow-smoke.ts` | `smoke:release-workflow` | `ci.yml:verify` | `ci-complete` |
| C-58 | A release needs a clean tree, a CHANGELOG section and a version newer than every tag | `packages/core/release.ts` | `tests/release-plan-smoke.ts` | `smoke:release-plan` | `ci.yml:verify` | `ci-complete` |
| C-59 | Gating OpenSSF Scorecard checks stay above their floors | `.github/scorecard-thresholds.json` | None | None | `scorecard-thresholds.yml:thresholds` | No |
| C-60 | The security documentation names only files, scripts, jobs and checks that exist | `docs/security-controls.md` | `tests/security-docs-smoke.ts` | `smoke:security-docs` | `ci.yml:verify` | `ci-complete` |

## What this catalogue does not cover

- **Repository settings.** Review rules, required checks, code-scanning merge protection,
  allowed actions, secret scanning and Dependabot alerts are GitHub settings.
  `.github/expected-settings.json` declares them; an administrator applies them, and a maintainer
  drift check compares the live settings with that file using read-only requests. No test in the
  public tree can read the live settings.
- **The publication pipeline.** Public releases are exported from a private development lineage
  ([Repository topology](repository-topology.md#how-a-release-reaches-this-repository)). That
  pipeline's controls and their tests live with that lineage and are not part of the public tree.
- **Controls that need a container engine or a real device.** The autonomy boundary probe, the
  container capability scripts and the Android app are run by the operator
  ([CI security](ci-security.md#not-run-in-ci)).
