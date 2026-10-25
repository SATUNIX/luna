# Security policy

`pi-system` puts a **default-deny guard rail** between the model and your machine. It is a guard
rail, not a sandbox. The full model, including the specific things it does not guarantee, is in
[`docs/security.md`](docs/security.md), and what it protects from whom is in
[`docs/threat-model.md`](docs/threat-model.md); read them before relying on the boundary.

## Supported versions

| Version | Supported |
|---|---|
| The newest `vX.Y.Z` release tag (betas until the first stable release) | Yes: security fixes are released as a new version |
| `main` (the `next` channel) | Yes: fixes land here first |
| Any older tag | No: update to the newest release (`/update`) |

The kit is in beta ([`docs/beta.md`](docs/beta.md)). Releases move forward: a fix is a new
release, never a moved tag.

## Reporting a vulnerability

Report a suspected vulnerability **privately**: use GitHub's *Report a vulnerability* on the
repository's **Security** tab (private vulnerability reporting). If that option is not available
to you, open an issue that says only that you have a security report, with no technical detail,
and a maintainer will arrange a private channel. The same route applies to conduct reports that
need privacy (`CODE_OF_CONDUCT.md`).

A useful report has:

- the version or commit, the profile and the pi version (`/profile status`, `/update status`);
- the smallest reproduction you can give, ideally a tool-call fixture in the shape of
  `tests/tool-firewall-smoke.ts`, `tests/firewall-shell-smoke.ts` or `tests/secret-guard-smoke.ts`,
  using a harmless command (`echo`, `true`, a marker file) in place of anything destructive;
- what you expected the boundary to do and what it did.

**Never include a live secret** in a report. If you have found an exposed credential belonging to
the project, say so in the report and the maintainers will rotate it first
([`docs/incident-response.md`](docs/incident-response.md)).

## Response targets

These are targets for a volunteer-maintained beta, not a contractual service level. When a target
is missed, the report stays open and you are told why.

| Step | Target |
|---|---|
| Acknowledge the report | 3 working days |
| Triage: reproduce, decide whether it is in scope, assign a severity | 14 days |
| Fix released, **critical** | 7 days after triage |
| Fix released, **high** | 30 days after triage |
| Fix released, **medium** | 90 days after triage |
| Fix released, **low** | The next planned release, or recorded as an accepted risk |

Severity follows the rubric in
[`docs/vulnerability-management.md`](docs/vulnerability-management.md). A fix ships as a new
release with a GitHub Security Advisory that names the affected versions, the fixed version and
any mitigation; the maintainers request a CVE through the advisory when the issue affects
released versions. You are credited in the advisory unless you ask not to be.

## Scope

In scope:

- a way for an agent's tool call to run a high or critical action without the approval the
  [autonomy gate](docs/autonomy-gate.md) documents, or to change the safety configuration
  (policy, approvals, autoloaded code, the unattended contract) without asking;
- forging an operator decision: an approval, a human-console answer, a phone pairing, or
  unattended mode outside a real container boundary;
- the web console or the remote host accepting a request it should refuse;
- the autonomy supervisor starting a container outside its documented boundary, or merging a
  cycle its review should have rejected;
- a kit state write that follows a link out of the workspace, or a secret file created readable by
  others;
- the CI, release or publication tooling in this repository letting unreviewed content reach
  `main` or a release.

Out of scope (documented limits, not vulnerabilities, unless the documentation says otherwise):

- what an **allowed** tool call does: the kit is not a sandbox;
- actions by a process of your own account that does not go through a tool call, by root, or by
  code running inside the pi process;
- a secret in a shape `secret-guard` or the redaction table does not know: detection is
  heuristic, and `secret-guard` loads only in the `balanced` and `autonomous` profiles;
- secrets that [tool capture](docs/tool-capture.md) records: it stores tool input and output
  losslessly by design, in owner-only files;
- an action you approved, and approval prompts that list *Approve* first (an operator decision,
  recorded in [`docs/remote-control.md`](docs/remote-control.md#the-yes-first-decision-sec-5));
- vulnerabilities in pi itself, in companion packages or in other upstream code, which belong to
  their maintainers (tell us too if the kit's use of them makes it worse);
- findings that need a modified kit, policy or profile that widens the boundary on purpose.

## Safe harbour

Research done in good faith under this policy is welcome. Test against your own installation and
your own accounts, use harmless commands, do not access or change data that is not yours, and
give the maintainers the time above before you publish. The maintainers will not pursue or
support action against research that follows these rules.

## What the boundary is

- **`tool-firewall`** (`packages/extensions/src/tool-firewall`) is in every profile. Unknown tools
  default to `ask`, which resolves to **deny** when there is no operator to ask. Destructive shell
  commands are denied in every profile. Approvals you give are scoped to the exact action,
  workspace, directory and session, expire, and can be listed and revoked (`/firewall list`,
  `/firewall revoke`). Every decision is audited.
- **`protected-paths`** is in every profile and protects agent-control files, including the
  firewall's own policy, approvals and audit files.
- **`secret-guard`** loads in the `balanced` and `autonomous` profiles: a name-based backstop that
  blocks writes of secret files and content, and shell commands that leak them.
- **`pentest-governance-domain`** (the `pentest` profile) adds scope and rules-of-engagement
  enforcement with action-card approval for authorised engagements.
- **`delegation-guard`** makes every child agent load the same protections as its parent, and
  fails closed when one is missing. **Effort** budgets delegation, but is a cost policy, not a
  security control.
- The **web console** is token-authenticated and loopback-bound by default
  ([`docs/web-console.md`](docs/web-console.md)).

Every control, with its code, test and CI job, is catalogued in
[`docs/security-controls.md`](docs/security-controls.md). `npm run test:security` exercises the
firewall, delegation, approvals, unattended-mode, console and remote-control suites offline, and
CI runs it on every change.
