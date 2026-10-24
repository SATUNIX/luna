# Security model

This page states what the pi-system safety boundary **guarantees** and, just as important, what it
**does not**. It is a default-deny **guard rail**, not a sandbox. The reporting process is in
`SECURITY.md` at the repository root.

The [Security level](security-level.md) control adjusts implemented firewall approval mechanisms,
with balanced as the migration default and off locked pending a verified container attestation
(`tests/security-level-smoke.ts`).

## The layers

| Layer | Extension | Ships in | Enforces |
|---|---|---|---|
| Universal firewall and autonomy gate | `tool-firewall` | every profile | Parses shell commands into effects, tiers every call (low, medium, high, critical) with session history, auto-allows routine work, judges medium actions in auto mode, denies critical ones, and audits every decision. See [Autonomy gate](autonomy-gate.md). |
| Protected paths | `protected-paths` | every profile | Blocks writes to agent-control files, including the firewall's policy, approvals and audit files and the unattended-run contract. |
| Delegation governance | `delegation-guard`, `effort` | every profile | Every child agent is started only with the protections its parent has loaded, and verifies them itself before running a tool, failing closed. See [Agent orchestration](agent-orchestration.md). |
| Universal secrets guard | `secret-guard` | shipped, **not in any profile** (experimental, opt-in) | A name- and pattern-based backstop: blocks writes to secret files and secret *content*, and shell commands that read, copy, encode or exfiltrate them. Enable it with `node packages/core/install.ts --only secret-guard --yes` or by adding it to a profile. |
| Tool I/O capture | `tool-capture` | every profile | Lossless, rotating JSONL of every tool call and output, joined to the firewall audit by action hash; secrets flagged. See [Tool I/O capture](tool-capture.md). |
| Domain governance | `pentest-governance-domain` | `pentest` | Scope and rules-of-engagement enforcement, MCP-only mode, action-card approval, hash-chained audit for authorised engagements. |
| Web console | `web-console` and `packages/web-ui` | most profiles | Token authentication, host and origin checks, an RPC allow-list. See [Web console](web-console.md). |
| Remote control | `remote-control` and `packages/web-ui/server/remote-host.ts` | most profiles | Phones linked by a one-time code plus approval at the terminal, keystore keys, a pinned TLS certificate, short-lived tokens. See [Remote control](remote-control.md). |

`tool-firewall` loads **before** `pentest-governance-domain` in the pentest profile (enforced by
`tests/epic1-smoke.ts`), so the general gate runs first. Coding profiles carry no pentest gate;
the firewall runs there with the `coding` policy, and the pentest profile switches it to the
strict `pentest` policy (see [Autonomy gate](autonomy-gate.md#policies-and-profiles)). The
firewall loads first in every profile and in every child, and pi hands it the very object that
will execute, after argument preparation and validation, with parallel calls executed only after
all are decided (`tests/firewall-preauth-smoke.ts`).

### Tool identity policy precedes permission

Tool identities match **exactly and case-sensitively**. The pi 1.4.0 core tools are `read`,
`bash`, `powershell`, `edit`, `write`, `grep`, `find` and `ls`
(`dist/core/tools/index.js` in the installed pi package). Its bundled extensions also register
`codemode` and `tool_search`. Only these identities are implicitly known under the `ask`
default. Recognising an alias such as `cat`, `view`, `read_file` or `apply_patch` selects a
partial input adapter; it grants no authority. An exact policy entry or an operator decision
is still required (`tests/firewall-shell-smoke.ts`, `tests/firewall-gate-smoke.ts`).

A recognised adapter with missing required inputs, unknown fields or unsupported patch/multi-file
forms is **high**, needs the operator and cannot gain learned or model-similarity authority.
An exact `allow` cannot remove that finding or lower critical effects. The adapter covers legacy
single-file edits, pi 1.3's single-file batch replacements and the pinned readseek single-file
hashline operations; extra nested target fields remain incomplete
(`tests/firewall-shell-smoke.ts`, `tests/firewall-gate-smoke.ts`). Unattended runs refuse incomplete
inputs without asking or executing a marker (`tests/firewall-unattended-smoke.ts`).

`codemode` scripts require operator approval; they are opaque code, not shell text. `tool_search`
only discovers and activates tools. Calls carrying pi's `parentToolCallId` and `<parent>/<n>` id
are judged using their own identity and input. Parent approval or discovery grants no authority
to a child call (`tests/firewall-gate-smoke.ts` models these events; it does not run the real
codemode worker). The shipped policy explicitly allows reviewed kit bookkeeping, delegation and
companion read helpers; multi-target companion mutation/code-execution tools (`ast_grep_replace`,
`lsp_navigation`, `pilens_lsp_navigation`, `rename`) explicitly ask. Ordinary helper calls are pinned by
`tests/tool-firewall-smoke.ts`; policy decisions and critical-effect precedence by
`tests/firewall-shell-smoke.ts`.

An invalid policy file, malformed individual rule or unrecognised policy field invalidates the
**whole policy**: every call is denied until repair, including normally trusted core tools.
Warnings reach the UI and stderr, and the audit records policy problems. Stateful regex flags
`g`/`y` are instead removed with a warning while the rule remains enforced. The cache keys on a
SHA-256 content digest and path, so preserving the mtime cannot hide a revision. A pending
select, confirm, console or judge approval is re-evaluated under a changed policy before it can
allow the call or save an operator grant. These cases are pinned by
`tests/firewall-policy-warnings-smoke.ts` and `tests/firewall-gate-smoke.ts`.

### MCP-only mode and `PI_ALLOW_DIRECT_TOOLS`

`pentest-governance-domain`'s MCP-only mode forces target-touching direct tools
(`write`, `edit`, `bash`) through the audited governance MCP path. It loads only in the `pentest`
profile, and even there it is not unconditionally on: by default it activates only once a real
engagement is configured (both `engagement/scope.yaml` and `engagement/roe.yaml` present and
complete). Set `PI_ALLOW_DIRECT_TOOLS=1` to force-allow direct tools mid-engagement (operator
override, still audited), or `=0` to force MCP-only lockdown without a configured engagement.

The kit's own first-party bookkeeping tools (`todo`, `subagent`, `dual_review`, the `task_*`,
`record_verdict`, `verdict_status`, `memory_*`, `mem0_*`, `skill_*` and `branch_*` tools) are exempt
from MCP-only mode: they do not touch a pentest target and are already gated by `tool-firewall`.

## What the boundary guarantees

1. **No silent allow-all.** A fresh session loads the shipped starter policy
   (`packages/extensions/src/tool-firewall/default-policy.json`), whose unknown-tool default is
   `ask`: nobody answering the bounded operator request means **deny**. See
   [Tool identity policy precedes permission](#tool-identity-policy-precedes-permission) for the
   exact identity, adapter and approval rules. Fresh-session loading and no-marker-execution
   cases are pinned by `tests/tool-firewall-smoke.ts`, `tests/firewall-gate-smoke.ts` and
   `tests/firewall-unattended-smoke.ts`.
2. **Destructive shell commands never run automatically.** The shell parser classifies each
   command by effect and target rather than by a regex over the text. Deleting `/`, `~` or system
   roots, `mkfs`, writes to raw block devices, fork bombs, and secret egress (a credential read
   and a network send in one command) are **critical** and denied in every profile and mode.
   Deletions outside the workspace, force-pushes, history rewrites and persistence are **high**
   and need an operator. Obfuscation (`r''m`, `r\m`, `$'\x72m'`, variable-built commands) is
   normalised before classification, and unparseable input is never auto-allowed. Authorisation
   precedes execution on every shell form tested, including wrappers such as `xargs`, `sudo`,
   `env`, `find -exec` and command substitution (`tests/firewall-noeffect-smoke.ts`: the marker
   file is never created and the tool never runs before an answer).
3. **Approvals are never broader than what you chose.** <a id="approvals"></a>An "allow" you give
   is bound to the exact action, the workspace, the directory and the session, and expires
   (24 hours for a session allow, 30 days for a learned one). Approvals are stored in one file,
   `<agent dir>/pi-kit/firewall-approvals.json` (mode 0600), and `/firewall list` shows each with
   its scope, who granted it and how; `/firewall revoke <id>`, `revoke session`, `revoke workspace`
   or `revoke all` removes them, effective from the next call. A malformed approvals file is
   ignored, never treated as an allow, and reported. A precedent learned in one workspace does
   not run unasked in another. The workspace is the nearest directory at or above the working
   directory that holds a `.git`. It is never your home directory, `/`, or a shared temp root such
   as `/tmp`, because a stray `.git` there would widen it to everything below
   (`tests/workspace-root-smoke.ts`).
4. **Every refusal is labelled once**, as `[HARD DENY]`, `[UNCERTAIN ...]`,
   `[OPERATOR DECISION: denied]` or `[AUTO-MODE BLOCK]`, in the text the agent sees, on the
   approval card and in the audit record. A hard deny cannot be overridden by an approval or the
   judge.
5. **Auto mode cannot approve anything critical, or any new kind of high action, on a model's
   say-so.** A high action runs without the operator only as an exact repeat of an approval you
   gave. A judge block whose confidence is not high goes to the operator rather than being final,
   and an unsure judge never becomes an allow.
6. **Nothing waits forever.** An approval card, the human console and the judge all have
   timeouts (15 minutes, 15 minutes and 15 seconds by default); an unanswered wait ends as
   `UNCERTAIN` and nothing runs. Aborting ends every wait.
7. **Every child agent is at least as protected as its parent.** `delegation-guard` starts a child
   only with the protections the parent registered; inside the child it checks that they loaded
   and otherwise blocks every tool and exits with code 78. This applies to grandchildren and to
   every launch path (the `subagent` tool, workflows, verification reviewers, validators, the
   `dual_review` tool and `/review`). Extensions are added to a child by kit name only, never by
   path, and a scan test fails when a launcher of `pi` children does not ask the guard
   (`tests/delegation-guard-smoke.ts`).
8. **Unattended mode needs what the supervisor builds, and a contract an agent cannot fake.** It
   is active only when the process environment and a contract file say so and agree, and the
   contract is not in the workspace, the working directory or the agent directory and sits on a
   **read-only mount** (the runner mounts `/run` read-only) or is owned by another user and unwritable
   by this process. A file the same user wrote and then made read-only is refused, root included.
   Any inconsistency means the normal rules apply. Starting a child with the variables from an agent's
   shell (an env prefix, `export`, `env`, or an interpreter's inline code that names them) is a
   safety-setting override: asked, and hard-denied inside a worker. A script the agent wrote
   earlier that sets them is not visible to the classifier; the provenance rule is what stops it.
   See [Autonomous runs](autonomy.md). Pinned by `tests/firewall-unattended-smoke.ts`.
9. **Every firewall decision is audited** to `.pi/tool-firewall-audit.jsonl` (tier, effects,
   reason codes, redacted command, action hash, and the decider: analyser, policy, learned
   precedent, judge or human). Every tool call and output is also captured by `tool-capture`. The
   capture log holds exact values, secrets included, so it is private (`0700` and `0600`),
   write-protected against the agent, and reading it is a credential read for the firewall.
10. **`secret-guard`, when enabled, blocks the obvious secret paths.** It blocks writing key
    material or tokens to any file, and `cat`, `cp`, `mv`, `base64`, `curl -F @file` and PowerShell
    style reads of `.env`, `*.pem`, `*.key`, `id_rsa` and protected engagement paths, including
    glob-obscured and quote-fragmented references. The firewall separately classifies credential
    files as credential reads whether or not `secret-guard` is loaded. For a tool the policy
    allows, it checks every path the call names in a `path`, `file_path`, `filePath`, `file`,
    `files`, `paths`, `cwd`, `dir`, `directory` or `root` field (`tests/firewall-shell-smoke.ts`).
11. **The project's `.pi` control directory needs an operator.** `<workspace>/.pi` and
    `<cwd>/.pi` hold the audit trail, verdicts and auto-mode switch, so renaming, replacing,
    linking over or deleting the directory itself is a **high** safety-control change, and so is
    moving a directory that holds it (the workspace included) or `rsync --remove-source-files` (or
    its alias `--remove-sent-files`) from one. A source operand of `mv` or of those `rsync` options
    that is an unexpanded glob (`*`, `?`, `[...]`) counts when it could match the directory or one
    that holds it (`mv .p* /tmp`), following bash's default rule that `*` does not match a leading
    dot; a bracket expression with a POSIX class, collating symbol or equivalence class
    (`[[:alpha:]]`) is taken to match any one character. Brace expansion (`{a,b}`, `{x..y}`) is
    applied to `mv`, `cp`, `scp` and `rsync` operands before they are classified (`mv .pi{,.bak}`
    moves `.pi`), and any other path that contains a brace group is a safety control when one of
    its expansions is; a word that would expand to more than 64 words is treated as a safety
    control. Quoting is not tracked here, so a quoted `'{a,b}'` is expanded too. The same goes for the files pi loads into the next session (`.pi/settings.json`,
    `.pi/mcp.json`, `.pi/mcp-adapter.json` (pi-mcp-adapter's project file), `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md` and anything under `.pi/extensions/`, `.pi/skills/`, `.pi/prompts/`
    and `.pi/themes/`) and for `.pi/GOAL.yaml`, which the judge and the system prompt read as your
    goal. `mkdir -p .pi`, reading or copying the directory out, and other `.pi` files stay ordinary
    work (`tests/firewall-shell-smoke.ts`). `protected-paths` also blocks tool writes to
    `.pi/GOAL.yaml` outright, while the `/goal` command still sets, shows and clears it
    (`tests/protected-paths-smoke.ts`).

## What the boundary does NOT guarantee

- **It is not a sandbox.** A tool call that is *allowed* runs with the agent's full operating
  system privileges. The firewall decides *whether* a tool runs, not *what it can reach* once
  running. For containment use the [autonomous runner's container](autonomy.md) or your own.
- **Content detection is heuristic.** A novel secret format, a secret split across writes, or one
  encrypted or obfuscated before writing can evade `secret-guard`. Treat it as defence in depth.
- **Command classification is static.** The parser sees the command text, not what a script
  does at run time: `./build.sh` or `python tool.py` is judged by name and context. A wrapper
  script the agent wrote earlier can hide an effect. Session history (download then execute,
  secret then send) and the headless fail-closed behaviour are the backstop.
- **An approval binds the command as written, in one workspace, directory and session, not what it
  will do.** `git push origin main` approved once runs again unasked in the same place even if
  `origin` now points somewhere else, and an approved script runs again after it has been edited.
  Approvals expire (24 hours for a session allow, 30 days for a learned one) and `/firewall revoke`
  withdraws them, but the next repeat is judged by its text.
- **The approvals file and the effort ledger are files.** Writes to the approvals file hold a lock
  and fail (nothing is remembered, a revoke says nothing changed) rather than go ahead without it;
  both locks recover from a crashed holder. A process running as your user can still edit either
  file; the firewall protects them from the agent's tools, not from you or from another process.
- **Low-tier actions run unasked in every mode.** That includes reads through exact built-in
  adapters, explicitly allowed external APIs and plain shell network GETs. `/firewall status`
  prints this. An exact policy allow is an operator trust decision about a tool's implementation;
  the firewall cannot authenticate a plugin or prove that its implementation matches its name.
  Exact names do not bind code: replacement code registering `read`, or any explicitly allowed
  name, inherits that identity's policy. In-process extension code can also perform I/O directly,
  outside tool-call interception. Plugins themselves are not isolated; no test establishes an
  implementation-binding or in-process isolation boundary.
- **It does not police network egress by itself.** A network send is medium (judged in auto mode,
  asked in manual) and becomes high or critical after a secret read. Destination allow-listing is
  the pentest governance layer's job (scope and rules of engagement), and in unattended runs the
  container's network is the stop, because package-manager and opaque-tool traffic cannot be
  attributed to a host.
- **The kit's own sources are ordinary files in a kit checkout.** When the workspace is a source
  checkout of this kit (for example the one a live install was made from), an agent edit to
  `packages/extensions/src/tool-firewall/`, `packages/extensions/third_party/protected-paths/` or
  `packages/extensions/src/secret-guard/` is classed like any other source edit (low); only
  `tool-firewall/default-policy.json` is a safety control among them
  (`tests/firewall-shell-smoke.ts`). If pi loads the extensions from that checkout, review such
  diffs before the next session.
- **Companion tools outside the kit's classification.** A pi package that registers its own shell
  or edit tools (for example the optional `pi-lean-ctx`) needs an exact policy entry or operator
  approval. Shell-looking fields are also analysed, but cannot authorise an unknown tool's
  other effects. `secret-guard` matches the built-in tool names. An explicitly allowed external
  tool with `risk_class: "network_read"` uses the URL/egress adapter and marks its result untrusted;
  other external API semantics remain the operator's responsibility. With `defaults.unknown: "deny"`,
  every tool needs an explicit policy entry, including built-in adapters. These cases are pinned by
  `tests/firewall-shell-smoke.ts`, `tests/tool-firewall-smoke.ts`, `tests/firewall-gate-smoke.ts`
  and `tests/firewall-unattended-smoke.ts`.
- **Effort is not a boundary.** It budgets delegation and shapes behaviour; the ledger and its
  environment are owned by your user. A hostile process could edit them. See [Effort](effort.md).
- **Unattended mode trusts the supervisor's claim of a boundary.** The firewall checks the
  environment, the contract and where it lives (a read-only mount, or another user's file), but it
  cannot verify that the container the supervisor describes exists. Someone who can mount
  filesystems or run code inside the pi process, or root on the host, can still present a
  contract. The container, not this check, is the boundary.
- **A custom policy can widen the boundary.** `PI_KIT_FIREWALL_POLICY` pointing at a permissive
  file (for example `{ "defaults": { "unknown": "allow" } }`) re-opens the gate. `verify.ts`
  only guarantees the *shipped* policy is default-deny. Such overrides, and `PI_KIT_UNATTENDED*`,
  are safety-setting overrides.
- **Interactive approval is only as careful as the person answering it.** Cards show the action,
  its tier and the reasons; a remembered approval is scoped, but you still decide.

## Overriding and tightening

- `PI_KIT_FIREWALL_POLICY=/path/to/policy.json` replaces the shipped policy.
- `/profile pentest` or `PI_KIT_FIREWALL_PROFILE=pentest` selects the strict policy. Profiles set
  the firewall mode and policy only; they never turn on unattended mode.
- `/auto off` or `PI_KIT_AUTO_MODE=0` asks for every medium and high action; `/auto learn off`
  stops applying learned precedents.
- `/firewall status` shows the policy, mode, judge, rule counts and session state;
  `/firewall list` and `/firewall revoke` manage approvals; `/firewall reload` re-reads the
  policy file.
- Tighten by adding `command_rules.deny` entries, or setting `tools.<name>.decision` to `deny`.

## Tests that pin this

`npm run test:security` runs the firewall, shell parser, approvals, outcomes, no-side-effect,
pre-authorisation, unattended-mode, protections-registry, delegation-guard, web-console and
remote-control suites, plus `secret-guard`. `verify.ts` fails the build if the shipped policy stops being default-deny or
its destructive patterns stop being a superset of `pentest-governance-domain`'s. As with any
pattern-based boundary, this is the current state of an ongoing effort, not a permanent guarantee.
