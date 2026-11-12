# Cycle 07 — Review (run luna-ops-01, stream `ops`)

Base: `0b8b2c9bceb2` (head of `stream/ops`, cycle start). Branch: `pi/luna-ops-01`.
Charter read in full. Board items DE-105 and DE-106 were already delivered in cycle 06 and are
merged into this base; this review checks the current code for remaining, evidenced ops defects.
Read cycle 06's report, review and plan, this run's proposals and HANDOFF. No red gate and no
upstream conflict on this base.

## Board items: already merged, re-checked

- **DE-105**: `tests/perf-budget.ts:21-25` takes an injected clock; `tests/redaction-corpus-smoke.ts:176-214`
  drives check 5 with a deterministic fake clock. Check 4 and `tests/firewall-gate-smoke.ts` keep real
  timing. Re-run `npm run -s smoke:redaction-corpus` to confirm.
- **DE-106**: `.github/workflows/ci.yml:24-51` shards verify and pi-compat; `:62-125` shards coverage
  and merges raw V8 reports. Coverage remains measure-only by reviewed policy (`25f9c40e`), so there is
  no threshold for the merge job to enforce; cycle 06 wrote the threshold-policy proposal. The
  12-minute PR wall-time target cannot be measured offline; host PR runs remain the measurement.

## Defects found in the stream's area (priority 4)

1. **Project-scope install writes the global `.env`** (`packages/core/install.ts:758-771`). The
   scaffold target is always `path.join(globalAgentDir(), ".env")`, regardless of `--scope project`.
   `docs/INSTALL.md:70` promises project scope writes only the project's `.pi/settings.json` and
   `.pi/.pi-kit.json`. A scout reproduced `--dry-run --scope project` printing
   `would scaffold <agent dir>/.env`, and a real run would create it. Root cause: the scaffold block
   predates scoping and was never gated on `scope === "global"`.
2. **`--help` is handled after argument validation** (`packages/core/install.ts:98-115`).
   `install.ts --help --profile` reaches validation first and exits 1 for the missing `--profile`
   value, while `docs/INSTALL.md:58` promises `--help` prints usage and exits 0 before any install
   work. Root cause: the help check was moved after validation without covering a help flag combined
   with a malformed value flag.
3. **`--for-changed` bypasses unknown `--skip` validation** (`packages/core/check-all.ts:499-509`).
   The plan branch returns before `unknownSkips`, so `check-all --for-changed=README.md --skip=evl`
   exits 0 while `--list --skip=evl` exits 2. Root cause: plan mode was added ahead of the existing
   skip validation; the file header still documents a misspelt skip as exit 2.

## Not found / not this cycle

No evidence of a remaining DE-105 flake in check 5; the real-timing check 4 is intentional. No
coverage threshold policy change is made here. Any unrelated issue goes to a proposal file.

## Mode

**Fix mode**: three concrete defects in the installer and the check-all CLI, each with a
reproduction and a small, testable fix. The board items are verified, not redone.
