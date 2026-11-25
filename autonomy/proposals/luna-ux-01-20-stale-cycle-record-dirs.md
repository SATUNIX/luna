# Stale `autonomy/cycles/luna-ux-01/<NN>/` records from an earlier run incarnation

## Finding

The trunk already holds cycle record directories for this run name, written by an earlier
incarnation of `luna-ux-01` whose cycle numbers restarted. Their bases and commits are not in this
lineage:

- `autonomy/cycles/luna-ux-01/18/` and `19/` name base `a014133e398a`.
- `22/` names `f19788240eaa`, `24/` `5e6b7a7b0f7f`, `26/` `5e0050c7a539`, `27/` `897ff52bce9c`,
  `28/` `051d491a20b3`, `29/` `337fb705914d`, `30/` `fc5dc46`, `33/` `3925c17a2485`.

Cycle 19 was refused for exactly this: the host attaches `autonomy/cycles/luna-ux-01/<NN>/verify.md`
and, failing a state-home note, `report.md` to the merge review
(`packages/autonomy/lib/templates/self-improve.ts`, `dir = cycleDir(cfg, n)`). A cycle that does not
overwrite its own directory is therefore reviewed against another lineage's plan, verify and report,
and can be rejected for claiming commits and checks the host ledger does not contain.

## Recommendation

The operator (or the host, before a run resumes) should do one of:

1. Scope the record path by a run incarnation id, not only by run name and cycle number, so a
   restarted run cannot inherit an older run's records; or
2. delete the pre-existing `autonomy/cycles/luna-ux-01/` directories that belong to the earlier
   incarnation before the next cycle.

## Why this is not a cycle change

Those files are another lineage's history; rewriting or deleting them inside a work cycle would be
a bookkeeping change the cycle prompt does not assign, so it is raised here instead. Cycle 20 did
nothing to them because `autonomy/cycles/luna-ux-01/20/` does not exist, so its review attaches no
stale record.
