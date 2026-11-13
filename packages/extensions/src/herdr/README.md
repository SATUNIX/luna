# herdr

Optional herdr integration: inside a herdr pane it raises a herdr notification, and the pane's
blocked state, when Luna waits on an approval or a question, when a verify check fails, and when a
long run ends. Outside herdr it does nothing. Registers no tools or commands.

Other extensions announce themselves on the `luna:attention` bus channel and never import this one.
See `docs/herdr.md` for events, variables and limits.
