---
name: memory
category: memory
description: Save, recall, correct and forget long-term memories in the vault. Use when the user says "remember", "don't forget", "forget that", "what do you know about", states a lasting preference, or a non-obvious decision or gotcha should outlive this session.
disable-model-invocation: true
triggers: ["remember that", "remember this", "don't forget", "do not forget", "forget that", "what do you know about"]
---

# Memory

The memory vault (`~/.pi/vault`, an Obsidian vault) holds what should outlive this session.
Recaps of each turn are written automatically; this skill covers the memories you write on
purpose.

## Save (`memory_save`)

Save when:
- The user asks: "remember …", "note that …", "from now on …". Save it — don't just agree.
- The user states a lasting preference (tools, style, workflow). Use `type: preference` and
  `scope: global` if it applies beyond this project.
- A non-obvious decision was made. Use `type: decision` and put the **why** in the content.
- You hit a gotcha that will bite again (a flaky command, an environment quirk). Use
  `type: gotcha`, and include how to avoid it.

Don't save:
- Anything the code, config, git history or docs already record.
- Task progress or plans for the current session (recaps cover that).
- Secrets, tokens or credentials, ever.

How to save:
- **Title:** short and specific ("Prefers small scoped commits", not "Preference").
- **Content:** one fact per memory. For decisions and gotchas, add a line that says how to
  apply it.
- **Scope:** `project` (the default) for this repo; `global` for things about the user or
  their whole setup.
- Saving a memory with the same or a very similar title updates the existing one. You don't
  need to search first to avoid duplicates.

## Recall (`memory_search`)

- Relevant memories are injected automatically when they clearly match the request. Search
  when you need more, or when the user asks what you know.
- A recalled memory reflects what was true when it was written. Check any file, function or
  flag it names before relying on it.

## Correct and forget

- A memory is wrong or outdated: save the corrected version under the same title (it
  updates in place).
- The user asks you to forget something: `memory_forget` with the note's id or path (it is
  moved to the vault's `.trash`, so it can be recovered).

## After saving

Confirm in one line what you saved and where (the note path the tool returned).
