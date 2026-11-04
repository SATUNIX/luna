# Cycle 09 — Review

- Run: `luna-improve-01`
- Branch: `pi/luna-improve-01`
- Cycle base (HEAD at review): `b05a67174f759bf8e7520fdb0b7adca38585e6ed`
- Reviewer inputs: `autonomy/CHARTER.md`, `autonomy/BACKLOG.md`, `autonomy/HANDOFF.md`,
  cycle 08 `report.md`/`review.md`/`verify.md`, plus one scout run and direct coordinator checks.

## Charter priority order applied

1. Failing acceptance check / broken state — none known; acceptance was green at cycle 08 close.
2. Unfinished handoff work — `autonomy/HANDOFF.md` names no in-bounds unfinished work.
3. Correctness / reliability bugs — **found one (see below)**.
4. Security hardening (behaviour-compatible) — none in-bounds found.
5. Tests then docs accuracy — one deferred docs note is a documented known gap, not a mismatch.
6. Dead / duplicated / complex code — **found one (see below)**.
7. Improvements — none chosen this cycle.
8. Proposals — B-007 remains an operator proposal (out of bounds).

## Backlog status at review

- B-001..B-006, B-008, B-009: `done`.
- B-007: operator `proposal` (release pipeline) — out of bounds, unchanged.

## Findings

### F-1 (priority 3, correctness) — `uninstall.ts` accepts invalid and unknown arguments silently

**Evidence.** `packages/core/uninstall.ts` parses its argv with helpers only:

```
const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const get = (flag: string, def: string): string | undefined => { ... };
const explicitScope = args.includes("--scope") ? get("--scope", "global") : null;
```

(`packages/core/uninstall.ts:17-25`.) Consequences:

- `node packages/core/uninstall.ts --scope bogus` sets `explicitScope = "bogus"`, matches none of the
  `project`/`global` branches, and falls through to **auto-detect** (`uninstall.ts:36-48`). The wrong
  scope can be removed — on the destructive path this is worse than a wrong install.
- `node packages/core/uninstall.ts --scope` (trailing, no value) yields `explicitScope = undefined`
  and likewise auto-detects instead of erroring.
- An unknown flag such as `--dryrun` or a stray word is ignored entirely.

`install.ts` already fixed this exact class for the install path with a validated flag table and a
comment naming the failure mode ("a typo such as `--profle pentest` used to be ignored and run a
default balanced install", `packages/core/install.ts:89-105`), and it rejects an unknown `--scope`
at `install.ts:120`. That behaviour is pinned by `tests/install-marker-smoke.ts:626-686`
(F5/B-025 and TOO-8). The uninstall entry point was never given the same guard.

**Minimal fix.** Add the same validation loop to `uninstall.ts` before the scope resolution:
`VALUE_FLAGS = ["--scope"]`, `BOOLEAN_FLAGS = ["--dry-run", "--yes"]`, reject unknown args, reject a
value flag with a missing/flag-shaped value, and reject a `--scope` other than `global|project`.
Print `[uninstall] <problem>` plus a usage line to stderr and `process.exit(1)`.

**Proving check.** Extend `tests/install-marker-smoke.ts` with a case mirroring
`testInvalidScopeRejected`/`testUnknownFlagsRejected`: run `uninstall.ts` with `--scope bogus`,
`--scope` (no value), and `--dryrun`, assert exit 1, assert the message, and assert no `pi` call is
made (empty `PI_FAKE_LOG`).

### F-2 (priority 6, dead code) — `getExternalByProfile()` is exported but unreferenced

**Evidence.** `packages/core/lib/sources.ts:43` defines and exports `getExternalByProfile()`.
A repository-wide search finds no caller: the only hits are autonomy cycle notes
(`autonomy/cycles/luna-improve-01/08/*.md`). `lib/sources.ts` is not part of a public entry —
`packages/core/package.json` declares only a `bin` map (`pi-system-install`, `pi-system-verify`) and
no `exports` field, and the file is imported by name only for `readSources`/`Sources`
(`capability-matrix.ts:17`, `install.ts:37`, `registry.ts:11`, `verify.ts:22`).

**Minimal fix.** Delete the function. **Proving check.** `npm run test:typecheck` and the existing
`tests/*sources*`/install smoke must stay green.

## Investigated and deferred (with reason)

- **eval `--category` with a missing value** (`packages/core/eval/run.ts:21`): a trailing
  `--category` is silently ignored and the whole fixture set runs. Real but low impact (offline
  eval harness, no destructive effect); it also risks changing a deliberately lenient harness. Left
  for a future cycle; recorded in `BACKLOG.md`.
- **`uninstall.ts` `--scope` value starting with `--`** — covered by the F-1 fix.
- **Installer raw `writeFileSync`** (`packages/core/install.ts:738`): already documented as a known
  pending gap in `docs/future-work.md:95` ("moving them to the safe-write helper is pending"), so it
  is a documented state, not a docs-accuracy mismatch. Out of scope for a small cycle.
- **Cycle 08 known limitation** (read-only `/gate`): recorded already; no action.

## New backlog items to file

- F-1 and F-2 become the cycle-09 work items (no new open items beyond them).
- Deferred: eval `--category` missing-value validation (priority 3, low impact).
