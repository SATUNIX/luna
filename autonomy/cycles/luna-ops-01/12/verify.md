# Cycle 12 verification

Base `e3c7fc9d6a94`, head is the tip (the record commit follows). Every command ran in `/work`;
`npm test` and `npm run check:all` were never run. Each line names the command, the result and the
assertion that proves it.

## Item 1 — PG-60 publish the stuck cycles

- `git push --dry-run origin HEAD` — PASS — `pre-push scan: 0 commit(s) checked, no blocked
  identifiers`; the run branch was already published at `e3c7fc9`.
- `git push --dry-run origin HEAD:refs/heads/stream/ops` (before the re-land) — **refused** — `37
  finding(s) in 25 commit(s)`, naming `3c7c8aede6c2 message line 1`; reproduces supervisor.log:139.
- `git rebase --onto ba62ea1 4431288 pi/luna-ops-01` — PASS — the first-parent cycle-09/10 commits
  replay onto the published `ba62ea1`; `git diff --stat e3c7fc9 fbd5dbd` is empty, so the tree is
  byte-identical and no content changed.
- `node packages/core/prepush-scan.ts range ba62ea1..HEAD` — PASS — `7` (then `8`) `commit(s)
  checked, no blocked identifiers or private paths`.
- `git push origin HEAD:refs/heads/stream/ops` — PASS — fast-forwards `ba62ea1..4dbaa55`; at review
  time `git ls-remote origin refs/heads/stream/ops` equals HEAD (`4dbaa55`, verified by the final
  reviewer), with the last records-only commits on top of `ce0a19a`. The
  stranded old-shape commits (not rewritten, still historical) are `3c7c8ae` (message line 1 is an old-shape board ID) and `22fdf7f`, `f1da979`, `c3a1ecb`, `a482425` on the `6f4a7f3` second parent.
- `git push origin HEAD` (run branch `pi/luna-ops-01`) — PASS — the remote was stranded at
  `e3c7fc9`; it was joined with a `-s ours` merge (`b2a409a`, `git diff HEAD^ HEAD` empty) so the
  push is a fast-forward, no force-push, and `origin/stream/ops` stays `616aa06` with the clean
  lineage.

## Item 2 — installer bad `--profile` plus docs (`af39987`, `e352e35`)

- `npm run test:typecheck` — PASS — `tsc` for root, config, core, autonomy, web-ui, container and
  tests; no errors.
- `npm run test:lint` — PASS — `eslint … --max-warnings 0 .`; exit 0.
- `npm run -s smoke:profile-transaction` — PASS, 32/32 — the check "the real installer reports a
  bogus profile cleanly with exit 2 and no stack trace" spawns the real `install.ts`, asserts
  `r.code === 2`, matches `/Profile not found/`, requires two real profile names, and fails on any
  `/at loadProfile|node:internal/` line. On the base the same command threw from `loadProfile`
  (`install.ts:416`) and exited 1 with a stack, so the test reds there.
- Manual run `node packages/core/install.ts --profile bogus-profile --dry-run` — PASS — prints
  `[install] Profile not found: /work/packages/kit/profiles/bogus-profile.json`, then
  `[install] Valid profiles: autonomous, balanced, lite, long-horizon, pentest, quick,
  self-improving …`, and exits 2 with no stack frame. The catch rethrows unless the message starts
  with `[install] Profile not found:`, so an unreadable or invalid JSON profile keeps its stack.
- `npm run -s smoke:docs` — PASS — `14 documented commands validated, 62 relative links resolved`,
  including the new `docs/INSTALL.md` sentence naming `tests/profile-transaction-smoke.ts`.
- `npm run -s smoke:redaction-corpus` — PASS, all 6 — the cycle-11 red
  (`check-all:smoke:redaction-corpus`) does not reproduce on this tree; it is the timing-shaped
  sub-quadratic growth check, a flake.

## Board items

- `node packages/core/journal.ts --check` — PASS — `journal: every report has a journal entry`.
- `node packages/core/reference.ts --check` — PASS — `docs/reference.md is up to date`.
- PG-20 confirmed met (generator, hard missing-entry rule, duplicate fixture, prompt reference); no
  code changed. PG-53 blocked on operator container config; no control loosened.

## Independent review

- A `reviewer` subagent that did not write the change first reviewed the diff and **FAILed** on two
  points: `origin/stream/ops` was one commit behind HEAD (installer fix unpushed) and the new exit-2
  contract was undocumented. The docs gap is fixed (`e352e35`) and the final `stream/ops` push lands
  HEAD.
- A second reviewer run was interrupted by the harness mid-tool (it confirmed the state facts first).
  A final compact re-review then returned **`VERDICT: PASS`**: narrow catch that rethrows other
  errors, message plus real profile names plus exit 2, test reds on the base without the fix,
  `docs/INSTALL.md` documents the exit-2 case, `origin/stream/ops == HEAD (4dbaa55)`,
  `ba62ea1` an ancestor (fast-forward, no force-push), leak scan clean, and the diff limited to
  `install.ts`, its test, `docs/INSTALL.md` and the journal line.
