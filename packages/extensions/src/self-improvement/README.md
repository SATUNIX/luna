# self-improvement

The `/improve` cycle mines the local trace ledger (`.pi/trace.jsonl`) for recurring
inefficiencies and proposes a reviewable diff that adds "Learned notes" to `AGENTS.md`.
It never calls a model and never commits.

## Behaviour

- `buildProposal` reads the last 1MB of `.pi/trace.jsonl` and derives deterministic notes
  (repeated reads of the same target, a high tool-result error rate). Only path-like targets
  (one token of letters, digits and `_ . / @ ~ + * ? = , : -`, at most 160 characters) can
  become a note; a target with spaces, backticks, newlines or markdown is dropped, so a shell
  command or grep pattern from the trace never reaches `AGENTS.md`
  (`tests/self-improvement-smoke.ts`, case 10). A trace field of the wrong type (a non-string
  tool or target) is dropped when the trace is read, so it never becomes a note
  (`tests/self-improvement-smoke.ts`, case 11).
- `/improve` always writes the summary, the notes hash and a unified diff preview to
  `.pi/self-improvement/proposal-<timestamp>.md`, and the exact notes with their hash to
  `proposal-<timestamp>.json`. The notice names the proposal id to arm
  (`tests/self-improvement-smoke.ts`, case 9).
- The notes are only written to `AGENTS.md` when explicitly armed with `/improve arm <id>`
  (or `/improve arm`, which takes the lexically last id in the exact
  `proposal-YYYY-MM-DDTHH-MM-SS-mmmZ` stamp format; other names are ignored or refused).
  Arming never mines the trace again: it applies the notes stored for that proposal, and
  refuses (writing nothing) when any stored note is not one of the two `buildProposal`
  templates (a read note's target must also be path-like), or when the notes do not match the
  hash in the `.json` and in the `.md`. The hash is only a consistency check between the two
  files, not proof of who wrote them; the template check is what limits what can be applied
  (`tests/self-improvement-smoke.ts`, case 9). Applying is idempotent: notes already present
  are not duplicated (`tests/self-improvement-smoke.ts`, cases 2, 3 and 6).
- The preview and the applied file share the same section model (`mergeNotes`), so the
  reviewed diff is exactly what gets written (`tests/self-improvement-smoke.ts`, cases 1 and 7).
  With no signal, or when every note is already present, the diff contains no added lines
  (`tests/self-improvement-smoke.ts`, cases 4 and 6).

## Configuration

None. Applying always needs `/improve arm`; there is no environment variable that applies a
proposal.
