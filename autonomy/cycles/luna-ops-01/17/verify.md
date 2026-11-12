# Cycle 17 verification — run `luna-ops-01` (stream `ops`)

Order: (a) targeted smokes for each changed file, (b) independent reproduction counts,
(c) upstream-merge checks, (d) journal/docs, (e) publication state. Only targeted `npm run -s
smoke:<name>` / `test:<name>` scripts were run; `npm test` and `npm run check:all` were not.

## (a) Targeted smokes on the branch head (`bfb0b18` + cycle-17 commits)

- `test:typecheck` — PASS (exit 0) — every changed TypeScript file compiles under strict tsconfig.
- `smoke:autonomy-review-inputs` — PASS 23/23 (was 21 before this cycle). The two new checks are
  the PG-63 acceptance fixtures: "a host upstream sync of a large trunk is not counted as the
  cycle's own diff; an oversized own diff is still rejected" and "a conflict-resolving cycle that
  merges a large upstream trunk is judged on its own paths, not the merge side".
- `smoke:autonomy-selfimprove` — PASS 40/40 — the real `mergeDecision` / template path the new
  fixtures drive through is otherwise unchanged.
- `smoke:firewall-gate` — PASS 20/20 — the P0 merge kept both timing guards
  (`assertSubQuadratic` and `assertCpuWithin`).
- `smoke:redaction-corpus` — PASS 6/6 — same, the redaction corpus growth/CPU guards both run.
- `smoke:web-ui-bind-policy` — PASS 23/23 — the check cycle 16 reported red passes on this tree.

## (b) Independent reproduction counts (PG-63)

The fixtures were instrumented once to print the judged-diff length, then the instrumentation was
removed and the file restored (`git diff` clean against the committed fixture). Recorded values:

- host-synced trunk shape: `judged diff = 257 chars`, budget `60000`, `upstream-bulk` absent.
- conflict-resolving shape: `judged diff = 402 chars`, budget `60000`, `upstream-bulk` absent.
- negative control: a `60001`-char own code diff is still refused before the model is asked, with
  `exceeds the merge review's budget of 60000 characters`.

The board's original counts (ux 114034 vs own 32996; ops 60598 vs 60000) are not reachable on this
head: the review already restricts the diff to the multi-parent own set. No production change was
needed; the deliverable is the coverage that pins it.

## (c) P0 upstream merge

- `refs/upstream/trunk` = `5a888fe5dcf2`, merge-base with the cycle-12 head `2e3155f` = `bf6d2bb`.
- `git merge refs/upstream/trunk` conflicted in `tests/firewall-gate-smoke.ts` and
  `tests/redaction-corpus-smoke.ts`; both resolved keeping both intents. Merged as `bfb0b18`.
- `smoke:firewall-gate` and `smoke:redaction-corpus` above pin the retained guards.

## (d) Journal and docs

- `node packages/core/journal.ts` derives the cycle-17 line; `--check` then prints
  `journal: every report has a journal entry`.
- `smoke:docs` — PASS — new `report.md`/`verify.md`/`review.md` claims resolve and the journal
  agrees with the reports.

## (e) Publication state (PG-60)

- `git ls-remote origin refs/heads/stream/ops` = `a7cb461fa43c`; it carries the re-landed cycles
  08, 09, 10, 12 and 15 — the board item's missing 08-10 defect is repaired.
- `git ls-remote origin refs/heads/pi/luna-ops-01` = the pushed merge `bfb0b185`; the run-branch
  range `2e3155f..HEAD` scanned clean ("29 commit(s) checked, no blocked identifiers").
- `node packages/core/prepush-scan.ts range origin/stream/ops..HEAD` refuses: `37 finding(s) in 25
  commit(s)`, first `22fdf7f26dc4 autonomy/cycles/luna-ops-01/08/review.md:70: blocked identifier`.
  The run branch still carries the cycle-12 `-s ours` bridge (`b2a409a`) that pulled the stranded
  `e3c7fc9`/`22fdf7f` ancestry in, so a `stream/ops` fast-forward from it is not possible. The
  re-land onto `a7cb461` is the integrator action recorded in the cycle-16 proposal; `stream/ops`
  was not pushed from here.
