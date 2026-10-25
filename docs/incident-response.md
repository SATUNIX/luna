# Incident response

What to do when something has already gone wrong: a secret leaked, a credential or dependency
is compromised, a private file was published, or someone reports a way around the firewall. The
repository owner leads every incident; a contributor or agent who notices one tells the owner
through the private route in `SECURITY.md` and changes nothing outside their own branch. Fixing a
vulnerability that is not yet being exploited follows
[Vulnerability management](vulnerability-management.md) instead.

Every playbook below starts the same way: **contain first, then rotate, then investigate, then
fix forward.** Never rely on rewriting git history, force-pushing or deleting a tag to make
something private again: a pushed branch is public at once and may already be cloned
([Repository topology](repository-topology.md#every-pushed-branch-is-public)), and a release tag
is never moved ([Releasing](releasing.md)).

## Evidence to keep

Copy these before changing anything, into a location outside the workspace and outside any
repository:

| Evidence | Where it is |
|---|---|
| Firewall audit log (every decision, its tier and reasons) | `.pi/tool-firewall-audit.jsonl` in the workspace by default, or `PI_KIT_FIREWALL_AUDIT_LOG` ([Autonomy gate](autonomy-gate.md#audit-and-tuning)) |
| Tool I/O capture (every call and its output, joined to the audit by action hash) | The capture directory ([Tool I/O capture](tool-capture.md)); it may hold secrets, so keep it owner-only |
| Trace ledger | `<workspace>/.pi/trace.jsonl` |
| Remote host audit | `audit.jsonl` in the remote host's state directory ([Remote control](remote-control.md#files-on-the-computer)) |
| Autonomy run directory (contract, digest, events, cycle reports) | The run directory ([Autonomous runs](autonomy.md#the-run-directory)) |
| CI evidence | The workflow run logs and SARIF results on GitHub, which expire; download them |
| Repository settings at the time | A read-only export of the rulesets and security settings, to compare with `.github/expected-settings.json` |

## A leaked secret

Applies to any credential: a provider API key, a token in a commit or log, a key in a published
file.

1. **Rotate first.** Revoke the credential at its issuer and issue a new one before anything
   else. Assume it was copied the moment it was exposed; deleting the commit or the file does not
   undo that.
2. Find every place it was used (CI variables, local configuration, a deployed service) and
   replace it there.
3. If it is in a public branch, delete the branch and treat the value as disclosed. If it is in
   `main` or a release, leave history alone: the value is already rotated, and a new commit
   removes it from the tree.
4. Check the issuer's logs for use between exposure and revocation.
5. Find how it got there. A secret the leak scan or gitleaks should have caught is a gap in
   C-49 or C-50 ([Security controls](security-controls.md)); add its shape to the scan with a
   synthetic test case.

## A compromised bot, App key or token

Applies to the GitHub App key that opens release pull requests, a bot account's token, or an
agent's forge credential.

1. Revoke it: delete the App's private key in its GitHub settings, revoke the token, or suspend
   the bot account. Generate a replacement only after step 3.
2. Review what it did: the repository's audit log, pull requests and branches it opened, pushes,
   releases and settings changes since the earliest possible exposure. Close or revert anything
   not reviewed.
3. Confirm the settings are still the declared ones: compare the live rulesets, allowed actions,
   environments and security settings with `.github/expected-settings.json`, and check that the
   identity is not a bypass actor and cannot approve pull requests.
4. Issue the replacement with the least privilege its job needs, and store it where agents
   cannot read it.
5. If a release was published while the credential was compromised, verify it: re-derive it from
   its tag and compare. A release that differs is a published-artefact incident (below).

## A malicious dependency or companion

Applies to an npm package in a lockfile, a companion in `packages/core/sources.json`, an image or
an action.

1. Stop it spreading: open a pull request that pins the last good version (or removes the
   package) and, for a companion, removes or re-pins its entry in `packages/core/sources.json`.
   Do not wait for Dependabot.
2. Tell users: a GitHub Security Advisory naming the affected kit versions and the commands to
   remove the package from an existing install.
3. Assume what it could reach was reached. Code that ran inside pi or during an install had the
   user's rights: rotate credentials available to it on maintainers' and CI machines.
4. Check how it was admitted: a lockfile change that passed `security:lockfile`, OSV and
   dependency review, or a companion pin without a tarball review, is a gap in C-38 to C-43.

## A published private file

Applies to a file that should never have been public: private notes, review evidence, a private
host name or address, an engagement file.

1. Delete the branch, or, if it reached `main`, remove the file in a new commit through the normal
   review. Treat the content as disclosed.
2. If the file contained a secret, follow "A leaked secret" first.
3. If it named private infrastructure, change what can be changed (addresses, account names) and
   check that infrastructure for access from unexpected places.
4. Find how it passed the pre-push hook, the pull-request leak scan and gitleaks, and add a
   synthetic case for its shape to `tests/prepush-scan-smoke.ts`.

## A firewall bypass report

Applies to a report that an agent's tool call can do something the [autonomy gate](autonomy-gate.md)
says it asks for, or can change the safety configuration.

1. Acknowledge and triage it as `SECURITY.md` says, privately.
2. Reproduce it with a benign vector (`echo`, `true`, a marker file in a temporary directory) and
   decide its severity ([Vulnerability management](vulnerability-management.md#severity)).
3. If it is being exploited, or is critical, publish a mitigation in the advisory before the fix:
   for example, the strict [security level](security-level.md), manual approvals (`/auto off`) or
   a `command_rules.deny` entry.
4. Fix the class, not the instance ([Secure development standard](security-standard.md)): look for
   every construct of the same shape, add each to the parser or classifier corpus, and, for a
   shell construct, to the exec-trace oracle (C-02).
5. Release the fix as a new version with its regression test and the advisory.

## After an incident

Record what happened, how it was found and what changed, in the CHANGELOG entry of the release
that fixes it (describing the class, not an exploit), and add any control the incident showed was
missing to [Security controls](security-controls.md).
