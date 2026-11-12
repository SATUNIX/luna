# Proposal: make `install.ts` report a bad `--profile` cleanly

Board: PG-50

## Finding (evidenced)

`node packages/core/install.ts --profile bogus-profile --dry-run` prints a raw Node stack trace for
an ordinary user error:

```
file:///work/packages/core/install.ts:416
  if (!fs.existsSync(p)) throw new Error(`[install] Profile not found: ${p}`);
                               ^
Error: [install] Profile not found: /work/packages/kit/profiles/bogus-profile.json
    at loadProfile (file:///work/packages/core/install.ts:416:32)
    at file:///work/packages/core/install.ts:511:16
    ... Node internals ...
```

`loadProfile` (`packages/core/install.ts:414-418`) throws a plain `Error` from deep in a
`main()`-less module body, so nothing catches it. The message itself is good; only the presentation
is wrong. The command is the first thing a new user runs, and `AGENTS.md` tells them to pick a
profile with it.

## Proposed fix

In `packages/core/install.ts`, catch the expected argument/profile errors at the top level and print
`[install] <message>` plus a one-line hint listing the valid profiles (or `--profile --help`), then
`process.exit(2)`. Keep the stack for unexpected errors so real bugs are still diagnosable. The
valid-profile list already exists (`PROFILES_DIR` / `canonicalProfileName`); reuse it rather than
adding a second list.

## Acceptance test

Extend the install CLI test (see the existing `tests/` install/CLI coverage) with a case that runs
`install.ts --profile bogus-profile --dry-run` and asserts the exit code is non-zero, stderr
contains `Profile not found` and names the valid profiles, and no line contains `at loadProfile` or
`node:internal`. This is a small, low-risk fix; it was deferred only to keep the cycle-10 diff
under the item budget.

## Why a proposal, not this cycle

Cycle 10's stream slice was PG-50 (host-wide gate slots) and the carried-over PG-46; this installer
defect is a separate, unrelated user-facing fix. It is recorded here so the dangling reference in
`autonomy/runs/luna-ops-01/HANDOFF.md` resolves and a later ops cycle can take it with the test
above.
