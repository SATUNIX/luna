# Secure development standard

Every change to this repository follows these rules. Each rule names the lint rule or test that
enforces it, or says that review is the only check. They sit beside the TypeScript standard in
`CONTRIBUTING.md`; the [threat model](threat-model.md) explains why they exist, and
[Security controls](security-controls.md) lists the controls they protect.

Two rules apply to all the others:

- **Fix the class, not the instance.** A finding names one place; before closing it, look for
  every other place with the same shape (every writer, every redactor, every parser path) and
  fix or list each one. The shared helpers below exist because one instance was fixed and its
  siblings were not. Review is the only check.
- **Fail closed on what you do not model.** A parser, classifier or check that meets input it
  does not understand reports it as unknown and refuses, asks or rates it higher; it never treats
  it as harmless. The shell parser's opaque result and the unknown-executable tier are the
  pattern (`tests/firewall-shell-smoke.ts`, `tests/firewall-exec-oracle-smoke.ts`).

## File I/O

| Rule | Enforced by |
|---|---|
| Write anything under a workspace (`<workspace>/.pi/`, `AGENTS.md`, `TODO.md`) through `packages/core/shared/safe-fs.ts`: `writeFileSafe`, `appendFileSafe`, `createFileExclusive`, `openFileExclusive`, `rotateFileSafe` or `ensureDirSafe`. It refuses a path outside the workspace, a symbolic link on the way down, and a target that is not a regular file the user owns with one link | ESLint `no-restricted-syntax` in `eslint.config.ts` rejects a raw `writeFileSync`, `appendFileSync`, `createWriteStream` or write-mode `openSync` in an extension outside `RAW_WRITE_ALLOWED`; `tests/workspace-symlink-smoke.ts` |
| An extension imports the generated copy in its own `shared/` directory, never `packages/core/shared/` itself; change the source and run `npm run gen:shared` | `npm run verify` fails when a copy differs; `tests/redaction-corpus-smoke.ts` |
| Replace a whole file by writing a new temporary file created exclusively (`O_EXCL`) beside it, then renaming it over the old one | The helper does this; `tests/workspace-symlink-smoke.ts` |
| Create a file with its final mode in the same call (`mode` with `wx`, or the helper's 0600 default); never create it and `chmod` it afterwards | `tests/profile-transaction-smoke.ts` for restores; review elsewhere |
| A secret or operator-authority file is mode 0600 in a 0700 directory, and a reader refuses one that is a link, another user's or open to others | `tests/human-console-auth-smoke.ts`, `tests/remote-host-smoke.ts` |
| Never use a fixed name in a shared temporary directory. Use `fs.mkdtempSync`, or a per-user `<tmp>/pi-kit-<uid>` directory (mode 0700, refused when it is a link or another user's) | `tests/branch-lab-smoke.ts`; review elsewhere |
| A new file the kit writes that holds a credential or operator authority is added to `OPERATOR_AUTHORITY_FILES` in `packages/extensions/src/tool-firewall/classify.ts` | `tests/firewall-autoload-smoke.ts` fails on a secret-looking file name in kit source that is not classified |
| A new location pi loads code or settings from without a trust prompt is covered by the firewall's autoload rules | `tests/firewall-autoload-smoke.ts` reads pi's sources and fails on an uncovered location |

A path the operator sets (an environment variable naming a log or state file) is trusted; only
its final name is checked. That is the one exception, and the [Security model](security.md#workspace-file-writes)
lists it.

## Regular expressions

| Rule | Enforced by |
|---|---|
| Compile a pattern from anything but a literal through `compileCheckedRegex` in `packages/core/shared/safe-regex.ts`, which refuses nested quantifiers, backreferences and over-long patterns | ESLint rejects a `new RegExp` or `RegExp()` with a non-literal pattern outside `DYNAMIC_REGEXP_ALLOWED`; `tests/skill-routing-smoke.ts`, `tests/workflow-smoke.ts` |
| A pattern from repository content that runs on every turn also runs under a time limit and is switched off when it hits it | `tests/skill-routing-smoke.ts` |
| An allowlisted dynamic pattern escapes its input or is built from constants, and the allowlist entry says which | Review of `eslint.config.ts` (owned in `.github/CODEOWNERS`) |
| Every rule in a redaction or scanning table is linear: bounded repetition, no nested quantifier over overlapping text | `tests/redaction-corpus-smoke.ts` runs 1 MB adversarial inputs against a time budget |

## Redaction

| Rule | Enforced by |
|---|---|
| Anything the kit stores or sends to a memory service passes through the one table in `packages/core/shared/redact.ts` (`redact` or `redactSecrets`); no consumer keeps its own list | `tests/redaction-corpus-smoke.ts` runs the source, every copy and every consumer over `tests/fixtures/secret-corpus.json` |
| A new consumer is added to the corpus test in the same change | Review; the corpus test lists its consumers |
| Corpus entries are synthetic, stored in parts so no scanner sees a whole value, and marked `"fixture": "synthetic"` | `tests/redaction-corpus-smoke.ts`; gitleaks and the leak scan report nothing on the corpus |
| Redaction is hygiene, not a boundary: never rely on it to make a log safe to publish | Documentation ([Security model](security.md#redaction)) |

## Cryptography

| Rule | Enforced by |
|---|---|
| No hash algorithm with a known serious weakness (MD5, MD4, SHA-1, RIPEMD-160) in `createHash` or `createHmac`, even for a cache key or a file name; use SHA-256 or SHA-512 | ESLint (`no-restricted-syntax`, every linted file) |
| Never write a cipher, signature scheme or key derivation of our own: use `node:crypto` on the host and the Android keystore on the phone | Review |
| Bearer tokens, pairing codes, keys and nonces come from `crypto.randomBytes` (or `randomUUID`), never `Math.random` (still used for some non-secret identifiers and temporary-file suffixes) | Review |
| A TLS server the kit runs refuses anything below TLS 1.2; the remote host uses an EC P-256 certificate whose SHA-256 fingerprint the app pins ([Remote control](remote-control.md)) | Review (`minVersion` in `packages/web-ui/server/remote-host.ts`) |

## Network clients

| Rule | Enforced by |
|---|---|
| Refuse to send a credential over plain `http://` to a host other than loopback, unless an explicit opt-in variable is set | `tests/memory-mem0-smoke.ts` |
| Cap every response body read into memory | `tests/memory-mem0-smoke.ts` |
| A server binds loopback by default; a wider bind is refused in unsafe combinations or warns | `tests/web-ui-bind-policy-smoke.ts`, `tests/remote-host-smoke.ts` |
| A compose file binds a loopback host IP on every published port and requires a credential on every published service | `tests/compose-policy-smoke.ts` |
| A bearer token is compared in constant time, is never accepted from a query string and never reaches a log or a response body | `tests/web-ui-security-smoke.ts` (query string, logs, bodies); the comparison itself is `constantTimeEqual` in `packages/web-ui/server/security.ts`, which nothing tests for timing |

## Child processes

| Rule | Enforced by |
|---|---|
| Spawn with an argument array (`spawn`, `execFile`, `spawnSync`); never `shell: true`, `exec` or `execSync` | ESLint (`no-restricted-syntax`, `no-restricted-imports`) |
| No `eval`, `new Function` or `node:vm` to run anything untrusted | ESLint |
| Pass a secret by file descriptor, standard input or a file name, never in argv or an environment the child does not need | Review; `tests/autonomy-container-smoke.ts` checks the relay's key is on no command line (it skips when no container engine is reachable) |
| Treat a child's output as untrusted data: bound its size, parse it with a guard, and fail on a non-zero exit, a signal or a timeout instead of using partial output | `tests/autonomy-review-inputs-smoke.ts` for the merge-review diff; review elsewhere |
| A CI shell step never hides a failure (`|| true`, `|| :`, `|| exit 0`, `|| echo`, `set +e`, `continue-on-error`, `allow_failure`) | `tests/workflow-policy-smoke.ts` with `tests/ci-fail-open.ts` |

## Untrusted data

| Rule | Enforced by |
|---|---|
| JSON from files, the network, child processes, models, the browser or the command line is `unknown` until a guard from `packages/core/lib/guard.ts` (`parseJsonAs`, `object`, `string`) accepts it; never cast it | ESLint rejects a direct cast of `JSON.parse` output or an awaited `.json()` body; `tests/typescript-coverage-smoke.ts`, `tests/untrusted-input-guards-smoke.ts` |
| Look tables up by own keys (`Map`, `Object.hasOwn`), never `obj[input]` | Review |
| Build a record from untrusted keys on `Object.create(null)` or as a `Map` | `tests/tool-capture-smoke.ts`; review elsewhere |
| Text a model reads from a worker, a repository or a tool result is data, not instructions: a prompt that includes it says so, and a decision about it is never taken from inputs the judged party wrote | `tests/autonomy-review-inputs-smoke.ts` |

## Dependencies

| Rule | Enforced by |
|---|---|
| Every npm tree has a committed lockfile, installed with `npm ci --ignore-scripts`; a package outside the npm registry, without a sha512 hash, or with an unreviewed install script fails | `npm run security:lockfile` (`tests/lockfile-check-smoke.ts`), in the `dependencies` job |
| Every manifest (npm, pip, Gradle, Dockerfile, compose image) has Dependabot coverage and is scanned by OSV | `tests/scan-coverage-smoke.ts` |
| Images are pinned by digest; downloaded binaries are verified against a pinned SHA-256 | `tests/container-static-smoke.ts`; review of the workflows |
| A companion package is pinned exactly with its sha512 integrity, reviewed against its tarball and recorded in `packages/core/sources.json` before adoption | `tests/companion-integrity-smoke.ts`, `tests/sources-smoke.ts` |
| A runtime dependency is added only with the change to the list in `docs/supply-chain.md` | `tests/clean-install-smoke.ts` |
| Updates follow the [update policy](supply-chain.md#update-policy) | Dependabot configuration; review |

## Suppressions

Every way a finding is switched off is listed, with its reason, in
`packages/core/scan-suppressions.json`: inline markers (`eslint-disable`, `nosemgrep`, the
TypeScript expect-error directive, `zizmor: ignore`, `noqa`), `.semgrepignore` paths, CodeQL
`paths-ignore` and query filters, gitleaks allowlists and zizmor configuration ignores.
`tests/suppression-inventory-smoke.ts` fails on a suppression the inventory does not list and on
a listed one that is gone; an inline entry is keyed by the SHA-256 of its line, so editing a
suppressed line updates the inventory in the same change. The full policy, with what each kind
of suppression may be used for, is in [CI security](ci-security.md#suppression-policy).

- `@ts-ignore`, `as unknown as` and the non-null `!` are not used at all (`CONTRIBUTING.md`).
- An `eslint-disable` needs `-- <reason>` and counts against a ceiling
  (`tests/typescript-coverage-smoke.ts`).
- A gitleaks allowlist is bound to named files, never a whole path or a bare pattern
  (`tests/suppression-inventory-smoke.ts`).
- A leak-scan exception pins the SHA-256 of the exact match and of the whole line, and lands in a
  pull request of its own before the content it admits (`tests/prepush-scan-smoke.ts`).

## Tests and review

| Rule | Enforced by |
|---|---|
| A security fix lands with a regression test that fails before it and passes after it, and its CHANGELOG entry names the test | Review; `CLAUDE.md` |
| A regression test uses benign vectors (`echo`, `true`, a marker file in a temporary directory) and describes the vulnerability class, not a working bypass | Review |
| A new test file is run by a `smoke:*` or `test:*` script and asserts something | `tests/wiring-smoke.ts` |
| Tests are hermetic: a temporary `HOME` and `PI_CODING_AGENT_DIR`, `isolateKitEnv()` before loading an extension | `tests/env-isolation-smoke.ts`; review |
| A change to a path in `.github/CODEOWNERS` needs the owner's review; every CI, release and security control file is listed there | `tests/codeowners-coverage-smoke.ts`; the review rule itself is a repository setting ([CI security](ci-security.md#repository-settings)) |
| An agent never approves or merges its own pull request, never pushes to a protected branch, and never changes repository settings | `.github/expected-settings.json` declares the review rule; `AGENTS.md` and `CLAUDE.md` state it |
| Documentation describes current behaviour, names the test behind each claim and names only files, scripts and jobs that exist | `tests/docs-smoke.ts`, `tests/security-docs-smoke.ts` |
