# Proposal — deduplicate the standing-mode reminder

Status: proposed (not implemented). Author: cycle 25, run `luna-core-01`. Stream: `core`.

## Problem

While ultracode standing mode is on and the `workflow` tool is active,
`packages/extensions/src/effort/index.ts:760-775` appends the full `policy/standing.md` text
inside the effort block **and** returns a hidden `message` with the shorter reminder:

```ts
const reminder = standingShown ? `Reminder: ultracode standing mode is on (size guideline ...); run substantial work as a workflow script, and do small tasks directly.` : null;
const hidden = [reminder, card].filter((text) => text !== null).join("\n\n");
...
return { systemPrompt: withEffortBlock(...), message: { customType: reminder ? STANDING_REMINDER_TYPE : WORKFLOW_CARD_TYPE, content: hidden, display: false } };
```

There is no `lastReminder` state and no reset, so the same string is appended to the session as a
new `custom` (user-role) message every turn while standing mode is on, even though the full
standing text is already in that same turn's system prompt and is re-sent each turn. `docs/effort.md`
records this as an admitted gap: "the hidden reminder is one more message in the session for every
turn while standing mode is on." Measured string length is 152-168 chars (~38-42 tokens), so
50 turns add ~2k tokens of verbatim duplication.

## Suggested fix

Mirror `context-sieve/index.ts:327-336` and the extension's own `cardSeen` lifecycle:

- hold `let lastReminder: string | null = null`;
- emit the reminder only when it differs from `lastReminder` (and update `lastReminder`);
- clear `lastReminder` in the `session_start`/`session_compact` handlers (`index.ts:695,723`)
  and whenever `standingShown` turns false, so re-enabling or changing the size/budget re-emits.

Extend `tests/effort-standing-smoke.ts` (the check at line 178) to assert the reminder appears on
the first turn after enabling, is absent on an unchanged second turn, and appears again after
`/effort uc --size ...` changes it. Update `docs/effort.md` to drop the "Not covered" sentence.

Finding C (the E5 `PLAN_STEER` sentence and the workflow card repeat `exhaustive.md`'s
"one step, one file and one check" rule) can be folded in or handled separately.
