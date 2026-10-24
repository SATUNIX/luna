# Security policy

`pi-system` puts a **default-deny guard rail** between the model and your machine. It is a guard
rail, not a sandbox. The full model, including the specific things it does not guarantee, is in
[`docs/security.md`](docs/security.md); read it before relying on the boundary.

## What the boundary is

- **`tool-firewall`** (`packages/extensions/src/tool-firewall`) is in every profile. Unknown tools
  default to `ask`, which resolves to **deny** when there is no operator to ask. Destructive shell
  commands are denied in every profile. Approvals you give are scoped to the exact action,
  workspace, directory and session, expire, and can be listed and revoked (`/firewall list`,
  `/firewall revoke`). Every decision is audited.
- **`protected-paths`** is in every profile and protects agent-control files, including the
  firewall's own policy, approvals and audit files.
- **`secret-guard`** is shipped but **opt-in**: a name-based backstop that blocks writes of secret
  files and content, and shell commands that leak them.
- **`pentest-governance-domain`** (the `pentest` profile) adds scope and rules-of-engagement
  enforcement with action-card approval for authorised engagements.
- **`delegation-guard`** makes every child agent load the same protections as its parent, and
  fails closed when one is missing. **Effort** budgets delegation, but is a cost policy, not a
  security control.
- The **web console** is token-authenticated and loopback-bound by default
  ([`docs/web-console.md`](docs/web-console.md)).

`packages/core/verify.ts` fails if the shipped firewall policy stops being default-deny.
`npm run test:security` exercises the firewall, delegation, approvals, unattended-mode and web
console suites offline, and CI runs it on every change.

## Reporting a vulnerability

Please report a suspected boundary bypass **privately**: use GitHub's *Report a vulnerability* on
the repository's **Security** tab. If that option is not available, open an issue that says only
that you have a security report, with no technical detail, and a maintainer will arrange a private
channel. Include a reproducing tool-call fixture where you can (see
`tests/tool-firewall-smoke.ts` and `tests/secret-guard-smoke.ts` for the shape).
**Never include a live secret** in a report.

This is a beta. Only the latest release receives fixes.
