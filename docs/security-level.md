# Security level

`/security` chooses how much of the firewall's existing automatic approval machinery may
operate. The order is `off`, `balanced`, `guarded`, `strict`; `off` cannot be selected. It grants no new
authority and is independent of [effort](effort.md), the model's thinking level,
[profiles](profiles.md) and `/auto` ([Autonomy gate](autonomy-gate.md)). `/auto` sets the *approval mode*, which the
Security page and `/security status` show beside the level, so there is one place to look.

A stored `relaxed` value is read as `balanced` and rewritten the next time the level is saved.

Open `/security` for a picker, or use:

```text
/security guarded
/security status
/security explain strict
/security reset
```

The picker marks the current effective level and describes every level, including the unavailable
`off`. Without a UI it prints status and help. Strengthening applies immediately. Weakening,
including leaving strict or resetting to a weaker profile default, needs a confirmation at the
terminal of an interactive root session: a two-option choice whose first, highlighted option keeps
the current level. Headless, RPC and delegated/child sessions refuse it.
When a phone is linked through [remote control](remote-control.md), the confirmation is still
asked at the terminal and never on the phone, as phone pairing is. The picker and the
confirmation close after the firewall's prompt timeout (`PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS`, 15
minutes by default), and a timeout changes nothing. A floor cannot be lowered with the command.
This local confirmation is **not** the proposal's authenticated operator event. Controls and
refusal cases are pinned by `tests/security-level-smoke.ts`.

## Implemented mechanisms

| Mechanism | balanced | guarded | strict |
|---|---|---|---|
| Low-tier actions | Run | Run | Run |
| Critical findings / invalid firewall policy | Deny | Deny | Deny |
| Unknown external tools under the default ask policy | Operator | Operator | Deny |
| Exact scoped operator session grants | Honour/create | Honour/create | Neither honour nor create |
| Learned exact approvals | Configured behaviour | Advisory only | Advisory only |
| Similar-grant / precedent-backed high judge | Configured behaviour | Cannot authorise | Cannot authorise |
| Medium-tier judge | With `/auto on` | With `/auto on`, except opaque/unsure | Disabled |
| Opaque or classifier-unsure actions | Existing escalation | Operator | Operator (unknown external tools deny) |
| Approval strategy | Configured `/auto` | Configured `/auto` | Pinned to operator; `/auto on` refuses |
| Additional deterministic medium admissions | None | None | None |

`tests/security-level-smoke.ts` pins all three selectable levels, learned authority, high
precedents, medium judgement, opaque actions, grant creation/honouring, pending changes and the
registry. `tests/firewall-gate-smoke.ts`, `tests/firewall-shell-smoke.ts` and
`tests/firewall-policy-warnings-smoke.ts` pin the underlying classification and invalid-policy
denials. Exact policy entries and trusted pi identities keep their existing meaning: strict
changes the unknown-tool default to deny, without rewriting those entries.

Protected paths, credential-disclosure checks, unattended hard denials, the engagement
and domain gates, and unknown-tool escalation remain in force at every level. Engagement still
requires once-only approvals and never learns; its `guarded` floor does not replace its
engagement rules. Supervisor-authorised unattended runs retain their existing contract-based
decision path ([Autonomous runs](autonomy.md)); selecting a level does not enter unattended mode.
These mechanisms have their own evidence in [Security model](security.md).

### Admission between off and balanced

The reviewed routine effect set is empty, so no level sits between `off` and `balanced`. Ordinary build/test/dev tooling is already low tier; at medium tier the broad effect
names (`code_exec`, `workspace_write`, `process_control`, reads) prove neither workspace confinement
nor absence of credential or network effects. There is no additional deterministic admission
without a narrower, reviewed classifier contract. The empty set is pinned by `tests/security-level-smoke.ts`.

### Unavailable checks and off

Every level's status lists **content screening, the OpenAPPA flow engine, the intent ledger and
the detector** as unavailable. No level provides them. `strict` means maximum implemented
protection, with low-tier reads and other low-tier actions still running unasked; it does not
implement those proposal checks.

`off` requires a supervisor-verified, operator-authorised container boundary. That attestation
does not exist, so neither the picker, a command, an environment request nor a hand-edited saved
`off` disables the firewall. A saved `off` instead resolves to at least balanced (or the stronger
profile default), with a warning. Existing unattended contracts are not this new attestation.
`tests/security-level-smoke.ts` pins the lock and warning.

## Persistence, defaults and floors

The canonical setting is `securityLevel`. The firewall stores it in
`<agent dir>/pi-kit/security.json` (override: `PI_KIT_SECURITY_CONFIG`):

```json
{
  "schemaVersion": 1,
  "level": "balanced",
  "source": "operator",
  "revision": 1,
  "changedAt": "2026-01-01T00:00:00.000Z"
}
```

Writes use a mode-0600 temporary file and atomic rename. Each saved selection increments the
revision. A profile installs `source: "profile"`; an operator choice survives ordinary profile
switches. `/security reset` writes the installed profile default with `source: "profile"`.
`engagement` defaults to guarded and every other profile to balanced.

A `/profile` switch whose profile default is lower than the level in force is a weakening, like
`/security <lower>`. It asks at the terminal of an interactive root session, with "No, keep the
current security level" as the first choice, and refuses in headless, RPC and delegated/child
sessions. Choosing No, dismissing or a timeout changes nothing. An operator-chosen level survives
profile switches, so such a switch lowers nothing and does not ask. Raising never asks.
`tests/profile-command-smoke.ts` pins these cases, and `tests/profile-transaction-smoke.ts` runs
the real installer through all five profiles. The switch's check lives in session-helpers, which
cannot import the firewall, so it keeps its own copy of the level list, the security file path,
the root-terminal check and the prompt timeout; `tests/security-level-smoke.ts` pins each copy
equal to the firewall's.

Effective security is the strongest of the request and all floors. The engagement policy floors it
at guarded. `PI_KIT_SECURITY_LEVEL` may only strengthen, never select off or weaken the saved
request. Invalid environment values warn and are ignored. A malformed, unknown or unreadable
saved configuration fails closed to the stronger of the profile default and balanced, with a
visible warning; it never falls back to a weaker level or off. A missing file uses the profile default.
Resolution reads current file bytes, caches parsing by content and takes one immutable snapshot
per decision. `tests/security-level-smoke.ts` pins these rules, same-mtime edits, profile
preservation, revisions and permissions.

A level change revokes this session's reusable approvals and judge cache. Pending operator or
judge approvals bind to the policy and security revision and are re-evaluated if either changes
before allowing a call. Session state retains that binding across reloads. The read-only
process-local registry at `globalThis[Symbol.for("pi-kit.security")]` exposes `snapshot()` with
`requested`, `effective`, `source`, `revision`, `floors`, optional `pinnedBy`, `unavailable` and
`warnings`. The footer shows a compact `sec` chip beside effort, including requested → effective
when raised and a warning marker on invalid state. Registry and footer behaviour are pinned by
`tests/security-level-smoke.ts` and `tests/status-bar-smoke.ts`.

Security levels are local guard rails. Code running as the same user, writable state and trusted
extensions in the process are not an authenticated authority boundary; see the limitations in
[Security model](security.md#what-the-boundary-does-not-guarantee) and the remaining work in
[Future work](future-work.md#approvals-and-the-firewall).
