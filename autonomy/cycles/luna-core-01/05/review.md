# Review — cycle 05, run `luna-core-01`, stream `core`

Base `266dcf6e2ef5` (head of `stream/core`, which merges `integration/luna`), branch
`pi/luna-core-01`.

## Mode

**Fix** first (the P0 red CI gate, priority 0), then **improve** for board item PG-10. The
previous merged cycle was improve work, so a fix-and-cleanup pass over it is folded into the
gate fix.

## Situation

Cycle 04 was rejected at acceptance, not on its merits: the run's acceptance listed
`check-all`, `check-all:smoke:env-isolation`, `check-all:smoke:redaction-corpus` and
`check-all:smoke:workflow-resume` red. Its commits, report and handoff live on
`origin/attempts/luna-core-01/cycle-04`. The three named smokes and `smoke:docs` all pass on
this base (see `verify.md`), so the red set was the one gate failure cascading through
`check-all`. The steward board names the same single cause: PR #62 fails `verify (2)`,
`coverage` and both `pi-compat` lanes on `smoke:docs`.

## Finding 1 (P0) — `smoke:docs` fails on the merged candidate

Evidence, reproduced on a clean tree:

```
$ node tests/docs-smoke.ts
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
+ [ 'report with no journal entry: luna-core-01/02; add:
    - luna-core-01/02 | Board: none | **successful** | <summary>' ]
```

Root cause, confirmed by reading `packages/core/lib/journal.ts`:

1. `autonomy/JOURNAL.md` has no `luna-core-01/02` entry (`autonomy/JOURNAL.md:12-15` stops at
   `luna-core-01/01`).
2. Cycle 02's report wrote its board lines as `- Board: V-11 done — ...` (bullet prefix, em
   dash). The checker's `REPORT_BOARD = /^Board: (.+?) (done|progress|blocked) - /gm`
   (`packages/core/lib/journal.ts:28`) matches no board, so the journal entry and the report
   would still mismatch on `sameSet` (`:129`).

The operator's steer and the steward backlog agree on this fix. Carried over from cycle 04 as
`4ab96f8` (cherry-pick of `3dc5da8`), re-verified here.

## Finding 2 (PG-10) — no `trunk` channel

`packages/extensions/src/kit-update/index.ts:471` inferred a git channel as only `next` (no
ref), `latest` (exact tag) or the raw ref; `:543` built `tags` as only `{latest, next}`;
`:1035` accepted `latest|next|X.Y.Z`. `packages/core/lib/distribution.ts:130` had the same
grammar, and `packages/core/install.ts` resolved only `next` and `latest`/pinned. So a source
pinned to `integration/luna` was an opaque pin, never a canary — the board's measured gap: 19
commits / +658 lines on `integration/luna` unseen while `luna.wt/live` sat on `v0.3.0-beta.2`.

Carried over from cycle 04 as `27d638b` + `2be85f8`, with the commit-message id reworded to
`PG-10`. A `reviewer` subagent that did not write it reviewed the whole diff and returned
`VERDICT: PASS`, with `latest` still the default and `trunk` reachable only by explicit
request or a registered `@integration/luna` ref.

## Candidate items checked but not taken

- **PG-27 (eval baseline).** A scout confirmed it is genuinely absent: no
  `packages/core/eval/baseline.ts`, no `tests/eval-baseline-smoke.ts`, no score artifact
  (only the unrelated `fixtures`/`footprint-baseline.json`); `npm run eval` runs 17/17
  fixtures but records nothing. Deferred: the reviewable diff is already 49,852 chars, past
  the 30,000 stop-new-items mark and near the 60,000 read budget. Carried in the handoff.
- **`trunk` on npm delivery.** A scout found `--mode npm --channel trunk` would resolve to
  `npm:@satunix/pi-system@trunk`, a dist-tag that does not exist
  (`packages/core/install.ts:272`, `packages/extensions/src/kit-update/index.ts:624,1075`).
  The npm path is currently disabled (`npmDeliveryEnabled()` is false in the shipped
  distribution), so it is not a live-path defect; filed as
  `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`.
- **Channel prose enumerations.** `docs/index.md:40`, `docs/architecture/profiles-and-install.md:252`,
  `docs/repository-topology.md:24-25`, `docs/migration.md:7` still list only `latest`/`next`.
  No gate depends on them; folded into the same proposal.
- Proposal `luna-core-01-03-codeowners-dead-path.md`: `.github/` is a control path; stays a
  proposal.
- Cycle 03's env-ownership work is on `origin/attempts/luna-core-01/cycle-03` only; not
  re-verified on this base, no room in this cycle.
