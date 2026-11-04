# Cycle 06 verify — luna-improve-01

Base: `a385401` (`integration/luna` seed). Head under test: this cycle's record commit.

This cycle changes only `autonomy/cycles/luna-improve-01/06/*`. Per the operator's steering,
`npm run check:all` is **not** run in this session (the supervisor runs the acceptance gate
`/opt/autonomy/gate.sh` on the pushed head). Verification is therefore that the report's factual
claims match `git`.

## Evidence

### Commit list matches `git log a385401..HEAD --oneline`

The report lists all ten pre-existing commits (newest first) plus the cycle-06 record commit. The
five PR #29 carry commits are marked; the other commits are not:

```text
$ git log a385401..HEAD --oneline
<cycle-06 record commit> docs(autonomy): record cycle 06 — list every commit and the true diff stat
92ef9ac docs(autonomy): record cycle 05 — re-applied carried fixes on a clean base
92dbeaf docs(future-work): drop the stale 0.1.0 version claim
794adac test(clean-install): install runtime dependencies offline from a cut lockfile
14d43dd test(firewall): handle a rootless user namespace in the unattended smoke
fe8a128 test(eval): return the environment to its pre-call state after installDelegation
fd76bd3 test(eval): make installDelegation hermetic against ambient kit env vars
f86177c fix(packaging): accept npm 12's object shape from npm pack --json
e6f20e6 docs(autonomy): record cycle 04 review, plan, verify and report
f766593 fix(web-ui): report the real package version instead of hard-coded 0.1.0
3f8ab1b fix(autonomy): stop writing every detached supervisor log line twice
```

### Diff stat is quoted verbatim from `git diff a385401..HEAD --stat`

See the report's "True diff stat" section. The command was re-run after the record commit and its
output pasted unchanged (including this directory's four new files).

### Firewall smoke is not loosened

- `tests/firewall-unattended-smoke.ts:599` (after `14d43dd`):
  `const realStanding = ...currentNamespaceStanding();`
  `const realWhy = realStanding.initialUser ? /neither on a read-only mount nor owned by another user/ : /not in the initial user namespace/;`
- Both real-`/proc` cases call `refused(label, env, realWhy)`, and `refused` always asserts
  `unattended().active === false` and `assert.match(b.stderr, why)`. The default `why` used by every
  synthetic mount-table case is unchanged.
- `git show 14d43dd` shows the only edits are the new exported helper
  (`packages/extensions/src/tool-firewall/unattended.ts:201`) and the two case call sites; no
  assertion was deleted or weakened.

### No `check:all`

Not run, as steered. The previous cycle's `check:all` (203/203) and this cycle's no-op-on-source
scope mean the gate is unchanged by these record files.

## Reviewer

An independent `reviewer` subagent that did not write these records checked this report against the
diff and the charter. The first review returned FAIL because the quoted `--stat` block's bars were
inflated; after the block was replaced with the exact `git --no-pager diff a385401..HEAD --stat
--no-color` output (verified byte-for-byte), the re-review returned **Verdict: PASS** on all six
checks.
