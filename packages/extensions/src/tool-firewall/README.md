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
is confirmed at the terminal only. Off is locked pending supervisor attestation. The proposal's content,
flow, intent and detector checks are unavailable. See `docs/security-level.md` and
`tests/security-level-smoke.ts`.

A worker that the autonomy supervisor starts inside a container boundary runs in **unattended
mode** (`PI_KIT_UNATTENDED=1`, `PI_KIT_UNATTENDED_BOUNDARY=container` and a read-only
`PI_KIT_UNATTENDED_CONTRACT`): no prompts and no judge inside the zone; critical, hard classes
and anything outside the zone are refused. The contract must be on a read-only mount (or be another
user's unwritable file) and outside the workspace, so a file the agent wrote and `chmod`-ed does not
count, and launching a child with those variables from a shell is a safety-setting override. The
autonomy CLI's commands that change a run (`start`, `up`, `plan --authorise`, `promote`, `resume`,
`reconfigure`, `pause`, `steer`, `backlog`, `inbox --answer`, `board` other than reading it, and any command
the classifier does not know) are high and never learned from an agent's shell, however the CLI is reached: by name, by its
script run directly or through `env`, by an interpreter or a package runner (`npx tsx`, `npx
pi-autonomy`, `npm exec pi-autonomy --`), or by a path relative to a `cd` (`tests/firewall-unattended-smoke.ts`).
Two matchers decide. The broad one finds anything that could be the CLI and only adds findings. It looks at a
word naming `pi-autonomy`, an autonomy/cli script or the legacy entry point `autonomy/supervisor.ts` (which
passes every command to the CLI; its `boundary` probes), expanded or not, with spaces or not; a word that holds
a whole command (`pm2 start "pi-autonomy promote"`, `pm2 start "eslint . ; pi-autonomy promote"`, `npm exec
--call '...'`, `c='pi-autonomy promote'; $c`), whose command it reads from the same word whatever precedes the
name in it; an option=value word under any option name (`--exec="pi-autonomy promote"`, `-c=...`,
`--setup=...`, `--node-options=--require=...`), whose value it reads as a command, as it reads the space form; a
short option with its value attached (`-xpi-auto*`, `-r./packages/autonomy/cli.ts`, `-c"pi-autonomy promote"`),
read by its value the same way when that value holds a letter or digit (`-x*` is not); a variable this command line set (`c=pi-autonomy; $c promote`); a
glob that could expand to it (`node packages/auto*/cli.ts`, `pi-auto*`, `./node_modules/.bin/pi-auto*`; a
bracket class it cannot evaluate counts as a match); and a computed command name
(`$(echo pi-autonomy) promote`). It counts the word when it is the program, or an operand of an interpreter,
a package runner, a node-family alias (`nodejs`, `esno`, `ts-node`), a version manager or launcher (`nvm`,
`fnm exec`, `volta run`, `nodenv`/`pyenv`/`rbenv exec`, `rustup run`, `corepack <pm>`, `asdf`, `mise`,
`cross-env`), a coverage tool (`c8`, `nyc`), a watcher or supervisor (`nodemon`, `pm2`), or any program the
classifier has no rule for, or of any program given by a path outside `/usr/bin`, `/bin`, `/usr/local/bin`,
`/sbin`, `/opt`, `/nix` and mise's install directory (`./eslint`, `scripts/git`, `node_modules/.bin/tsc`,
`env ./eslint`, `./docker`), whose own rule is not consulted because the file is whatever it is, not the tool
its name suggests (`./ssh pi-autonomy promote`, which the parser reads as ssh, is rated as a launch with unseen
operands). That path is judged once normalised and resolved against the working directory, so a `..` that
leaves a system directory (`/usr/bin/../../tmp/eslint`) is not exempt. Every program is a launcher when `PATH` is
set on the command or earlier in the line to anything but system directories and the inherited `$PATH`
(`PATH=.:$PATH eslint pi-autonomy promote`, `export PATH=.:$PATH; eslint ...`; `PATH=/usr/bin:$PATH grep`
is not), when it calls a shell function defined on the line (`eslint() { ./x "$@"; }; eslint ...`), and when it
is `source` or `.` with operands after the file, which the file reads as `$1`, `$2`, …. When a word holds a command it rates every command in the word that names the CLI, split on `&&`,
`||`, `;`, `|`, `&` and newlines (`--exec="pi-autonomy status; pi-autonomy promote"`), the word's tokens after
the CLI together with the operands after the word, and, when the CLI's command is inside the word, the
operands after the word on their own (`--exec="pi-autonomy status" promote`); the worst reading stands, and an
operator stuck to a token ends it (`"pi-autonomy status; echo done"` is a reading command). A word is split
into tokens on the shell's IFS (space, tab, newline), so `"pi-autonomy status\rpi-autonomy promote"` names
the unknown command `status\rpi-autonomy` (high), and on any whitespace too, since the program that receives
the word may split it that way: each split is a reading. Inline code that names the CLI or its library (`node -e`, `node -pe`, `node --eval=`, `npx tsx -e`,
a heredoc or here-string fed to an interpreter, an awk program that calls `system()` or a pipe) is high, a
reading command included, because what it calls cannot be read; so `node -e "console.log('pi-autonomy')"` is
high too. What only mentions the CLI is not a launch: inline code that is one bare word (`node -c
packages/autonomy/cli.ts`, node's syntax check), an awk program that only matches text, and an operand of a
program with no rule followed only by options the CLI does not accept (`somecustomtool packages/autonomy/cli.ts --lint`). When `xargs` or `parallel` appends arguments that cannot be seen, the command is
rated as if they were its worst options. Its findings: a control or unknown command is high, `report`, `key-limit`, `export`,
`doctor --setup` and `boundary --probe` are medium, and the files its options read (`--config`, `--file`,
`--ntfy-token-file`, `--spec-file`, `--repo`, `--prs-file`) and write (`--out`, `--alert-state`) are
classified like any other read or write, so `report --ntfy-token-file ~/.ssh/id_ed25519` is a credential read
however it is launched. The narrow one makes a reading command (`status`, `top`, `events`, `templates`,
`inbox`, `board --run <id> --json`, `plan`, `init`, `draft`) routine, in place of the ordinary rules, only for
an exact, fully literal, direct launch with every option one the CLI accepts: `pi-autonomy <command>`, or the
workspace's autonomy CLI script run as the program or as the first operand of `node`, `tsx` or `bun`. It
refuses the launch when any of these holds: an assignment on the command (`PATH=/tmp/x pi-autonomy status`);
any variable set or exported earlier in the line; a shell function of the same name; a wrapper other than
`exec`, `nohup`, `setsid`, `stdbuf`, `watch`, `env -S`, `script -c`, `entr -s` or `sh -c` (so `pnpm exec`,
`find -exec`, `xargs`, `parallel`, `fnm exec`, `volta run` and `corepack pnpm exec` are refused); no command at
all (`pi-autonomy`); or the program is anything but `pi-autonomy` or the script itself (`nodejs` and the
launchers above are refused). Everything else (inline code, a stdin script, a package runner, an interpreter
option, another program whose path ends in the name) falls through to the ordinary rules, so the autonomy rule
never rates a command lower than it would be without it. `tests/firewall-shell-smoke.ts` checks that as a
property over about 2,800 cases (100 launch forms by 25 commands, the `xargs`/`parallel` forms that append the
command, and 12 inline-code forms), and has one named row per guard that fails when that guard alone is
reverted.

Not covered:

- A name that does not appear in the text: `$AUTONOMY promote` with a variable from the environment, `pi-$X`,
  `c=$(printf pi-%s autonomy); $c`, or a path built inside code (`'./packages/auto'+'nomy/cli.ts'`). These keep
  the ordinary rules' rating (a dynamic command name is medium).
- The parser does not look inside `fnm exec`, `volta run`, `nodenv`/`pyenv`/`rbenv exec`, `rustup run`, `c8`,
  `nyc` or `corepack <pm>`: a control command through one is high, but another command through one keeps the
  launcher's own rating (`fnm exec rm -rf ~` is low).
- `NODE_OPTIONS=--require`/`--import` loader injection outside the autonomy rule is low in the ordinary rules.
- Array-form subprocess calls in inline code drop their arguments (`spawnSync('rm', ['-rf', ...])` is low), and
  the bodies of `node -pe` and `npx tsx -e` are not run through the ordinary inline-code rules.
- `docker run <image> pi-autonomy ...` and `npm run <script>` bodies are not resolved.
- Programs with a rule of their own whose options or operands run a command or load a module: `git rebase
  --exec`/`-x`, `git bisect run`, `mocha`/`jest`/`vitest` `--require`, `-r` (also attached, `mocha
  -rpi-autonomy`), `--setupFiles`, `--file` and `--config`, `npx eslint --rulesdir`, `npm run <script>
  --script-shell=<file>`, `vim -c "!..."`, `emacs --eval`, `screen -dm`, `docker exec`, `make CMD="..."`,
  `just --command`, `task --exec`, `husky run`, `lint-staged --shell`, and `turbo`/`nx`/`lerna` `exec` and
  `run` keep that program's rating (low or medium), whatever the command names.
- `PATH` changed by anything but an assignment or `export`/`declare`/`local` in the same line (`typeset` and
  `readonly`, which the shared shell parser does not record, `hash -p ./x eslint`,
  `alias eslint=./x`, a `PATH` set by an earlier tool call or a sourced file), a function defined by an earlier
  tool call, and a system directory reached through a symlink are not seen.
- Positional parameters handed to `sh -c` (`sh -c 'exec "$@"' sh pi-autonomy promote`, `sh -c '"$@"' tsc
  pi-autonomy promote`) are a computed command name (medium); a `cd` to a glob
  (`cd packages/auto* && node cli.ts promote`, whose directory is unknown) and a runner's directory option
  (`pnpm -C packages/autonomy exec node cli.ts promote`, `npm --prefix`) keep the ordinary rules' rating
  (medium or low).
- A glob behind a path made only of wildcards (`./* promote`) is not taken as the bin name.
- Still rated as a launch (fail closed, false positives): a word naming the CLI after an interpreter's script,
  a test runner or a static tool (`node scripts/gen.ts pi-autonomy docs/out.md`, `npx vitest run
  packages/autonomy/cli.ts --coverage`, `npm test -- --grep pi-autonomy tests`, `npx eslint
  packages/autonomy/cli.ts --fix`, `pnpm eslint packages/autonomy/cli.ts --max-warnings 0`) is high when another
  word follows it, because the tool's name could be a trampoline file or package script that runs the rest; an
  option word or a quoted word naming the CLI with more after it (`node --test
  --test-name-pattern="pi-autonomy promote" tests/`, `node scripts/x.ts --notes "pi-autonomy (promote)"`,
  `pm2 start "echo pi-autonomy promote"`) is high, because what a program does with an option's value or a
  quoted word is not known; a program given by path with the CLI's name and another word after it
  (`./tools/grep pi-autonomy README.md`, `./node_modules/.bin/eslint packages/autonomy/cli.ts packages/x.ts`)
  is high, because the file may be a trampoline; an operand after a word holding a reading command
  (`nodemon --exec "pi-autonomy status" --watch src`) is high, because which program reads it is not known; and
  an attached option value that is a short glob (`mytool -lp* foo`) is high, because it could expand to
  `pi-autonomy`.

The full description is in `docs/autonomy-gate.md`.

| File | Role |
|---|---|
| `shared/shell.ts` | Shell parser (a generated copy of `packages/core/shared/shell.ts`): quoting, substitutions, heredocs, wrappers (sudo/env/ssh/bash -c/xargs/find -exec/eval/tmux), obfuscation normalisation. |
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
  `policies.engagement.command_rules` applies to the engagement policy only.

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

## Patch writers and shell writers

`git apply`, `git am` and `patch` (also spelt `git-apply`, `git-am` and `gpatch`) name their targets inside the patch. The classifier and
`protected-paths` both read the patch headers (`---`, `+++`, `***`, `Index:`, `diff --git`, rename and
copy lines and git's older `rename old` and `rename new`, git's quoted names) through one shared rule in `shared/inline-guard.ts`, and give the
decision a direct write would get to every place a target could land: each strip level whatever `-p` says,
every directory the command may be in (a `cd` that fails or sits in a subshell adds a candidate and replaces
none, and `git -C` is cumulative), and for git the top of the repository. A patch file is read at every place
it could be read from. Over-blocking an unusual invocation is accepted. These forms are covered directly and through `bash -c`,
`sh -c`, `eval`, `cd`, `xargs` and a pipe (`tests/protected-paths-corpus-smoke.ts`).

A patch that cannot be read fails closed, as a write to a safety-control file: standard input with no
heredoc or `<` file behind it, a missing file, process substitution, a path computed at runtime, a
binary patch, a patch with no file headers, arguments added by `xargs` or `find -exec`, `env -C` and
`sudo -D`, standard input with more than one source, a heredoc the shell would expand, a patch file
the same command rewrites, a transfer-encoded mail for `git am`, more than one `-d` or `--directory`, a
directory or output named by a variable, a `cd`, `pushd` or `popd` that cannot be read (a variable, `~`, a
flag, none, or more than six in one command), `CDPATH` set in the command, `--git-dir`, `--work-tree`,
`GIT_DIR` or `GIT_WORK_TREE` anywhere in the command, a `patch` backup named by `-B`, `-Y`, `-z`, `--prefix`,
`--basename-prefix`, `--suffix` or `SIMPLE_BACKUP_SUFFIX`, a `git am` series file or a `--patch-format` other
than `mbox`, `mboxrd`, `stgit` or `hg`, a git subcommand the shell computes, and a shell, `parallel` or
`script` reading its commands from a pipe on a line that names a patch tool, including a shell inside a
subshell or compound after the pipe (`| (cd x; sh)`, `| if true; then sh; fi`). That text is matched coarsely, so a heredoc patch whose body contains such a `cd`
also fails closed. `git apply --check` and `--stat` and `patch --dry-run`
write nothing and are not read. `git am --continue`, `--skip` and `--abort` are not read because they
carry no new patch: what they apply was checked when the `git am` that queued it ran. Only those exact spellings count: an
abbreviated long option is expanded as the tool would expand it and is treated as a write, and a prefix
that fits two options fails closed.

`git checkout <ref> -- <path>` and `git restore --source <ref> <path>` are checked as writes to each
path. `sed -i`, `perl -i`, `dd of=`, `install`, `rsync`, `ln -s` and a copy into a directory ending in
`/` are checked against the same protected list.

This is a guard, not a boundary. It reads command text and cannot see what a command will do when it
runs. The limits it leaves open:

- **Interpreters.** A script file, or an interpreter whose target is computed at runtime, can write
  anything: `python3 tool.py` is not inspected (`docs/security.md`).
- **Inherited shell state.** A `CDPATH` or shell function that was set before the command, and an alias, are
  not visible in its text. A `cd` is placed as if none applied.
- **Wrappers and spellings it does not know.** A catch-all runs on every parsed command that is not itself a
  patch call, and in the text walker on every piece: if its words still name `git` then `apply` or `am`, or
  `patch`, it fails closed as an unreadable patch, unless the command is a known reader or a known harmless
  command. Wrappers not on any list, and
  inline interpreter code (`python3 -c 'os.system("git apply …")'`, awk's `system()`), are covered this way,
  and an unusual invocation may be refused when it does nothing wrong. `patch` counts only when the next word
  is an option, a redirect or a `.patch` or `.diff` file, or when the command has its input fed in, and
  `apply` or `am` only straight after `git` and its global options, so a `patch` with plain positional
  operands behind an unknown wrapper is not caught.
- **Computed commands.** A command word or `eval` text computed at runtime (`X=git; $X apply p.patch`,
  `$(which git) apply p.patch`, `bash -c "$(echo git apply p.patch)"`) fails closed when that command's own
  words, with the values of the variables it uses, name a patch tool. A command computed from text that names
  none (a variable set outside the command, an encoded string) is not read; the firewall rates it medium for
  dynamic execution.
- **Inert text.** A quoted-delimiter heredoc body, and quoted text, are not read as commands only when they
  go to a command that treats its words as data (`cat`, `tee`, `git commit` and the like; never `make`, which
  reads a heredoc as a makefile). Every other heredoc is read as commands. A heredoc saved to a file and run later is not seen, nor is an option of such a command that runs
  its value (`git fetch --upload-pack`, `man -P`). An unquoted heredoc body, and quoted text behind a wrapper or
  an assignment, are still read as commands and may be refused when they do nothing wrong.
- **Two readers, one shared rule.** Both hooks read patch writers with this firewall's parser
  (`packages/core/shared/shell.ts`, generated into both extensions) through one shared rule
  (`shared/inline-guard.ts` `patchCallsInParse`, `patchStdinOf`, `patchTargetsAt`), and also with the shared
  text walker (`patchCallsInText`), kept as a fail-closed backstop: a writer either reading finds is checked in
  protected-paths, and either reading's unreadable verdict is `patch_unreadable` here. The walker stays because
  two adversarial reviews of a parser-only reading found forms only its quote-blind reading catches (interpreter
  argument lists, ssh options that run locally, exported variables, abbreviated build-tool options); removing it
  would loosen both hooks. Besides a patch call it cannot place, the parser rule fails closed on a line that
  names a patch tool when the parser reports text it cannot read, and on commands fed to the standard input (a
  pipe, a heredoc, a here-string, a `<` file) of a shell, `sudo -s`, `su`, `at`, `batch`, `parallel`, a build
  tool reading its build file from stdin or an `ssh` with no remote command, a shell with no script inside a
  subshell, group or `if` after a pipe, and a script or build file read from a process substitution. A patch
  tool named in a value a program runs as a command also fails closed: a run-variable in the command's
  environment or set with `export` (`GIT_EDITOR`, `PAGER`, `CC`; any variable for a build tool) and `git -c`
  values (`core.editor`, `core.pager`, `diff.external`), as does one in heredoc or here-string text fed to a
  command that does not read it as data. Targets are placed at the session directory and also at the directory
  the parser tracked; a wrapper option that moves the directory (`sudo -D`, `nsenter --wd`, `unshare -w`,
  `systemd-run --working-directory`, `conda run --cwd` and the like) leaves it unknown, which fails closed.
  protected-paths' other write targets (redirects, `cp`, `sed -i` and the like) are still read with its own
  regular expressions (`docs/future-work.md`).
- **Patch writers the text does not name.** A shell fed through a pipe is only caught when the line names a
  patch tool, so a script that is encoded or held in a file is not.
- **History-carrying git commands.** `git stash pop` and `apply`, `merge`, `rebase`, `cherry-pick`,
  `revert`, `pull` and `reset --hard` write whatever the named commit or stash holds. The paths are in
  git objects, so they are rated as ordinary git writes.
- **Check and use.** A patch file is read when the command is classified. A process that changes it
  afterwards, outside the same command line, is not seen, and neither is a rewrite in the same line whose
  destination is a glob or a variable.
- **Symbolic links.** Candidates are joined as text. A symbolic link in a directory the command moves
  through, or a repository top found through one, is not followed.
- **Undiscovered tree redirection.** A git configuration file that moves the work tree (`core.worktree`), or a
  `.git` file pointing elsewhere, is not read.
- **Other names.** A copy or link of `patch` or `git` under a name of its own is not read as a patch
  writer, and neither is a patch applied through an alias or a script.
- **Parent-directory copies.** A copy into a directory with no trailing `/` is checked against the
  destination alone by the classifier; `protected-paths` also resolves existing directories.
- **Replaced parents.** Moving or linking a directory above a protected file is only caught where the
  parent is itself classified.

## Operator delegation

The operator can let a session run named day-to-day verbs of one wrapper program without a prompt, for a
limited time, by adding an entry to `firewall.json` (never the shipped policy):

```json
"delegations": [{ "operator": "alex", "path": "/opt/ops/bin/runctl", "verbs": ["status", "pause", "steer"], "expires": "2027-01-31" }]
```

- **What is delegated.** A bash call that is exactly one plain command (no pipe, list, redirect,
  assignment, substitution, background job or wrapper such as `env`, `sudo` or `bash -c`) whose program,
  named by path, resolves to the entry's `path`, whose first argument is one of its `verbs`, and which
  carries no option at all (`--approve`, `--yes`, `--file` and the like change what a verb grants or
  reads), and no unquoted glob or brace word, which bash could expand into one. Every other finding must be low: a call that also reads a secret or writes a protected file is decided as
  usual. The decision is audited as `tool_approved` with `decider: "delegate"` and the operator, path,
  verb and expiry; it writes no feedback and no approval, so it never teaches the judge or the learner.
- **What never is.** Verbs outside the day-to-day set `status`, `pause`, `steer`, `backlog` and
  `metrics`; any of `start`, `supervise`, `plan`, `promote`, `cancel`, `reconfigure`, `init`,
  `recreate`, `decide`, `add-stream`, `remove-stream`, `start-streams`, `resume` (it can approve or start
  a run), `restart`, `answer`, `raise-budget`, `units`, `tick` and `board-push`, even when an entry lists
  them (the entry is dropped); a call with any option; the same
  verbs through the autonomy CLI itself or any other program; `systemctl enable`; and any session that
  is unattended, a kit child, under the engagement policy or at strict security.
- **How an entry is checked.** Strictly, on every call: `path` must be absolute, its own real path, a
  regular file owned by the operator (or root) and not writable by its group or everyone; `expires` must
  be a date in the future and at most 90 days ahead; unknown keys are refused. A bad entry is dropped with
  a warning in `/firewall status`, which also lists the live ones; nothing else in `firewall.json`
  changes. The file is read on every call, so an edit takes effect at once; each change of the live
  delegations (and the first set seen) is an audit record, `delegations_changed`, and `firewall.json`
  itself is in the protected boundary wherever `PI_KIT_FIREWALL_CONFIG` puts it. Every configured delegate path, valid or not, joins the protected boundary, so writing, moving
  or `chmod`-ing it is a safety-control action even while its entry is dropped, and running any protected
  file as a program or as an interpreter's script is never routine (`protected_exec`). Of the tilde forms
  only `~/` names a delegate; `~user/`, `~+/` and `~-/` never do.
- **Not covered.** The firewall cannot see what the delegate program does with a verb: the operator is
  trusting that program, which runs with the session's permissions. Pinning its contents (a hash) is not
  implemented; the ownership and mode checks, the boundary and the expiry are what bound it
  (`tests/firewall-delegation-smoke.ts`).

## Audit

Each tool call appends one JSONL record to `PI_KIT_FIREWALL_AUDIT_LOG`, or to
`.pi/tool-firewall-audit.jsonl` when the variable is unset. Every refusal also appends one
`tool_refused` record from the shared `shared/refusal-record.ts` helper (guard, cause, matched rule
or path token, tool, a command digest when the call carries a command, session id; never the command
text or a secret value);
`secret-guard` and `protected-paths` write the same record (`tests/firewall-refusal-record.ts`). For a
firewall refusal, `matched` is the unattended denial code when there is one, else the code of the
highest-tier finding (so a key read piped to the network is `secret_egress`, and a refusal for lack of
an operator still names the finding, not `unavailable`), else why no operator answered, else the
decider. Decisions that wait on a judge or
human add a closing `tool_approved` or `tool_blocked` record. A call whose policy or security level
changed while its approval was pending writes one `tool_reconsidered` record and is decided again;
only that second decision can write `tool_refused` (`tests/firewall-refusal-record.ts`). Before an append, a log over 4 MiB
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
  arguments change nothing; a headless session gets the text on stderr).
- `/auto [status|on|off|learn on|off|learned|forget <sig>|stats|explain [n]|check <cmd>]`.

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
