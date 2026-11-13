# secret-guard

Name- and pattern-based backstop for secret files and credentials, loaded by the `balanced` and
`long-horizon` profiles (see Profiles below). When loaded, its `tool_call` hook blocks the actions below; every
item is pinned by `tests/secret-guard-smoke.ts` unless another test is named.

## What it blocks

- `read`, `grep`, `find`, `ls` and `glob` of a credential file: `.env`, `.env.*`, `*.key`,
  `*.pem`, `*.p12`, `*.pfx`, `id_rsa` / `id_ed25519` / `id_ecdsa` / `id_dsa`, `.npmrc`, `.netrc`,
  `credentials` / `credentials.json`, `secret.*` / `secrets.*` (json, yaml, toml, env, txt),
  anything under `.ssh/`, and `.pi/agent/auth.json` (`SECRET_READ_BASENAME_PATTERNS`,
  `SECRET_READ_PATH_PATTERNS`). Paths are resolved through symlinks and `..` first.
- `write` / `edit` to a secret file: the names above plus any path containing `credentials` or
  `secret` (`SECRET_PATH_PATTERNS`), and to the protected engagement and agent-control paths in
  `PROTECTED_PATTERNS` (for example `.git/`, `engagement/scope.yaml`, `.pi/trace.jsonl`,
  `.pi/verdicts.json`, `.pi/agents/`).
- `write` / `edit` whose content is high-confidence secret material, such as private-key blocks
  and known token prefixes (`SECRET_CONTENT_PATTERNS`).
- `bash` commands that leak a secret (`git add` / `git commit` of a `.env`, `echo` of a
  `password=`-style assignment, `curl` / `wget` posting credentials; `SECRET_BASH_LEAK_PATTERNS`),
  or that read, copy, encode or transfer a secret or protected path (`cat`, `cp`, `mv`,
  `base64`, `curl` uploads), including glob-, bracket-class-, brace- and quote-obscured names
  (`.e?v`, `.en[v]`, `[.]env`, `.e{n,x}v`). Brace groups and bracket classes of up to 32 characters
  (`[v]`, `[c-c]`, `[[:lower:]]`) are expanded before the name scan (duplicates collapse, at most 1024 words and 1 MiB per token, 16
  levels of nesting; a group past a bound widens to `*`, which can only block more). A
  negated or larger bracket class is matched against representative secret filenames, and a glob
  directory segment with at least three literal characters (`secre[t-u]`, `.ss[h-i]`) is matched
  against `secret`, `secrets`, `credentials` and `.ssh`. Quoted text is expanded as well, because
  `sh -c 'cat .en[v]'` hands it to a second shell. A quote inside a word is removed the way the
  shell removes it before the scan (`.e'n'v`, `".e"nv`, `cred"entials"/db.txt`); a word quoted as a
  whole keeps its quotes, because the quoting is what marks a search pattern as text. A `$'...'`
  string is decoded first (`\x2e`, octal, `\u002e`, `\n`). Not covered:
  a backslash-escaped bracket (`[v\]]`), and a name reached only through `?`,
  `*`, a negated class or a class of more than 32 characters when it is not canonical (`foo.p?m`,
  `foo.p[!x]m`). The `.env.example` and `.env.sample` exemption applies after expansion. All of
  this is pinned by `tests/secret-guard-smoke.ts`.
  For a plain leading `rg`, `grep`, `egrep` or `fgrep` command, a recognised search pattern is
  excluded from the secret-path token scan. The first positional argument is the pattern unless
  `-e` / `--regexp` or `-f` / `--file` supplies one; a pattern file is always scanned as a path.
  File operands, including those after `--`, are still scanned. Unknown options, ambiguous shell
  syntax, unbalanced quotes and shell substitutions receive the unchanged full scan, and so does
  an unquoted pattern containing `*`, `?`, `[`, `]`, `{`, `}` or `~`, which the shell expands
  before the tool runs (a quoted pattern is text). This
  precision rule is pinned by `tests/secret-guard-smoke.ts`; the four piped searches through all
  three guards are pinned by `tests/firewall-benign-corpus.ts` via `tests/tool-firewall-smoke.ts`.
- any tool call whose `path` or `file` argument (or, for `bash`, `command`, `cmd` or `script`) is truthy
  but not a string; the reason names the field (`tests/untrusted-input-guards-smoke.ts`).

## What it does NOT block

- `.env.example` and `.env.sample`, which stay readable and writable; their content is still
  scanned.
- Public keys (`*.pub`) and ordinary source whose name merely mentions `credentials` or
  `secret` (for example `src/credentials-view.ts`): reads use the narrower read patterns.
- A directory-wide `grep` or `find` whose path does not name a credential file can still reach
  its contents. This is defence in depth, not operating-system isolation.

## Configuration

No env vars of its own. It also protects the files the firewall trusts: `PI_KIT_FIREWALL_POLICY`,
`PI_KIT_FIREWALL_AUDIT_LOG`, `PI_KIT_FIREWALL_APPROVALS` and the unattended-run contract
(`PI_KIT_UNATTENDED_CONTRACT`) cannot be written by the agent (the contract path is pinned by
`tests/firewall-unattended-smoke.ts`; the other three are not covered by a test). On load it
registers itself in `globalThis[Symbol.for("pi-kit.protections")]`
(`tests/protections-registry-smoke.ts`). Patterns are hardcoded in `index.ts`. To extend, add an
extension in your own repo that hooks `tool_call` with your patterns.

## Profiles

Loaded by the `balanced` and `long-horizon` profiles. It is one of the three mandatory protections
(with `tool-firewall` and `protected-paths`): every other shipped profile records, with a reason, why
it goes without it in `packages/core/lib/protection-coverage.ts`, and `npm run profile:check` fails a
profile that drops a mandatory protection without such an exemption
(`tests/profile-protections-smoke.ts`; `tests/docs-smoke.ts` checks the manifest names the same two
profiles). The usual reason is the write rule above: any path containing `secret` or `credentials`
is refused, which blocks ordinary edits in a repository with such names. Add it to another profile
deliberately, by listing it under `extensions.add` in `<agent dir>/pi-kit/overrides.json` (which
keeps the rest of the profile). The tool firewall's own classifier, loaded by all profiles, already
refuses or asks about many of the same actions; this extension is the stricter, pattern-based second
layer. Its manifest sets `childGovernance`, so when it is loaded, child sessions started by
delegation load it too (`tests/delegation-guard-smoke.ts` pins that rule for `childGovernance`
extensions).

## Refusal records

A refusal is not only a UI notice: `blocked()` appends one `tool_refused` record to the firewall
audit log through the shared `shared/refusal-record.ts` helper (`tests/firewall-refusal-record.ts`).
It names the guard, the cause (`secret-path`, `secret-read`, `protected-path`, `secret-content`,
`secret-leak`, `secret-transfer`, or `invalid-input`), the matched rule source or path token, the
tool, a SHA-256 digest of the command when the call carries one, and the session id. For a
`secret-content` refusal the matched value is the pattern label (for example `provider API key (sk-)`),
never the content itself. It never writes the command text or a secret value, and a failed write never
breaks the refusal.
