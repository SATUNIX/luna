---
argument-hint: "[failure or context]"
---

# Code Recover

Recover a coding task after failure or interruption.

Context: ${@:-the latest failure or interruption}

Return:

- Current status
- Latest checkpoint
- Dirty files
- Failing command or error
- Safe next action

Do not revert unrelated changes.
