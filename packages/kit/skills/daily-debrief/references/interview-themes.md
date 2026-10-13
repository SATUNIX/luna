# Daily Debrief — Interview Themes (reference)

A bank to draw from, not a script to read out. For each theme, **infer from the notes first**, then
ask only the gap. Keep it to a couple of questions at a time and follow the tester's answers.

## Themes

**Scope & assets**
- Infer: which in-scope hosts/apps the day's activity touched.
- Ask: "Anything you looked at today that isn't on the asset list yet?" / "Any new hosts, subdomains or endpoints surface?"

**What was tested** (→ `methodology-mapper`)
- Infer: methodology areas the recorded activity covers.
- Ask: "Which areas did you actually exercise today?" / "Anything you expected to test but didn't get to?"

**Results — worked, failed, inconclusive** (→ `hypothesis-lifecycle`)
- Infer: hypotheses whose state the evidence already moved.
- Ask: "What landed?" / "What looked promising but you couldn't confirm?" / "Anything that failed in a way worth noting?"

**Un-logged observations** (highest value)
- Infer: nothing — these are by definition not written down.
- Ask: "Anything you noticed but didn't log — odd behaviour, a stack trace, a verbose error, something that felt off?"

**New access or credentials** (→ `evidence-review`, keep secrets out of prose)
- Infer: access changes implied by recorded evidence.
- Ask: "Did you gain any new access or creds today, and where are they stored?" (record by Evidence ID, never paste the secret).

**Artefacts & screenshots** (→ captions for `finding-report`)
- Infer: artefacts already in the evidence store.
- Ask: "Which screenshots or captures did you take, and what does each one show?" Draft a caption per image while it's fresh.

**Blockers & ROE** (→ `scope-roe-governance`)
- Ask: "Anything blocked you — access, scope ambiguity, something you want operator sign-off on before continuing?"

**Tomorrow**
- Ask: "What's the first thing you want to pick up next session?" Capture as candidate next steps, subject to scope/ROE.

## Intake → discipline mapping

| Tester says… | Route through | Resulting record |
|---|---|---|
| "I confirmed X" | `hypothesis-lifecycle` + `evidence-review` | hypothesis → validated / finding-ready, with Evidence IDs |
| "I think X but couldn't prove it" | `hypothesis-lifecycle` | hypothesis stays candidate/inconclusive |
| "I grabbed this screenshot/capture" | `evidence-review` | artefact with ID, hash, sensitivity label; caption drafted |
| "I got creds / new access" | `evidence-review` | referenced by Evidence ID; secret not written to prose |
| "I tested area Y" | `methodology-mapper` | coverage updated; gaps surfaced as candidates |
| "I'm blocked on Z" | `scope-roe-governance` | open question / operator decision recorded |

## What a good debrief is not
- Not a replacement for logging during the test — it reconciles, it doesn't back-fill from memory alone.
- Not a place to upgrade a hunch. If the evidence isn't there, it stays a hypothesis.
- Not an authorisation step. Coverage gaps and "tomorrow" items are candidates, still gated by scope/ROE.
