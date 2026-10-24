# secret-guard

Opt-in, name- and pattern-based backstop for secret files and credentials. It ships in no
profile (see Profiles below). When loaded, its `tool_call` hook blocks the actions below; every
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
  `base64`, `curl` uploads), including glob- and quote-obscured names.
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

Shipped but **not** in any profile: its manifest is `experimental` and `enabledByDefault: false`
(`tests/docs-smoke.ts` fails if its manifest starts naming a profile while these docs say
otherwise). Add it deliberately, by listing it under `extensions.add` in
`<agent dir>/pi-kit/overrides.json` (which keeps the rest of the profile) or in a profile's
`include`, when you want a name-based backstop for `.env`, keys and similar files. The tool
firewall's own classifier, loaded by all profiles, already refuses or asks about many of the same
actions; this extension is the stricter, pattern-based second layer. Its manifest sets
`childGovernance`, so when it is loaded, child sessions started by delegation load it too
(`tests/delegation-guard-smoke.ts` pins that rule for `childGovernance` extensions).
