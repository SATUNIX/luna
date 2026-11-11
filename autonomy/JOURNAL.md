# Team journal

One line per autonomy cycle report: `- <run>/<NN> | Board: <ID[, ID]>|none | <outcome> | <summary> [| decisions: autonomy/decisions/<file>.md]`.
`packages/core/lib/journal.ts` and `tests/docs-smoke.ts` keep it in step with
`autonomy/cycles/**/report.md`; search by board ID with `grep <ID> autonomy/JOURNAL.md`.

- luna-improve-01/04 | Board: none | successful | Rejected at merge review for exceeding the review budget, with its real fixes taken up in cycle 05
- luna-improve-01/05 | Board: none | successful | Re-applied the carried fixes on a clean base and ran the full acceptance suite
- luna-improve-01/06 | Board: none | successful | Records correction accounting for every carried commit in the range
- luna-improve-01/07 | Board: none | successful | Closed runtimeLock over optional and peer edges and pinned delegation environment restore
- luna-improve-01/08 | Board: none | successful | Parsed a bare git:// source as git rather than a git:-prefixed path
- luna-improve-01/09 | Board: none | successful | Rejected bad uninstall arguments and removed the dead getExternalByProfile export
- luna-ops-01/02 | Board: A-91, A-01 | successful | Fixed the fail-closed harness check and added the team journal | decisions: autonomy/decisions/luna-ops-01-02-team-journal.md
- luna-core-01/01 | Board: none | successful | Refused a value-less or unknown --category in the eval harness and declared the context-sieve message-budget env var
- luna-ops-01/03 | Board: A-01, A-91 | successful | Added the missing luna-core-01/01 entry that reddened smoke:docs and made the journal check flag an entry with no report | decisions: autonomy/decisions/luna-ops-01-03-team-journal.md
- luna-ux-01/01 | Board: none | successful | Fixed the duplicated narrow status-bar critical-warning merge and made /footer ascii on reach the todo widget
