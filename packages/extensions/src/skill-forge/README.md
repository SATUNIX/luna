# skill-forge

T4 skill synthesis engine. Mines trace-ledger sessions to identify reusable patterns and synthesise new skills into the kit's skills/ corpus. Provides synthesise/score/archive tools for the self-improvement loop.

## skill_score

`skill_score` runs `node <kit>/packages/core/eval/run.ts --json` with the kit checkout as its
working directory, the path resolved from this extension's own location. It never runs the eval
harness of the repository the session is in. The score record is appended to
`<cwd>/.pi/skill-scores.jsonl`. The eval harness is not part of the npm package, so outside a kit
checkout the tool reports the score as unavailable. See `tests/skill-archive-smoke.ts`.

## skill_archive

`skill_archive` moves `.pi/skill-proposals/<name>`, or else the project skill `.pi/skills/<name>`
(legacy `./skills/<name>`), to `.pi/skill-archive/<name>` and writes `ARCHIVE_REASON.txt` into it.
It never deletes an earlier archive: when `.pi/skill-archive/<name>` already exists, the new archive
goes to `.pi/skill-archive/<name>-<epoch ms>` (with a `-2`, `-3`, ... suffix if that is taken too),
and the result names the directory used. See `tests/skill-archive-smoke.ts`.
