# schedule

`/schedule list | add <name> <when> -- <prompt> | remove <name> | run-now <name>`: the pi side of
`luna schedule`, which keeps a spec per schedule in the state home and runs it from a systemd user
timer (or a crontab line without systemd). `add` asks through pi's confirm dialog and refuses
without a UI. A command, not a model tool. In no profile: add it under `extensions.add` in
`<agent dir>/pi-kit/overrides.json`. See
`docs/schedule.md`.
