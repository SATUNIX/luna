# Changelog

All notable changes to `@satunix/pi-system` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before `0.2.1-beta.0` were internal; their numbers do not correspond to public releases.

## [Unreleased]

## [0.2.4-beta.8]

### Added

- **`npm run gen:shared`** writes the generated copies of the shared security helpers in
  `packages/core/shared/` (safe file writes, secret redaction, the safe-regex check, the inline
  interpreter guard) into the extensions that use them; `npm run verify` fails when a copy differs
  from its source.
- **`smoke:workspace-symlink`, `smoke:redaction-corpus` and `smoke:autonomy-gate-overlay`**, also
  run by `npm run test:security`, with a synthetic secret corpus in
  `tests/fixtures/secret-corpus.json`.
- **The remote host warns when it listens on every interface.** With `PI_REMOTE_BIND` unset or
  `all`, `host.log` gets a `WARNING:` line recommending `tailscale` or `loopback`, and the host's
  status carries it, which `/remote status` and `remote-cli.ts status` show; `remote-cli.ts` also
  marks a suspended phone. `docs/remote-control.md` lists the recommended binds
  (`tests/remote-host-smoke.ts`).
- **Security standardisation documents.** `docs/security-standard.md` (the secure development
  rules for file writes, temporary files, regular expressions, redaction, network clients, child
  processes, untrusted data, dependencies, suppressions and review, each naming its lint rule or
  test; linked from `CONTRIBUTING.md`), `docs/threat-model.md` (assets, attackers, trust
  boundaries, the control for each, non-goals), `docs/security-controls.md` (every control with its
  code, test, npm script, CI job and required check), `docs/vulnerability-management.md` (sources,
  owner, severity rubric, fix-or-accept rules and the risk-acceptance register that replaces the
  residual-findings list in `docs/supply-chain.md`), `docs/incident-response.md` (leaked secrets,
  compromised credentials, malicious dependencies, published private files, firewall bypass
  reports) and `docs/operator-checklist.md` (the operator-only settings and release steps).
  `SECURITY.md` now states supported versions, response targets (acknowledgement in 3 working
  days, triage in 14 days, fix targets by severity), scope and safe harbour. `docs/ci-security.md`
  gains the gating matrix, the Scorecard and OSV rationale, the fail-closed, manifest-coverage and
  suppression policies, the allowed-actions bump procedure and a settings table keyed to
  `.github/expected-settings.json`; `docs/supply-chain.md` an update policy; `docs/remote-control.md`
  and `docs/security.md` the SEC-5 (Yes-first) decision record with its compensating controls.
- **`smoke:security-docs`** (`tests/security-docs-smoke.ts`) fails when the controls catalogue
  names a file, test, npm script, workflow job or required check that does not exist (or a check
  `.github/expected-settings.json` does not declare), when a threat-model row names no catalogued
  control, when a security page names a missing path or script or, in the private tree, a file the
  public export does not ship, when a cited settings field is not in the expected-settings file,
  and when `SECURITY.md`, `CONTRIBUTING.md`, `docs/support.md` or `mkdocs.yml` lose their links to
  the security pages.

### Fixed

- **The container entrypoint says when it cannot check `settings.json`.** Without `jq` it skipped
  the pi-mcp-adapter migration silently; it now logs a `WARN:` line, and the readiness check still
  refuses the unmigrated file. The image installs `jq`, so this affects only hosts that run the
  entrypoint outside it (`tests/container-static-smoke.ts`).
- **`smoke:firewall-exec-oracle` passes as root.** bash does not import `PS4` from the environment
  when its effective uid is 0 (CVE-2016-7543), so the `env 'PS4=…' bash -x` entry ran no marker in
  GitLab CI's containers. As root that entry is now classified but not executed, and the test says
  so.

- **A release that changes the scan exceptions can pass `leak-scan`.** The `leak-scan`
  pull-request check reads `packages/core/leak-scan-exceptions.json` from `main` and refuses an
  exceptions change mixed with other files, so a release pull request carrying new exceptions could
  never pass it. Publication now opens an exceptions-only `release/<tag>-exceptions` pull request
  first and stacks the draft release pull request on it, with a "Blocked by" note; `leak-scan` stays
  strict and fails on the release until the exceptions merge with a merge commit and the branch is
  updated from `main`. No branch is ever overwritten. `docs/releasing.md` ("Releases that change
  scan exceptions") and the operator checklist describe the procedure, and `docs/ci-security.md`
  now says its "Blocks a merge" column is the declared ruleset, not what the live one enforces
  (`tests/public-export-smoke.ts`).
- **Continuing a session from the console accepts only a session file.** `sanitizeSpawnConfig`
  checked a resume target only for its type and NUL bytes before it became the value of pi's
  `--session`. It now accepts only an absolute path to a `.jsonl` regular file inside pi's sessions
  directory, after symbolic links are resolved, that does not start with `-`; a caller that names
  no sessions directory cannot resume. No HTTP route passes a caller's path there today
  (`tests/web-ui-spawn-validate-smoke.ts`).
- **`/auto` no longer rewrites a project's `.pi/auto-mode.json`.** It rewrote the file whenever it
  existed, which is repository content (and, through a committed link, could truncate another
  file). It now writes the legacy file only in an operator-set `PI_KIT_AUTO_MODE_STATE_DIR`; a
  project file that selects manual approvals stays in force until you remove it
  (`tests/workspace-symlink-smoke.ts`, `docs/autonomy-gate.md`).
- **The GitLab `secrets-public` scan matches the gitleaks allowlists again.** It ran `gitleaks dir`
  over `public-build` from the repository root, so findings were reported as `public-build/tests/...`
  and the path-anchored allowlists (`^tests/...`) matched none of them; every tag pipeline failed
  there, and with it the export validation and publication jobs. The job now scans from inside
  the export (`cd public-build`, `gitleaks dir --config ../.gitleaks.toml ... .`).
  `smoke:suppression-inventory` checks that every allowlist still matches its files as that job
  reports them, and `smoke:gitlab-ci-structure` pins the layout.
- **Two public tests pass inside the public export.** The suppression inventory listed an inline
  marker in a private file, and the scan-coverage test dropped a private Dependabot directory as
  its mutation, so both failed in the exported tree (GitHub `verify`, GitLab `checks-public`). In
  a public export the inventory now skips entries and allowlist paths for files that are absent
  by design (the private tree still checks them strictly), and the mutation targets a Docker
  manifest the tree has (`smoke:suppression-inventory`, `smoke:scan-coverage`).
- **The release plan fails on an npm registry error instead of planning a first release.** The
  dist-tags lookup in `release.yml` fell back to `{}` on any failure; only npm's not-found answer
  does now (`tests/workflow-policy-smoke.ts` rejects the fallback idiom).
- **The documented runtime dependency set is now the shipped one.** `docs/supply-chain.md`,
  `docs/releasing.md` and `docs/INSTALL.md` said the kit had no runtime dependencies while
  `package.json` ships `quickjs-wasi`; the clean-install smoke now fails when the artefact's
  `dependencies` differ from the list in `docs/supply-chain.md` or are not pinned exactly
  (`tests/clean-install-smoke.ts`).
- **An agent CLI started by absolute path is recognised again.** The identity check skipped the
  name lookup for any command containing `/`, so `/usr/local/bin/pi --no-extensions` and
  `/usr/bin/claude --dangerously-skip-permissions` were rated as unknown programs (medium) instead
  of unguarded agents (high), and a moved `HOME` on such a launch was not seen. A path launch is
  now the same agent as one by name (`tests/firewall-shell-smoke.ts`).
- **Security documentation no longer states controls that are not in place.** `docs/ci-security.md`
  said CodeQL "blocks on code-scanning alerts (branch protection)" and that the release jobs run in
  "the protected `npm` environment"; both are repository settings `.github/expected-settings.json`
  declares, and the page now says so. `docs/supply-chain.md` and `docs/releasing.md` said npm
  installs peer dependencies in pi's clone; pi runs `npm install --omit=dev --legacy-peer-deps`,
  so it does not. `docs/supply-chain.md` had a dated audit heading, `docs/remote-control.md` said
  the firewall did not treat `control.json` as a credential, `docs/ci-security.md` named a test
  the public export does not ship, and `docs/support.md` pointed to an incident section that did
  not exist (`tests/security-docs-smoke.ts`).

### Security

- **Inline interpreter code that mentions agent configuration and can write or exec fails closed.**
  The firewall and `protected-paths` recognised a protected path in inline interpreter code only
  in the spellings the corpus listed, so a path assembled another way could pass both. They now
  apply one shared rule (`packages/core/shared/inline-guard.ts`, generated copies checked by
  `npm run verify`): an interpreter run on inline code (any option, a heredoc, piped input, or no
  script file) whose command text mentions an agent-configuration segment and has any write- or
  exec-capable call is rated high (`inline_agent_config`) and blocked. It may over-block inline
  code that merely mentions agent configuration; read-only code keeps its earlier behaviour. A path
  computed entirely at runtime with no distinctive segment is still not recognised. Rows and
  controls are in `tests/protected-paths-corpus-smoke.ts`.
- **`protected-paths` blocks plain shell commands that mutate a control file.** `touch`,
  `truncate`, `rm`, `unlink`, `chmod`, `chown` and `chgrp` on a protected path (the agent's
  `settings.json`, the workspace `.pi/mcp-adapter.json` and `.pi/.pi-kit.json`, the remote host's
  `devices.json`) passed `protected-paths` although the firewall already rated them high; every
  file operand of those commands is now a write target (the mode, owner and `truncate` size
  operands are skipped), with rows and benign controls in `tests/protected-paths-corpus-smoke.ts`.
- **The security pages state what inline interpreter coverage really is.** `docs/security.md`
  and controls C-04 and C-06 now say that both layers recognise a protected path in inline
  interpreter code only in the literal and common home-relative spellings the corpus tests, list
  paths assembled any other way as a known residual risk that approval prompts and the sandbox and
  container profiles cover, and `docs/future-work.md` records the planned shared fail-closed rule.
- **Inline interpreter code that names a control file through a wrapper or a composed path is
  high.** `python3 -c` writes to `os.path.expanduser("~/.pi/agent/…")` or
  `Path.home()/".pi/agent/…"` were routine, and a Node write to `homedir() + "/.pi/agent/…"` only
  medium, so an agent could plant an extension or append to the remote host's `devices.json` and
  `audit.jsonl` without asking. Inline code in Python, Node, Deno, Bun, Ruby, PHP or Perl that has
  any write-capable call and names a safety-control, operator-authority or console-key path, as a
  literal (wrapped or not) or as the literal tail of a runtime composition (`os.path.join`,
  `Path.home()/…`, `+`, interpolation, a literal after `chdir`), is now high
  (`inline_control_write`), and `protected-paths` blocks it; `deno eval` code is classified as
  inline code. `tests/firewall-shell-smoke.ts` and `tests/protected-paths-corpus-smoke.ts` pin the
  rows and benign controls.
- **An opened repository no longer chooses the installer `/profile` runs.** A committed
  `.pi/.pi-kit.json` with a relative `kitSource`, next to an unfiltered kit entry in
  `.pi/settings.json`, made the first interactive session run that repository's own
  `packages/core/install.ts`, and `/profile` did the same. The kit root now comes from
  `PI_KIT_ROOT`, from a marker `kitSource` that is absolute, resolves through any links outside the
  workspace (the enclosing git work tree) and names the kit in its `package.json`, or else from the
  package the extension was loaded from; any other path `kitSource` is ignored with a warning. The
  marker's other fields are still read as data (`smoke:kit-root-trust`, also run by
  `npm run test:security`; control C-61 in `docs/security-controls.md`).
- **An opened repository no longer chooses the web UI server `/console` and `/remote` start.**
  When no web UI sat beside the extension, web-console and the remote-control host joined a
  committed marker's `kitSource` with `packages/web-ui` and spawned its `server/server.ts` or
  `server/remote-host.ts` unchecked. Both now apply the installer's check (absolute, outside the
  workspace through any links, the kit by package name), from one helper,
  `packages/core/shared/kit-source.ts`, copied into session-helpers, web-console and
  remote-control by `npm run gen:shared`; a refused `kitSource` is reported and never run
  (`smoke:kit-root-trust`).
- **pi-mcp-adapter's global config is a control file.** A write to `<agent
  directory>/mcp-adapter.json` (the MCP servers the next session starts, and their sampling,
  elicitation and install switches) was medium; the firewall now classifies it as a safety-control
  path (high), as it already did the workspace `.pi/mcp-adapter.json`, and `protected-paths` blocks
  it (`tests/protected-paths-corpus-smoke.ts`, `tests/firewall-shell-smoke.ts`).
- **protected-paths blocks writes to the workspace `.pi/mcp-adapter.json`.** pi-mcp-adapter's
  project config chooses the MCP servers the next session in that workspace starts; the firewall
  already rated a write to it high, and protected-paths now blocks it too, by relative, absolute
  and runtime-built name (`tests/protected-paths-smoke.ts`, `tests/protected-paths-corpus-smoke.ts`).
- **Public files no longer cite private security-review IDs.** Comments, tests and docs that named
  a finding of the private review now describe the risk instead, and the blocked-identifier scan
  (the public export and the pre-push hook) refuses an `SR-` finding ID
  (`tests/prepush-scan-smoke.ts`).
- **Public files no longer cite private roadmap item IDs either.** Comments in workflows, scripts
  and tests that named an item of the private roadmap or review by its short ID now say what the
  rule is, and the blocked-identifier scan also refuses an upper-case `R`, `P`, `M` or `D`, a
  hyphen and one or two digits as a whole token (look-alikes such as `P-256`, `SHA-256`,
  `Node-22` and lower-case flags pass; `tests/prepush-scan-smoke.ts`).
- **The firewall's shell parser fails closed on constructs it does not model.** Command text that
  bash runs from inside an arithmetic expression or an array subscript, function definitions and
  calls, `coproc`, brace expansion in a command name, prompt and trap hooks (`PS0`, `PS1`, `PS4`,
  `PROMPT_COMMAND`, `BASH_FUNC_*`, `trap`), callbacks (`mapfile -C`, `complete -C`, `bind -x`),
  `fc`, `source` of standard input, `su -c`, debugger and terminal launchers, and some thirty exec
  wrappers (`pkexec`, `chroot`, `unshare`, `flatpak-spawn`, `uv run`, `mise exec`, …) are now parsed
  into the command they run, or reported as opaque, which never runs without asking. A wrapper
  given an option it does not know is opaque. `tests/firewall-shell-smoke.ts` pins the rows, and the
  new `tests/firewall-exec-oracle-smoke.ts` runs a corpus in real bash and fails when a command bash
  executes is neither a parsed segment nor reported as opaque.
- **An unknown executable is medium, not routine.** A command the classifier has no rule for asks
  (or goes to the judge in auto mode); a short reviewed list of read-only text utilities stays low
  (`tests/firewall-shell-smoke.ts`).
- **Writes to the files pi loads with no trust prompt are safety-control changes.** Everything pi
  loads from the agent directory (extensions, skills, prompts, themes, installed `npm/` and `git/`
  packages, `SYSTEM.md`, `APPEND_SYSTEM.md`, the global context files, `settings.json`,
  `trust.json`), `~/.agents/skills` and a project's `.agents/skills`, and the kit's install marker
  `.pi-kit.json` are high to write, and so is a `git clone` or `git worktree add` whose destination is
  one of them. A clone or worktree outside the workspace is now medium. `tests/firewall-autoload-smoke.ts`
  reads pi's own sources and fails when pi loads from a location the firewall does not cover.
- **The operator-authority files are classified in one list.** The web console token, the remote
  host's `control.json`, `identity.json`, `tls-key.pem`, `devices.json` and `audit.jsonl` (in
  `PI_REMOTE_STATE_DIR` or `<agent dir>/remote-control`), pi's `auth.json` and `models.json`, and the
  remembered approvals are listed in `OPERATOR_AUTHORITY_FILES`: reading a secret one is a credential
  read and writing any is high. `tests/firewall-autoload-smoke.ts` checks each entry against the
  source that writes it and fails on a secret-looking file name in kit source that is not classified.
- **Running another coding agent is identified by what it is, not its name.** `pi`, `claude`,
  `codex`, `gemini`, `aider` and other agent CLIs are recognised through `npx`, `pnpm dlx`, `bunx`,
  a package path or `python -m`, and one started with a moved `HOME`, `XDG_CONFIG_HOME`,
  `PI_CODING_AGENT_DIR` or the agent's own home variable (`CODEX_HOME`), which skips the operator's
  guard configuration, is high
  (`tests/firewall-shell-smoke.ts`).
- **More constructs that make bash run a command are parsed.** A command substitution in the word
  of an unquoted parameter expansion (`${x:-…}`, `${x:=…}`) or in a `case` pattern; a command name
  that an earlier `alias` or `hash -p` in the same command redefined (classified as what bash runs
  instead; an alias value that is not a simple command, and `enable -f`, are opaque); and
  `PS4`/`PROMPT_COMMAND` hook values passed as `env NAME=value` operands. The environment `env` or a
  prefix hands to a shell it starts now stays on the commands that shell runs, so `BASH_ENV` (and
  a safety-setting override) passed that way is rated as documented. A shell function's path
  arguments are checked as writes as well as reads, since the body's positional parameters are not
  bound. `tests/firewall-shell-smoke.ts` pins the rows and the exec oracle corpus covers each class.
- **Operator-authority secrets reached without their exact name are credential reads.** A glob
  that can expand to a secret (`remote-control/*`, `auth.js*`), a directory that holds one read
  recursively, archived, copied or given to a tool such as `grep`, and the home directory read the
  same way, are high; so is inline interpreter code that names any credential or operator-authority
  path, which now uses the classifier's own lists rather than a fixed pattern
  (`tests/firewall-autoload-smoke.ts`, `tests/firewall-shell-smoke.ts`).
- **Inline interpreter code with a literal mutation target is classified by that target.** Ruby
  (`File.write`, `FileUtils`), PHP (`file_put_contents`, `copy`, `symlink`), Perl (`open` with a
  write mode, `unlink`), Node (`copyFileSync`, `symlinkSync`, …) and Python (`shutil`, `os`,
  `pathlib.Path(…).write_text`) calls are writes, copies, links or deletes of the path they name;
  a link to a control file is high, and a Perl mutation through a runtime value is medium
  (`tests/firewall-shell-smoke.ts`, `tests/protected-paths-corpus-smoke.ts`).
- **Updating an autoloaded repository is a safety-control change.** `git pull`, `checkout`,
  `reset`, `merge` and the other working-tree commands in a repository pi autoloads (named with
  `git -C`, `--work-tree` or reached by `cd`) are high, and `cp -l`/`cp -s` of a control file is
  high like `ln` (`tests/firewall-shell-smoke.ts`). `protected-paths` blocks the same updates and
  also clone destinations, `tar -C`, `unzip -d` and `rsync` destinations, relative targets after
  `cd`, hard links and Perl `open` targets (`tests/protected-paths-corpus-smoke.ts`).
- **Environment egress is high.** Printing the environment or a secret-named variable into a
  command that sends to a remote host, and an inline interpreter program that reads the environment
  and opens a network connection, are high; a secret-named variable anywhere in a `curl`-like
  command is medium; an inline program that writes or deletes through a computed name, or fetches a
  URL it builds at runtime, is medium (`tests/firewall-shell-smoke.ts`).
- **A write to a runtime-built path that ends in a control file fails closed.** When the literal
  part after the last expansion names a safety-control or operator-authority file (`$D/.pi/auto-mode.json`),
  the firewall rates the write high and `protected-paths` blocks it; a symbolic link to a control
  file is high too. `protected-paths` now also expands `~`, `$HOME` and `$PI_CODING_AGENT_DIR`,
  extracts literal targets from Node, Python, Ruby, PHP and Perl one-liners (the shared corpus
  covers each language), and protects the agent
  directory's autoload locations and the remote host's state directory. The new
  `tests/protected-paths-corpus-smoke.ts` runs one write corpus against both extensions.
- **A tool's `trace_path` argument is path-checked.** skill-forge's `trace_path` joins the firewall's
  path fields, and `tests/firewall-path-fields-smoke.ts` fails when a kit or pi tool declares a
  path-like parameter the firewall does not check.
- **Human-console answers are authenticated.** The console's `resolved/` files sit in the
  workspace, so a tool call could write an approval for its own request. Every answer now carries
  an HMAC-SHA256 over the request id, the digest of the exact request bytes and the decision, made
  with a key at `<agent directory>/human-console/response.key` (0600 in a 0700 directory, outside
  the workspace). Only the interactive console creates the key; a requester that finds none files
  nothing and says the console must start first. A key or key directory that is a symbolic link, is
  another user's or is open to other users is refused. The firewall treats the key directory as a
  credential for reads (the file, the directory, a glob, a recursive read or `find -exec` under it:
  high) and as a security control for writes (planting, linking, copying or moving it: high).
  Inline interpreter code that builds the key's path at run time is not seen by that rule and stays a
  residual risk.
  The tool firewall,
  `pentest-governance-domain` and `ask_human` delete and audit (`human_console_answer_rejected`)
  an answer that does not verify for their request and keep waiting; an unsafe key makes the
  console unavailable, which fails closed (`tests/human-console-auth-smoke.ts`; the broker,
  firewall and governance smokes now answer with signed files).
- **Unattended mode's contract provenance counts only in the initial user namespace.** The check
  accepted a read-only mount or a foreign owner seen from any namespace, so a process could create
  a user and mount namespace with a read-only bind mount and be treated as unattended on the host;
  comparing namespaces with PID 1's alone was not enough, because a process that also makes a PID
  namespace is PID 1 there. Both proofs now count only when the process is in the initial user
  namespace (the kernel's fixed initial namespace id and the identity uid map); a read-only mount
  also only in PID 1's mount namespace, and a foreign owner never when it is one of the user's
  subordinate ids. Elsewhere the mode fails closed with the reason. A worker under a rootless
  engine (rootless Podman, the runner's default, or rootless Docker) runs in a user namespace its
  user made and so is not unattended: the normal headless rules apply there
  (`tests/firewall-unattended-smoke.ts`, with real `unshare` cases, with and without a PID
  namespace and its own `/proc`, where the kernel allows them). The autonomy boundary probe reports
  whether the worker shares PID 1's namespaces.
- **Linking a phone needs a person at a terminal.** The control secret admits any process of the
  account, so an agent's tool call that read `control.json` could open an offer and approve the
  phone that claimed it. The host now approves only for a control connection whose process has a
  controlling terminal, is in its foreground group and reads a terminal; other approvals are
  refused and audited as `pair_decide_refused`, and every `pair_approved` record names the
  deciding process and the request's address (`tests/remote-host-smoke.ts`,
  `tests/remote-pairing-controls-smoke.ts`).
- **Compensating controls for Yes-first phone pairing, with the default unchanged.** Approve stays
  the first choice (operator decision). Approving now needs the last four characters of the device
  ID, which the terminal hides and the operator types from the phone, and a wrong value rejects;
  a second claim of a claimed code cancels the request and is refused (`offer_contested`); a
  request from outside loopback, LAN and Tailscale ranges carries a warning; each dialog a phone
  answers is audited as `phone_dialog_answer` with device, session, tier and choice, and the
  terminal shows which phone answered (`tests/remote-host-smoke.ts`,
  `tests/remote-control-extension-smoke.ts`).
- **A phone added to `devices.json` without a pairing record is suspended.** At start the host
  compares `devices.json` with `audit.jsonl`; a device with no `pair_approved` record cannot sign
  in, is marked SUSPENDED and is reported (`device_unaudited`) until it is revoked or paired again
  (`tests/remote-host-smoke.ts`).
- **Workspace state writes no longer follow a symbolic link a repository committed.** The kit
  wrote its state under `<workspace>/.pi` (the trace ledger, the firewall audit log, goal,
  task-graph, verdicts, recovery reports, snapshots, context contributions, workflow run files)
  and `AGENTS.md`/`TODO.md` with plain `fs` calls, which follow links, so a cloned repository that
  committed `.pi/trace.jsonl` (or `.pi` itself) as a link could make an ordinary session append to
  or replace a file elsewhere that the user can write. Every such write now goes through one
  helper, `packages/core/shared/safe-fs.ts` (copied into each extension by `npm run gen:shared`,
  drift-checked by `npm run verify`): directories are checked from the workspace root down, the
  file is opened with `O_NOFOLLOW` and must be a regular file the user owns with one link, and a
  whole-file replacement goes through an exclusive temporary file and a rename. ESLint now rejects
  a raw write call in an extension outside a reviewed allowlist (`tests/workspace-symlink-smoke.ts`).
- **The autonomy gate's held-out overlay is copied without following the worker's links.** The
  overlay was applied with `fs.cpSync` over the worker-controlled clone, so a committed link in
  the clone could redirect the copy out of it, and the check's working directory could pass
  through a link. Both are now refused as a gate error (`tests/autonomy-gate-overlay-smoke.ts`).
- **Untrusted regular expressions are checked before use.** A project skill's `re:` trigger and a
  workflow gate pattern are compiled only when the shared safe-regex check accepts them, and a
  skill trigger runs under a 50 ms limit that switches a slow one off for the session. ESLint now
  rejects a non-literal `new RegExp` outside a reviewed allowlist (`tests/skill-routing-smoke.ts`,
  `tests/workflow-smoke.ts`).
- **One secret-redaction table for everything the kit stores.** The memory vault, `/save`, the
  firewall feedback log, autonomy notebooks, workflow run files, role-runner telemetry and mem0
  memories each had their own patterns, with different coverage, and some rules backtracked badly
  on long input. They now share `packages/core/shared/redact.ts`, whose rules are all linear;
  mem0 memories were not redacted at all and now are (`tests/redaction-corpus-smoke.ts`,
  `tests/memory-mem0-smoke.ts`).
- **Profile restores never leave a world-readable file.** The rollback wrote its temporary file
  with the process umask before setting the snapshot's mode, so a restored `.env` could briefly be
  readable by others, and the predictable temporary name could be planted. It is now created
  exclusively with mode 0600 under a random name (`tests/profile-transaction-smoke.ts`).
- **branch-lab worktrees live in a per-user directory.** They were created under a shared
  `<temp>/pi-branch-lab`, which another local user could create first. They now live under
  `<temp>/pi-kit-<uid>` (mode 0700; a link or another user's directory is refused)
  (`tests/branch-lab-smoke.ts`).
- **Credentials are not sent over plain HTTP by default.** mem0 refuses to send `MEM0_API_KEY` over
  `http://` to a non-loopback host unless `MEM0_ALLOW_INSECURE_HTTP=1`, and caps responses at
  4 MiB (`tests/memory-mem0-smoke.ts`). The role-runner refuses an `http://` LiteLLM URL other than
  loopback or an in-cluster `*.svc` service, and any URL with embedded credentials, unless
  `--allow-insecure-http` or `PI_LITELLM_ALLOW_INSECURE_HTTP=1`, and caps responses at 8 MiB.
- **tool-capture records are built on a null prototype**, so a captured field named `__proto__`
  round-trips as data instead of changing the record's prototype (`tests/tool-capture-smoke.ts`).
- **Publication reads the tagged commit's Git objects, not the runner's working tree.** GitLab
  extracts the artefacts of needed jobs into the checkout before a job's script runs, and the
  publish job only compared `HEAD` with `CI_COMMIT_SHA`, which cannot see a modified tracked file,
  so an artefact from the general runner pool could change the files the protected job re-derived
  and published, including the publisher itself. `publish-github` now takes a fresh clone, fetches
  only `build-public`'s artefact, and refuses a checkout with any tracked file changed or any path
  beside `public-build/` in git-only commands before repository code runs; `publish.ts` repeats the
  check and, like `build-public`, exports with `exportTree(..., { commit })`, which reads every
  byte and mode from the commit (`smoke:public-export`, `smoke:gitlab-ci-structure`).
- **The pull-request leak scan applies the pre-push hook's rules.** The `leak-scan` job ran with
  `--pending-from HEAD`, which passed a match admitted only by an exception the same pull request
  added and switched off the rule against an exceptions change mixed with other files, so a push
  made with `--no-verify` could add an identifier and its own exception and pass the required
  check. Both now fail; `--pending-from` only names which findings the new exception would admit.
  New exceptions land in their own pull request first (`smoke:prepush-scan`).
- **The leak scan blocks Windows home paths in any letter case, and SSH2 private-key headers.**
  The drive-letter form was matched case-sensitively, so a lower- or upper-case path passed
  (`smoke:prepush-scan`).
- **The per-lockfile audit loops cannot pass over nothing.** `lockfile-check --list` exited 0
  when it found no lockfile, and the loops in `security.yml` and the GitLab `dependencies` job
  ignored the exit status of the command substitution. `--list` now fails when it finds none, and
  both loops capture the list with a checked assignment first (`smoke:lockfile-check`,
  `smoke:scan-coverage`, `smoke:gitlab-ci-structure`).
- **Both pipeline policy tests reject every common fail-open idiom.** They caught `|| true`,
  `|| :` and `allow_failure: true` only; they now also reject `|| exit 0`, `|| echo`, `set +e`
  and `allow_failure` with `exit_codes:`, from one shared list (`tests/ci-fail-open.ts`,
  `smoke:workflow-policy`, `smoke:gitlab-ci-structure`).
- **The ledger validator can check against an anchor kept outside the data root.**
  `scripts/validate-ledgers.py --write-anchor` records each ledger's head and `--anchor` fails a
  ledger whose anchored records were rewritten (even with a recomputed chain), truncated or
  deleted; the docs now say the chain alone detects accidents, not deliberate tampering
  (`tests/ledger-anchor-smoke.ts`).
- **Companion installs run with npm lifecycle scripts off and are integrity-checked.** Companion
  installs (`packages/core/sources.json`) run with `npm_config_ignore_scripts=true`, and the
  installer checks the integrity npm recorded for each companion against the sha512 pinned in
  `sources.json`; a difference removes the package and fails the install
  (`tests/companion-integrity-smoke.ts`).
- **The autonomy image installs pi from a committed lockfile, and the helper installs the kit's pi
  version.** The image ran `npm install -g @earendil-works/pi-coding-agent@1.4.0` (pi 1.x ships no
  shrinkwrap, so its dependencies floated); it now runs `npm ci --ignore-scripts` from
  `packages/autonomy/image/tools/package-lock.json` and fails when the locked pi is not `PI_VERSION`.
  The language tools stay pinned global installs: locking them surfaces two advisories with no
  upstream fix yet (zod 3.25.76 in bash-language-server, katex 0.16 in markdownlint's math extension).
  `pi-kit-helper.sh update-pi` and `pi-kit-helper.ps1 update-pi` ran an unpinned
  `npm install -g @earendil-works/pi-coding-agent` with install scripts; they now install the exact
  `devDependencies` pin with `--ignore-scripts`, and refuse when the pin is not exact
  (`tests/helper-smoke.ts`).
- **The container image installs pi and pi-mcp-adapter from a committed lockfile, and the adapter
  config cannot be changed from inside the container.** pi was installed with `npm install -g`
  (transitive versions floating), and pi fetched `npm:pi-mcp-adapter@6.0.0` into the writable agent
  directory at first start with no lockfile. Both now come from `packages/container/tools/package-lock.json`
  with `npm ci --omit=dev --ignore-scripts` at build time, owned by root, and the overlay registers
  the adapter by its path in the image. The entrypoint replaces `mcp-adapter.json` with the image's
  copy at every start (an edited copy is kept as `.replaced`, with a warning) and points an older
  `settings.json` at the baked adapter; `validate-runtime-readiness.py` fails while the live copy
  differs; `validate-pentest-env.sh` fails when the Dockerfile, manifest and lockfile pins disagree
  (`tests/container-static-smoke.ts`).
- **A release-mode container build verifies the kit commit.** It cloned `--branch "$PI_KIT_REF"`
  (default `main`) with no check of what arrived, and its `|| (echo ...; exit 1)` guards exited only a
  subshell, so a failed check did not fail the build. `BUILD_MODE=release` now requires
  `PI_KIT_SHA` (a full commit id; `scripts/build.sh --sha`) and fails unless the clone is that commit,
  and every guard stops the build.
- **The Qdrant compose service is no longer published unauthenticated on every interface.** Its port
  mapping named no host IP and no API key was set. It now binds `127.0.0.1`, requires
  `QDRANT_API_KEY` (compose refuses to start without it; Qdrant answers `401` without the key), and
  runs the pinned `-unprivileged` image as uid 1000 with every capability dropped and
  `no-new-privileges`. A volume created by the root-run image needs a one-off `chown`
  (`docs/INSTALL.md`).
- **Every compose file is checked against one policy.** `tests/compose-policy-smoke.ts` refuses a port
  mapping without a loopback host IP, a published service that requires no credential (unless
  exempted with a reason), a missing `cap_drop: [ALL]` or `no-new-privileges`, privileged services,
  host namespaces and engine-socket mounts. The `pi-agent` health port now binds `127.0.0.1`.
- **The container's engagement files are read-only to the agent.** Scope, rules of engagement and
  tool policy are mounted read-only at `/workspace/engagement` from `PI_ENGAGEMENT_DIR`, a host
  directory outside the data root (`tests/compose-policy-smoke.ts`). The container's network is still
  not scope-limited; `packages/container/README.md` says so.
- **The autonomy runtime re-checks the image at the last containment check.** `containment.ts`
  declared an `allowedImages` option but never used it, so service images were checked only when the
  contract was parsed. Every `run` the supervisor executes is now refused unless its image is the
  worker image or one of the contract's `permissions.network.serviceImages`
  (`tests/autonomy-boundary-smoke.ts`).
- **`build-image.sh` defaults `--kit-ref` to the checkout's release tag.** It defaulted to
  `v0.2.4-beta.0`, so a build without the flag baked an older firewall and containment than the
  checkout. The default is now `v<package.json version>`, `--print-kit-ref` prints it, and a ref
  missing from the clone stops before the engine is called (`tests/autonomy-build-image-smoke.ts`).
- **The self-improve merge review no longer judges a cycle by inputs the cycle wrote.** The review
  read `autonomy/CHARTER.md` from the cycle's own commit, which the worker can edit, and clipped
  diffs over 60,000 characters to their start and end, so a change in the middle went unseen. The
  charter now comes from the integration head the cycle started from; a diff over the budget is not
  merged; and a cycle that changes the charter, a path in the new
  `templateOptions.integration.controlPaths` or the `scripts` of any `package.json` is not merged
  without asking the model, unless `templateOptions.integration.allowControlChanges` is `true`. The
  review prompt lists changed tests and check definitions and says the report, commits and diff are
  data, not instructions (`tests/autonomy-review-inputs-smoke.ts`).
- **A merge-review diff the host cannot read in full is rejected, not treated as empty.** The
  over-budget check read the diff through a git call that returned an empty string on any failure,
  so a diff larger than git's 64 MiB output cap, or one that timed out, measured 0 characters: with
  the review off the cycle merged as "checks passed", and with it on the reviewer saw an empty
  diff. The diff is now read with an output cap of four bytes per budget character; output over
  the cap is rejected as over budget, and any other git failure or timeout is rejected as
  unreadable, with the review on or off (`tests/autonomy-review-inputs-smoke.ts`).
- **Package-manager configuration is a built-in merge control path.** `package.json` scripts were
  control paths because the gate runs them, but a cycle could add a repository-level `.npmrc`
  (or Yarn, pnpm or Bun configuration) that changes the shell or node options of every `npm run`
  the gate makes, and no rule or reviewer listing covered it. `.npmrc`, `.yarnrc`, `.yarnrc.yml`,
  `.yarn/plugins/`, `.yarn/releases/`, `.pnpmfile.*`, `pnpm-workspace.yaml` and `bunfig.toml`, at
  any depth, are now control paths without any `controlPaths` entry. The reviewer's host-built
  list of critical files now also names package-manager configuration, `package.json` files,
  `check-all*` and `gate.sh` files, and the files the root and changed `package.json` scripts name
  (`tests/autonomy-review-inputs-smoke.ts`).
- **secret-guard loads in the balanced and autonomous profiles, and every profile must cover the
  mandatory protections.** `secret-guard` is one of the three mandatory protections the delegation
  guard and the overrides check name, yet it shipped in no profile. It now loads in `balanced` and
  `autonomous` (manifest status `beta`). `npm run profile:check` fails a profile that does not load
  `tool-firewall`, `secret-guard` and `protected-paths` unless `packages/core/lib/protection-coverage.ts`
  records why; the other five profiles record that secret-guard refuses every write to a path
  containing `secret` or `credentials` (`tests/profile-protections-smoke.ts`).
- **pi's undici moves from 8.10.2 to 8.12.3, in the repository and in both images.**
  `@earendil-works/pi-coding-agent` 1.4.0 pins undici 8.10.2 exactly, which is affected by
  GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685 and GHSA-f72v-6w45-q472 (fixed in 8.12.2). An npm
  `overrides` entry raises it to 8.12.3 in the root `package.json`, in the autonomy image's
  `image/tools/package.json` and, scoped to pi, in the container's `tools/package.json`, where
  pi-mcp-adapter keeps its own undici 6.29.1. Both images already install from these lockfiles
  with `npm ci`, so the override reaches them. npm audit and OSV now report nothing for any
  lockfile.

## [0.2.4-beta.7]

### Fixed

- **Dependency review accepts `json-schema-typed` 8.0.2.** The GitHub `dependency-review` job
  failed the v0.2.4-beta.6 pull request because GitHub detects this package's licence as
  "BSD-2-Clause AND JSON". Its code is BSD-2-Clause; the JSON licence match comes from the IETF
  JSON Schema description text it bundles. It reaches the container's memory and governance MCP
  servers through `@modelcontextprotocol/sdk` 1.32.1. `security.yml` now allows that one package
  at that one version (`allow-dependencies-licenses`); the licence allow list is unchanged.

## [0.2.4-beta.6]

### Added

- **A code of conduct.** `CODE_OF_CONDUCT.md` adopts the Contributor Covenant 2.1, with a private
  reporting route that matches `SECURITY.md`; `CONTRIBUTING.md` links it. Nothing tests it.

### Changed

- **The suite is tested against pi 1.4.0.** The `pi-ai`, `pi-coding-agent` and `pi-tui` dev
  dependencies move from 1.3.0 to 1.4.0, and `PI_BUILTIN_TESTED_VERSION` with them. pi 1.4.0
  registers the same 24 built-in slash commands, the same `/mcp` and `/llama` extension commands and
  the same core tools as 1.3.0, so the built-in lists and the firewall's trusted pi tools are
  unchanged (`tests/command-contract-smoke.ts`). The `>=0.85.1` peer floor is unchanged.
- **Root development dependencies are on their newest releases:** eslint 10.13.0, jsdom 30.1.3,
  mermaid 12.2.0, typescript-eslint 8.72.0, zod 4.6.7, and the lockfile's transitive packages
  (typebox 1.4.3, @types/node 26.6.5 among them). TypeScript moves from 5.9.3 to an exact 6.0.3,
  the newest release typescript-eslint supports (`>=4.8.4 <6.1.0`); TypeScript 7 exports no
  compiler API, which `packages/core/eval/harness.ts` uses, and is not adopted
  (`docs/supply-chain.md`). mermaid 12.2.0 depends on katex `^0.18.0` itself, so the `katex`
  override added for GHSA-238p-pmpm-9mq7 is gone; katex resolves to 0.18.10, the newest
  non-deprecated release in that range. `npm audit` and OSV report nothing on the root lockfile.
- **quickjs-wasi 3.6.3.** The workflow sandbox's QuickJS runtime moves from 3.6.2 to 3.6.3, which
  fixes a promise resolver being freed while it is still running when settling it re-enters host
  code. `quickjs.wasm` is byte-identical, so the pinned sha256 is unchanged
  (`tests/workflow-sandbox-smoke.ts`).
- **CI actions updated:** `github/codeql-action` 4.39.1, `google/osv-scanner-action` 2.7.0,
  `ossf/scorecard-action` 2.5.0, `zizmorcore/zizmor-action` 0.8.0 and `actions/setup-python`
  7.1.0, each still pinned to a full commit SHA. The docs build runs on Python 3.15.
- **The autonomy image runs pi 1.4.0 and pins its language tools.** It installed pi 0.87.1 and
  the pi-lens tools unpinned, so a rebuild picked up TypeScript 7.0.2, which ships no `tsserver`,
  and `typescript-language-server` failed with "Could not find a valid TypeScript installation".
  Every tool is now pinned: TypeScript 6.0.3, typescript-language-server 6.0.2, jscpd 5.4.2 (from
  3.5.10) and the newest release of the rest.
- **The container image runs pi 1.4.0.** `packages/container` pinned pi 0.87.1 in its
  Dockerfile, both compose files and `capability/env/defaults.env`; all four, and the pin
  `validate-pentest-env.sh` checks, now name 1.4.0.
- **The container image runs pi-mcp-adapter 6.0.0.** It ran 2.8.0, which installs its own pi-ai,
  pi-tui and typebox copies; 6.0.0 uses pi's (peer ranges include pi 1.x) and its MCP client
  carries the fix for GHSA-6qxp-vccf-f47h. 6.0.0 reads only the `settings` of its own
  `mcp-adapter.json` and, by default, adds `mcp__<server>` and deferred `mcp__<server>__<tool>`
  tools and runs each `mcp` call as a nested call to one, which `pentest-governance-domain`'s
  MCP-only mode blocked for every call. So the overlay's `mcp.json` is now `mcp-adapter.json`, also
  with `namespaceProxyTools`, `allowInstall`, `allowScriptToolSave` and `jev` off; the image sets
  `PI_MCP_CONFIG_MODE=exclusive` (only that file is read) and `MCP_DIRECT_TOOLS=__none__` (only the
  `mcp` tool); and the overlay `settings.json` keeps Pi's built-in MCP off. In the built image the
  tool surface is `mcp` alone, as before, and calls to both bundled servers succeed with and
  without MCP-only mode. A data root seeded by an earlier image keeps its 2.8.0 pin until its
  `settings.json` is updated (`packages/container/README.md`). `validate-pentest-env.sh` checks the
  new pin, settings and environment (`tests/container-static-smoke.ts`); no test loads the adapter.
- **The tool firewall treats `.pi/mcp-adapter.json` as a safety-control file**, as it does
  `.pi/mcp.json`: pi-mcp-adapter 3.0.0 and later read MCP servers from it
  (`tests/firewall-shell-smoke.ts`).
- **The memory-mcp Qdrant service runs v1.20.0, pinned by digest.** It ran v1.12.6. trivy
  reports 12 critical and 148 high findings in the v1.12.6 image and no critical and 45 high in
  v1.20.0, two of them fixable (follow-redirects in the bundled web UI). Qdrant upgrades only one minor release at a
  time: a v1.12.6 volume does not start under v1.20.0, and `docs/INSTALL.md` gives the stepped
  upgrade, checked by hand on a v1.12.6 volume through each minor release. No kit code calls Qdrant;
  the memory MCP server uses SQLite and JSONL, and the docs no longer call it Qdrant-backed.
- **CI runs the suite on Node 26.** The `verify`, `profile-regression`, `dependencies` and
  release jobs use Node 26; the `pi-compat` lanes stay on Node 22, the engines floor. The engines
  floor itself (Node 22.19) is unchanged.
- **The Android app's toolchain and libraries are current.** Gradle 9.8.2 (wrapper and checksum
  regenerated from the official distribution), Android Gradle plugin 9.4.1 with its built-in
  Kotlin, Kotlin 2.4.21, compile SDK 37.2, target SDK 37 and build tools 37.0.0, plus AndroidX
  Core 1.19.1, Activity 1.13.0, Fragment 1.9.1, Lifecycle 2.11.0, WebKit 1.18.0, coroutines
  1.11.0, OkHttp 5.5.1 and ZXing core 3.5.4. Building needs `platforms;android-37.2` and
  `build-tools;37.0.0` (see `apps/android/README.md`); JDK 17 is still enough.
- **pi remote draws edge to edge and keeps its page clear of the system bars and the keyboard.**
  Android 15 and later always draw an app that targets API 35 or later edge to edge, and
  `adjustResize` no longer makes room for the keyboard. Without handling, the page would have run
  under the status bar and navigation bar and the composer under the keyboard. The app now pads
  its page by the system-bar, display-cutout and keyboard insets on every Android version, and
  keeps the bars black with light icons. Nothing tests this automatically: the build has been
  launched on an Android 17 test image, which has no system bars or on-screen keyboard, and not
  yet checked by hand on a phone or a full emulator image.

### Fixed

- **The autonomy egress proxy no longer uses a deprecated DNS option.** Its default resolver
  passed `verbatim: true` to `dns.lookup`, which current Node type declarations mark deprecated
  and lint rejects; it now passes the equivalent `order: "verbatim"` (Node 22.1 and newer), so
  addresses are still returned in resolver order. No test drives the default resolver:
  `tests/autonomy-egress-smoke.ts` injects its own.
- **The role-runner image builds again.** Its build-time check stage runs
  `tests/role-runner-smoke.ts`, which imports `packages/core/lib/guard.ts`, but the stage did not
  copy that file, so the build failed with `ERR_MODULE_NOT_FOUND`. The stage now copies it.
- **A download-then-execute approval card always says the file was downloaded.** The firewall's
  History line read "runs or makes executable <path>, which was downloaded", and the card clips
  each line to 116 characters, so under a long absolute path (a long `TMPDIR`, for one) the reason
  fell off the end and the operator saw only a truncated path. The reason now comes first: "runs
  or makes executable a file this session downloaded: <path>". `smoke:firewall-gate` (also run by
  `smoke:env-isolation`) failed with a long `TMPDIR` for this reason; it now asserts the whole
  History prefix and passes with a long and the default `TMPDIR`.

### Security

- **undici 8.12.3 in the root lockfile (GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685,
  GHSA-f72v-6w45-q472).** pi-coding-agent 1.4.0 pins undici 8.10.2 exactly, and these advisories
  (published 2026-10-23) are fixed in 8.12.2. A root `overrides` entry moves the development
  install to 8.12.3, the version jsdom already used; OSV reports nothing on the lockfile. The
  container and autonomy images install pi globally, where overrides do not apply, so they still
  carry 8.10.2 until pi updates its pin or the images install from a lockfile.
- **The container's governance and memory MCP servers no longer ship vulnerable dependencies.**
  Both pinned `@modelcontextprotocol/sdk` 1.29.0, and the governance lockfile resolved versions of
  hono, @hono/node-server, fast-uri, ip-address, proxy-addr, qs and body-parser that have published
  advisories: 38 OSV advisories in all, including the 32 that the OpenSSF Scorecard reported
  (GHSA-6qxp-vccf-f47h in the SDK, GHSA-jqcg-44mw-7w3h in proxy-addr, eleven in hono, eight in
  fast-uri, seven in ip-address and others). Both servers now pin the SDK at 1.32.1 and zod at 4.6.7,
  and their lockfiles resolve hono 4.13.13, @hono/node-server 2.1.5, fast-uri 3.1.9, ip-address
  10.7.4, proxy-addr 2.0.8, qs 6.16.1 and body-parser 2.4.0. `osv-scanner` and `npm audit` report
  nothing for either lockfile. memory-mcp now has a committed `package-lock.json`, and the
  container image installs both servers with `npm ci --omit=dev --ignore-scripts` (it ran
  `npm install`), so the build installs exactly the reviewed tree and fails if a lockfile disagrees
  with its manifest. A release-mode build (`BUILD_MODE=release`) of a kit ref that predates the
  memory-mcp lockfile now fails instead of resolving the ranges. The
  `better-sqlite3` dependency is gone: memory-mcp has always used `node:sqlite`, and nothing
  imported the native addon. `scripts/validate-governance-mcp-server.sh` checks the new pins.
- **OSV-Scanner checks every lockfile in the tree, not only the root one.** `security.yml`
  scanned `package-lock.json` alone, so the 32 advisories OpenSSF Scorecard reported against
  `packages/container/mcp-servers/governance/package-lock.json` (`@modelcontextprotocol/sdk`,
  `hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `proxy-addr`, `qs`, `body-parser`) never
  failed CI. The job now runs `--recursive ./`, which also covers the MCP server lockfiles and
  `requirements-docs.txt`.
- **Dependabot watches the MCP servers, the docs toolchain, the container images and the Android
  build.** It covered only the actions and the root npm tree. It now also proposes updates for
  the npm manifests under `packages/container/mcp-servers/`, pip (`requirements-docs.txt`), the
  container Dockerfile, the memory-mcp compose service and the Android Gradle build, with the same
  7-day cooldown. The autonomy image Dockerfile and the role-runner Containerfile named their base
  images in `ARG` defaults, which Dependabot does not follow; both now name them by digest in their
  `FROM` lines, and Dependabot's docker entry covers both directories.
  `smoke:autonomy-container` reads the autonomy image's Node base from its final `FROM` line.
- **The Semgrep image is 1.182.1.** 1.178.0 bundled PyJWT 2.13.0 (CVE-2026-102268, critical, and
  six high advisories) and certifi 2026.7.22 (GHSA-6q48-6c7w-9gw2, critical), plus high findings
  in Alpine's libexpat, pcre2 and python3; 1.182.1 has no high or critical findings.
- **Every Node image runs Node 26.12.1, past the October 2026 Node security release.** The
  container image (`packages/container/Dockerfile`) and the GitLab CI default image ran Node
  22.23.3, which misses the TLS, DNS and brotli fixes in 22.23.4 / 24.22.1 / 26.12.1; the autonomy
  and role-runner images named a tag with no digest. All four now name a Node 26.12.1 image by
  digest: `node:26-alpine` for the container and role-runner images, `node:26-trixie-slim` for
  the autonomy image (Debian 13, from bookworm), and `node:26-trixie` for GitLab CI (from
  `node:22-bookworm`). `smoke:autonomy-container` builds its test image from the autonomy image's
  pinned base, read from the Dockerfile, so the two cannot drift apart.
- **The images no longer ship the advisories in the npm that Node bundles.** The container and
  autonomy images install npm 12.2.1 before anything else (Node 26.12.1 bundles npm 11.20.0, whose
  brace-expansion, undici and http-cache-semantics copies have known advisories); the role-runner
  runtime stage removes npm, which it never used.
- **The autonomy image's gitleaks is built from source.** The upstream v8.30.1 binary, still the
  newest release, was built with Go 1.24.13 and carries Go standard-library, `golang.org/x/crypto`,
  `golang.org/x/text` and `klauspost/compress` advisories. The image now builds v8.30.1 with a
  digest-pinned Go 1.27.3 and moves only those three modules to their newest releases. CI's
  gitleaks (`security.yml` and the GitLab `gitleaks` and `secrets-public` jobs) still runs the
  upstream release; `docs/supply-chain.md` records why, with the autonomy image's remaining Debian
  13 findings that Debian has not fixed.
- **The GitLab CI scanner and Python images moved to current releases.** Semgrep 1.182.1 (from
  1.178.0, whose PyJWT and certifi had critical advisories), `python:3.15.1-alpine3.24` for the
  role contracts (from 3.13.7 on Alpine 3.22, whose OpenSSL had a critical advisory) and
  `python:3.15.1-slim` for the docs jobs (from 3.12), each by digest.
- **The opt-in `pi-lean-ctx` companion moves from 3.10.5 to 3.11.4.** Its self-contained MCP
  client bundle (`extensions/vendor/mcp-sdk.cjs`) is now built from `@modelcontextprotocol/sdk`
  1.32 rather than 1.29. The bundle holds only the SDK's client and stdio transport, so
  GHSA-22jm-h49p-29qw, which affects servers that pass a `taskStore`, never applied to it; the
  rebuild only moves it off an SDK version that scanners flag. OSV and `npm audit` cannot see a
  vendored bundle. The registered tools, peers and the lack of install scripts are unchanged; the
  review in `packages/core/sources.json` records the diff. `pi-lens` 4.4.4 is already the latest
  release.
- **The Android build no longer runs a Kotlin Gradle plugin with a known code-execution flaw.**
  `apps/android` built with Kotlin Gradle plugin 1.9.22, affected by GHSA-r937-wjx7-w2jp
  (CVE-2026-53914: unsafe deserialisation in the Kotlin build cache). It now builds with 2.4.21.
  OSV also listed 66 advisories against the build's resolved Gradle plugin classpath (AGP 8.2.1
  pulled in old Netty, protobuf, Guava, commons-io, commons-compress, Bouncy Castle, jose4j, JDOM
  and Xerces). On AGP 9.4.1 the build still resolved Bouncy Castle 1.80.2, commons-lang3 3.16.0,
  jose4j 0.9.5, JDOM 2.0.6 and, for Android Lint, httpclient 4.5.6; dependency constraints raise
  these to their latest releases. OSV now reports nothing for either the plugin classpath or the
  app's configurations. None of these libraries ships in the APK.

## [0.2.4-beta.5]

### Fixed

- **The pi-compat lanes resolve pi-tui again.** The control centre, the `/` command menu and the
  workflow panel import `@earendil-works/pi-tui`, but `package.json` did not declare it; the
  pinned tree found it only because pi 1.3.0 depends on it. The lane installed another pi over
  that tree, npm nested that pi's pi-tui under it and pruned the root copy, and every check that
  loads those extensions failed with `ERR_MODULE_NOT_FOUND` on 0.85.1 and 0.99.2. `pi-tui` and
  `pi-ai`, which the kit also imports, are now peer dependencies with the same `>=0.85.1` floor as
  pi, `pi-tui` is a dev dependency pinned to 1.3.0 beside pi, and the lane installs `pi-tui` at
  its own version. Inside pi nothing changes: pi's loader already maps these imports to its own
  copy. `tests/pi-host-peers-smoke.ts` fails on an undeclared pi import, an unpinned pi peer, or a
  lane install that leaves a pi peer out.
- **`npm run verify` type-checks only against the pinned pi.** Its `tsc --noEmit` step read the
  installed pi's type declarations, so in the `pi-compat` CI lanes (0.85.1, 0.99.2) it failed on
  names those releases do not export, and so did `tests/new-extension-smoke.ts`, which runs verify
  on a fresh scaffold. When the installed pi differs from the `devDependencies` pin, the step now
  prints `SKIP: installed pi X is not the pinned Y; the verify job type-checks the pin`; at the pin,
  or when either version cannot be read, it runs `tsc` as before (`tests/new-extension-smoke.ts`).
  The effort wake-chain cap needs pi 1.2.0 or newer (`tests/effort-standing-smoke.ts`); on older
  pi the cap is never reached, as `docs/supply-chain.md` states.
- **The overlay tests pass on pi older than 1.3.0.** The control centre and the `/workflows` panel
  open as an overlay only on pi 1.3.0 or newer, where pi fixed the overlay `done()` bug, but their
  tests expected an overlay on any pi, so the 0.85.1 and 0.99.2 compatibility lanes failed. The
  tests now expect an overlay exactly when the installed pi is 1.3.0 or newer, and check the
  version rule itself on both sides of 1.3.0. Behaviour is unchanged
  (`tests/control-center-smoke.ts`, `tests/workflow-panel-smoke.ts`).
- **progress-guard's loop nudge reaches the looping run on pi older than 0.87.0 too.** It
  returned the nudge and the review/delegate checkpoint from `turn_end` as entries, which pi only
  appends from 0.87.0 on; older pi ignored them, so the model saw the guidance only at the next
  prompt, through the `context-sieve` contribution. When `turn_end` carries no `entries`, the
  guard now sends the same hidden message as a steering message, which older pi adds before the
  next model request of the same run. `tests/progress-guard-agsix-smoke.ts` checks the in-run
  delivery on the installed pi and drives both `turn_end` shapes.
- **A reviewed `nosemgrep` suppression no longer raises a GitHub code-scanning alert.** Semgrep
  keeps suppressed findings in its SARIF output, marked `suppressions`, and code scanning raised
  them anyway; the security workflow now drops them before the upload, and the `--error` gate is
  unchanged. The web console's static-file `sendFile` call, which only ever receives a path from
  its own listing of `public/`, carries a suppression with the full rule ID, and
  `docs/ci-security.md` says the full ID is required. Nothing pins the workflow step; it was
  checked by running Semgrep 1.182.1 with the workflow's rule packs on the flagged files.
- **A workflow script's leading comments can no longer stall the host.** The step that drops a
  leading `export` before `const meta` used one regular expression whose lazy block-comment group
  backtracked exponentially on a source of `/*` and many `*//*` repeats (26 repeats took about
  60 ms, and each 2 more took 4 times as long); it is now a single left-to-right scan. A block
  comment ends at its first `*/`, so an `export` that only followed an invalid `*/` is now left
  in place for the parser to reject. `tests/workflow-sandbox-smoke.ts` pins the accepted and
  refused prefixes and that 50,000 repeats finish in under a second.
- **`prepush-scan.ts install` no longer checks for an existing hook and then writes it.** It
  created the hook after a separate existence check, so a hook that appeared in between was
  overwritten (CodeQL `js/file-system-race`). It now creates the hook with an exclusive open and
  reads and re-modes an existing one through a single descriptor; a different hook, or a dangling
  symlink at the hook path, is refused and left as it is (`tests/prepush-scan-smoke.ts`).
- **Install scaffolds the agent `.env` without a check-then-create race.** It no longer tests for
  the file before creating it: it reads `.env.example` once (skipping when it is absent) and
  creates `.env` 0600 with an exclusive create, so a `.env` that appears in between is kept as is
  and the run does not fail on it. Install now prints `Scaffolded <path> from .env.example` after
  the file is created, and nothing when it already exists (`tests/install-marker-smoke.ts`).
- **`build-web.ts` reads each compiled file's committed copy without checking for it first.** It
  used to test for the file and then read it, the check-then-use pattern CodeQL reports as
  `js/file-system-race`; it now reads directly and treats a missing file (`ENOENT`) as absent, so
  `--check` still reports it as missing and a build still writes it. `smoke:web-build` pins that
  every committed file matches its source; nothing pins the missing-file branch.
- **Workflow discovery reads each `*.js` script through one open file.** It used to check the
  path's type and size and then read the path again, so the bytes parsed for `meta` could come
  from a different file than the one checked (CodeQL `js/file-system-race`). The type, the 1 MiB
  limit and the text now all come from the same descriptor, opened non-blocking so a FIFO named
  `*.js` is skipped instead of hanging discovery; a directory named `*.js` is still skipped
  silently. `tests/workflow-registry-smoke.ts` pins the oversized, directory and FIFO cases.
- **The command contract's built-in check passes on every supported pi, not only the pinned
  one.** `smoke:command-contract` required the installed pi's `BUILTIN_SLASH_COMMANDS` to equal
  `packages/core/lib/pi-builtins.ts` and its version to equal the copy's, so the pi 0.85.1 lane
  (no `/bug`) and the 0.99.2 lane (same names, other version) both failed. The copy is the union
  of built-ins across supported pi versions, so a kit command that shadows a built-in on any of
  them is still rejected. At the pinned pi the slash and built-in extension commands must match
  the copy exactly; at any other installed pi they must be a subset of it, so a pi that adds a
  built-in still fails (`tests/command-contract-smoke.ts`).
- **The prompt-arguments smoke runs on pi 0.85.1.** It read pi's internal `loadPromptTemplates`
  as `{ templates, diagnostics }`, but pi 0.85.1 returns the template array itself, so the
  floor lane failed with `undefined !== []`. The smoke now accepts both shapes and checks every
  template's fields before use; the kit itself never calls that function
  (`tests/prompt-arguments-smoke.ts`, `npm run smoke:prompt-arguments`).

### Security

- **The remote host never sends a stringified thrown value to the phone.** A failed `/api` or
  `/v1` request that carries a 4xx, 502 or 504 status answers with the error's message when it
  is an `Error`, and with the fixed text `request failed` otherwise, so a custom `toString` (or
  an embedded stack trace) cannot reach the reply; such a value is written to the host log.
  Other failures answer `internal error (see the host log)`. The reply text is pinned by the
  `remote-host smoke` check "a failed request tells the client an Error's message, never a
  stringified thrown value"; nothing pins the log line.
- **The Android app's exported launcher activity no longer raises a Semgrep code-scanning
  alert.** `MainActivity` must stay exported: it is the launcher and receives `pirc://pair` links.
  A link only opens the "Link a computer" confirmation screen, and the computer still has to
  approve the phone in the terminal, so the manifest now carries a full-ID `nosemgrep` with that
  reason. Nothing pins it; it was checked by running Semgrep 1.182.1 with the workflow's rule
  packs on the manifest.

## [0.2.4-beta.4]

### Added

- **Run-scoped approvals for workflow agents.** A workflow agent's approval requests now name its
  run and the exact action hash, and the attended session's console handles them per run: at most 2
  prompts open at once, identical actions grouped under one prompt, a No-first menu, denials that
  stick for the rest of the run, a run grant for medium actions only, and a pause (No-first resume
  question) once more than 10 distinct actions are approved. Worktree agents file their requests
  with the starting session's console. See `docs/script-workflows.md`
  (`tests/firewall-workflow-approvals-smoke.ts`, `tests/workflow-hooks-smoke.ts`).
- **Ultracode standing mode.** `/effort ultracode` (also `/effort uc` and `/effort e5 --standing`)
  chooses E5 and turns on standing mode for script workflows, after one No-first select: "No, keep
  asking per workflow" or "Yes, allow workflow runs this session", which pre-authorises the
  `workflow` tool so the firewall runs its calls without asking (only the policy's own `ask`, on a
  screen, in a root session, not under strict security or the pentest policy). It is refused in
  children and without a screen, recorded with `appendEntry` and restored on reload or resume
  without the pre-authorisation. While the tool is active, `policy/standing.md` sits inside the effort block with the size
  guideline (`--size`, default 50, soft) and budget (`--budget`, given to each run as
  `budget.total`), and each turn carries a hidden reminder line. More than 5 workflow completion
  turns in a row ask a No-first select. `off`, or a tier below E5 (also by `/effort reset`), returns to opt-in and revokes
  the pre-authorisation; live runs continue. See `docs/effort.md`
  (`tests/effort-standing-smoke.ts`).
- **Workflow authoring skill and built-in script workflows.** The new `workflow-authoring` skill
  is the Luna port of the workflow authoring reference: the `workflow` tool and its hooks,
  pipeline by default, adversarial and lens-diverse verify, judge panel, loop until dry,
  multi-modal sweep, completeness critic, no silent caps and resume, plus Luna notes (firewall,
  roles and the writer lock, kept `luna/wf/` branches to merge, `effort` as thinking level, trust,
  fenced results, no secrets in prompts or args). `agent-orchestration` points to it. The kit
  ships five script workflows run with `workflow({name, args})`: `understand`, `review-changes`,
  `design-panel`, `research-sweep` and `migrate` (worktree per site, nothing merged, a site
  whose reported branch is not `luna/wf/<runId>/<n>` fails unreviewed); each logs
  and returns what its caps dropped. See `docs/script-workflows.md`
  (`tests/workflow-builtin-smoke.ts`, fake agents).
- **The /workflows panel for script runs.** A nested `workflow()` shows as a `▸ <name>` group in
  the Phases and Agents panes, an `agent()` call answered from a resumed run's journal has a `◆`
  dot (and the header counts them), and the header shows badges for `sandbox: reduced`,
  `approvals: k` (when the run model counts approvals; the engine does not count child approvals
  yet) and the budget used (when the run has a `budget.total`). `k` skips the selected running
  agent only. `s` saves a script run's script as `.pi/workflows/<name>.js` behind a No-first choice
  (an overwrite is No-first too), only while it still hashes to the script the run executed, and
  trusts that digest in every project; the question names the sha256 and the trust grant. Pause
  and resume now show in a script run's panel, and a footer status line (`setStatus`) summarises
  the active runs. See `docs/workflows.md`
  (`tests/workflow-panel-smoke.ts`).
- **The /workflows panel.** `/workflows [run-id]` shows this session's workflow runs, modelled on
  Claude Code's panel: a run list, and a run view with a header (name, description, status,
  done/total agents, elapsed), a Phases pane with done/total, an Agents pane (id, model, tokens,
  elapsed, status dot), narrator lines and the footer keys `↑↓ select · x stop · p pause · s save ·
  esc back`. `x` (stop) and `s` (save a copy of the definition into `.pi/workflows/`) ask a
  No-first choice inside the panel; `s` refuses when `.pi`, `.pi/workflows` or the target file is a
  symlink. It opens as a TUI overlay and prints text in other modes.
  It shows YAML and script runs. See `docs/workflows.md`
  (`tests/workflow-panel-smoke.ts`; script runs in `tests/workflow-hooks-smoke.ts`).
- **Script workflows run.** The new `workflow` tool runs a JavaScript workflow script (`script`,
  `scriptPath` or `name`, plus `args` and `resumeFromRunId`) in the workflow-script sandbox in the
  background and returns `runId`, `scriptPath` and `transcriptDir` at once. `agent()` starts a real
  subagent as a `workflow` launch charged to the run's pinned effort scope, at E1 and depth 1 with
  no further delegation, with `label`, `phase`, `schema`, `model` (configured providers only;
  otherwise `null` and a log line), `effort`, `isolation: "worktree"` and `agentType` (kit roles and
  aliases). Concurrency is `min(16, cpus - 2)` per run with a 1000-agent cap, `budget` counts the
  run's output tokens, and `workflow()` nests one level. Every call is journaled; a resume reuses
  the longest unchanged prefix, keyed by sha256 of `{prompt, opts}` without the label, and reuses a
  writer only while the checkout (the runs directory left out) or its kept branch is unchanged;
  identical concurrent calls each reuse their own entry. The result arrives as a
  `luna-workflow-result` follow-up that triggers a turn, with the value or the error text inside
  an untrusted fence.
  Both firewall policy copies ask before `workflow`, and a child session is denied it. See
  `docs/script-workflows.md`; tests `tests/workflow-hooks-smoke.ts`, `tests/workflow-resume-smoke.ts`,
  `tests/workflow-notify-smoke.ts`, plus `tests/delegation-guard-smoke.ts` and
  `tests/tool-firewall-smoke.ts`.
- **Workflow run control.** A live workflow run can be paused (it starts no new agents; running
  ones finish), resumed, stopped (it ends `interrupted` and can be resumed) or skipped (the agents
  running now stop and their steps are recorded `skipped`; the run goes on, but a skipped gate
  step or gated-group member fails its review gate), through one API used
  by the new `workflow_control {runId, action}` tool and `/workflow pause|resume|skip|stop`.
  `state.json` and the run model show `paused`. Both firewall policy copies allow the tool as
  `process_control`. Resuming a run whose interrupted step can write now asks a No-first select
  ("No, leave the run interrupted" / "Re-run" / "Skip"), and a headless resume of such a run is
  refused. See `docs/workflows.md` (`tests/workflow-control-smoke.ts`).
- **Script workflows in the registry.** `.js` workflow scripts in the kit, user
  (`<agent dir>/workflows`) and project (`.pi/workflows`) directories are now listed by
  `workflow_run list` and `/workflow list`, read from a literal-only `export const meta = {...}`
  that is parsed, never run (`wf-meta.ts`). Scripts and YAML workflows share one namespace.
  `.claude/workflows` is not read. No engine runs scripts yet, so `workflow_run` refuses a
  script's name. Opening a project script, including from a nested `workflow(name)` call, goes
  through the No-first trust gate. See `docs/workflows.md` (`tests/workflow-meta-smoke.ts`,
  `tests/workflow-registry-smoke.ts`).
- **No-first trust prompt for project workflows.** A project workflow without a digest grant now
  asks with a select whose default is "No, don't run it", then "Run once" and "Trust this digest"
  (instead of pi's Yes-default confirm). "Trust this digest" stores the file's SHA-256 in
  `<agent dir>/pi-kit/trusted-workflows.json` (0600, protected from agent writes), so later runs
  of the same file, headless ones included, go ahead; headless runs without a grant are refused
  (`tests/workflow-smoke.ts`, `tests/protected-paths-smoke.ts`).
- **Workflow telemetry.** A YAML workflow run now feeds an in-process run model: one phase per
  top-level step and one agent per step execution, each with its label, phase, role, model, token
  usage (updated while the child runs), elapsed time and status, and `run_start`, `phase`, `agent`
  and `run_end` events for listeners. The `pi-kit.subagents` status snapshot also counts active
  workflow runs as `workflows`. Nothing is written to disk. See `docs/workflows.md`
  (`tests/workflow-telemetry-smoke.ts`).
- **Workflow run-file redaction.** A workflow run now redacts secrets in its inputs, step answers
  and errors before it writes `state.json` or `steps/<id>.md`. It uses copies of the trace
  ledger's redaction rules and secret-guard's content patterns, run in linear time. `state.json`
  is marked `"redacted": true`, and the run directory is 0700 and its files 0600. This is
  best-effort, not a security boundary (`tests/workflow-redaction-smoke.ts`, which also fails if
  the copied rules drift from their sources).
- A **workflow-script sandbox** in the `subagent` extension (`wf-sandbox.ts`, `wf-runner.mjs`); no
  tool or command runs it yet. A script runs in raw QuickJS (no `Date`,
  `Math.random`, `eval` or host globals) under `node --permission`, `prlimit` and `bwrap`, with an
  empty environment and only JSON strings crossing over stdin. Busy loops, memory, CPU time, silence
  and 1 MiB payloads are capped. The pinned `quickjs-wasi@3.6.2` (now a dependency) is checked
  against its wasm sha256, and an evil-suite self-test runs on first use. Without bwrap it refuses
  unless the operator picks reduced mode in a No-first select (`tests/workflow-sandbox-smoke.ts`,
  `docs/workflow-sandbox.md`).
- **Structured subagent results.** `runAgent` in the subagent extension takes a JSON result
  `schema`. The schema is checked before launch (object root, `required` within `properties`,
  only the keywords the validator supports, used only where it enforces them, and patterns that
  also compile with pi's `u` flag), and an invalid one is rejected without a launch. The
  child gets a child-only `StructuredOutput` tool; the host takes the submitted arguments from the
  child's event stream and validates them again itself. A run without a valid result is launched
  once more (charged), then returns `null`. The firewall allows the tool in both policy copies. Not
  yet exposed by the `subagent` tool or workflows (`tests/workflow-structured-smoke.ts`,
  `tests/tool-firewall-smoke.ts`; `docs/structured-output.md`).
- **Worktree isolation for workflow agents** (E5 slice S4), a building block that no tool uses yet.
  `subagent/worktree.ts` creates `<repo>/.pi/worktrees/<runId>/<n>` on branch `luna/wf/<runId>/<n>`
  in the caller's cwd. An unchanged worktree is removed with its branch. A changed one is kept,
  journaled and never merged. A 17th live worktree per checkout waits for a slot, and an in-process
  per-checkout lock runs main-checkout writers one at a time. `protected-paths` now blocks git's
  `hooks/`, `config` and `info/` in the git common directory under both policies, and, from inside a
  linked worktree, the main checkout's protected entries. A linked worktree's `.git` file and the
  common dir's `worktrees/` are protected too, the first lookup per cwd is kept, and a `.git` file
  naming no real git dir blocks every write. Finishing a worktree checks its git-dir link first,
  keeps it uninspected if the link changed, and runs git with fsmonitor, hooks and submodule
  recursion off; its status check does not enter nested repos, so their clean filters do not run,
  while a staged gitlink still counts as a change (`tests/workflow-worktree-smoke.ts`).
- A **workflow launch kind** in the effort ledger for script-workflow agents. A run opens a pinned
  scope with `openRunScope(runId)` and reserves with its run token; the scope outlives the per-turn
  ledger rotation. Limits come from the new `workflow` block of `effort.json`: 16 live agents per
  run, 1000 per run and 2000 per session, none of them counted against the tier budget or the
  64-child session ceiling. `reserveWorkflow` waits out a concurrency denial and throws a
  `WorkflowLedgerError` for any other. The session's workflow ledger is created only when no file
  exists; an unreadable one is never replaced, so new runs are refused. No tool starts workflow runs yet
  (`tests/workflow-ledger-smoke.ts`, `tests/effort-smoke.ts`).
- **Generations capped by the Memento opt-in.** A pi-autonomy run whose contract enables
  generations reads the per-model opt-in (`<agent dir>/pi-kit/autonomy.json`) and the tier's
  `memento.maxGenerations` for its worker model at its effort tier. It uses the same reader as
  `/effort memento`, through `packages/core/memento.ts`, and runs the lower of the contract's
  `maxGenerations` and that allowance. An allowance of 0 (not opted in, a tier without generations,
  or a profile other than `long-horizon` or `autonomous`) runs a single generation with no box. The
  decision is made once, at the first step. It is recorded in `state.memento`, logged with its
  reason, and shown by `pi-autonomy status`. `/effort memento` says the allowance applies to
  pi-autonomy runs (`tests/autonomy-generations-smoke.ts`, `tests/memento-optin-smoke.ts`;
  docs/autonomy.md, "Generations"; docs/effort.md, "Memento mode").
- **Generations in the run status.** `pi-autonomy status --run <run>` (and its `--json`, under
  `generations`) shows a run's generation n/N, why the last generation rotated (time or dollar box,
  the recovery decision, whether a notebook was appended) and the latest notebook as the next worker
  sees it, redacted again before it is printed. A rotation's problems can quote the worker's
  notebook; control and format characters are removed from them before they are saved to state.json
  or the supervisor log, and from every last-rotation field before it is shown. In pi, `/autonomy status <run>` of such a run sets
  the footer status line to `memento <run>: gen n/N, ...`, and clears it for a run without
  generations; it is refreshed only by that command (`tests/autonomy-generations-smoke.ts`,
  `tests/autonomy-command-smoke.ts`; docs/autonomy.md, "Generations").
- **Generations (Memento mode)** for finite autonomous runs: a `generations` contract key (off by
  default; `iterationMinutes` 5-240, `iterationUsd`, `maxGenerations` up to 8, `graceMinutes`,
  `resetOnNoProgress`, `notebookMaxChars`; unknown keys are errors, and no box may exceed the budget
  it sits in). When a generation's box runs out, the worker is asked for its notebook, stopped, the
  notebook is taken out of the workspace without following links, appended with the supervisor's
  measurements, and handed to a fresh worker after the verified state, inside the untrusted fence.
  A generation without progress skips the nudges and spends a hard restart, so repeated ones end the
  run `recovery_exhausted`. A box that ran out while no worker was live (a pause during the grace
  period) rotates on resume without starting a worker for the spent generation; a worker that
  crashes after its box ran out rotates without its already-judged step being judged again; the per-step
  budget applies during the grace period (`tests/autonomy-generations-smoke.ts`, `tests/autonomy-contract-smoke.ts`;
  docs/autonomy.md, "Generations").
- A **generations notebook** for autonomous runs (`packages/autonomy/lib/notebook.ts`): a worker's
  schema-1 notebook (`state`, `tried`, `failures`, `do_not_retry`, `next`, `self_reported`) is parsed
  with type guards, stripped of every Unicode control and format character (Cc, Cf) and default-ignorable code point except tab and newline, redacted, clipped and capped at 6000 characters (oldest `tried` first) with a
  report of what changed (unknown keys cleaned, clipped and capped at 20); a worker-supplied `measured`
  is dropped, since only the supervisor fills it.
  Generations are appended to a 0600 file written atomically, and rendered inside `untrusted()`
  (`tests/autonomy-notebook-smoke.ts`; docs/autonomy.md, "Generations: notebook").
- **Control centre.** `/kit` (and its `/helpers` alias, and the `alt+m` key, configurable with
  `hubKey` in `<agent dir>/pi-kit/ui.json`) opens a searchable hub of the kit's levels and pages.
  Rows show their current value from the process registries and fall back to the typed command, so
  every old command keeps working, and a change that lowers oversight needs a confirmation the
  terminal alone can answer (`tests/control-center-smoke.ts`).
- A **slash-command contract** in `npm run verify`: duplicate command names, a command that shadows
  a prompt template or a pi built-in, and drift between an extension's `registers.commands` and its
  `pi.registerCommand` calls now fail the gate (`tests/command-contract-smoke.ts`). The two
  shadowed `orchestrate` prompt templates were removed, and command names in 17 manifests were
  normalised to bare names.
- A **tool-name check** in the distribution contract (`npm run verify` and
  `smoke:distribution-contract`): a shipped profile in which two extensions declare the same tool
  in `registers.tools` now fails the gate, because pi keeps only the first registration of a tool
  name. No shipped profile has one. `memory-local`, in no profile, still shares `memory_search`
  with `memory-vault`, and its summary now says not to load the two together
  (`tests/distribution-contract-smoke.ts`).
- A **curated `/` menu** in the TUI. The `/` menu now hides the kit commands that moved into the
  hub: only `/kit`, `/goal`, `/verify`, `/save`, `/remember`, `/effort`, `/profile`, `/update` and
  `/security` stay pinned, with `/autonomy` in autonomous, `/engagement` in pentest and
  self-improving, and `/improve` and `/review` in self-improving. pi's built-ins, prompt templates
  and skill commands are never hidden by default, and companion-package commands are hidden. A
  hidden command still runs when typed, comes back after four typed characters, and its suggestion
  says where it moved; `commandMenu`, `pinnedCommands` and `hiddenCommands` in
  `<agent dir>/pi-kit/ui.json` change the filter (`tests/command-menu-smoke.ts`).
- A **pre-push leak scan** for clones of the public repository. `node packages/core/prepush-scan.ts
  install` writes a git pre-push hook that scans every added line, commit message and author
  identity of the commits not yet on the remote for private host names, home-directory paths,
  private addresses and key or token shapes, and refuses commits that add files under `internal/`,
  `reviews/` or `examples/engagement/`; findings never print the value. The rules are shared with
  the export scan (`packages/core/lib/leak-scan.ts`), and the reviewed exact-line exceptions moved
  to the public `packages/core/leak-scan-exceptions.json` (`tests/prepush-scan-smoke.ts`).
- GitHub **issue and pull-request templates**, and `.github/CODEOWNERS` now also gives the owner
  `SECURITY.md`, the security, CI, release and topology documents, `.gitleaks.toml`, the starter
  policies, the profiles, the installer and uninstaller, `pentest-governance-domain` and the leak
  scan.
- **Per-model Memento opt-in and per-tier generation allowances.** Each effort tier now carries
  `memento.maxGenerations` (E1-E3 0, E4 2, E5 4, never above `memento.maxGenerationsCeiling` 8 or
  below the tier before it), checked the same way by both effort policy loaders. Memento mode is
  off for every model until `/effort memento on [provider/model] [--max N]` opts one in through a
  No-first select. The opt-in is written to `<agent dir>/pi-kit/autonomy.json` (0600, protected
  from agent writes). It is refused headless, in a child and outside the `long-horizon` and
  `autonomous` profiles. `/effort memento` shows the allowance: the tier's, lowered by the model's
  own limit, and pi-autonomy caps a run's generations to it (see "Generations capped by the Memento
  opt-in"). See `docs/effort.md`
  (`tests/memento-optin-smoke.ts`, `tests/effort-smoke.ts`, `tests/protected-paths-smoke.ts`).
- **Offline Memento eval.** `npm run eval:memento -- --results <file> --out <dir>`
  (`packages/core/eval/memento.ts`) scores a single-attempt arm against a generations arm on the
  same tasks at the same budget. A report over budget, malformed, or from an arm that throws counts
  as a failure. Each arm gets a Wilson 95% interval, and the verdict is `inconclusive` whenever the
  intervals overlap. It writes one new 0600 Markdown proposal and never changes the Memento opt-in
  or other configuration. The command line replays a recorded results file and runs no model. See
  `docs/efficiency-and-loops.md` (`tests/memento-eval-smoke.ts`).

### Security

- **A rewritten run script is trust-gated.** The `workflow` tool ran a script in a run directory this
  session created as the session's own by its run id alone, re-reading the file, so an agent that
  rewrote its run's `script.js` had a later `{scriptPath, resumeFromRunId}` call run the tampered
  script with no trust prompt. The tool now records the script's SHA-256 when it creates the run
  and skips the gate only when the run id and the file's digest both match; a rewritten script
  goes through the project trust gate (refused headless, No-first select attended). To iterate,
  pass the edited script inline with `resumeFromRunId`. See `docs/script-workflows.md`
  (`tests/workflow-notify-smoke.ts`).
- **Result-schema patterns cannot stall the root process.** `checkSchema` accepted any `pattern`
  that compiled, and the host tested it against child-model text synchronously, so `^(a+)+$`
  against 27 `a`s and a `!` took about half a second, doubling with each `a`. A `pattern` is now
  refused before launch when it is longer than 256 characters, has a backreference, or puts a
  repeating quantifier on a group that contains a quantifier or an alternation, or has more than 16
  choice points (quantifiers with differing minimum and maximum, and `|`), which bounds V8's
  uninterruptible compile (`a?` 50 times then `a` 50 times took about 5 s to compile). The
  validator (`packages/role-runner/src/schema.ts` and its subagent copy) fails a string over 65536
  characters without running the pattern and runs each match under a `node:vm` time limit (100 ms
  per test, 1 s per validation); the limit does not cover compilation. See
  `docs/structured-output.md` ("Pattern limits") (`tests/workflow-structured-smoke.ts`).
- **Workflow run grants are scoped to the checkout.** The action hash a workflow agent's console
  request carries (which groups prompts and keys run grants and sticky denials) now covers the
  resolved cwd and workspace root as well as the tool name and input, so a grant in one worktree
  no longer approves the same relative path or shell command in another. The audit log's
  `actionHash` is unchanged (`tests/firewall-workflow-approvals-smoke.ts`).
- **The console's safety pause is held for the operator.** When a workflow run passes 10 distinct
  approvals the console's pause can be lifted only by the operator (Yes in the console, or
  `/workflow resume <id>`); the agent's `workflow_control` resume is refused with a message saying
  so (`tests/workflow-control-smoke.ts`, `tests/firewall-workflow-approvals-smoke.ts`).
- **A recovery scout runs without a shell.** A subagent role counted as read-only when it had no
  `write`, `edit`, `subagent` or `notebook_edit` tool, so the built-in `scout` and `reviewer`, which
  have `bash`, were launched as read-only, including on the recovery budget that is open even at
  E1. When a subagent role or a conductor specialist is launched, only `read`, `grep`, `find` and
  `ls` now count as read tools, so a role or specialist with `bash`, `powershell` or an extension or
  MCP tool is not reported to delegation-guard as read-only (`tests/delegation-guard-smoke.ts`,
  `tests/conductor-specialist-bounds-smoke.ts`). A recovery launch of a subagent role with other
  tools is charged only on its read tools, and the child is started with just those
  (`--tools read,grep,find,ls` for the scout); a scout charged to the discretionary budget keeps
  `bash` (`tests/delegation-guard-smoke.ts`). A conductor specialist, which counted as read-only
  whenever it had no `write`, `edit` or `bash` tool, follows the same rule, so one with
  `powershell` or an MCP tool is no longer launched as read-only
  (`tests/conductor-specialist-bounds-smoke.ts`).
- **Tools no longer run scripts from the working directory.** `mem0_add` and `mem0_search` start the
  memory MCP server shipped with the kit, resolved from the extension's own location, instead of
  `packages/container/mcp-servers/memory-mcp/index.ts` under the current directory; a relative
  `PI_KIT_MEMORY_MCP_ARGS` script or `PI_KIT_MEMORY_MCP_COMMAND` path is refused
  (`tests/memory-mem0-smoke.ts`). `skill_score` runs the kit's own `packages/core/eval/run.ts`
  instead of the opened repository's (`tests/skill-archive-smoke.ts`). Either tool let a cloned
  repository run its own code with no approval prompt.
- **A project `.pi/auto-mode.json` can no longer turn automatic approvals on.** The legacy
  per-directory file now only downgrades (`{"enabled":false}` selects manual); `{"enabled":true}`
  is ignored, so a file committed to a cloned repository no longer skips the terminal-gated `/auto on`
  (`tests/firewall-gate-smoke.ts`).
- **`auto-commit-on-exit` is opt-in.** It ran `git add -A` and `git commit` with a model-written
  message on every session shutdown in the quick, balanced, long-horizon, autonomous,
  self-improving and pentest profiles, outside the firewall, so untracked secrets and other
  people's work-in-progress could land in history. It is now in no profile, `enabledByDefault:
  false` and `experimental` (like `secret-guard`); operators who want it add it
  (`extensions.add` in `overrides.json`, or a profile `include`). When it runs it stages with `<cwd>/.pi/` excluded, so save snapshots,
  compaction copies and audit logs are never committed (`tests/shutdown-hook-gating-smoke.ts`).
- **`/save` masks more secret shapes.** Snapshots and compaction copies now redact
  `Authorization: Bearer`/`Basic`/`token` values, `github_pat_` tokens and `user:pass@`
  credentials in URLs, using tool-capture's patterns (`tests/save-smoke.ts`).
- **Firewall redaction covers prefixed keys and inline passwords.** The redaction used for the
  firewall audit log, the feedback log and the judge's input now catches `DB_PASSWORD=...`,
  `GITLAB_TOKEN=...`, `AWS_SECRET_ACCESS_KEY=...`, `mysql -p<password>` and
  `curl -u user:password`, which were stored in plain text (`tests/firewall-gate-smoke.ts`).
- **Capture redact mode no longer stores text past the 4 MiB scan budget.** With
  `PI_KIT_CAPTURE_REDACT=1`, string data the scan did not reach was stored unredacted; it is now
  replaced with `[REDACTED:unscanned]`, and records in both modes carry `unscanned: true`
  (`tests/tool-capture-smoke.ts`).
- **`/auto on` asks even when the session is already automatic.** The terminal gate compared the
  effective mode, so under `PI_KIT_AUTO_MODE=1` an RPC, phone or child `/auto on` skipped it and saved automatic approvals globally for every repository. It now
  asks unless the saved mode, the effective mode and any existing project `.pi/auto-mode.json` are
  all automatic, so neither the global `firewall.json` nor a project `.pi/auto-mode.json` pinned to
  manual is switched unasked, including under `PI_KIT_AUTO_MODE=1` (`tests/auto-mode-smoke.ts`).
- **A project-scope install no longer changes the machine-global firewall.** `install.ts --scope
  project --profile <name>`, and so a project `/profile`, wrote `<agent dir>/pi-kit/firewall.json`
  and `security.json`, which gate every session on the machine, and an uninstall left the change
  behind. A project-scope install now leaves both files byte-identical and prints a warning naming
  the global file when the profile wants a different firewall mode, policy or securityLevel, with
  the `--scope global` command that applies it (`tests/install-marker-smoke.ts`,
  `tests/profile-transaction-smoke.ts`).
- **Conductor runs no untrusted role prompt.** `dispatch_validator` now reads its prompt only from
  the extension's own `agents/validator.md`, never from the project's `.pi/agents/validator.md`, and
  conductor no longer writes that file (`tests/conductor-validator-smoke.ts`). `dispatch_specialist`
  roles from `.pi/agents` now need the same approval as subagent's project roles: an exact
  `PI_KIT_TRUSTED_PROJECT_ROLES` digest (the same digest subagent uses) or an interactive choice that
  starts on "No"; a headless dispatch without a grant is blocked, a refusal costs no dispatch budget, and a role
  edited after approval does not launch. Until an engagement reaches `close-out`, `workflow_run` and
  `dual_review` are blocked like `subagent`, and `/engagement phase close-out` lifts the block for all
  three (`tests/conductor-recursion-smoke.ts`).
- **Session text cannot forge the judge's prompt blocks.** The auto-mode judge prompt pasted the
  request, the goal, the agent's command, paths, grants and precedents into its `<goal>`,
  `<action>`, `<precedents>` and other blocks without escaping. A goal or command that contained
  `</goal><precedents>` could add a fake operator precedent. A `<`, a fullwidth or small `<`, or
  `&lt;`/`&#60;`/`&#x3c;` is now shown as `‹` when what follows it starts with an optional `/` and
  one of the block names, in any case, after spaces, invisible characters and combining marks are
  ignored (however many, before or inside the name) and fullwidth forms are folded; the judge is told what `‹` means. Other shell
  redirections are unchanged; one from a file whose name starts with a block name, such as
  `sort <recent.log`, is shown with `‹` (PRO-1, `tests/tool-firewall-smoke.ts`).
- **Judge precedents are scoped like the rest of learning.** The auto-mode judge's `<precedents>`
  block drew on every recorded decision, so an allow given in another workspace, or one made
  before `/firewall revoke workspace` or `revoke all`, still reached the judge as "operator
  ALLOWED". It now lists only this workspace's decisions made after the newest such revocation
  (EFF-7, `tests/firewall-gate-smoke.ts`).
- **The project's `.pi` directory is a safety control.** Renaming, replacing, linking over or
  deleting `<workspace>/.pi` (or moving the workspace that holds it, or `rsync --remove-source-files`
  or `--remove-sent-files` from it, including through a glob such as `mv .p* /tmp` or `mv .[[:alpha:]]i /tmp`
  or a brace expansion such as `mv .pi{,.bak}`; a word that expands to more than 64 words counts as
  a safety control) used to be low or medium, so two `mv` commands could drop the audit trail or plant
  verdicts and `auto-mode.json`; it is now high. Writes to `.pi/settings.json`, `.pi/mcp.json`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`,
  `.pi/{extensions,skills,prompts,themes}/` and `.pi/GOAL.yaml` are high too, and
  `protected-paths` blocks tool writes to `.pi/GOAL.yaml`, so only `/goal` sets the goal the judge
  trusts (`tests/firewall-shell-smoke.ts`, `tests/protected-paths-smoke.ts`).
- **Lowering oversight starts on "No".** pi's confirm dialog starts on "Yes", so the `/security`
  weakening confirmation and the control centre's weakening rows now ask with a two-option choice
  whose first option keeps things as they are. Typed `/auto on` now asks the same way at the
  terminal when approvals are manual, and is refused over RPC, headless and in child sessions
  (`PI_KIT_AUTO_MODE=1` remains for scripted runs); the hub's Approvals row no longer asks twice
  (`tests/auto-mode-smoke.ts`, `tests/security-level-smoke.ts`, `tests/control-center-smoke.ts`).
- **Profile security defaults.** `quick` and `lite` now install the relaxed security level,
  `pentest` keeps guarded and every other profile keeps balanced. Relaxed still behaves like
  balanced. A `/profile` switch that would lower the level in force now asks at the terminal,
  with "No" as the first choice, and is refused without an interactive root terminal; an
  operator-chosen level is never lowered by a switch (`tests/profile-command-smoke.ts`,
  `tests/profile-transaction-smoke.ts`, `tests/security-level-smoke.ts`).
- **pi-lens write targets are checked as writes.** `lsp_navigation`'s `rename_file` destination
  (`newFilePath`) was not checked at all, and the paths of `ast_grep_replace` and
  `lens_diagnostic_mark` were checked only as reads, so a rename or replacement onto
  `~/.ssh/authorized_keys` or a git hook carried no persistence finding and shared the action
  family of a benign call. Both are now assessed as writes, also when the call carries a
  `command` field, which is still shell-classified (`tests/firewall-shell-smoke.ts`).
- **pi-lens 4 tools have exact firewall decisions.** Analysis/configuration helpers and tool
  activation are allowed; diagnostic marking asks because it can write suppression comments.
  All 13 registered pi tools are pinned through the real gate, with credential paths blocked.
  The new `lens_diagnostics.analysisRoot` field joins the path checks, and `read_symbol.kind`
  is covered by the read adapter (`tests/tool-firewall-smoke.ts`,
  `tests/firewall-shell-smoke.ts`).
- **Companion downloads are off by default.** pi-lens installs missing tools from npm "latest"
  or GitHub releases inside the pi process, outside the pinned supply chain. The tool firewall
  now sets `PI_LENS_DISABLE_LSP_INSTALL=1` and `PI_LENS_DISABLE_TOOL_INSTALL=1` unless the
  operator set them to exactly `0`, which opts back in; any other value (empty, `true`, `yes`) is
  set to `1`, since pi-lens disables only on exactly `1`. pi-lens 4.4.4 honours both switches,
  including managed refreshes; missing grammar downloads have a separate trust gate and remain a
  limitation (`tests/tool-firewall-smoke.ts`, `docs/supply-chain.md`).
- **An allowed tool's path arrays are checked for credential reads.** The firewall checked only a
  single `path`, `file_path` or `filePath` of a tool the policy allows. pi-lens's
  `ast_grep_search`, `ast_grep_outline` and `lsp_diagnostics` take a `paths` array, so
  `~/.ssh/id_rsa` in that array ran as a routine read. Every path-like field is now checked:
  `file`, `files`, `paths`, `cwd`, `dir`, `directory` and `root` as well
  (`tests/firewall-shell-smoke.ts`).
- **Adjustable security level.** `/security` selects relaxed, balanced, guarded or strict, with
  profile defaults, strengthening-only floors, a terminal-only confirmation for weakening, a
  read-only registry and a footer chip. Strict pins operator approvals and denies unknown external
  tools; guarded disables learned/similarity authority. Changes revoke session grants and judge
  caches and re-evaluate pending approvals. Off remains locked; relaxed currently equals balanced;
  proposal checks are explicitly unavailable (`tests/security-level-smoke.ts`).
- **A `.git` in a shared temp root no longer widens the firewall's workspace.** An empty
  `/tmp/.git`, which some sandboxes create, made `/tmp` the workspace for every session started
  below it. Paths anywhere under `/tmp` then classified as inside the workspace, and approvals were
  scoped to all of it. Temp roots are now excluded the way the home directory and `/` already were
  (`tests/workspace-root-smoke.ts`).
- **Tool identity policy precedes permission.** Exact, case-sensitive pi identities and explicit
  policy entries grant tool authority; recognised aliases and read-like external names do not.
  Explicit deny/ask applies to every adapter, incomplete schemas require an operator, and allow
  cannot lower critical effects. Unknown/ask/incomplete calls cannot learn broader authority.
  Codemode scripts ask; nested calls are checked independently of parent approval. Reviewed kit
  and companion helpers have explicit entries; companion multi-target mutation tools ask.
  Pinned by `tests/firewall-shell-smoke.ts`, `tests/firewall-gate-smoke.ts`,
  `tests/tool-firewall-smoke.ts` and `tests/firewall-unattended-smoke.ts`.
- **Invalid firewall policy denies all calls until repaired.** Invalid files or individual rules
  cannot silently discard restrictions. Content digests detect same-mtime changes, and pending
  approvals re-evaluate changed policies before allowing or storing a grant
  (`tests/firewall-policy-warnings-smoke.ts`, `tests/firewall-gate-smoke.ts`). Exact tool names
  still cannot bind implementations, and in-process extension code is not isolated; see the
  security model for the limitation.
- **Private modes for the agent `.env` and the firewall's logs.** The installer now scaffolds
  `<agent dir>/.env` with mode 0600 instead of copying the template's 0644. The firewall creates
  `firewall-feedback.jsonl`, `firewall-judgements.jsonl`, `firewall-profile.json`, each
  `firewall-sessions/<id>.json` and its audit log 0600, and the directories it creates for its
  state (`pi-kit/`, `firewall-sessions/`) 0700. Modes are set on create only, and existing files
  and directories are not chmodded. Files the firewall rewrites atomically (session files,
  `firewall-profile.json`, and `firewall-feedback.jsonl` after `/auto forget`) come back 0600
  (`tests/install-marker-smoke.ts`, `tests/tool-firewall-smoke.ts`).
- **Memory vault projects are keyed by canonical root.** Two repositories with the same
  directory name shared one `Projects/<name>/` folder, so a session in one was injected with the
  other's recaps and memories. Each project folder now records the canonical (symlink-resolved)
  root that owns it in `.pi-project.json`; the first root to open a name keeps the plain folder,
  including one written before ownership was recorded, and any other root with that name gets
  `<name>-<hash>`. Nothing is moved or deleted. A symlinked root uses the folder its canonical
  path already owns, whichever path opened it first; a moved root whose old owner path is gone
  gets a hashed folder plus a warning naming the record to edit (`tests/memory-vault-smoke.ts`).
- **Auto-promoted recap preferences stay in their project.** A preference the recap model
  flagged was saved with global scope and recalled in every project without confirmation; it
  is now saved to the current project like decisions and gotchas
  (`tests/memory-vault-smoke.ts`).
- **The container's `pi-agent` fails closed.** It used to discard the errors from `pi install`
  and the profile apply, print one warning, and start pi without the kit's guards; with no kit
  mounted it started pi with no warning at all. It now prints the error, does not start pi, and
  exits non-zero when no kit is found or either step fails; `PI_AGENT_ALLOW_UNGOVERNED=1` starts
  pi anyway with a warning (`tests/container-static-smoke.ts`).
- **branch-lab discards and merges.** `branch_discard` refuses a worktree with uncommitted changes
  or a branch with commits not merged into `HEAD` unless `force: true` is passed, and both shipped
  firewall policy copies now pin `branch_discard` to `ask`, so every discard needs operator
  approval. `branch_merge` accepts only the `ort`, `recursive`, `resolve`, `ours` or `subtree`
  strategy. Worktrees now live under `pi-branch-lab/<repo key>/<taskId>`, keyed by a hash of the
  repository top level, so two repositories can lease the same task id, and session start drops
  leases whose worktree is gone while keeping their branches (CRT-5, CRT-7, ORC-8;
  `tests/branch-lab-smoke.ts`).
- **`/improve arm` applies the proposal that was reviewed.** It no longer mines the trace again:
  `/improve` stores each proposal's notes with a hash next to the reviewed
  `.pi/self-improvement/proposal-<timestamp>.md`, and `/improve arm <id>` (or, with no id, the
  lexically last exact-stamp id) applies exactly those notes. It refuses a record whose notes
  are not `buildProposal` templates or do not match the hash in the `.md` (a consistency
  check, not authorship proof). `PI_KIT_SELF_IMPROVE_ARM=1` was removed, since it applied every newly mined
  proposal unseen. Only path-like trace targets become notes, so a grep pattern or command can
  no longer add lines or headings to `AGENTS.md` (`tests/self-improvement-smoke.ts`).
- **Malformed tool arguments and state files are checked, not cast** (SEC-9, CR-6, TOO-9).
  `protected-paths` blocks a `write`/`edit` whose `path`, or a `bash` call whose `command`, `cmd`
  or `script`, is present (not null) but not a string. `secret-guard` blocks any tool call with a
  truthy non-string `path` or `file`, and a `bash` call with a truthy non-string `command`, `cmd`
  or `script`. The reason names the field (`<guard>: blocked <tool>: <field> is not a string`);
  a non-string path used to make either hook throw an opaque error. Loading the firewall's session file
  keeps only numeric `stats` counters and `judgeCache` entries shaped like a judge verdict, and
  keeps only the `credentialReads` rows with a string `what` and a numeric `at` (one malformed row
  no longer drops the others, so a later send is still `secret_egress`). session-helpers refuses an array
  `settings.json` when toggling compaction instead of leaving it silently unchanged, replaces an
  array `trigger-compact.json` so turning the trigger off takes effect, and ignores install-marker
  fields of the wrong type, so a numeric `kitSource` no longer makes `findKitRoot` throw
  (`tests/untrusted-input-guards-smoke.ts`).

### Changed

- **GitHub is the authoritative repository.** The README, `CONTRIBUTING.md`, `AGENTS.md`,
  `CLAUDE.md`, `docs/repository-topology.md`, `docs/releasing.md` and `docs/ci-security.md` now
  describe development by pull request on `SATUNIX/pi-system` with one required approval, releases
  tagged there, a non-admin agent identity, and a read-only GitLab mirror as backup. `npm run new`
  prints the release-manifest step only in a checkout that has the manifest, so the public tree
  gets no step naming a file it lacks (`tests/new-extension-smoke.ts`).
- **pi-lens is pinned to 4.4.4, from 3.8.63.** The static package review records the tool,
  command and hook diff, native dependencies, lifecycle scripts, corrected peer-dependency
  warning and runtime download limits in `docs/supply-chain.md`. The balanced profile selects
  the whole companion; the old claim that it filtered pi-lens tools was incorrect. In a real pi
  1.3.0 terminal it loads without pi's peer-dependency warning (`tests/tool-firewall-smoke.ts`,
  `tests/firewall-shell-smoke.ts`).
- **The kit also recognises itself as `@satunix/luna`.** Duplicate-registration cleanup,
  `/update`, `/profile` and the remote console's version lookup accept the package name
  `@satunix/luna` and the repository `github.com/SATUNIX/luna`, as well as every pi-system form
  they accepted before. Other repositories named `luna`, and the unrelated npm package `luna`, are
  left alone. A new `git.previousSources` list in `distribution.json`, empty for now, names former
  public sources: `/update kit` moves an install registered from one to the current `git.source`,
  keeping its channel, profile and project scope (`tests/install-profile-filter-smoke.ts`,
  `tests/kit-update-smoke.ts`, `tests/profile-command-smoke.ts`, `tests/remote-host-smoke.ts`,
  `tests/distribution-smoke.ts`).
- **`/update` keeps pi within the version the kit is tested with.** It used to offer every new
  pi release, including ones past the version the installed pi-system release is tested with.
  Now a newer pi is reported in `/update status` with the tested version, and `/update pi` and
  `/update all` leave pi alone and say why. `pi update --self` cannot stop at the tested version,
  so going further is your call (`tests/kit-update-smoke.ts`).
- **pi 1.3.0 is the tested version.** The suite is pinned to pi 1.3.0 (from 0.87.1), and CI runs
  the whole suite at the 0.85.1 floor and at 0.99.2, the last 0.x release; both must pass. Since
  pi 1.2, `before_agent_start` also fires for runs an extension starts with a custom message; the
  firewall, memory recall and skill routing read the prompt only from a user prompt, so an
  extension's message never stands in for the operator's request. Two firewall smokes now find
  pi's agent loop whether npm nests it (pi 0.x) or hoists it (pi 1.x), and the output-cap check
  compares against pi-ai's own token estimate, whose characters-per-token ratio changed in 1.x.
- **The test suite is TypeScript.** Every `tests/*.mjs` smoke is now a strictly typed `.ts`
  file run directly by Node's type stripping (Node >=22.18, already required), as are the
  private public-release scripts. A shared `tsconfig.base.json` holds the strict settings, and
  the new `test:typecheck` check runs `tsc` over the extensions and the tests in `check:all`, so
  type errors now fail CI. Test behaviour is unchanged.
- **The extensions pass a type-aware linter and stricter compiler settings.** ESLint with
  typescript-eslint (`strictTypeChecked`, plus bans on shell spawning, `exec`, `vm`, `eval` and
  HTML string sinks) now runs in `check:all` as `test:lint`, over the extensions, the tests and
  the release scripts. The extensions are checked with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride` and `noImplicitReturns`. Explicit `any` in
  the extensions went from 184 to 0: pi's own types are used for `ctx` and events, and data from
  files, the network, child processes and models is read as `unknown` and checked.
- **The installer, verifier and autonomy runner are TypeScript.** Every `.mjs` file in
  `packages/core` and `packages/autonomy` is now strict `.ts`, run directly by Node's type
  stripping (internal/docs/adr/0001). Commands keep working under their old names where users
  call them: `packages/core/install.mjs` stays as a shim that starts `install.ts`. JSON from
  files, containers, models and the command line is checked by small dependency-free schemas
  (`packages/core/lib/guard.ts`) before it is used. Output, flags and exit codes are unchanged.
- **The npm package is compiled.** `npm run build:npm` stages the published package in
  `dist/npm/` with the Node-run TypeScript compiled to JavaScript (Node does not strip types
  under `node_modules`); extensions stay TypeScript for pi's loader. The release workflow
  publishes the stage, and `smoke:package` / `smoke:clean-install` install it under
  `node_modules` to prove it runs.
- **The web console server, the MCP servers and the role-runner are TypeScript.** The console
  server (`packages/web-ui/server`, including the remote-control host), its installer and
  scripts, the governance and memory MCP servers and the role-runner are strict `.ts`. Request
  bodies, phone and bridge messages, pi child output and state files are checked before use,
  and a field of the wrong type is refused instead of converted. MCP configs that name
  `mcp-servers/*/index.js` keep working (a one-line shim starts `index.ts`); new configs name
  `index.ts`. The npm package compiles the console server like the installer.
- **The console's browser code is TypeScript.** The web console and the phone app's scripts are
  strict `.ts` under `packages/web-ui/src/`, compiled by `npm run build:web` into the
  `public/js`, `mobile/js` and `mobile/dev` files that are served (internal/docs/adr/0002). The
  compiled files stay committed, so serving, the Android build and installs need no build step;
  `smoke:web-build` fails if they drift from their sources. Server replies are typed from the
  server's own definitions, and a compile-time check keeps the two in step.
- **TypeScript is the standard, and a check keeps it that way.** The tests now meet the same
  strict compiler settings and lint rules as the code they test (no `any`, no unchecked casts).
  `smoke:typescript-coverage` fails if JavaScript source comes back outside a short list of
  shims and generated files, if a `.ts` file sits outside every type-checked project or the lint
  rules, or if an `eslint-disable` lacks a reason or pushes the count above its ceiling.
  CONTRIBUTING.md describes the standard.

### Fixed

- **`skill_archive` no longer deletes an earlier archive of the same name.** It removed an
  existing `.pi/skill-archive/<name>` before moving the new skill there, although the model is told
  the move is non-destructive. A repeat archive now goes to `.pi/skill-archive/<name>-<epoch ms>`
  and the earlier copy is kept (`tests/skill-archive-smoke.ts`).
- **Workflow review gates need a final `VERDICT: PASS` line.** The shipped `feature` and
  `bugfix` gates matched `## Verdict` followed by `PASS` anywhere in the reviewer's reply, so a
  reviewer echoing its template (`PASS or FAIL`), writing `Passing tests are missing, so: FAIL`,
  or quoting a `PASS` from the implementer's report passed the gate on a failing review. They
  now pass only when the last non-blank line is `VERDICT: PASS` (case is ignored), and the
  reviewer role and both review tasks ask for that line. Any other ending fails the gate.
  Checked by `tests/workflow-smoke.ts` (`npm run smoke:workflow`).
- **Kit prompt templates keep the text typed after them.** None of the 23 kit templates had an
  argument placeholder, so pi dropped `add retry to fetchUser` from `/code-plan add retry to
  fetchUser`. Each template now declares `argument-hint` and passes its arguments through
  `${@:-default}`, with a default such as "the current task" when none are given
  (`tests/prompt-arguments-smoke.ts`).
- **Lite and the kit prompts no longer point the model at tools it cannot reach.** Lite hid 9 of
  its 12 allowlisted skills from the system prompt without loading `skill-router`, the only way
  to find them; it now loads `skill-router`, and drops the `memory` skill because it loads no
  memory extension to provide `memory_save`. `/code-compact` and `/agent-checkpoint` now call the
  `pi_system_governance` MCP tools only when that server is available, and the `mcp-tool-use`
  skill no longer says direct pi tools are unavailable outside the `pentest` profile's MCP-only
  mode (`tests/prompt-arguments-smoke.ts`).
- **A loop inside one run is nudged inside that run.** progress-guard wrote its loop nudge and
  the review/delegate checkpoint only as a `context-sieve` contribution, which is read when the
  next prompt starts, so a model looping inside one long run never saw either until the run
  ended. `turn_end` now also returns the guidance as a hidden `custom_message` entry, which pi
  appends after that turn's tool results, so the next model request of the same run carries it:
  the light nudge in `auto` mode once per cooldown, and the checkpoint on the episode's first
  escalation and then once per cooldown. The contribution is still written for the next prompt
  (`tests/progress-guard-agsix-smoke.ts`).
- **context-sieve deduplicates the hidden message per contribution.** It compared the whole
  joined message-channel text with the last one injected, so a change to one contribution (the
  orchestrator directive's complexity score, say) injected every unchanged contribution again.
  Each contribution is now compared with its own last injected text; only new or changed ones
  are injected, the unchanged ones are named in one line, and a contribution that disappears is
  injected again if it returns. `sieve-budget.json` lists the injected ids under
  `message.injected` (`tests/context-budget-smoke.ts`).
- **Per-workspace logs are bounded.** trace-ledger renames `.pi/trace.jsonl`, and tool-firewall
  renames its audit log (`.pi/tool-firewall-audit.jsonl` or `PI_KIT_FIREWALL_AUDIT_LOG`), to a
  `.1` copy before the next append once the file passes 4 MiB, replacing the previous `.1`; the
  file is never truncated. Trace records now carry `retention: "append-only/rotated-at-4MiB"`.
  protected-paths blocks writes to both `.1` copies, and secret-guard also blocks writes to
  `<PI_KIT_FIREWALL_AUDIT_LOG>.1`. recovery-orchestrator reads only the last
  256 KiB of `.pi/trace.jsonl` for its report, and the end of `.pi/trace.jsonl.1` when the live
  file holds fewer than its 30 entries, instead of the whole file
  (`tests/trace-ledger-bound-smoke.ts`, `tests/firewall-outcomes-smoke.ts`,
  `tests/protected-paths-smoke.ts`, `tests/secret-guard-smoke.ts`, `tests/recovery-grounding-smoke.ts`).
- **A freshly scaffolded extension passes `npm run verify`.** The `_template` now declares
  `"profiles": []` instead of `["balanced"]`, which no profile includes, and `npm run new` runs
  `npm run catalog` after copying it. It prints the real path
  (`packages/extensions/src/<name>/`) and a checklist: profile membership, the new files for
  `internal/public-release/manifest.json`, `npm run catalog` after editing, then `npm run verify`
  (`tests/new-extension-smoke.ts`).
- **`check-all --skip` rejects a name that is not a check.** A misspelt name used to be ignored,
  so the whole gate ran; it now exits 2 and names the unknown entries. The aggregates check-all
  already drops, such as `test:security`, are still accepted (`tests/check-all-npm-smoke.ts`).
  The `docs-nav-check.ts` header no longer lists a fourth "reachable doc is parseable" check that
  it never ran.
- **The control centre's profile rows are pinned to the profile files.** A test now checks that
  the hub lists exactly the profiles in `packages/kit/profiles/`, and that a row is `weakening`
  and labelled "(auto approvals)" exactly when that profile's `firewall.mode` is `auto`
  (`tests/control-center-smoke.ts`).
- **Docs no longer describe behaviour the code lacks.** The recovery page offered `/unstuck`
  and `PI_KIT_RECOVERY_THRESHOLD`, neither of which exists; it now names only the progress-guard
  escalation and `/recover`, and its open design questions moved to Future work. secret-guard's
  source header and manifest summary called it universal and in every profile, and its README
  said reads were not blocked and named constants that do not exist; they now say it ships in no
  profile, list the reads it blocks, and name `tests/secret-guard-smoke.ts`. custom-compaction's
  SOURCE.md claimed it applies a compaction template; it now says plainly that the extension is a
  no-op that only warns. The web console README and page no longer say "no build step" (browser
  code is compiled by `npm run build:web`), no longer tell users to `cd pi-console`, name the
  console's real agent directories, and say the New session picker lists only `models.json`
  providers. The control centre's main page holds five pages, not four. pi loads only the first
  of `AGENTS.md` and `CLAUDE.md`, so a pi agent developing this repository never saw
  `CLAUDE.md`'s rules; `AGENTS.md` now carries the test-isolation, TypeScript, scope and release
  rules (`tests/docs-smoke.ts`).
- **A profile switch's lowering prompt uses the firewall's timeout.** The `/profile` check that
  asks before lowering security read `PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS` with its own rule, so a
  value below 1 (such as `0.5`) closed the prompt at once where the firewall falls back to 15
  minutes, and a fractional value was not rounded down. It now parses the value as the firewall
  does, `/security` and `/auto on` share one exported root-terminal check, and a parity test pins
  session-helpers' copies of the level list, security file path, root-terminal check and prompt
  timeout equal to the firewall's (`tests/security-level-smoke.ts`).
- **Validator, specialist and dual-review children get their task over stdin.** conductor put
  the validator's evidence bundle and a specialist's task on the child's argv, so a task over
  Linux's 128 KiB single-argument limit failed every dispatch with `spawn E2BIG`, and argv is
  readable by any local user through `ps`; dual-review put its prompt and diff there too. All three
  now write it to the child's stdin, which print mode merges into the prompt, as subagent does
  (`tests/conductor-validator-smoke.ts`, `tests/conductor-recursion-smoke.ts`,
  `tests/dual-review-smoke.ts`).
- **A crashed implementer's task-graph claim expires, and the graph can be cleared.** `task_next`
  marked a task `in_progress` with no time, so an implementer killed by its bounds held the task
  forever and its dependants never became unblocked. A claim now records `claimedAt`, any
  `task_update` of an `in_progress` task renews it, and `task_next` returns a claim older than
  `PI_KIT_TASK_GRAPH_LEASE_MS` (default one hour, `0` disables expiry) to `pending` and says so.
  The new `task_clear` tool (allowed by the shipped firewall policy) removes every task, so a new
  mission in the same project no longer inherits the last one's tasks
  (`tests/task-graph-invariants-smoke.ts`, `tests/tool-firewall-smoke.ts`).
- **The web console's user agents are the subagent tool's user agents.** The console read and
  wrote user agents in `~/.pi/agents`, which the subagent tool never reads; it now uses
  `<agent dir>/agents` (`~/.pi/agent/agents` unless `PI_CODING_AGENT_DIR` moves it), so an agent
  made in the console can be delegated to (`tests/web-ui-api-smoke.ts`).
- **Doctor compares companions with the settings.json of the marker's scope.** A global install
  opened in a project with its own `.pi/settings.json` was compared with that project file and
  reported its companions as not registered. Doctor now marks a drift line with `! `, shows the
  firewall's security level, the Help page and the `/kit` description name the configured
  `hubKey`, and the Thinking row offers `off` (`tests/control-center-smoke.ts`).
- **`npm run install:web` no longer claims to add `/console` to a profile without it.** For a
  `quick` or `lite` install it reinstalled the same profile, still without `web-console`, and then
  said `/console` would work. It now leaves such an install alone, names the profiles that include
  `web-console`, suggests switching to `balanced` with the install's own `--scope` (and git ref), and does not offer `/console`; when
  `overrides.json` also lists `web-console` in `extensions.remove`, it says that entry must be
  removed as well. For a profile that includes `web-console` but whose `extensions.remove` drops
  it, it names that entry as the cause instead (`tests/web-ui-install-smoke.ts`).
- **Malformed config, ledger and stream data no longer throw inside the kit's readers.** Each of
  these cast parsed JSON to a typed shape and then used a field of the wrong type. A routing
  policy naming its models with non-strings is now refused at load instead of throwing from
  `before_agent_start` on every prompt (`tests/model-routing-smoke.ts`); a `.pi/trace.jsonl`
  line with no string `tool`, a non-string `target` or an unknown `kind` is counted as corrupt by
  `/trace` instead of throwing (`tests/trace-ledger-bound-smoke.ts`); an effort policy tier with
  no `aliases` loads with none, so `normalizeTier` no longer throws, and non-string aliases or a
  missing `label` are refused (`tests/effort-smoke.ts`); spec-plan counts a non-string `content`
  as no lines and lets a call with a non-string `path` or no input through instead of blocking it
  with a TypeError (`tests/spec-plan-smoke.ts`); a mem0 search response with a null entry or a
  non-list `results` is shown or treated as no results (`tests/memory-mem0-smoke.ts`); and a
  specialist or validator child message with a non-array `content` or a null part is skipped when
  the final assistant text is read (`tests/conductor-specialist-bounds-smoke.ts`).
- **Untrusted JSON is checked instead of cast in the remaining readers.** task-graph rebuilds each
  task on load: an unknown status becomes `blocked`, non-string dependencies are dropped and a
  non-string title falls back to the id (`tests/task-graph-invariants-smoke.ts`). conductor drops
  engagement history entries of the wrong shape (`tests/conductor-engagement-smoke.ts`).
  recovery-orchestrator, self-improvement and skill-forge drop trace fields of the wrong type, so
  an object `tool` no longer reaches a recovery report as `[object Object]` and a numeric target
  no longer becomes a learned note (`tests/recovery-grounding-smoke.ts`,
  `tests/self-improvement-smoke.ts`, `tests/skill-archive-smoke.ts`). The public-release export and
  publish scripts check the manifest, `package.json` and the GitHub API responses with
  `packages/core/lib/guard.ts` schemas, so a `package.json` that is not an object fails the
  metadata check rather than throwing (`tests/public-export-smoke.ts`). autonomous-loop,
  progress-guard, delegation-guard, verify-gate, web-console, control-center, session-helpers,
  caveman, custom-footer, subagent and trigger-compact read their files and event data as
  `unknown` with no change in behaviour (nothing pins those beyond their existing smokes).
- **The lint gate refuses a cast of `JSON.parse` output or of an awaited `.json()` body** outside
  `tests/`, other than `as unknown` and a `JSON.stringify` round trip of the program's own value
  (`eslint.config.ts`, `tests/typescript-coverage-smoke.ts`). It sees the direct form only: a
  value first bound to a variable and cast later is left to review.
- **Secret redaction no longer stalls on long identifier runs.** tool-capture's
  `password_assignment` and `url_credentials` patterns and trace-ledger's target redaction
  backtracked quadratically or worse: 14 KB of a repeated `x_token` froze the agent for about
  6 s per tool result, and a 12 KB command for about 30 s before and after the call. The
  patterns are now linear, and trace-ledger redacts only the first 1 KiB of a target, of which
  200 characters are stored; 200 KB of adversarial text now takes well under 200 ms
  (`tests/tool-capture-smoke.ts`, `tests/trace-ledger-bound-smoke.ts`).
- **An autonomous loop stops on Esc, on a provider error, and when the model says it is done.**
  `/loop` re-queued `Continue: <goal>` after an aborted or errored turn, so Esc left a hidden
  Continue queued and a failing provider spent every remaining iteration back to back. Its steer
  also told the model to run `/loop stop`, an operator-only command, so the model could not end
  the loop. An aborted or errored turn now disarms the loop with a warning, and the new
  `loop_complete` tool (allowed by the shipped firewall policy) lets the model end it; the steer
  names the tool (`tests/liveness-containment-smoke.ts`, `tests/tool-firewall-smoke.ts`).
- **Recovery no longer caps out on resolved stalls, and its steer names only tools.**
  progress-guard escalates every read stall as `stall`, and recovery-orchestrator never reset
  its per-signature attempt count, so the third resolved stall in a process went straight to
  "blocked" and stopped the autonomous loop. A successful write or edit to a named file outside
  `.pi/` now resets the count; filling in the recovery report does not, so the cap still holds
  when the model follows the steer, and each entry gets its own report file.
  The recovery steer asked the model for `/fork`, `/verify` and a `git-checkpoint` call it cannot
  make; it now uses the `subagent` and `verify_completion` tools and leaves forking to the
  operator (`tests/recovery-grounding-smoke.ts`).
- **The container entrypoint seeds the directory pi reads.** It copied `settings.json`,
  `mcp.json` and `models.json` into `$HOME/.pi/agent`, but the compose files set
  `PI_CODING_AGENT_DIR`, which pi reads instead, so pi started without the seeded provider,
  models or MCP config. It now seeds `PI_CODING_AGENT_DIR` (`tests/container-static-smoke.ts`).
- **The container health check no longer needs a server.** `healthcheck.py --check` queried a
  `/health` server that nothing started, so the container never became healthy. `--check` is now
  a local probe that the data root is writable; `--serve` stays opt-in and binds `127.0.0.1`
  unless `PI_AGENT_HEALTH_HOST` is set, and the compose files no longer set it to `0.0.0.0`
  (`tests/container-static-smoke.ts`).
- **Two autonomy supervisors can no longer both take over one stale run lock.** The takeover
  judged the lock stale and then moved it aside, so a second supervisor that had judged the same
  stale lock could move the first one's new lock aside and both held the run. A taker now needs an
  exclusive claim file for that lock, moves it only if it is still the same file, and puts back a
  newer lock moved by mistake; a claim left by a crashed taker is cleared once older than the stale
  threshold (`tests/autonomy-lifecycle-smoke.ts`).
- **A rolled-back `/profile` switch no longer says "Nothing was changed" after package
  operations.** The rollback restores configuration files only; a `pi install` the installer had
  already run is now named as not rolled back, in the installer's own message and in `/profile`'s
  (`tests/profile-safety-smoke.ts`, `tests/profile-transaction-smoke.ts`). Under `--settings-only`
  the `pi remove` of a retired or previous kit registration now runs after the run commits, while
  settings.json still lists it, so the installer's own rollback can no longer restore a settings
  entry whose clone was deleted. `/profile` passes the new `--no-migrate`, which stops before any
  change instead of moving the kit's source and names `/update kit` and the Migration guide, so
  its rollback cannot restore one either (`tests/distribution-smoke.ts`,
  `tests/profile-transaction-smoke.ts`).
- **`/update` names a mixed state when it stops after replacing the kit.** A failure between the
  kit step and the profile re-apply used to say only "run /update again", which then found nothing
  to do. The message now says the new kit runs with the previous profile's settings, gives the
  version or commit before with the command that goes back to it where one exists, and prints the
  installer command that re-applies the profile (`tests/kit-update-smoke.ts`).
- **The role-runner result always carries the harness run_id.** `normalizeResult` kept a
  `run_id` the model put in its output, so a result could name a different run; it now always
  sets the harness's own run id (`tests/role-runner-smoke.ts`).
- **The judge prompt stays bounded for long scripts.** The command was clipped to 4000
  characters, but every parsed step and finding was listed, so a 400-line script gave a judge
  prompt of about 61,000 characters. Steps and findings are now each capped at 30 lines and 4000
  characters, riskier lines first, with a `(+N more ...)` line; the same script now gives about
  8,500 characters. A step's location is clipped to 200 characters like its text, and a line that
  would pass the budget is skipped instead of ending the list, so one step with a very long host
  name no longer hides the others (EFF-3, `tests/tool-firewall-smoke.ts`).
- **`install.ts --only` keeps the required base.** `--only` used the named extensions verbatim, so
  the documented `--only secret-guard,memory-local,verify-gate` example loaded no `tool-firewall`
  or `protected-paths`, without a warning. It now adds every missing extension from
  `requiredProfileExtensions` in `packages/core/distribution.json` and warns about each one; the
  INSTALL.md example no longer names the experimental `secret-guard` (`tests/install-marker-smoke.ts`).
- **The installer rejects unknown flags.** A typo such as `--profle pentest` was ignored and ran a
  default balanced install. An unknown argument, or a value flag with no value, now exits 1 with a
  usage line. INSTALL.md no longer says `--yes` skips a confirmation: the installer never prompts
  (`tests/install-marker-smoke.ts`).
- **Uninstall leaves companions you registered yourself.** The install marker recorded every
  selected companion, including one already registered at the kit's pin before the install, so
  uninstall removed it. Only the companions the run installs are recorded now; ones a previous
  marker recorded are still carried (`tests/install-marker-smoke.ts`).
- **`overrides.json` can no longer remove a required extension.** Only `tool-firewall`,
  `secret-guard` and `protected-paths` were refused; a removal of `delegation-guard`, `effort` or
  `session-helpers` was applied to every profile without a warning. That removal is now ignored
  with a warning, and a test pins the protection lists in delegation-guard and session-helpers to
  the core list and `distribution.json` (`tests/profile-safety-smoke.ts`).
- **Recovery and verify-pending markers no longer cross sessions.** `progress-guard` and
  `/recover` now write the escalation marker to `.pi/recovery/sessions/<id>/escalation.json`, and
  `recovery-orchestrator` reads, consumes and clears on `session_start` only its own session's
  marker, so a child or a second session in the same cwd can neither erase a parent's escalation
  nor enter recovery for it. A session without an id keeps the flat `.pi/recovery/escalation.json`,
  and a marker naming another session is ignored (`tests/recovery-grounding-smoke.ts`). Each verify
  run writes its own `.pi/verify-pending/<run>.json` and removes only that file, so when two runs
  overlap the first to finish no longer unblocks completion while the second is running;
  `orchestrator` and `conductor` read the per-run files and the legacy `.pi/verify-pending.json`
  (`tests/verify-failclosed-smoke.ts`).
- **A busy verifier board no longer drops a FAIL silently.** `verify-gate` retries a held board
  lock with a bounded backoff (about 1.3 s) before giving up. A write that still fails is returned
  by `recordVerifyVerdict`, listed under "Verifier board NOT updated" in the verification report,
  named in the `/verify` notification and shown as an error notification by the automatic
  turn-end check, instead of only reaching `console.error`. The board itself still holds the
  earlier verdict in that case (`tests/verify-failclosed-smoke.ts`).
- **A `write` or `edit` after or during verification no longer lets the mission complete.** A
  successful `write` or `edit` tool result now turns a recorded `verify` or `review` PASS on
  `.pi/verdicts.json` into a FAIL marked `stale`, and a `/verify`, `verify_completion` or automatic
  turn-end run during which such an edit happened records its PASS as that stale FAIL, so
  `missionCompleteBlocked` blocks until verification runs again. A failed edit leaves the verdicts
  as they were. Only `write` and `edit` tool results in the same pi process count: a `bash` command
  that changes files (`sed -i`, `git checkout`, a formatter) or an edit by another process does not
  mark a verdict stale (`tests/verify-failclosed-smoke.ts`).
- **Model routing uses the session's own task classification.** `orchestrator` writes its score
  to `.pi/task-classification/sessions/<id>.json` and `provider-router` reads only its own
  session's file, so another session or a child in the same cwd no longer switches models on a
  score it did not produce. A session without an id keeps the flat `.pi/task-classification.json`
  (`tests/model-routing-smoke.ts`).
- **The install marker no longer keeps old companion pins.** A reinstall carried every
  companion the previous marker recorded, so a companion `pi install` had moved to a new pin
  stayed listed at each old version, and one no longer registered stayed listed too; uninstall
  then asked `pi` to remove sources that were not there. Carried companions are now re-read
  from settings.json: recorded at the registered pin, dropped once unregistered
  (`tests/install-marker-smoke.ts`).
- **Releasing from a release branch works.** Once any release tag existed, `npm run release`
  refused a version that `--bump-only` had already written ("not forward of current"), so the
  documented release-branch flow could never tag. Now it refuses a version only when it is
  already tagged, is not newer than the newest release tag, or is older than `package.json`. When
  the version fields already carry the version, it only gates and tags.
  `docs/releasing.md` and `release.ts` no longer say to push `main` directly, which its
  protection forbids, and the docs no longer suggest deleting and recreating a wrong tag: a bad
  release is fixed forward (`tests/release-plan-smoke.ts`, `tests/release-lockfile-smoke.ts`).
- **The documented install command works again.** The README, `AGENTS.md` and the install pages
  pinned `v0.2.4-beta.0`, a tag that was never published, so `pi install …@v0.2.4-beta.0`
  failed. They now pin the current release, the README badge's alt text matches its version, and
  `release.ts` moves the pins with every version bump (`tests/docs-smoke.ts`,
  `tests/release-lockfile-smoke.ts`).
- **`/profile` no longer reports an error after a successful switch.** On pi 1.3.0 every switch
  ended with `Extension "command:profile" error: This extension ctx is stale after session
  replacement or reload`. The handler read `hasUI` on the context that its reload had just
  replaced, and pi throws on any use of a replaced context. The switch itself completed
  (`tests/profile-command-smoke.ts`).
- **Tool firewall:** a command or shell variable named like a built-in object member
  (`toString`, `constructor`, `__proto__`) matched the inherited member instead of nothing, so
  commands such as `constructor ~/.aws/credentials` were not tiered high. Tables are now looked
  up by own keys only.
- **Pentest governance:** an audit-chain tail that parsed as JSON but was not a chained record
  (a number, string, array or object without a sequence) restarted the evidence chain at 0. It
  is now treated as corruption, which blocks the action as invalid JSON already did.
- **Remote control:** bridge commands with non-string fields (for example a provider given as
  an array) were coerced to strings and acted on; they are now refused. A malformed pairing
  offer no longer leaks the admin link, a control record that is not an object is ignored, and a
  mirrored confirm closed by a detach resolves to "no".
- **Autonomy relay:** a price looked up by a model name such as `constructor` resolved an
  inherited member and priced the call as free, and a negative cost or token count lowered the
  recorded spend; both could let a run exceed its budget. Prices come from the table's own keys
  and negative figures count as zero.
- **Autonomy runner:** a container mount option could name its source or target twice and
  override the checked one; `export` followed files that resolve outside the run directory; the
  manager's `extendMinutes` was coerced from strings; a contract key named `__proto__` slipped
  past the unknown-key check; `pi-autonomy toString` ran as a command. All are now refused.
- **MCP servers:** the governance and memory ledgers restarted their hash chain at 0 when the
  last record parsed but was not a chained record; that is now an error. `--call toString` and
  similar names ran inherited members; they are unknown tools.
- **Remote control host:** a phone field of the wrong type (for example a device name sent as an
  array) was converted to text and used, including in the pairing proof; it is now refused. The
  platform a pairing phone claims is stripped of control characters before the operator sees
  it, bridge replies are checked field by field (only `ok: true` succeeds), `remote-cli
  toString` no longer runs, and a device can be named with spaces.
- **Web console:** a thinking level or agent `source` of the wrong type is refused instead of
  converted (a falsy `source` used to fall back to the query and rewrite the project agent);
  agent fields fold every kind of line break, so a value cannot add a frontmatter key; editing
  an agent keeps its model; only RPC frames from a pi child are forwarded to viewers; a bad
  pi-lens date or a malformed agent name in the URL is a 4xx or null, not a 500. The console
  installer stops on a kit marker with an unknown scope instead of reconciling the default one.
- **Role-runner:** result keys and `pi run` arguments named like `Object.prototype` members
  (`constructor`, `__proto__`) passed validation; they are refused.
- **Profiles and the lab target:** profile aliases and lab users are resolved from own keys
  only, so a name such as `constructor` no longer matches an inherited member.
- **Eval relay:** a request with a body that is not JSON returned an unhandled rejection and
  stopped the relay; it now gets a 400.
- **Phone app:** tapping Send on an input dialog posted two answers, the first without a value,
  so a delivered answer could show an error and re-enable its buttons. Send answers once, with
  the typed value.
- **Web console:** clearing an agent's model in the agent editor kept the old model; it is now
  removed.
- **Memory MCP server:** its local `--call` path converted fields of the wrong type to text (an
  array topic was stored as its joined string, an object as `[object Object]`, a string limit
  became `NaN`); they are now refused. The MCP tool path was already validated.
- **Autonomy runner:** the container boundary accepted `--group-add` (including podman's
  `keep-groups`, which passes the operator's groups into the container); it is now refused.
- **`subagent:status`:** `--id` accepted a path such as `../x` and printed that log file; it now
  takes a run id only.
- Smaller hardening found while typing: a hostile default in `effort.json` warns instead of
  throwing, and the verifier board's generation stays numeric when the file was hand-edited.

## [0.2.4-beta.3]

### Security

- **Pin `katex` to 0.18.2.** The docs toolchain pulled `katex@0.16.47` transitively through
  `mermaid`, which the OSV scanner flagged for CVE-2026-103923 (GHSA-238p-pmpm-9mq7), a
  low-severity prototype-pollution gadget. An `overrides` entry moves it to the patched 0.18.2;
  `npm audit` is clean and all 52 Mermaid diagrams still parse.

### Fixed

- **The remote host log tail no longer stats a path it then reopens.** `tailLog()` takes the size
  from the open descriptor (`fstatSync`) instead of `statSync` on the path, removing a
  time-of-check/time-of-use window (CodeQL `js/file-system-race`).
- **Model labels on the phone replace every separator.** The session detail sheet used
  `String.replace`, which rewrites only the first `|`; it now uses `replaceAll` (CodeQL
  `js/incomplete-sanitization`).

## [0.2.4-beta.2]

### Added

- **Reporting skills.** Two `evidence-reporting` skills for the pentest reporting workflow:
  `finding-report` renders a finding-ready observation into the house deliverable format (finding
  data block with CVSS 4.0 vector and MITRE ATT&CK, a "threat actor" risk statement running
  Due to → There is a risk that → Resulting in, a general technology Background, a specific
  Overview, single-sentence Remediation, and evidence by ID plus screenshot captions), and
  `daily-debrief` runs a conversational end-of-day debrief that assesses the agent's own notes,
  interviews the tester for the gaps, reconciles findings through the existing discipline skills,
  and organises everything into that format. Both ship in the `pentest` profile only. See
  `docs/skills-catalogue.md`.
- **Status cat.** The status bar shows a small fixed-width ASCII cat for the agent's state
  (thinking, streaming, running a tool, waiting for you, compacting, and the result of a request).
  It replaces pi's spinner while a request runs, never ticks while idle, and is switched with
  `/footer cat on|off` or `PI_KIT_CAT=0`. See `docs/status-bar-and-costs.md`.
- **Remote control from an Android phone.** `/remote` (the `remote-control` extension, in the
  `balanced`, `long-horizon`, `autonomous` and `self-improving` profiles) starts a pi remote host
  on the computer and shares the terminal's session with **pi remote**, a new Android app in
  `apps/android` that is a phone-sized pi-console. The phone connects directly over the LAN or a
  VPN such as Tailscale. Phones are linked with a one-time code plus approval at the terminal
  after comparing a device ID, keep their key in the Android Keystore, pin the host's
  certificate and use short-lived tokens. From the phone you can prompt, steer and abort the
  terminal session, answer its dialogs, change model and thinking, and start, open and end other
  sessions. See `docs/remote-control.md`.

## [0.2.4-beta.1]

### Fixed

- Public commits retain every allowlisted file, including the autonomy handoff seed matched
  by local ignore rules. Export validation and publication check the staged manifest.
- Handoff notes use an atomic create and an open file descriptor, preserving existing notes
  when another process creates or replaces the destination. New files use owner-only
  permissions; supported platforms refuse final-component symlinks.

### Changed

- Removed generated marketing media from the development repository and updated the public
  export manifest to match.
- Prepared the next public beta through the protected GitLab export pipeline.

## [0.2.4-beta.0]

The first public beta. Delivered from `github.com/SATUNIX/pi-system`; see `docs/beta.md` for what
is and is not covered, and `docs/migration.md` if you installed from the earlier private source.

### Added

- **Public delivery.** The kit installs from `git:github.com/SATUNIX/pi-system` (release tags for
  `latest`, `main` for `next`). Installs registered from the retired private GitLab sources move
  when you install the public kit and run its installer (`docs/migration.md`): the retired host is
  never contacted, the channel, profile and hand edits are kept, and the old registration is
  removed. This release's `/update` also recognises a retired registration or a local checkout with
  a retired `origin` and never contacts that host; an old checkout that has not been brought forward
  runs the old code and cannot migrate itself.
- **Verified updates.** `/update` re-reads the installed state after each step and reports a step
  that ran but left the old state behind as failed, stopping the run without reloading. A step
  nothing could confirm is reported as not verified, and a failed lookup is never reported as
  "up to date". Progress and failures go to standard error when there is no terminal UI.
- **Effort control.** Five tiers (E1 Minimal to E5 Exhaustive; default E3) chosen with `/effort`,
  applied from the next message, shown in the status bar, and independent of the model, thinking
  level, profile and permissions. Delegation limits (concurrent, total, scouts) are enforced by a
  shared ledger at every depth, with a separate recovery budget. See `docs/effort.md`.
- **One governed delegation engine.** `delegation-guard` is the single child-launch contract used
  by the `subagent` tool, workflows, the completion reviewer, the Conductor and recovery: every
  child loads its parent's protections, verifies them itself and fails closed (exit 78), at any
  depth, and is budgeted by the effort ledger.
- **Scoped approvals.** Remembered approvals are bound to the exact action, workspace, directory
  and session, expire, and are stored in one file that `/firewall list` and
  `/firewall revoke` inspect and change. Refusals carry exactly one label. Judge blocks that are
  not high-confidence go to the operator. All approval waits are bounded.
- **Unattended mode** for autonomous workers: activates only from a supervisor-built environment
  and a read-only contract, never from inside a session.
- **Web console authentication.** A per-start token, Host and Origin checks, JSON-only writes and
  an RPC allow-list; loopback by default. See `docs/web-console.md`.
- **Transactional `/profile`.** A switch snapshots settings, runs the installer, judges the result
  by what is on disk and rolls back on any failure. `/profile status` and `/compaction status`
  show the effective state.
- **Status bar.** One renderer with `light`, `default` and `heavy` layouts, prioritised segments,
  terminal-width-safe fitting, effort, unattended and compaction state, and cost provenance
  (measured, estimated or unknown).
- **General autonomous runs.** `packages/autonomy` generalises the self-improvement supervisor
  into a run engine: a versioned, fail-closed run contract; a lifecycle state machine with distinct
  outcomes; templates (`implement`, `deploy`, and `self-improve` as one optional template); a
  boundary you read and authorise by digest before anything runs; scoped unattended authorisation
  with host-side containment of every container; an allowlist egress proxy and run-scoped services;
  trusted acceptance checks and an independent review; bounded recovery and hard budgets; and
  approval-gated promotion. The `pi-autonomy` CLI accepts `--json` on every command, and `/autonomy`
  (autonomous profile) drives it from inside pi as a command the model cannot call. See
  `docs/autonomy.md`.
- `docs/concepts.md`, `docs/effort.md`, `docs/migration.md`, `docs/troubleshooting.md`,
  `docs/web-console.md`, `docs/beta.md` and `docs/private-system-lessons.md`; Mermaid diagrams in
  place of PlantUML, checked by `npm run docs:mermaid`.
- CI: a test-wiring check (`check:all` fails on a test no script runs or that asserts nothing), a
  clean-install test that installs the packed tarball for every profile and starts the real pi, a
  release workflow that is manual and dry-run by default with a static test that it cannot publish
  on a dry run, and a pi-compat matrix at the supported floor and the newest release looked at.

### Changed

- **Requirements:** Node.js 22.19 or newer (pi's own minimum) and pi 0.85.1 or newer (the floor
  moved from 0.76.0). The suite is pinned to and tested against pi 0.87.1.
- Approvals learned in one workspace no longer run unasked in another; session allows expire after
  24 hours and learned ones after 30 days; an unanswered approval card is refused as uncertain
  after 15 minutes.
- `/footer <unknown>` is rejected instead of toggling the bar; `/footer` on its own still toggles.
- `trigger-compact` no longer compacts in the middle of a run, stands down when pi's own trigger is
  earlier, and never runs in child sessions; `context-sieve` budgets scale with the real context
  window; a full window with compaction off is explained rather than retried.
- Firewall, profile and overrides configuration that is unsafe (an unknown mode or policy, an
  unparseable `firewall.json`, an override that removes a mandatory protection) fails before
  anything is written instead of being silently replaced.
- `pi-lean-ctx` is pinned at 3.10.5 and is in no profile (opt-in); its review now states that it
  registers shell and edit tools outside the firewall's shell and secret classification.
- `dream.mjs` no longer writes trace-derived notes into `AGENTS.md`.
- Completion gates (verifier-board, orchestrator, conductor) require at least one passing trusted
  source (`verify`, `review` or `validator:<id>`); self-recorded passes alone do not count.
- A project install keeps its state marker in `<project>/.pi/.pi-kit.json`, and `/profile`,
  `/update`, uninstall and the web UI read it before the global one.
- Context contributions are scoped per session.
- `PI_KIT_SUBAGENT_ISOLATE=0` no longer disables child isolation.

### Removed

- The private GitLab pipeline and release script; the `roles/` contracts and `packages/role-runner`
  (they target a private platform); `pi-impact-analyzer` and the unused `pi-subagents` reference;
  the historical design, review and campaign documents. Git history keeps them; see
  `docs/private-system-lessons.md`.
- Machine paths, private host names and account names from tracked files. The retired private
  source URLs remain only in `git.legacySources` and the migration tests and page, because
  migration has to recognise them.

### Fixed

- Readers of persisted state ignore malformed or wrong-shaped data instead of crashing the host.
- Approval brokers always settle, remove their pending and resolved files, and quarantine malformed
  requests.
- A killed or timed-out profile switch no longer counts as success (`pi.exec` resolves a
  signal-killed child as code 0).
- `echo path | xargs touch` and similar wrappers are no longer routine actions.
- The web console shuts down cleanly on SIGTERM with an open event stream.
- `/console stop` stops a hung web UI and never signals a pid that is not the console.
- `THIRD_PARTY_NOTICES.md` reproduces the upstream licence with its holder and year, and states the
  licence position of the caveman concept source.

### Security

- Web console: authentication, Host, Origin and content-type checks, an RPC allow-list, a
  Content-Security-Policy. See `docs/web-console.md`.
- Approvals cannot be broader than the operator's choice; malformed approval files fail closed.
- Every child agent is at least as protected as its parent, at every depth; a missing protection
  stops it.
- pentest-governance blocks an action whose audit record cannot be written.

## [0.2.1-beta.0]

First versioned release, delivered from a private GitLab project (since retired).

### Added

- One package, one install: `node packages/core/install.mjs --channel latest --profile <name>`
  from any clone registers the newest release with pi; or `pi install
  git:<the private source>@v<version>` (the first interactive start then applies
  the `balanced` profile; `PI_KIT_AUTO_PROFILE=<name>|0` changes or turns this off).
- Release channels: `latest` (the newest `vX.Y.Z` tag), `next` (every commit on `main`) and
  pinned versions. `install.mjs --channel <latest|next|X.Y.Z>` picks one.
- Kit delivery setting, `packages/core/distribution.json`: `git` (release tags and `main` of the
  kit's repository, the current setting) or `npm` (dist-tags of `@satunix/pi-system`). The
  installer, `/profile` and `/update` follow it; `PI_KIT_DELIVERY` and `PI_SYSTEM_GIT_SOURCE`
  override it per machine. When a release changes it, `/update kit` moves installs over.
- `kit-update` extension, in every profile: a daily background check for new versions of pi,
  the kit (release tags or `main` over `git ls-remote`, never prompting for credentials) and
  linked packages, and `/update` (`status`, `all`, `kit`, `pi`, `packages`, `channel <name>`) to
  apply them, re-applying the current profile and companion pins.
- `lite` profile: the small-model set formerly shipped as the separate lite package, with
  `skills.only` / `prompts.only` allowlists (new profile fields).
- GitLab release stage: a pushed `vX.Y.Z` tag that passes every check and scan, matches
  `package.json` and is on `main` gets a GitLab Release with notes from this changelog
  (`packages/core/release-notes.mjs`). A private CA is
  supported, and every other pipeline runs the release path read-only (`release-preflight`).
- Security scanning in the GitLab pipeline: gitleaks over full history, Semgrep, `npm audit`,
  `npm audit signatures`, lockfile integrity, and GitLab's SAST and Secret Detection. The same
  checks plus CodeQL, OSV-Scanner, dependency review, zizmor, OpenSSF Scorecard and Dependabot
  are ready in `.github/workflows/` for when the repository is on GitHub.
- npm delivery, built and paused: `.github/workflows/release.yml` (trusted publishing with
  provenance, dist-tags from `packages/core/publish-plan.mjs`), runnable only by hand.
- `npm run smoke:package` (tarball contents and per-profile resolution from the packed copy),
  `npm run smoke:distribution` (delivery, channels and installer source selection) and
  `npm run security:lockfile` (registry-only sources, integrity hashes, install-script
  allowlist).

### Changed

- The installer registers a checkout in place by default, the released kit when given
  `--channel`, and keeps the existing git or npm registration when run from pi's own copy of
  the kit. It keeps exactly one registered copy of the kit (git sources match on repository,
  whatever the ref), removing other checkouts, other deliveries and legacy exports.
- `release.mjs` accepts prerelease versions, bumps every workspace manifest, and runs the
  package check instead of generating surfaces.
- `install.mjs --uninstall` removes the companions it registered, not just the kit.

### Removed

- Generated install surfaces (`packages/kit/surfaces/`, `export-package.mjs`,
  `export-all.mjs`) and the `@satunix/pi-system-lite` package. `--surface lite` still works as a
  deprecated alias for `--profile lite`.
- The `export:*`, `install:lite`, `publish:dry-run` and `smoke:export-package` scripts.
