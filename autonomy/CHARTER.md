# Improvement charter

This branch (`integration/luna`, cut from `main` at `62096ffc3643` on 2026-11-03) is improved in
cycles by autonomous runs; every cycle that meets this charter is merged into it, and the next
cycle builds on it. A person reviews it afterwards, and changes reach `main` only
through that person's decision. This charter is how every change is judged. A change that does
not meet it is not an improvement, however large it is.

## Objective

Find and fix real, evidenced problems in this repository, and improve it where the need is demonstrated.

## What counts as an improvement

A change is accepted when all of these hold:

1. **It fixes a real, evidenced problem, or adds clear value.** Examples are a bug reproduced
   by a test, a reliability or security gap shown in the code, a documented behaviour that the
   code doesn't have, or friction that users hit. Cite the evidence (file:line, command
   output, a failing test).
2. **It is tested.** New or changed behaviour has a test that fails without the change and
   passes with it, in the repository's own test conventions.
3. **It is documented.** User-visible behaviour, commands, settings and interfaces are updated
   wherever the repository documents them, in the same change.
4. **The acceptance checks pass.** The supervisor runs these on the pushed head, in a clean
   clone with no network. Their definitions are held outside this repository, so they cannot be
   edited from here:

- gate (required): `/opt/autonomy/gate.sh`

5. **It is scoped and reviewable.** It is one logical change per commit, and there is no
   repo-wide reformatting or tidying of unrelated files. Commit messages say what the finding
   was, its root cause, the fix and how it was verified.

## Out of bounds

- Weakening, disabling, skipping or deleting security controls, checks or tests, or loosening a
  test so that it passes.
- Changing CI secrets, credential handling, release tags, versions or release and publish
  pipelines.
- Adding or upgrading dependencies, unless the objective says otherwise. The workspace has no
  network beyond what the run was given. If a dependency is warranted, write a proposal at
  `autonomy/proposals/<run>-<NN>-<slug>.md` instead.
- Rewriting pushed history. Only fast-forward pushes are accepted.
- Editing `autonomy/CHARTER.md`. Propose charter changes in `autonomy/proposals/<run>-<NN>-<slug>.md`.

## Priorities

Work in this order, and prefer to finish an item rather than start a new one:

0. Red gate / broken branch: repair a failing acceptance check or broken pushed state.
1. An upstream merge conflict: merge `refs/upstream/trunk`, preserve both sides' intent and re-verify.
2. The steward board items in order, with their acceptance criteria. These outrank cleanup and your own ideas.
3. Unfinished items carried over in `autonomy/runs/<run>/HANDOFF.md`.
4. Defects you find: correctness and reliability bugs.
5. Security hardening that keeps behaviour compatible.
6. Tests for untested behaviour and documentation accuracy.
7. Cleanup: code shown to be dead, duplicated or needlessly complex.

Own new ideas go into `autonomy/proposals/<run>-<NN>-<slug>.md` as proposals, not into this cycle, unless they
block an assigned item. The steward decides which proposals become assignments.

## Cycle modes

Use **fix mode** for repairs and **improve mode** for assigned board improvements. Every improvement needs evidence, tests and docs. Consolidate previous
improvements after higher-priority gate, upstream conflict and board work.
Run the targeted tests for what you changed. Never run `npm test` or `npm run check:all`
yourself: the host gate runs the full suite on a clean checkout.

A cycle whose honest review finds nothing to do records `Outcome: nothing found` instead of
inventing work. Several of those in a row end the run.
