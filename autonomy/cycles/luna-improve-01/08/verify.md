# Cycle 08 verification — luna-improve-01

Mode: fix. Base `69afbd4`; change under verification `4cbe38c`
("fix(distribution): parse a bare git:// source as git, not a git:-prefixed path").

## Change under test

Two one-line guards plus tests:

- `packages/core/lib/distribution.ts:146` —
  `const hasPrefix = trimmed.startsWith("git:") && !trimmed.startsWith("git://");`
- `packages/extensions/src/kit-update/index.ts:188` — the same guard on the duplicate parser.
- `tests/distribution-smoke.ts` — `parseGitSource("git://github.com/SATUNIX/luna")` must
  deep-equal `{ repo: "git://github.com/SATUNIX/luna", ref: null, key: "github.com/satunix/luna" }`.
- `tests/kit-update-smoke.ts:236` — bare `"git://github.com/SATUNIX/luna"` added to the list of
  sources that must satisfy `isKitGitSource === true`.

## Reproduction (old behaviour)

Old expression `trimmed.startsWith("git:")` is also true for a bare `git://` URL, so the prefix
branch sliced four characters off and left `//github.com/SATUNIX/luna`; the protocol regex could
not match and the fallback host was empty, yielding `null`. The plan records the direct probe:

```text
"git://github.com/SATUNIX/luna"     => null            (before the fix)
"git:git://github.com/SATUNIX/luna" => {"repo":"git://github.com/SATUNIX/luna",...}
"https://github.com/SATUNIX/luna"   => {"repo":"https://github.com/SATUNIX/luna",...}
```

`tests/distribution-smoke.ts` deep-equals the parsed object, so it fails on the pre-fix code
(returns `null`).

## Checks run on `4cbe38c`

| Check | Result |
|-------|--------|
| `node tests/distribution-smoke.ts` | all 14 checks passed (exit 0) |
| `node tests/kit-update-smoke.ts` | all 40 checks passed (exit 0) |
| `npm run test:typecheck` | exit 0 |
| `npm run test:lint` (`--max-warnings 0`) | exit 0 |
| `npm run verify` | all checks passed (exit 0) |
| `npm run check:all` | **203/203 check runs passed** in 440.2s (exit 0) |

The kit-update case fails on the pre-fix code because `isKitGitSource` returns `false` when
`parseGitSource` returns `null`.

## Independent review

A read-only `reviewer` subagent reviewed `git diff 69afbd4..4cbe38c` against
`autonomy/CHARTER.md`. Verdict: **PASS**, no must-fix items. It confirmed the regex at
`distribution.ts:148` admits `git`, the protocol branch then parses the URL (host, path, ref,
key), only `git://`-prefixed inputs change behaviour, and no protected path, `package.json`
script or dependency changed. It cross-checked that `validatePreviousSources`,
`isKitGitSource`, `isPreviousGitSource` and `gitSourceWithRef` now agree with the already-fixed
`/profile` matcher in `packages/extensions/src/session-helpers/index.ts:311`.

## Scope and safety

Only two parser guards, two test additions and this cycle's records changed. No
`autonomy/CHARTER.md`, operator control path, `package.json` script, dependency, `.github/` or
`packages/web-ui/` change. Diff is `git diff 69afbd4..4cbe38c` (5 files, +93/-3); it reviews
whole well inside the merge budget.
