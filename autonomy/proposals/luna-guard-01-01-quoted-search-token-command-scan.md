# Proposal: do not treat a quoted search pattern as a secret path

**Run/cycle:** luna-guard-01 / 01
**Area:** guard precision (PG-23 follow-up)
**Evidence:** after commit 9829eac/8f6078b, `commandReferencesSecret` in
`packages/extensions/src/secret-guard/index.ts` tokenises a shell command and tests each path
token. A quoted search pattern is still a token, so a transfer-verb pipeline such as
`rg -n "secret-guard" packages/extensions/src | head -3` is blocked because the token
`secret-guard` matches the broad `/secret/i` basename pattern. The board named `rg -n
"secret-guard" …` as a benign command; without the pipe it is allowed, with `| head` it is not.

## Proposed change

Give tokens a role instead of guessing from text: for `rg`/`grep`, the first non-option argument
after the tool is the pattern, not a path, unless `-f`/`--file` is present; only later path
arguments are scanned. Do the same for `sed` expressions and `awk` programs. Add corpus rows
`rg -n "secret-guard" packages/extensions/src | head -3` and the equivalent `grep "secret-guard"
… | head -3` as must-allow, and keep the existing secret-file and protected-path exfil rows
must-block. Cap the change at this family: no general shell parser.

## Why not this cycle

Cycle 01 already narrowed the whole-line scan to tokens and preserved true positives. A token-role
rule crosses into shell parsing and needs its own two-sided tests; guessing it in this cycle would
risk weakening real exfil detection.
