---
name: daily-debrief
category: evidence-reporting
description: Run a conversational end-of-day assessment debrief — assess your own notes, interview the tester to fill the gaps, then reconcile findings and organise notes into the house report format. Use when wrapping up a testing session or when asked to debrief.
disable-model-invocation: true
triggers: ["daily debrief", "debrief", "debrief me", "end of day", "end-of-day wrap", "wrap up the day"]
---

# Daily Debrief

A short, conversational wrap-up that keeps the engagement record honest and current. You read what
is already captured, assess it, ask the tester only what you cannot infer, then fold the answers
back into the hypotheses, evidence and findings — ending with items organised into the
`finding-report` house format. It is a back-and-forth, not a form to fill in.

## When to use
- End of a testing session, or any time the tester says "debrief" / "wrap up".

## When not to use
- Mid-test, when a single observation just needs recording — use `hypothesis-lifecycle` directly.

## Procedure
1. **Assess first (before asking anything).** Read the engagement's current state — open and
   finding-ready hypotheses, recorded evidence, methodology coverage, the running report, and your
   own session notes/recaps. Form a picture of what is known, what changed today, and what is
   ambiguous. Stop when you can name the specific gaps only the tester can close.
2. **Interview conversationally.** Ask focused questions a couple at a time, grouped by theme,
   following the tester's lead. Ask only what you could not infer in step 1; confirm, don't
   re-ask, what the notes already show. Theme bank and phrasings: `references/interview-themes.md`.
   Stop when the day's scope, tests, results, new access and captured artefacts are accounted for.
3. **Integrate each answer through its discipline.** New/changed claim → `hypothesis-lifecycle`
   (a transition needs evidence, a limitation, or an operator decision). New artefact →
   `evidence-review` (ID, hash, sensitivity label). Coverage → `methodology-mapper`. Anything
   touching a target → `scope-roe-governance` still gates it. Update the records; do not let the
   debrief invent or inflate a finding.
4. **Organise into the format.** Promote validated, impact-understood items to `finding-report`
   deliverables in the house format; update the running notes/report; draft screenshot captions
   while the context is fresh. Leave unproven items as hypotheses, clearly marked.
5. **Report back.** A concise summary: what changed today, what is now finding-ready, coverage
   gaps, open questions/blockers, and suggested next steps — nothing that outruns the evidence.

## Decision heuristics
- **Infer, then confirm.** A question whose answer is already in the notes wastes the tester's
  attention and erodes trust in the debrief.
- **Two questions, not twenty.** Let answers open the next question; keep it a conversation.
- **Capture the un-logged.** The highest-value things a debrief surfaces are observations the
  tester saw but never wrote down — ask for them explicitly.

## Anti-patterns
- Interrogating with a long checklist up front, or re-asking what the notes already record.
- Promoting a hunch to finding-ready because the tester "is pretty sure" — evidence still rules.
- Writing raw credentials or PII into notes instead of referencing an Evidence ID.
- Treating methodology coverage as authorisation to run an untested active check.

## Done
The day's work is reconciled with the records, new evidence is logged with IDs, coverage is
updated, finding-ready items are rendered via `finding-report`, and the tester has a short summary
with clear next steps. Applies to the pentest reporting workflow.

## References
- `references/interview-themes.md` — the question bank, what to infer vs ask, and the
  intake→discipline mapping.
- Related: `finding-report`, `hypothesis-lifecycle`, `evidence-review`, `methodology-mapper`,
  `scope-roe-governance`, `report-export-review`.
