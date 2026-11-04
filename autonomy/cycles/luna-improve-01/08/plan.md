# Cycle 08 plan — luna-improve-01

Mode: fix
Base: `69afbd4` (cycle 07 record commit; the pushed head and this clone's stand-in for
`integration/luna`).

## Review result

The backlog has no open in-bounds item: B-001..B-006 and B-008 are `done`, B-007 is an
operator `proposal` (release pipeline, out of bounds to edit). `HANDOFF.md` names no carried
code work. A read-only `scout` over `packages/core/**` found one confirmed correctness bug in
the git-source parser, plus lower-value cleanup candidates (`getExternalByProfile` dead code,
`eval/run.ts --category` missing value).

## Item 1 — `parseGitSource()` rejects a bare `git://` protocol URL (fix)

**Finding / evidence.** `packages/core/lib/distribution.ts:143-148` strips a leading `git:`
before checking the URL form:

```ts
const hasPrefix = trimmed.startsWith("git:");
const url = hasPrefix ? trimmed.slice(4).trim() : trimmed;
if (!hasPrefix && !/^(https?|ssh|git):\/\//i.test(url)) return null;
```

`"git://github.com/SATUNIX/luna"` also starts with `git:`, so the prefix branch runs, leaving
`//github.com/SATUNIX/luna`; the protocol regex on line 158 cannot match (`[a-z]+` needs a
letter before `:`) and the fallback host is empty, so the function returns `null`. The regex on
line 148 deliberately admits the `git:` scheme, and the comment above the function says pi
writes "a protocol URL", so the bare `git://` form is meant to parse.

Reproduced:

```text
$ node --experimental-strip-types -e 'import {parseGitSource} from "./packages/core/lib/distribution.ts"; ...'
"git://github.com/SATUNIX/luna"    => null
"git:git://github.com/SATUNIX/luna" => {"repo":"git://github.com/SATUNIX/luna",...}
"https://github.com/SATUNIX/luna"   => {"repo":"https://github.com/SATUNIX/luna",...}
```

**Why it matters (charter priority 3 — correctness).** The kit's own `/profile` matcher
(`packages/extensions/src/session-helpers/index.ts:311`, `gitSourceKey`) treats a bare
`git://…` entry as a git URL, and `tests/profile-command-smoke.ts:330` asserts that a bare
`git://github.com/SATUNIX/luna` entry is the kit. The toolchain does not agree: core
`isKitGitSource()` (used by the installer's `registeredKitSource`, `removeOtherKitEntries`) and
`sourcesReferSamePackage()` both call `parseGitSource`, so a registration in that form is not
recognised — the installer would re-register the kit and the cleanup would miss the old entry.
`validatePreviousSources()` would throw on a `git://` `previousSources` entry.

**Change.** One-line guard so a `git://` URL is not treated as a `git:`-prefixed source:

```ts
const hasPrefix = trimmed.startsWith("git:") && !trimmed.startsWith("git://");
```

The existing protocol branch then parses the URL unchanged (host, path, ref, key).

**Checks that prove it.**
- Add a `tests/distribution-smoke.ts` assertion (case "git sources parse to pi's identity"):
  `parseGitSource("git://github.com/SATUNIX/luna")` deep-equals
  `{ repo: "git://github.com/SATUNIX/luna", ref: null, key: "github.com/satunix/luna" }`.
  This fails on the current code (returns `null`) and passes after the fix.
- Run `node tests/distribution-smoke.ts` (all its cases), plus `npm run verify` for the
  distribution/security contracts and `npm run test:typecheck`.
- The kit-update extension holds a copy of the same parser
  (`packages/extensions/src/kit-update/index.ts:188`); the same guard is applied there for
  consistency, with a `tests/kit-update-smoke.ts` case, because `detectKitInstall()` locates the
  install root through `parseGitSource` and its `isKitGitSource` already accepts the bare form.

**Docs.** No user-visible command or setting changes; the existing comment in
`distribution.ts` already states the protocol-URL form is accepted, so no doc edit is needed.

## Out of scope / not taken

- `getExternalByProfile()` (`packages/core/lib/sources.ts:42`) is dead exported code
  (priority 6); a removal is cosmetic-only and is deferred to keep this cycle's diff to one
  logical change.
- `eval/run.ts:21` silently ignores a trailing `--category` with no value (low); deferred.
- The installer's project-settings writes do not go through `safe-fs`; the scout flagged it but
  the docs do not claim the installer is covered, and it needs a design decision about the global
  settings path, so it is not taken this cycle.

## Task graph

1. Implement the `parseGitSource` guard + tests (this cycle, one commit).
2. Independent `reviewer` over `git diff 69afbd4..HEAD` against the charter.
3. Accept record commit and push.
