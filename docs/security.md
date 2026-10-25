# Security model

This page states what the pi-system safety boundary **guarantees** and, just as important, what it
**does not**. It is a default-deny **guard rail**, not a sandbox. The reporting process is in
`SECURITY.md` at the repository root.

What the boundary protects, from whom, is in the [Threat model](threat-model.md); every control,
with its code, test and CI job, is in [Security controls](security-controls.md); the rules a
change to the kit follows are in the [Secure development standard](security-standard.md). What to
do when something goes wrong is in [Incident response](incident-response.md).

The [Security level](security-level.md) control adjusts implemented firewall approval mechanisms,
with balanced as the migration default and off locked pending a verified container attestation
(`tests/security-level-smoke.ts`).

## The layers

| Layer | Extension | Ships in | Enforces |
|---|---|---|---|
| Universal firewall and autonomy gate | `tool-firewall` | every profile | Parses shell commands into effects, tiers every call (low, medium, high, critical) with session history, auto-allows routine work, judges medium actions in auto mode, denies critical ones, and audits every decision. See [Autonomy gate](autonomy-gate.md). |
| Protected paths | `protected-paths` | every profile | Blocks writes to agent-control files, including the firewall's policy, approvals and audit files and the unattended-run contract. |
| Delegation governance | `delegation-guard`, `effort` | every profile | Every child agent is started only with the protections its parent has loaded, and verifies them itself before running a tool, failing closed. See [Agent orchestration](agent-orchestration.md). |
| Secrets guard | `secret-guard` | `balanced` and `autonomous`; the other profiles record an exemption (`tests/profile-protections-smoke.ts`) | A name- and pattern-based backstop: blocks writes to secret files and secret *content*, and shell commands that read, copy, encode or exfiltrate them. It also blocks every write to a path containing `secret` or `credentials`, which is why the other profiles go without it. Add it to another profile with `extensions.add` in `overrides.json`. |
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
    `files`, `paths`, `cwd`, `dir`, `directory`, `root`, `analysisRoot`, `newFilePath`,
    `scriptPath` or `trace_path` field (`tests/firewall-shell-smoke.ts`);
    `tests/firewall-path-fields-smoke.ts` fails when a kit or pi tool declares a path-like
    parameter outside that list.
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
    `.pi/GOAL.yaml` outright, while the `/goal` command still sets, shows and clears it, and to
    `.pi/mcp-adapter.json` (`tests/protected-paths-smoke.ts`, `tests/protected-paths-corpus-smoke.ts`).
12. **What pi loads with no trust prompt, and the operator-authority files, need an operator.**
    Writing anything pi loads from the agent directory (extensions, skills, prompts, themes, the
    installed `npm/` and `git/` packages, `SYSTEM.md`, `APPEND_SYSTEM.md`, the global context
    files, `settings.json`, `trust.json`), `~/.agents/skills`, a project's `.agents/skills`, or the
    kit's install marker `.pi-kit.json` is a **high** safety-control change, and so is a `git clone`
    or `git worktree add` into one, or a git command that rewrites the working tree (`pull`,
    `checkout`, `reset`, `merge`, …) of a repository that is one, named by `git -C` or reached by `cd`
    (`tests/firewall-autoload-smoke.ts` reads pi's sources and fails on a location the firewall
    misses; `tests/firewall-shell-smoke.ts` pins the git rows). The operator-authority files are one list in the
    classifier (`OPERATOR_AUTHORITY_FILES`): the web console token; the remote host's
    `control.json`, `identity.json`, `tls-key.pem`, `devices.json` and `audit.jsonl` in
    `PI_REMOTE_STATE_DIR` or `<agent dir>/remote-control`; pi's `auth.json` and `models.json`; and
    the remembered approvals. Reading a secret one is a credential read and writing any is high;
    the same test checks each entry against the code that writes it and fails on an unclassified
    secret-looking file name in kit source. A path that reaches a secret without naming it exactly
    is classified as that secret: a glob that can expand to one or to a directory holding one
    (`remote-control/*`, `auth.js*`), and a directory that holds one (the state directory, the agent
    directory, `~/.pi`) when it is read recursively, archived, copied or given to a tool such as
    `grep` (`tests/firewall-autoload-smoke.ts`). Inline interpreter code that names any credential or
    operator-authority path as a string literal is a credential read, whichever call reads it. A
    write to a path built at runtime whose literal tail names one of these files is high too, and so
    is a hard or symbolic link to one (`ln`, `cp -l`, `cp -s`, or a link call in inline code).
    Inline interpreter code (Python, Node, Deno, Bun, Ruby, PHP, Perl) that has a write-capable
    call (`open` with a write mode, `os.open` with write flags, pathlib `write_text`/`write_bytes`/
    `open`, `shutil` copies and moves, Node `fs` writers, copies and renames, `Bun.write`, Deno
    writers, Ruby `File`/`FileUtils`, Perl `open` for writing) and names one of these files is high
    (`inline_control_write`, `tests/firewall-shell-smoke.ts`) when the name is spelt in one of the
    forms the shared corpus tests: a literal path, a literal wrapped in `expanduser`, or the home
    directory joined to literal segments in the common spellings the corpus lists
    (`Path.home()/".pi/agent/…"`, `os.path.join(os.environ["HOME"], ".pi", …)`,
    `homedir() + "/.pi/…"`, a home-interpolated string, a relative literal after `chdir`). Reading
    such a file the same way stays a read.
    `protected-paths` blocks the same writes, including through `~`, `$HOME`,
    `$PI_CODING_AGENT_DIR`, a relative target after `cd`, clone, pull and checkout targets, `tar -C`,
    `unzip -d` and `rsync` destinations, links, plain shell commands that create, empty, delete or
    re-permission a protected file (`touch`, `truncate`, `rm`, `unlink`, `chmod`, `chown`, `chgrp`)
    as well as redirection, `tee` and `cp`/`mv` destinations, and the literal and listed inline
    spellings above; `tests/protected-paths-corpus-smoke.ts` runs one corpus against both.
    On top of those spellings, both layers apply one coarse, fail-closed rule, kept as generated,
    byte-checked copies of `packages/core/shared/inline-guard.ts`. It applies when a command runs an
    interpreter on inline code. The interpreter families are Python, PyPy, Node and its TypeScript
    and loader aliases (`tsx`, `ts-node`, `esno`, `esr`, `vite-node`, `babel-node`, `sucrase-node`,
    `jiti`, `iojs`), Deno, Bun, Perl, Ruby, PHP, Lua, awk, `osascript`, `pwsh`, `tclsh`, R and
    `Rscript`, Julia, Groovy, `jshell`, Swift, Kotlin, Scala, Elixir, Erlang (`erl`, `escript`),
    Racket, Guile and SBCL, with any version suffix. Inline code is any option before the script
    operand, a heredoc, piped or redirected input, no script file operand at all, or a Deno or Bun
    subcommand that runs code from the command line or stdin (`deno eval`, `deno run -`, `bun eval`,
    `bun -e`/`-p`). The interpreter is found behind leading assignments and the wrappers `env`
    (including `env -S`), `sudo`, `doas`, `nice`, `nohup`, `timeout`, `stdbuf`, `xargs`, `command`,
    `builtin`, `exec`, `time`, `ionice`, `chrt`, `setsid`, `taskset`, `busybox`, `npx`, `bunx`,
    `bun x`, `npm exec`, `pnpm exec`/`dlx`, `yarn dlx`/`exec`, `uvx`, `uv run`, `uv tool run` and
    `pipx run`, skipping their option values, including a value taken by the last letter of a
    combined short-option cluster (`sudo -u root`, `sudo -iu root`, `env -iu X`, `timeout 5`).
    Redirect words (`<file`, `<<WORD`, `<<<word`, `2>&1`, `>out`, also written with no space after
    the command word, as in `python3<<<'…'`) are dropped before the command is resolved, and the
    reserved words and grouping `{`, `}`, `!`, `if`, `then`, `do`, `else`, `elif`, `while`, `until`
    and `coproc` before the command word are skipped; `|&` is read as a pipe. A wrapper whose target is missing or not a literal name (`sudo "$PY"`), and a command
    word that is itself a variable, a substitution (`$PY`, `"$PY"`, `${PY}`, `$(…)`, backticks) or
    a glob (`pytho?`, `python[3]`), count as inline code. The command lines of `sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `fish`,
    `ash`, `yash` and `busybox sh` (`-c`, or a here-string fed to the shell) and of the `eval`
    builtin are read the same way, up to four levels deep; deeper nesting counts as inline code. A
    shell left with no script operand once its redirects are dropped (or given `-s`) counts as
    inline code when it has piped input or any redirect, heredoc or here-string. The rule fires when, in addition,
    the command text mentions an agent-configuration segment (`.pi` next to `agent`, `settings`,
    `extensions`, `auth`, `remote-control`, `devices`, `audit`, `mcp-adapter`, `.pi-kit` or
    `console`; `.pi-kit`, `mcp-adapter` or `PI_CODING_AGENT_DIR` alone; or, without `.pi`, one of
    the tails `agent/settings.json`, `agent/extensions`, `remote-control/devices.json`,
    `remote-control/audit.jsonl`, `mcp-adapter.json`, `pi-kit.json` or `auth.json`; all compared
    after quotes, whitespace, the concatenation operators between literals and, for the tails, path
    separators are removed), and the code has any write- or exec-capable call (an identifier
    containing `write` such as `createWriteStream`, a copy, `cpSync`, move, rename, remove, `rmdir`,
    `rmtree`, link, `mkfifo`, `mknod`, `utime`, `setxattr`, `makedirs`, permission or ownership
    call, `open` with a write mode, a print redirect, `system`/`exec`/`spawn`/`popen`/`subprocess`,
    `shutil`, `FileUtils`, `fs.`, `Deno.`, `Bun.`, backticks). Then the firewall rates it at least
    **high** (`inline_agent_config`) and `protected-paths` blocks it, whichever of those spellings
    builds the path (`tests/protected-paths-corpus-smoke.ts`).
    Because that parser is a coarse tokenizer, a parse-free backstop also runs over the raw command
    line: when the whole command mentions an agent-configuration segment, has a write- or
    exec-capable word, and names any of the interpreters, shells or wrappers above (or `eval`) as a
    whole word, the same rating and block apply. The name may sit next to a shell metacharacter
    (`python3<<<`, `{python3`, `|&bash`), and it is also looked for with the glob characters
    `[ ] ? *` removed, with quotes and backslashes removed, and as any globbed word that could
    expand to one of the names (`pytho?`, `/usr/bin/python[3]`). The backstop over-blocks by design:
    any one command line that combines an interpreter name, agent-configuration text and a write
    word is blocked, even when the interpreter runs a script file
    (`python3 scripts/write_settings.py ~/.pi/agent/settings.json`) or the three only meet in a
    commit message; split such a command or reword the message. The corpus pins both over-blocks.
    The rule only ever raises a rating. It over-blocks by design: inline code that merely mentions
    agent configuration next to such a call is caught too; run it from a script file instead. Inline
    code with no write- or exec-capable call (reading a protected file) keeps the behaviour above.
    Its remaining limits are a path computed entirely at runtime with no distinctive segment or tail
    in the command text (character codes, decoded strings, a value read from a file or the
    environment other than `PI_CODING_AGENT_DIR`), an interpreter or wrapper not listed above whose
    name never appears in the command text, and code run from a script file, which neither layer reads
    (see "Inline interpreter code" under
    [What the boundary does NOT guarantee](#what-the-boundary-does-not-guarantee)).
    A path built at runtime whose tail is a single segment (`$OUT/settings.json`,
    `os.path.join(d, "devices.json")`)
    is not resolved by either, nor is a path assembled from computed pieces with no literal naming the
    file (character codes, decoded strings), and `protected-paths` reads shell text with
    patterns rather than a parser, so it does not follow a `cd` inside a subshell or a function.
    A content read, archive or copy of the home directory itself, or of a directory above it
    (`grep -r … ~`, `tar czf … ~`), is a credential read too; listing it (`ls`, `du`) is not
    (`tests/firewall-shell-smoke.ts`).

## What the boundary does NOT guarantee

- **It is not a sandbox.** A tool call that is *allowed* runs with the agent's full operating
  system privileges. The firewall decides *whether* a tool runs, not *what it can reach* once
  running. For containment use the [autonomous runner's container](autonomy.md) or your own.
- **Inline interpreter code is matched coarsely, not understood.** The firewall and
  `protected-paths` recognise a protected path in `python -c`, `node -e` and similar one-liners in
  the literal and common home-relative spellings that `tests/protected-paths-corpus-smoke.ts`
  tests, and both fail closed on inline code that mentions an agent-configuration segment next to
  any write- or exec-capable call (item 12). A path computed entirely at runtime with no
  distinctive segment in the command text (character codes, decoded strings, a value read from a
  file), and code run from a script file, are not recognised, and a write to a control file made
  that way can be rated low or medium and not blocked. The agent's normal approval prompts and the
  sandbox and container profiles remain the boundary there.
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
  environment, the contract and where it lives (a read-only mount, or another user's file), and
  counts either proof only from the initial user namespace, so namespaces a user can create
  without root prove nothing (`tests/firewall-unattended-smoke.ts`). It cannot verify that the
  container the supervisor describes exists. Someone who can run code inside the pi process, or
  root on the host, can still present a contract. The container, not this check, is the boundary.
- **For an untrusted repository, use the strict [security level](security-level.md) or a
  container.** The classifier is static, and an injected agent that is determined to find an
  unmodelled construct is the case [Autonomy gate](autonomy-gate.md#parser-coverage) lists as not
  covered.
- **A custom policy can widen the boundary.** `PI_KIT_FIREWALL_POLICY` pointing at a permissive
  file (for example `{ "defaults": { "unknown": "allow" } }`) re-opens the gate. `verify.ts`
  only guarantees the *shipped* policy is default-deny. Such overrides, and `PI_KIT_UNATTENDED*`,
  are safety-setting overrides.
- **Interactive approval is only as careful as the person answering it.** Cards show the action,
  its tier and the reasons; a remembered approval is scoped, but you still decide.

## Workspace file writes

A cloned repository is untrusted content, and git stores symbolic links, so any path the kit
writes under a workspace (`<workspace>/.pi/...`, `AGENTS.md`, `TODO.md`) may be a committed link to
a file elsewhere. The kit's own state writes go through one helper, `packages/core/shared/safe-fs.ts`,
copied into each extension that writes (`npm run gen:shared`; `npm run verify` fails when a copy
differs). For a write under the workspace it:

- refuses a target outside the workspace root (a `path.relative` check, not a string prefix), and
  checks every directory from the root down with `lstat`, refusing a symbolic link or a
  non-directory and creating a missing one with mode 0700;
- opens the file itself with `O_NOFOLLOW` and requires a regular file owned by the current user
  with a single hard link;
- replaces a whole file through a new temporary file created exclusively (`O_EXCL`) beside it and
  renamed over it, keeping the old file's mode, and creates new files with mode 0600.

The writers that use it include the trace ledger, the firewall audit log, `/auto`, goal-core,
task-graph, verifier-board and verify-gate, `/recover`, self-improvement's `AGENTS.md` edits,
`/save`, todo, the conductor, context-sieve, the workflow run files and the caveman and plan-mode
contributions. `tests/workspace-symlink-smoke.ts` plants a link at each state file, and `.pi` as a
link to a directory, drives those writers through their real entry points, and checks that nothing
outside the workspace changed; it also checks the helper's refusals and modes directly. ESLint
(`eslint.config.ts`) rejects a raw `writeFileSync`, `appendFileSync`, `createWriteStream` or
write-mode `openSync` in an extension unless the file is on a reviewed allowlist with its reason.

Profile restores (`/profile` rollback and the installer's `--settings-only` rollback) write
through an exclusive temporary file created 0600 before it is given the snapshot's mode, so a
restored `.env` is never world-readable, even briefly (`tests/profile-transaction-smoke.ts`).
branch-lab keeps its worktrees under a per-user `<temp>/pi-kit-<uid>` directory (mode 0700, owned by
you; a link or another user's directory there is refused) (`tests/branch-lab-smoke.ts`). The
autonomy gate copies its held-out overlay over the worker's clone without following a link the
worker committed, and refuses a check whose working directory passes through one
(`tests/autonomy-gate-overlay-smoke.ts`).

Not covered:

- A local process that races the checks (between the `lstat` of a directory and the open below
  it) can still redirect a write. The threat addressed is content committed to a repository,
  which cannot race.
- On Windows `O_NOFOLLOW` and the owner check do not exist; the `lstat` checks still run.
- A path the operator sets (for example `PI_KIT_FIREWALL_AUDIT_LOG` or
  `PI_KIT_BRANCH_LEASES_FILE`) is trusted: only its final name is checked.
- The human console's request files are still written with plain `fs` calls, and are on the ESLint
  allowlist as a known gap.

## The kit installer and install markers

`/profile` and the first-run auto-profile run the kit's installer
(`node <kit root>/packages/core/install.ts`). A project install keeps its marker in
`.pi/.pi-kit.json`, which a cloned repository can commit, so the marker never chooses where that
installer comes from. The kit root is `PI_KIT_ROOT` when set, otherwise the marker's `kitSource`
only when it is an absolute path that resolves, through any symbolic links, outside the workspace
(the enclosing git work tree, else the session directory) and whose `package.json` names the kit;
otherwise it is the package the extension was loaded from. A path `kitSource` that fails a check
is ignored with a warning, once per session, and the installed kit is used. The marker's other
fields (profile, scope, mode, channel) are still read as data. `tests/kit-root-trust-smoke.ts`
plants a complete kit inside a fixture repository and points a committed marker at it by a
relative path, an absolute path, from a subdirectory of the work tree and through a link from
outside, and checks that neither the auto-profile nor `/profile` hands the repository's installer
to `pi.exec`, and that the installed kit and an absolute checkout outside the workspace still
resolve.

`/console` (web-console) and the remote-control host start make the same choice for the web UI
server they spawn (`<kit>/packages/web-ui/server/server.ts` and `remote-host.ts`) when no web UI
sits beside the extension, and apply the same check: one helper, `packages/core/shared/kit-source.ts`,
copied into each of the three extensions (`npm run gen:shared`). A refused `kitSource` is reported
and the command says it could not find the web UI instead of running the repository's server. The
same smoke loads detached copies of both modules against the same fixtures.

Not covered: `PI_KIT_ROOT` is an operator setting and is trusted as given. The package name is a
consistency check, not an integrity check: an absolute directory outside the workspace that the
operator's own marker names is trusted.

## Redaction

Text the kit stores or sends to a memory service passes through one secret-redaction table,
`packages/core/shared/redact.ts`, copied byte for byte into each consumer: the memory vault,
`/save` snapshots, the firewall's feedback records, autonomy notebooks, workflow run files (on top
of their own rules), role-runner telemetry and memories sent to mem0. It replaces private keys,
authorisation headers and bearer tokens, credentials in URLs, common provider token shapes, and
`KEY=value`, `"key": "value"`, `--password value`, `mysql -p…` and `curl -u user:…` values with
`[REDACTED]`, keeping the key name or header.

`tests/redaction-corpus-smoke.ts` runs the source, every copy and every consumer over the synthetic
corpus in `tests/fixtures/secret-corpus.json` and fails on any value left in the output; it also
checks that text without a secret is unchanged, that a second pass changes nothing, and that 1 MB
adversarial inputs finish inside a linear-time budget. Every rule is bounded, and an unterminated
private key is redacted to the end of the text rather than re-scanned.

Redaction is best-effort hygiene, not a detection boundary: a secret in a shape the table does not
know, or split across records, is kept as written. Treat stored logs as sensitive regardless.

## Untrusted regular expressions

A project skill's `re:` trigger and a workflow step's output pattern come from the opened
repository. Both are compiled only when `packages/core/shared/safe-regex.ts` accepts them (no
quantified group that holds a quantifier or an alternation, no backreference, a length and choice
cap); a refused gate pattern fails its gate (`tests/workflow-smoke.ts`). A skill trigger is also
tested under a 50 ms time limit, and one that hits the limit is switched off for the session
(`tests/skill-routing-smoke.ts`). ESLint rejects a `new RegExp` built
from a non-literal pattern outside a reviewed allowlist. The syntactic check does not catch every
slow pattern (adjacent overlapping runs are polynomial); the time limit is what stops those for
skill triggers.

## Decisions and their compensating controls

Some behaviour is an operator decision rather than a default the kit would otherwise choose. Each
is recorded with its risk and the controls that compensate for it.

| Decision | Risk | Compensating controls | Record |
|---|---|---|---|
| **SEC-5: approval prompts are Yes-first.** The firewall's approval card lists *Allow once* first, and the phone-pairing prompt lists *Approve* first | A reflexive Enter approves | Pairing: the typed device-ID suffix, the second-claim refusal, the out-of-range address warning, the terminal check on who decides, suspension of unaudited devices. Cards: the tier, reasons and history on every card, headless asks resolving to deny, and every phone answer audited with its device and tier | [Remote control](remote-control.md#the-yes-first-decision-sec-5) |
| **The remote host listens on every interface by default** | Anyone who can reach the port can try to link or sign in | One-time codes with a try limit, rate limits and lockout, a warning at start, recommended `tailscale` or `loopback` binds | [Remote control](remote-control.md#settings) |
| **The default firewall audit log stays in the workspace** (`.pi/tool-firewall-audit.jsonl`) | A repository could commit a link there | It is written no-follow through the safe-write helper, like every workspace state file ([Workspace file writes](#workspace-file-writes)) | [Autonomy gate](autonomy-gate.md#audit-and-tuning) |

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
