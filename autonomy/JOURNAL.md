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
- luna-core-01/02 | Board: V-11, V-101 | successful | Framed first-prompt memory recall as background history and finished the Luna rename with a brand guard
- luna-core-01/05 | Board: PG-10, PG-27 | successful | Added an opt-in trunk channel for the integration branch and repaired the luna-core-01/02 journal gate
- luna-core-01/06 | Board: PG-10, PG-27 | successful | Added a dated offline eval baseline with a 7-day freshness check and consolidated the trunk channel docs and npm guard
- luna-ops-01/03 | Board: A-01, A-91 | successful | Added the missing luna-core-01/01 entry that reddened smoke:docs and made the journal check flag an entry with no report | decisions: autonomy/decisions/luna-ops-01-03-team-journal.md
- luna-ux-01/01 | Board: V-05 | successful | Added the Luna launch screen with a self-stopping reveal, reduced motion, narrow and ASCII fallbacks, tests and docs
- luna-ops-01/04 | Board: V-41 | successful | Repaired the red smoke:docs journal gate for luna-ux-01/01 and recorded the V-04 /workflow(s) caller inventory
- luna-ux-01/03 | Board: V-01, V-03 | partial | Re-landed the reviewed overlay frame and transcript dim improvements and carried the /settings-into-/menu V-03 work to cycle 04
- luna-ux-01/06 | Board: V-03 | successful | Folded /settings into /menu as the primary command with kit/helpers aliases and a Settings page, and repaired the smoke:docs journal gate for luna-ux-01/03
- luna-ux-01/07 | Board: PG-59, V-05 | successful | Merged upstream trunk preserving both sides, made the trunk-gap notice own the session-start kit notice so pi-compat lanes pass, and re-verified the already-shipped launch screen
- luna-ux-01/08 | Board: V-73, PG-12 | successful | Re-landed the reviewed V-73 alias wording and the alias-target-missing command-contract rule, fixed the withOverlayFrame dim leak when build throws, and re-verified the already-merged PG-12 trunk-ahead notice
- luna-ux-01/09 | Board: V-73 | successful | Made control-centre Back follow the visited-page stack (Settings to Display to Back returns to Settings) and re-verified the already-merged V-73 alias wording and the green luna-ux-01/03 journal gate
- luna-ux-01/02 | Board: V-05 | successful | Consolidated the launch screen onto the menu's TUI predicate so older hosts without ctx.mode still get it; added the undefined-mode tests and re-verified the launch screen
- luna-core-01/07 | Board: PG-27, PG-51 | successful | Converted the CPU-bound smoke timing guards to CPU time (all budgets kept), fixed the skill-router re: trigger guard and a workflow-plan timer race the load-check exposed
- luna-core-01/09 | Board: PG-55, PG-57 | successful | Carried over the blocked-publication stop and made a declared-output step name the absolute output path in its task and its failure
- luna-core-01/10 | Board: PG-55, PG-57 | successful | Made the publish-blocked operator answer resume exactly one cycle, fixing the no-op exit path in the cycle-09 stop
- luna-core-01/11 | Board: none | successful | Carried the PG-51 thread-scoped CPU timing guards and fixed the /compress budget overrun by charging the omission marker and conversation newline to it
- luna-core-01/12 | Board: PG-55, PG-19, V-81 | successful | Made the publish-blocked answer publish by rolling back to the last published head and dropping discarded tags, capped cycle paperwork at 60 lines with a journal-line check, and gave the footprint meter its documented CLI
- luna-ux-01/10 | Board: PG-59, V-05 | successful | Re-verified the already-green update-notice and launch-screen items and re-landed the reviewed control-center fixes: All commands lists each command once, a cancelled RPC value dialog closes the hub, and the hub overlay fits a short terminal
- luna-ux-01/11 | Board: PG-59, V-05 | successful | Re-verified the already-green update-notice and launch-screen items and landed the reviewed overlay inner-width/mouse forwarding and short hidden-command reveal fixes
- luna-ux-01/12 | Board: V-02 | successful | Repaired the cycle 11 journal/board red gate and re-landed its overlay and /kit fixes, then made the human console hold input while a card is open and ask_human hold too, so sibling cards serialise instead of stealing focus (V-02)
- luna-ux-01/13 | Board: PG-09 | successful | Re-landed the reviewed cycle 11/12 work and repaired its rejected red gate by keeping the run broker's two workflow-run cards open while non-run cards wait behind them; PG-09 inbox not started because the diff is already 44307 characters
- luna-core-01/13 | Board: PG-19, V-81 | successful | Re-verified the already-merged paperwork budget and footprint CLI and corrected the stale session_start wipe claim in the integration workflow page and the caveman comment
- luna-core-01/14 | Board: none | successful | Fixed the /compress zero-turn crash and made the footprint CLI reject a malformed baseline cleanly, with targeted smokes and an independent review
- luna-core-01/15 | Board: none | partial | Fixed the memory-vault first-user-prompt recall loss after a custom-message run and removed two grepped dead-code sites, with targeted smokes; the independent reviewer did not return a verdict
- luna-core-01/16 | Board: none | successful | Kept memory-vault pinned/relevant recalls when recaps are oversized and charged context-sieve join separators plus the empty-contribution lastInjected cleanup, each pinned by a test that fails on base; the independent reviewer hung again so an objective base-vs-head check replaced its verdict
