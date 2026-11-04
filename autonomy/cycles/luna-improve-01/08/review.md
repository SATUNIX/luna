# Cycle 08 review — luna-improve-01

Mode: fix. Base `69afbd4` (cycle 07 record commit; pushed head and this clone's stand-in for
`integration/luna`).

## Starting state

- `autonomy/BACKLOG.md`: B-001..B-006 and B-008 are `done`; B-007 is an operator `proposal`
  (release pipeline, out of bounds to edit). No open in-bounds item.
- `autonomy/HANDOFF.md`: cycle 07 names no carried code work; the "next work" line is "the next
  evidenced fix in charter order".
- Charter order (highest first): failing check / broken state; unfinished handoff work;
  correctness/reliability bugs; security hardening; tests then docs; dead/duplicated/complex
  code; improvements; proposals.

## Findings

### 1. `parseGitSource()` rejects a bare `git://` protocol URL — confirmed correctness bug

`packages/core/lib/distribution.ts:143-148`:

```ts
const hasPrefix = trimmed.startsWith("git:");
const url = hasPrefix ? trimmed.slice(4).trim() : trimmed;
if (!hasPrefix && !/^(https?|ssh|git):\/\//i.test(url)) return null;
```

`"git://github.com/SATUNIX/luna"` also starts with `git:`, so the prefix branch runs and leaves
`//github.com/SATUNIX/luna`; the protocol regex cannot then match and the function returns
`null`. Direct probe:

```text
"git://github.com/SATUNIX/luna"     => null
"git:git://github.com/SATUNIX/luna" => {"repo":"git://github.com/SATUNIX/luna","ref":null,"key":"github.com/satunix/luna"}
"https://github.com/SATUNIX/luna"   => {"repo":"https://github.com/SATUNIX/luna",...}
"git:git@github.com:SATUNIX/luna"   => {...,"key":"github.com/satunix/luna"}
```

The regex on line 148 deliberately admits the `git:` scheme and the comment above the function
says pi writes "a protocol URL", so the bare form is meant to parse.

Impact: the kit's `/profile` matcher (`packages/extensions/src/session-helpers/index.ts:311`
`gitSourceKey`) already treats a bare `git://…` entry as a git URL, and
`tests/profile-command-smoke.ts:330` asserts that. Core disagrees: `isKitGitSource()`,
`sourcesReferSamePackage()` and `validatePreviousSources()` all go through `parseGitSource`, so
a registration in that form is not recognised by the installer (re-register, missed cleanup) and
`validatePreviousSources()` throws. Charter priority 3.

### 2. Lower-value candidates deferred

- `getExternalByProfile()` (`packages/core/lib/sources.ts:42`) is dead exported code
  (priority 6); cosmetic, deferred to keep this cycle to one logical change.
- `eval/run.ts:21` silently ignores a trailing `--category` with no value (low); deferred.
- The installer's project-settings writes do not go through `safe-fs`; docs do not claim the
  installer is covered and it needs a design decision, so not taken.

## Checked and clean

- `packages/core/install.ts`, `packages/core/lib/settings.ts` — `parseGitSource` consumers that
  motivated the finding.
- `packages/extensions/src/session-helpers/index.ts` — the tolerant duplicate parser already
  handles `git://`; it was the reference for the intended behaviour.
- Existing tests already reference `git://` (`tests/install-profile-filter-smoke.ts:358`,
  `tests/kit-update-smoke.ts:236`, `tests/profile-command-smoke.ts:330`).

## Decision

Take finding 1: one-line guard in `packages/core/lib/distribution.ts` (and the duplicated parser
in `packages/extensions/src/kit-update/index.ts`), with a test in `tests/distribution-smoke.ts`
that fails without the fix and a `tests/kit-update-smoke.ts` case. Nothing higher in charter
order was found; deferred items are recorded in `plan.md` "Out of scope / not taken".
