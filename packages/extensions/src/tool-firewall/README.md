# tool-firewall

The autonomy gate for every tool call. It parses shell commands into their real effects,
tiers each action (low / medium / high / critical) together with the session's history, and
then decides:
- routine work is allowed;
- in auto mode, medium actions go to an in-process judge;
- high actions run when they exactly repeat an approval given for this session, workspace and
  directory, or a learned action; otherwise the judge reasons over the similar actions the
  operator allowed here (full steps, severity and chain) and the learned profile, and anything
  it finds different goes to the operator through a compact (≤10-line) card, or the human-console
  menu when headless;
- critical actions are denied.

Every refusal is labelled HARD DENY (policy says never), UNCERTAIN (the judge or classifier could
not settle it, or nobody could be asked: escalated to the operator, or refused after a bounded
wait) or OPERATOR DECISION (a human allowed or denied it); a high-confidence judge block is
labelled AUTO-MODE BLOCK. What the operator allows is remembered only as a scoped, inspectable,
revocable entry in `firewall-approvals.json` (`/firewall list`, `/firewall revoke`).

`/security` (picker), `/security <level>`, `/security status`, `/security explain [level]` and
`/security reset` choose the implemented security level, independently of `/auto`. Balanced
keeps the configured behaviour described above; guarded disables learned and similarity
authority and high judgement; strict pins the operator, disables reusable approvals and denies
unknown external tools. Low-tier actions still run and critical findings always deny. Weakening
is confirmed at the terminal only. Off is locked pending supervisor attestation, and relaxed
currently equals balanced (no safely reviewed medium routine effects). The proposal's content,
flow, intent and detector checks are unavailable. See `docs/security-level.md` and
`tests/security-level-smoke.ts`.

A worker that the autonomy supervisor starts inside a container boundary runs in **unattended
mode** (`PI_KIT_UNATTENDED=1`, `PI_KIT_UNATTENDED_BOUNDARY=container` and a read-only
`PI_KIT_UNATTENDED_CONTRACT`): no prompts and no judge inside the zone; critical, hard classes
and anything outside the zone are refused. The contract must be on a read-only mount (or be another
user's unwritable file) and outside the workspace, so a file the agent wrote and `chmod`-ed does not
count, and launching a child with those variables from a shell is a safety-setting override. The
autonomy CLI's control commands (`start`, `plan --authorise`, `promote`, `resume`, `reconfigure` and
the like) are high and never learned from an agent's shell.

The full description is in `docs/autonomy-gate.md`.

| File | Role |
|---|---|
| `shell.ts` | Shell parser: quoting, substitutions, heredocs, wrappers (sudo/env/ssh/bash -c/xargs/find -exec/eval/tmux), obfuscation normalisation. |
| `classify.ts` | Command table, path classes and tool table → findings (tier, effect, code). |
| `security-level.ts` | Canonical securityLevel persistence, immutable resolution, floors and the read-only security registry contract. |
| `security-command.ts` | `/security` picker, status, explain, reset and weakening confirmation. |
| `trajectory.ts` | Per-session state (secret reads, downloads, deletions, judge cache, stats) and the root-session id that subagents share. |
| `approvals.ts` | The approvals file: schemaVersion, scope (action, workspace, cwd, policy, root session), grantor, expiry, strict validation, revocation and floors. |
| `unattended.ts` | The autonomy run contract: entering unattended mode, the egress/remote checks, hard and outside-the-zone denials. |
| `profile.ts` | Global learning: judge-verdict telemetry, per-kind statistics and the background-distilled operator profile. |
| `judge.ts` | Judge prompt and strict-JSON verdict (with confidence) parsing. |
| `feedback.ts` | Operator decision log, learned/suspended/expired status, precedents. |
| `card.ts` | Approval card text and choices. |
| `config.ts` | `~/.pi/agent/pi-kit/firewall.json`, mode/policy resolution, known hosts (with sources and revocation), workspace root. |
| `index.ts` | Orchestration, outcomes, bounded prompts, audit, `/firewall` and `/auto` commands. |

## Policy file

`default-policy.json` (mirrored byte-for-byte at `packages/core/policies/default.json`) holds:
- the tool table (`tools.<name>.decision`: allow / ask / deny);
- the unknown-tool default;
- operator regex rules: `command_rules` applies to every policy, and
  `policies.pentest.command_rules` applies to the pentest policy only.

Tool `deny` and `ask` entries compose with every adapter's effects. Identity matching is exact
and case-sensitive: pi 1.3's core `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`,
`ls` and bundled `codemode`/`tool_search` are known under `defaults.unknown: "ask"`. Recognised
aliases (`cat`, `view`, `read_file`, `apply_patch`, etc.) are only input adapters and need an exact
policy entry or operator approval. Missing required inputs, unknown fields and unsupported
patch/multi-file forms need the operator even with `allow`. Legacy single-file edits, pi 1.3's
single-file replacement batches and pinned readseek hashline edits are covered
(`tests/firewall-shell-smoke.ts`).

External read-like names and shell-looking arguments do not grant authority. Unknown tools are
high-tier under `ask`, so a model verdict cannot approve a fresh unknown API. Unknown,
explicit-ask and incomplete-adapter calls never gain learned or model-similarity authority;
exact scoped session grants explicitly given by the operator remain valid. An `allow` cannot
suppress critical effects (`tests/firewall-gate-smoke.ts`, `tests/firewall-shell-smoke.ts`).
Unattended runs refuse these operator-required calls without executing them
(`tests/firewall-unattended-smoke.ts`).

`codemode` is opaque code requiring approval; `tool_search` discovers/activates tools. Every
nested call is gated on its own name and arguments, never its parent's approval
(`tests/firewall-gate-smoke.ts`, with synthetic `parentToolCallId` events). The policy names
reviewed kit delegation/bookkeeping and companion read helpers explicitly
(`tests/tool-firewall-smoke.ts`). The companion mutation/code-execution tools `ast_grep_replace`,
`lsp_navigation`/`pilens_lsp_navigation` and `rename` ask because their target sets/effects are not fully modelled
(`tests/firewall-shell-smoke.ts`). Their known targets are still assessed: a `rename_file`
destination (`newFilePath`) and every path of a `file_write` entry (`ast_grep_replace`,
`lens_diagnostic_mark`) is checked as a write, so a persistence, git-hook or safety-control target
keeps its finding and its own action family. A `command` field of a policy entry is still
shell-classified whatever its risk class, and these path checks are added on top of that analysis
(`tests/firewall-shell-smoke.ts`).

`PI_KIT_FIREWALL_POLICY` selects a replacement policy. Invalid files, rules, decisions, types or
unrecognised fields deny **all** calls until repaired, with UI/stderr warnings and audit records.
Valid regex rules with stateful `g`/`y` flags lose those flags and stay enforced. Revisions are
keyed by content digest and path, not mtime. Pending select/confirm/console/judge approvals
re-evaluate a changed policy before allowing or storing an operator grant
(`tests/firewall-policy-warnings-smoke.ts`, `tests/firewall-gate-smoke.ts`).

Policy override authority remains with the operator: `defaults.unknown: "allow"` is deliberately
permissive; `deny` requires an exact entry even for core tools. Explicit external
`allow`/`network_read` uses the URL/egress adapter and marks results untrusted
(`tests/firewall-shell-smoke.ts`). Exact names cannot bind implementations or intercept direct
I/O by in-process extension code. Plugins are not isolated; no isolation test exists. See
`docs/security.md` for that limitation.

## Audit

Each tool call appends one JSONL record to `PI_KIT_FIREWALL_AUDIT_LOG`, or to
`.pi/tool-firewall-audit.jsonl` when the variable is unset. Decisions that wait on a judge or
human add a closing `tool_approved` or `tool_blocked` record. Before an append, a log over 4 MiB
is renamed to `<file>.1`, replacing the previous copy (`tests/firewall-outcomes-smoke.ts`).

Audit is best-effort: `audit()` swallows its own errors and MUST never throw, and it must never
break a tool call. In the headless broker, `finish()` MUST stay unconditional so the broker
promise always settles. The code currently attempts the audit record before calling `finish()`,
but that ordering is not what makes it safe: because `audit()` is non-throwing, `finish()` is
reached regardless — and if `audit()` ever threw before `finish()`, the promise would not
resolve. Keep `audit()` non-throwing and `finish()` unconditional when editing this path.

## Commands

- `/firewall [status|list|revoke <id>…|session|workspace|all|host:<name>|reload|help]`:
  inspect what the firewall remembers and revoke it (effective on the next tool call; invalid
  arguments change nothing; a headless session gets the text on stderr). `/firewall:status` and
  `/firewall:reload` remain as aliases.
- `/auto [status|on|off|learn on|off|learned|forget <sig>|stats|explain [n]|check <cmd>]`,
  with `/auto-mode` as an alias.

## Environment

State and behaviour: `PI_KIT_FIREWALL_CONFIG`, `_POLICY`, `_PROFILE`, `_AUDIT_LOG`, `_FEEDBACK`,
`_SESSIONS_DIR`, `_JUDGEMENTS`, `_LEARNED_PROFILE`, `_ROOT_SESSION`, `_APPROVALS` (the approvals
file), `PI_KIT_AUTO_MODE`, `PI_KIT_AUTO_MODE_MODEL`, `PI_KIT_AUTO_MODE_STATE_DIR`.
Bounds: `PI_KIT_HUMAN_CONSOLE_DIR` and `_TIMEOUT_MS` (the broker, 15 minutes by default),
`PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS` (an interactive card, 15 minutes),
`PI_KIT_FIREWALL_JUDGE_TIMEOUT_MS` (the judge, 15 seconds).
Unattended (set by the supervisor only): `PI_KIT_UNATTENDED`, `PI_KIT_UNATTENDED_BOUNDARY`,
`PI_KIT_UNATTENDED_CONTRACT`.

## Protections registry

At factory time, once its hooks are installed, tool-firewall (like `secret-guard` and
`protected-paths`) adds its name to `globalThis[Symbol.for("pi-kit.protections")]`, a `Set` of
names with `has(name)` and a sorted `list()`. Another extension can create that `Set` first or
call `.add(name)` on it; a factory that failed before installing its hooks does not register. It
is a consistency check for a launcher, not a boundary against code in the same process.

## Unattended-mode footer global

`globalThis[Symbol.for("pi-kit.unattended")]` is a frozen
`{ active: boolean, boundary: string | null, autoApprove: boolean, label: string }` (`label` is
empty when unattended mode was never requested). The firewall never reads it back.
