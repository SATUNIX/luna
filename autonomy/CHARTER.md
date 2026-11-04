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
  network beyond what the run was given. If a dependency is warranted, write a proposal in the
  backlog instead.
- Rewriting pushed history. Only fast-forward pushes are accepted.
- Editing `autonomy/CHARTER.md`. Propose charter changes in `autonomy/BACKLOG.md`.

## Priorities

Work in this order, and prefer to finish an item rather than start a new one:

1. A failing acceptance check or a broken pushed state.
2. Unfinished items carried over in `HANDOFF.md`.
3. Correctness and reliability bugs.
4. Security hardening that keeps behaviour compatible.
5. Tests for untested behaviour, then documentation accuracy.
6. Cleanup: code you can show is dead, duplicated or needlessly complex, simplified without
   changing behaviour.
7. Improvements to existing systems: more capability, functionality, performance, reliability
   or usability. Take these on only when nothing above is open.
8. Evaluations and proposals (write-ups with evidence and a recommendation, committed under
   `autonomy/proposals/`).

## Cycle modes

Items 1–6 are **fix mode** and item 7 is **improve mode**. A cycle fixes while there is
something to fix, and improves only when there isn't. An improvement needs the same evidence
as a fix: a measured baseline, a documented limitation, or a gap you can demonstrate. It also
needs tests and docs. The cycle after an improvement starts with a **consolidation** pass over
what changed (bugs, edge cases, missing tests, docs drift, leftover complexity), because new
code is where the next bugs are. So the work cycles: fix → improve → consolidate → fix.

A cycle whose honest review finds nothing to do records `Outcome: nothing found` instead of
inventing work. Several of those in a row end the run.
