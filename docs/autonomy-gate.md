# Autonomy Gate (tool-firewall v2)

`tool-firewall` decides, before every tool call runs, whether it may run. The goal is
simple: an agent in auto mode should do routine work without asking, and dangerous actions
should still be stopped or brought to you. This page describes how that decision is made. It
implements the deterministic core of
`docs/proposals/PI_AUTONOMY_GATE_SPEC.md` (phases 1–3 and a light phase 5). The spec's
ML models, separate daemon and sandboxing are deferred.

## How a decision is made

1. **Parse.** Shell commands are parsed, not pattern-matched. The parser handles:
   - quotes, `$'…'`, `$( )`, backticks, heredocs, redirections, pipes and `cd`/variable
     tracking;
   - obfuscation such as `r''m`, `r\m` and `$'\x72m'`;
   - wrappers: `sudo`, `env`, `timeout`, `nice`, `xargs`, `find -exec`, `bash -c`, `eval`,
     `tmux send-keys`, `su -c`, privilege and namespace launchers (`pkexec`, `chroot`,
     `unshare`, `bwrap`, …), project runners (`uv run`, `poetry run`, `mise exec`, …),
     terminal launchers, and `ssh host '…'`, whose remote command is parsed and classified
     too. [Parser coverage](#parser-coverage) lists the rest.

   Anything it cannot parse reliably is treated as opaque and never auto-allowed. A writer
   fed by `xargs` or `parallel` (`touch`, `cp`, `mv`, `tee`, `chmod`, …) writes to paths the
   parser cannot see, so it is medium, not routine.
2. **Classify.** Each command and each non-shell tool call becomes a set of **effects**:
   read, workspace write, delete, network send, remote exec, privilege, persistence,
   credential read, security control, destructive system, obfuscated exec, and others.
   Targets are scoped by path class:
   - build output inside the workspace, e.g. `rm -rf node_modules`, is routine;
   - other deletes in the workspace are medium;
   - deletes outside the workspace are high;
   - deletes of `/`, `~` or system roots are critical.
3. **Session history.** The following raise the tier:
   - reading a secret, then sending data to a remote host;
   - downloading a file, then running it or making it executable;
   - a burst of deletions.

   History is kept per session under `~/.pi/agent/pi-kit/firewall-sessions/`.
4. **Tier and decide:**

   | Tier | manual | auto (coding policy) | pentest policy |
   |---|---|---|---|
   | low | allow | allow | allow |
   | medium | ask | judge: allow, block (high confidence) or ask you (unsure) | ask (the judge may only clear pure reads) |
   | high | ask | exact approval runs; else the judge, if you allowed something similar here; else ask | ask each time, no approvals; denied headless |
   | critical | deny | deny | deny |

   In auto mode with the coding policy, two cases count as low:
   - read-only `ssh` to a known host (from `~/.ssh/config` or `knownHosts`);
   - read-only `sudo -n` commands. `sudo` inside `ssh host '…'` counts as `sudo -n`, because it
     has no terminal to prompt on.

   Remote writes, mounts, key installs and interactive sudo stay medium or high. Manual mode
   never applies these two shortcuts: a read-only `ssh` to a known host asks there.

What runs without asking in every mode is the **low** tier: reads of paths that are not
credentials (inside or outside the workspace), git reads, network GETs, workspace writes,
ordinary development tooling, and tools whose name reads as read-only (`get_…`, `list_…`).
`/firewall status` prints this for the mode in force.

An executable the classifier has no rule for is **medium**, not routine: it asks in manual mode
and goes to the judge in auto mode. A short reviewed list of read-only text utilities (`cut`,
`column`, `paste`, `base64`, `od`, …) stays low. A shell function defined earlier in the same
command is low to call. Its body is rated where it is defined, with its positional parameters
(`$1`, `"$@"`) unresolved, because the parser does not bind a call's arguments to them; instead
every path argument of the call is checked as a read and as a write, so passing a safety-control
path to a function is high whatever the body does with it (`tests/firewall-shell-smoke.ts`).

Starting another coding agent (`pi`, `claude`, `codex`, `gemini`, `aider` and others) is
recognised by identity: the bare command, the command by absolute or relative path
(`/usr/local/bin/pi`), a package runner (`npx`, `pnpm dlx`, `bunx`), a package path under
`node_modules`, or `python -m`. One started with a moved `HOME`, `XDG_CONFIG_HOME`,
`PI_CODING_AGENT_DIR` or its own home variable (`CODEX_HOME`) runs with a configuration the
operator did not set up, so it is high; so is one started with a flag that turns its own
approvals off (`tests/firewall-shell-smoke.ts`).

## Parser coverage

The parser's contract is that every command bash would execute from a command line is either a
parsed segment, which the classifier rates, or reported as opaque, which never runs without
asking. Beyond the forms above it parses:

- command text inside `$(( ))`, `(( ))`, the word operand of a parameter expansion, quoted or
  not (`${x:-…}`, `${x:=…}`), and a `case` pattern; and, when it contains a substitution, an
  array subscript or arithmetic operand (reported as opaque);
- function definitions (`f() { …; }`, `function f`), `coproc`, and brace expansion, including in
  a command name (opaque when mixed with quoting or past 64 expansions);
- hook and callback text bash runs later: `PS0`, `PS1`, `PS2`, `PS4`, `PROMPT_COMMAND` and
  `BASH_FUNC_*` values, whether set as a prefix, with `export`/`declare` or as an `env NAME=value`
  operand, `trap`, `alias`, `mapfile`/`readarray -C`, `complete`/`compgen -C`, `bind -x`;
  `BASH_ENV` and `ENV` are medium, including when `env` or a prefix hands them to a shell it
  starts (the environment a wrapper passes stays on the commands that shell runs);
- builtins that change what a later command name runs: a name redefined by `alias` or by
  `hash -p` earlier in the same command is classified as the alias value or hashed path with the
  call's arguments; an alias whose value is not a simple command, and `enable -f`, are opaque;
- `source` or `.` of standard input with a here-document, and a shell reading its script from one;
- `fc` without `-l`, `expect -c`, debugger command scripts and `systemd-nspawn` are opaque;
- wrappers that run a command: about thirty exec, privilege and namespace launchers, the project
  runners, `nix-shell --run`, `nix develop -c`, `pnpm exec`, `nodemon --exec`, `entr`,
  `concurrently`, `hyperfine`, `script -c`, `gdb --args`, `perf` and terminal emulators. A wrapper
  given an option the parser does not know is opaque rather than guessed at. Running inside a
  namespace wrapper or `systemd-run` is at least medium.

`tests/firewall-shell-smoke.ts` pins these rows. `tests/firewall-exec-oracle-smoke.ts` checks the
contract against bash itself: it runs a corpus of benign commands in real bash with a `PATH` of
logging stubs (inside `bwrap` when it works on the host, otherwise in a scratch directory with the
same stub `PATH`), records every command that ran, and fails when one ran that the parser neither
returned as a segment nor reported as opaque, or when one of them was rated routine.

Not covered: values that arrive at run time. `IFS` changes, arithmetic indirection through a
variable set elsewhere and a command name built from a variable the parser cannot resolve are not
modelled; a dynamic command name is never routine, but a dynamic argument is checked only as far
as its literal text. An alias or `hash` entry set outside the command (a shell profile, a sourced
file) is not known, an alias value ending in a space (which makes bash expand the next word as an
alias too) is not followed, and a function's positional parameters are not bound to the call's
arguments (the arguments are checked as reads and writes instead, as above).

## Three outcomes

Every refusal is exactly one of these, and the tool result the agent reads, the approval card
and the audit log all say which:

| Outcome | Meaning | What happens |
|---|---|---|
| **HARD DENY** | Policy says never: the critical tier, a policy `deny`, a pentest rule, and in an unattended run the hard classes below. | Never shown to you, never judged. No approval, session allow or judge can override it. The agent is told to leave it out or ask you to run it. |
| **UNCERTAIN** | The automatic layers could not settle it: the judge is unsure of a block, unavailable, timed out or aborted, or the command cannot be read; or nobody could be asked. | With a UI or console it goes to you (the card is tagged `UNCERTAIN`). Without one it fails closed after a bounded wait, with a message the agent can relay. |
| **OPERATOR DECISION** | You allowed or denied it (card or console). | Remembered only within the scope the card names (below). |

A high-confidence block by the auto-mode judge is its own labelled case (`AUTO-MODE BLOCK`):
final, with the reason returned to the agent.

```mermaid
flowchart TD
    A[tool call] --> B{critical, policy deny,<br/>pentest rule?}
    B -- yes --> HD[HARD DENY]
    B -- no --> C{low tier?}
    C -- yes --> RUN[runs]
    C -- no --> D{exact approval here?<br/>same workspace, cwd, session}
    D -- yes --> RUN
    D -- no --> E{auto mode and<br/>judge-eligible?}
    E -- allow --> RUN
    E -- block, high confidence --> JB[AUTO-MODE BLOCK<br/>reason to the agent]
    E -- block unsure, unavailable,<br/>timeout, opaque command --> U[UNCERTAIN]
    E -- not judged --> Q{operator reachable?}
    U --> Q
    Q -- card or console answers --> OD[OPERATOR DECISION<br/>allow or deny]
    Q -- nobody, or no answer in time --> UF[UNCERTAIN, refused<br/>bounded, actionable text]
    OD -- allow --> RUN
```

Nothing waits on a UI that is not there. The human-console broker honours
`PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS` (15 minutes by default; subagents get a shorter one) and the
turn's abort signal. An interactive card, confirm or note prompt is bounded by pi's own dialog
timeout and abort signal and again by the firewall, with `PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS`
(15 minutes by default). The judge waits at most `PI_KIT_FIREWALL_JUDGE_TIMEOUT_MS` (15 seconds
by default) and stops at once when the turn is aborted. A console that cannot even be written to
is UNCERTAIN, not "the operator declined". An interactive `ask_human` question gives up at the
console timeout too.

## Action families

"This kind of action" means a set of **families**. Work on a remote host or as root is grouped
by where it runs and what it does, e.g. `srv02 as root:write_outside` or
`srv02 as root:credential_read`. Ops commands there vary in every path and flag, but your
decision is about the host and the kind of effect.

Some families keep an exact key instead, because their meaning depends on the exact target:
- local work;
- network sends (per destination);
- history rewrites and publishes (per remote);
- security-control, destructive, obfuscated and opaque actions;
- cross-action chains such as secret → send.

Families and scopes decide what counts as *similar* and whether the judge may look at an
action at all. They never allow anything by themselves.

## The judge (auto mode)

**Medium** actions go to a model called in-process, with a 15-second timeout. It sees:
- your **latest** request and the session goal (`.pi/GOAL.yaml`, if set);
- the last few actions;
- this action's parsed effects and reasons;
- up to five of your past decisions on similar actions.

It answers `allow` or `block`, and says how sure it is (`confidence`: high, medium or low):
- `allow` runs the action, whatever the confidence.
- A **high-confidence block** is final. It is returned to the agent as the tool result, with the
  reason, so the agent can change course or explain to you why the step is needed. You get a
  quiet notice, not a prompt. An answer that states no confidence (the older shape) is treated
  the same way.
- A **medium- or low-confidence block** is UNCERTAIN, not final. It goes to you with the judge's
  doubt on the card (or to the human console when headless).
- If the judge is unavailable, times out or is aborted, the action is UNCERTAIN too.

A **high** action goes to the judge only when all of these hold:
- auto mode is on, with the coding policy;
- the action is learnable;
- you have already allowed something similar in this workspace: either a **session allow**
  that shares a family or a host/root scope with it, or approvals of **every family in it**
  (within 30 days, with no denial since, and none revoked).

The judge then reasons over the **whole actions** you allowed: their command, steps,
severity, reasons and chain. It also sees your latest request, the goal, precedents, and your
learned profile. Precedents are your earlier decisions on similar actions in this workspace only,
and none made before a `/firewall revoke workspace` or `revoke all` (`tests/firewall-gate-smoke.ts`). It allows only when this is the same kind of step: same host and privilege,
same or narrower paths and services, no new kind of effect, no higher severity, continuing the
same work. "Block" does not refuse outright. It asks you, and the card says exactly **how
this differs** from what you allowed. A kind you have never allowed always comes to you first,
and critical actions never reach the judge.

Model: `PI_KIT_AUTO_MODE_MODEL`, then `judgeModel` in `firewall.json`, then the session model.

## Approval cards and remembered approvals

A card is at most **10 lines** of at most 116 characters, so it fits a pane and the human
console. It contains:
- the tier and summary (prefixed `UNCERTAIN` when the automatic layers could not settle it);
- the command;
- the reasons, highest first, then "+N more";
- the session history;
- the judge's note;
- your past decisions on this kind;
- what a session allow would cover, and how far it reaches.

`/auto explain` shows the full analysis of the last card.

The choices are:
- *Allow once*;
- *Allow for this session*: an exact repeat runs, and in auto mode similar steps go to the
  judge, checked against this action. It is not a blanket allow for "root on srv02". This
  choice is not offered under the pentest policy;
- *Deny*;
- *Deny and tell the agent why*.

Headless sessions and subagents send the same menu through the human console. A console
without menu support still answers yes/no.

**Console answers are authenticated.** The console's files live in the workspace
(`.pi/human-console`), where the agent can write, so a file in `resolved/` is not evidence that a
person answered. Each answer carries an HMAC-SHA256 over the request id, the SHA-256 of the
request's exact pending bytes and the decision, made with a key at
`<agent directory>/human-console/response.key` (64 hex characters, mode 0600 in a 0700
directory, owned by the operator). Only the interactive console creates the key, when its session
starts; a requester (the firewall, `pentest-governance-domain`, `ask_human`) never does, and one
that finds no key files nothing and reports that the console must start first. The tool
firewall, `pentest-governance-domain` and `ask_human` accept only an answer whose MAC verifies
for the request they wrote; an unsigned, forged, rewritten or replayed answer is deleted,
audited as `human_console_answer_rejected` and the wait goes on, so it ends in the usual timeout.
A key that is missing, a symbolic link, open to other users, owned by another user or malformed,
or a key directory that is a symbolic link, open to other users or another user's, makes the
console unavailable (UNCERTAIN, fail closed). The key is outside the workspace and the console
directory. The firewall classifies `<agent directory>/human-console` as a credential for reads and
a security control for writes: reading the key directly, through a glob, by reading the directory
or the agent directory recursively, or with `find -exec` is a high-tier credential read, and
writing the key or creating, linking, copying or moving the directory is high. This keeps the
agent's tool calls away from the key by policy, not by the kernel. Residual risks: inline
interpreter code that builds the key's path at run time is not recognised by that rule (the
firewall cannot see a path assembled at run time), and code inside a pi process (an extension), a
same-user process that is not a tool call, or an agent whose request to read the key you approve
can read it.
`tests/human-console-auth-smoke.ts` (`npm run smoke:human-console-auth`) pins the key checks, the
refusals, the classifier tiers for those read and write forms and an end-to-end approval.

### What an approval covers

An approval is never broader than the choice you made. Each one is an entry in
`~/.pi/agent/pi-kit/firewall-approvals.json` (`PI_KIT_FIREWALL_APPROVALS`), and it is bound to:
- **one exact action** (tool and arguments, by hash);
- **one workspace and working directory**: the same command in another workspace, or another
  directory of the same one, is asked again;
- **the policy** it was given under (never the pentest policy, which offers no session allows);
- for a **session** approval, the **root session**, shared with the subagents it spawns (they
  inherit `PI_KIT_FIREWALL_ROOT_SESSION`); a `/new` session starts with none. It expires after
  24 hours.

A **persistent** approval is a *learned exact action* (below). It is bound to the workspace it
was learned in and expires after 30 days.

Each entry records who or what granted it (you, through the card or the console, or the
learning rule), when, why the action needed approval, and its expiry:

```json
{ "schemaVersion": 1, "updated": "2026-09-30T10:00:00.000Z",
  "approvals": [ { "id": "apr_1a2b3c4d", "createdAt": "…", "expiresAt": "…",
    "context": "session", "session": "s1", "workspace": "/work/repo", "cwd": "/work/repo",
    "policy": "coding", "tool": "bash", "hash": "…64 hex…", "families": ["…"], "scopes": ["local"],
    "tier": "medium",
    "grantedBy": { "actor": "operator", "via": "card", "session": "s1", "mode": "manual",
                   "policy": "coding", "choice": "Allow for this session (exact repeats only)" },
    "action": { "command": "git push origin feature/a", "summary": "…", "steps": [], "reasons": [], "chain": [] } } ],
  "floors": { "all": null, "workspaces": {}, "actions": {} } }
```

The file is treated as untrusted input. A file of another `schemaVersion`, invalid JSON, or an
entry of any unknown shape (a wrong type, a missing field, an unknown key) is **ignored, never
treated as an allow**, and reported: on stderr, as a warning in an interactive session, in
`/firewall list`, and as an `approvals_malformed` audit record. A rejected file is kept beside
the rewrite as `firewall-approvals.json.rejected-<hash>`. The file, like the rest of the
firewall's state, is protected from the agent's own writes.

`/reload` and compaction keep the same session and read the same file, so an approval persists
across them and is neither widened nor lost. A different session never sees it.

### Learning

Every decision you make is also appended, with secrets redacted, to
`~/.pi/agent/pi-kit/firewall-feedback.jsonl`. The same redaction applies to the audit log and
the judge's input. It covers known token shapes, `KEY=value` with a prefixed key
(`DB_PASSWORD=`, `GITLAB_TOKEN=`, `AWS_SECRET_ACCESS_KEY=`), `mysql -p<password>` and
`curl -u user:password`, and runs in linear time on 200 KB inputs
(`tests/firewall-gate-smoke.ts`). One "yes" is never "allow always", and "allow
once" is remembered only by this rule:

An action that you approved at least **3 times, in at least 2 sessions, within 30 days, all
after your last denial of it, in the same workspace** becomes a *learned exact action* in auto
mode with the coding policy. It is stored as a persistent approval (so it is listed and can be
revoked) and only the **exact same action** then runs without the judge. Families are counted
the same way, per workspace, and make similar actions judge-eligible. A learned action requires
all of these:
- never critical;
- never security-control, destructive-system or obfuscated-exec effects;
- never secret egress, uploads of secrets, a shell piped from the network, unguarded agent
  spawns or safety-env overrides.

A later denial suspends it (it is checked each time it would run), and it expires after 30
days. Manual mode never applies a learned allow.

### Revoking

`/firewall list` shows every approval with its scope, grantor, expiry and whether it applies
to this session and workspace, then the known hosts and how many kinds you approved here.
`/firewall revoke` withdraws them, and the next tool call already asks again:

| Command | Effect |
|---|---|
| `/firewall revoke <id>…` | one or more approvals (a unique prefix of six or more characters works). Revoking a learned action also restarts its learning from zero. |
| `/firewall revoke session` | this root session's approvals |
| `/firewall revoke workspace` | everything for this workspace, and everything learned there (the judge-eligibility of similar actions too) |
| `/firewall revoke all` | every approval, and everything learned |
| `/firewall revoke host:<name>` | trust in a known host (below) |

Every target is checked before anything changes: an unknown id, an ambiguous prefix, a missing
argument or a scope word combined with another target is an error and changes nothing. In a
headless session the output goes to stderr instead of a notice.

### Known hosts

`knownHosts` in `firewall.json` and the hosts named in `~/.ssh/config` make read-only `ssh` and
`sudo -n` reads routine in auto mode (they never allow a write). `/firewall list` shows each one
with its source. `/firewall revoke host:<name>` removes it from `knownHosts`, or, for a host that
only `~/.ssh/config` names, lists it under `untrustedHosts` (your ssh config is never edited).
`~/.ssh/config` is writable by the agent (with an approval), so hosts it names are trusted only
while the file is unchanged since the session started; after a change the firewall trusts
`firewall.json`'s hosts alone until you run `/firewall reload`.

### Global learning (background)

Every decision you make, and every verdict the judge gives, is kept globally:
- `firewall-feedback.jsonl` holds your decisions, with steps, chain, note, and the judge's
  view when it ran first;
- `firewall-judgements.jsonl` holds the judge's verdicts, with their confidence. It rotates at
  4 MiB and keeps one old copy.

After every 8 new decisions (or once a day if there are any new ones), a background
distillation compresses these into `firewall-profile.json`. The profile holds:
- per-kind statistics: approvals, denials, judge allows and blocks, and where you overrode or
  agreed with the judge;
- up to 12 short **principles** (how you decide) and up to 12 **cautions** (what you refuse),
  written by the judge model.

The distillation is off the hot path, runs one at a time across processes, and never blocks
a tool call. The judge sees the profile, plus the history of this action's kinds, as data.
The profile only informs the judge: what may reach the judge and what runs without it stays
deterministic. Precedents and the profile are global examples for the judge and never allow
anything by themselves.

The judge prompt puts each input in its own block (`<request>`, `<goal>`, `<recent>`, `<action>`,
`<grants>`, `<precedents>`, `<profile>`). Text that comes from the session, such as the request,
the goal file, the agent's command, paths, grants and precedents, has its block tags defused: a
`<`, a fullwidth `＜` or small `﹤`, or the entities `&lt;`, `&#60;` and `&#x3c;` is shown to the
judge as `‹` when what follows it starts with an optional `/` and one of the block names, in any
case. Spaces, invisible characters (default-ignorable and format characters) and combining marks
are ignored for that check however many there are, before or inside the name, and fullwidth
letters and `／` count as their plain forms. Other shell
operators such as `< in.txt`, `<<EOF` and `2>&1` reach the judge unchanged; a redirection from a
file whose name starts with a block name, such as `sort <recent.log`, is shown as
`sort ‹recent.log`. The command is clipped to 4000 characters. Its parsed steps and its findings
are each capped at 30 lines and 4000 characters, riskier lines first, with a `(+N more ...)` line
for the rest. A step's text and location are clipped to 200 characters each, and a line that would
pass the budget is skipped while shorter ones after it are still listed. A long generated script
therefore cannot make the judge prompt unbounded (`tests/tool-firewall-smoke.ts`).

`/auto profile` shows the profile, `/auto profile rebuild` rebuilds it now, and
`/auto profile reset` clears it (your decisions are kept).

## Policies and profiles

`~/.pi/agent/pi-kit/firewall.json`:

```json
{ "mode": "auto", "policy": "coding", "judgeModel": "provider/id", "learn": true, "knownHosts": ["buildbox"], "untrustedHosts": [], "source": "profile" }
```

The installer and `/profile` write it from the profile's `firewall` field:

| Profile | mode | policy |
|---|---|---|
| quick, balanced | manual | coding |
| long-horizon, autonomous, self-improving | auto | coding |
| pentest (formerly `engagement`) | manual | pentest |

- The policy always follows the profile.
- The mode follows the profile, unless you set it with `/auto on|off` and the policy did not
  change.
- `/auto on` lowers oversight, so unless both the saved mode in `firewall.json` and the
  current session's mode are already automatic it asks at the terminal of an interactive root
  session, with "No, keep manual approvals" as the first choice. It asks even while
  `PI_KIT_AUTO_MODE=1` makes the current session automatic, because it writes the saved mode, and it asks when a project `.pi/auto-mode.json` exists and
  does not already say `{"enabled": true}`, even while `PI_KIT_AUTO_MODE=1` overrides the file
  for the current session. `/auto` writes the legacy file only in an operator-set
  `PI_KIT_AUTO_MODE_STATE_DIR`, without following a symbolic link there; a project's own
  `.pi/auto-mode.json` is repository content and is never written, so one that selects manual
  approvals stays in force until you remove it (`tests/workspace-symlink-smoke.ts`). Over RPC (a
  linked phone or the web console), headless and in delegated/child sessions it is refused; a
  scripted run sets `PI_KIT_AUTO_MODE=1` instead. `/auto off` never asks
  (`tests/auto-mode-smoke.ts`).
- Environment variables override the file: `PI_KIT_AUTO_MODE=1|0` and
  `PI_KIT_FIREWALL_PROFILE=coding|pentest`.
- A project `.pi/auto-mode.json` from the old per-directory auto mode can only downgrade:
  `{"enabled":false}` selects manual approvals, and `{"enabled":true}` is ignored, so a file a
  repository carries never turns automatic approvals on (`tests/firewall-gate-smoke.ts`).

The **pentest** policy differs from coding in several ways:
- it adds the operator regex rules in `policies.pentest.command_rules` of the shipped policy
  (for example, any recursive `rm` is denied);
- it never trusts the auto-low shortcuts;
- it does not learn, and it offers no session allows;
- it denies high actions when no operator is present (a HARD DENY: the policy needs an
  interactive operator);
- `protected-paths` also blocks `.git/`, `node_modules/`, `.pi/agents/` and the engagement
  records.

Under **coding**, `protected-paths` blocks only secrets, key files, agent-control and audit
surfaces, kit policy files, the firewall's own state (including the approvals file) and git's
`hooks/`, `config`, `info/` and `worktrees/`, plus a linked worktree's `.git` file.

Under both policies, git's `hooks/`, `config` and `info/` are found in the repository's git common
directory. For a linked worktree that is the main checkout's `.git`, outside the worktree. From
inside a linked worktree, the main checkout's own protected entries (for example
`<repo>/.pi/verdicts.json`) are blocked too. The worktree's `.git` file and the common dir's
`worktrees/` are blocked so the agent cannot point the lookup at a git dir it made. The lookup's
first result for a cwd is kept for the session, and a `.git` file that does not name a real git
dir blocks every write (`tests/workflow-worktree-smoke.ts`).

## Unattended mode

The autonomy runner starts each worker inside a hard boundary (a container) with an environment
only the supervisor sets:

| Variable | Value |
|---|---|
| `PI_KIT_UNATTENDED` | exactly `1` |
| `PI_KIT_UNATTENDED_BOUNDARY` | a known boundary kind: `container` |
| `PI_KIT_UNATTENDED_CONTRACT` | absolute path of a read-only, sanitised JSON copy of the run contract |

```json
{ "schemaVersion": 1,
  "unattended": { "authorised": true, "autoApprove": true },
  "boundaryDigest": "sha256:…",
  "permissions": { "egress": ["relay", "*.internal.example"], "remotes": ["origin"] } }
```

When, and only when, all of that holds, the firewall enters **unattended** mode: the container
is the boundary, so there are no approval prompts and no judge calls inside the zone, and
low, medium and high actions run. What still applies:

- **Refused, always** (HARD DENY): everything critical; tampering with the kit's controls
  (settings, the firewall's config, approvals and audit state, policy files, the contract,
  `PI_KIT_*` safety and `PI_KIT_UNATTENDED*` variables, `pi --no-extensions`); destructive
  system actions; credential-exfiltration chains, including a secret read in one call and a
  send in a later one; and anything that reaches for the boundary itself (privileged or
  socket-mounting containers, mounts, routes, capabilities, sysctl, kernel modules).
- **Needs authority outside the zone, fails closed** with a message the agent can relay:
  a network read or send to a host that is not in `permissions.egress` (an exact host or
  `*.suffix`; loopback is always inside; `host.docker.internal` is the host and is not; a web
  search has no fixed destination), a git remote that is not in `permissions.remotes` (also one
  retargeted in the same command, or configured to reach a foreign host), publishing, and cloud
  or cluster APIs. Nothing in a contract authorises publishing: the host does that.
- **UNCERTAIN, nobody to ask**: an `ask` rule in the policy, or a tool the policy does not name.
- `autoApprove: false` runs only the low tier and refuses everything above it at once.
- `secret-guard` and `protected-paths` are separate hooks and keep working, and both protect the
  contract path.

The mode can be entered **only** from that environment and contract, decided once when the
extension loads:

- A `firewall.json` setting, `/auto`, settings, a tool call, an environment variable changed
  afterwards, or a forged footer global cannot enable it. Launching a child with
  `PI_KIT_UNATTENDED…` from a tool call is a safety-setting override: asked when attended, hard
  denied when unattended.
- A missing, malformed or contradictory contract, an unknown boundary kind, a boundary named in
  the contract that differs from the environment, `authorised` other than `true`, a contract
  inside the workspace or agent directory (the agent could have written it), one a non-root
  process could rewrite, or the pentest policy, means **not unattended**, with a loud warning
  (stderr at load, a notice at session start, `/firewall status`). The normal interactive or
  headless rules then apply: fail closed, never silently permissive.
- A read-only mount or a foreign owner proves the contract came from outside only in the initial
  user namespace. Any user can create a user and mount namespace (and a PID namespace, in which its
  own process is PID 1) and make a read-only bind mount there, or own files as one of its
  subordinate ids (`/etc/subuid`). So both proofs count only when the process is in the initial
  user namespace (the kernel's fixed initial namespace id and the identity uid map); a read-only
  mount counts only in PID 1's mount namespace as well, and a foreign owner never when it is one of
  the user's subordinate ids. A worker in a rootful engine's container (Docker without user
  namespace remapping) passes. A worker under a rootless engine is in a user namespace its user
  made, which cannot be told apart from one an agent made, so it is not unattended and the normal
  headless rules apply. `tests/firewall-unattended-smoke.ts` covers each case, including real
  `unshare` namespaces, with and without a PID namespace and its own `/proc`, where the kernel
  allows them.
- The contract is re-read on every call. Any change to it, or its removal, turns the mode off
  for the rest of the process.
- It is visible: `globalThis[Symbol.for("pi-kit.unattended")]` is a frozen
  `{ active, boundary, autoApprove, label }` for the footer, and `/firewall status` shows the
  boundary, the contract digest and the egress and remote lists. The firewall never reads the
  global back.
- Effort and model choices never grant a permission: no decision depends on them.

**Children.** Subagents and their children are separate processes that inherit the environment
(the subagent runner copies `process.env`), read the same contract and validate it themselves.
A child that cannot read the contract, or whose environment was cleared, is not unattended and
follows the normal headless rules. A launcher may hand a child a narrower contract through
`PI_KIT_UNATTENDED_CONTRACT`; it applies to that child only.

## Commands

- `/firewall [status]` shows the mode, policy, what runs without asking, the three outcomes,
  unattended state, approvals, known hosts and the session. `/firewall:status` is an alias.
- `/firewall list` and `/firewall revoke …` inspect and withdraw remembered approvals (above).
- `/firewall reload` (alias `/firewall:reload`) reloads the policy file and re-baselines
  `~/.ssh/config`.
- `/auto status|on|off` sets the mode globally (`/auto-mode` is an alias).
- `/auto learn on|off`, `/auto learned` and `/auto forget <sig>` (a trailing `*` matches a
  prefix) manage learning. `/auto learned` shows the precedents of this workspace.
- `/auto stats` shows prompts per 100 actions, judge calls and blocks, learned hits, and
  repeats of session allows.
- `/auto profile [rebuild|reset]` shows or rebuilds the learned profile.
- `/auto explain [n]` explains the last *n* decisions.
- `/auto check <command>` classifies a command without running it.

In a headless session the output of these commands goes to stderr.

## Audit and tuning

Every decision is one line in `PI_KIT_FIREWALL_AUDIT_LOG` (default
`.pi/tool-firewall-audit.jsonl`). Each line includes:
- the tier, mode (`unattended` inside an unattended run), policy, workspace, effects and
  reason codes;
- the signature;
- the redacted command;
- the **decider** (analyser, policy, grant, precedent, judge, judge+grant, human, unattended);
- the **outcome** on a refusal (`hard_deny`, `uncertain`, `operator_decision`, `judge_block`);
- the latency.

Decisions that wait for someone add a `tool_approved` or `tool_blocked` line, and an
escalation adds a `tool_escalated` line saying why (`judge_unsure`, `judge_unavailable`,
`classifier_unsure`). Records carry the `toolCallId` and `actionHash`, which join them to the
exact arguments and output in the [tool I/O capture](tool-capture.md).

`npm run firewall:replay` replays the classifier and the decision matrix over your real
sessions in `~/.pi/agent/sessions`. Options include `--mode`, `--policy`, `--show` and
`--json`. It also reports how many prompts remain if every card is answered "allow for this
session". It is the regression and tuning tool:
- on 839 real calls, it cut about 54 human prompts to 6, all of them genuinely sensitive;
- in a root-over-ssh ops session on srv02 (29 prompts), one session allow on the first card
  sends the other 28 to the judge, which asks you only about steps that differ from it.

## Limits

Where the gate sits among the kit's trust boundaries, and what it is not meant to stop, is in the
[threat model](threat-model.md).

This is still a decision gate, not a sandbox. An allowed call runs with the agent's full
privileges. The parser covers the shell forms agents actually produce, and unparseable input
fails towards asking. A determined adversary with arbitrary code execution inside an allowed
interpreter is out of scope; see [security.md](security.md). In unattended mode the container's
network and filesystem policy is the hard stop: the firewall cannot attribute the network use of
a package manager or an opaque tool to a host, so those are left to the boundary, and it trusts
the supervisor's word that the boundary named in the environment is really there.
