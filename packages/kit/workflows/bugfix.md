---
name: bugfix
description: Reproduce → root-cause → fix → verify, with the fix gated on a reviewer PASS.
inputs:
  bug:
    description: The symptom, error message, or failing test
    required: true
steps:
  - id: reproduce
    agent: scout
    task: |
      Reproduce this bug without changing any files: {{inputs.bug}}
      Find the smallest command that shows it (a test, a script, a request) and run it.
      Report: the exact reproduction command, its output, and the code path involved (path:line).
      If you cannot reproduce it, say so and report what you tried.
  - id: diagnose
    agent: planner
    task: |
      Bug: {{inputs.bug}}

      Reproduction:
      {{steps.reproduce.output}}

      Identify the root cause (not the symptom) and plan the smallest fix, plus a regression
      test that fails before the fix and passes after it.
  - id: fix
    agent: implementer
    skills: [patch-hygiene]
    task: |
      Fix this bug: {{inputs.bug}}

      Diagnosis and plan:
      {{steps.diagnose.output}}

      Reviewer feedback from the previous attempt (empty on the first pass):
      {{steps.verify.output?}}

      Add the regression test, apply the fix, re-run the reproduction command from:
      {{steps.reproduce.output}}
      Report the before/after results.
  - id: verify
    agent: reviewer
    task: |
      Verify the fix for: {{inputs.bug}}

      Reproduction: {{steps.reproduce.output}}
      Fix report: {{steps.fix.output}}

      Re-run the reproduction and the regression test yourself and inspect the diff.
      End your reply with a last line that is exactly VERDICT: PASS or VERDICT: FAIL.
    gate:
      pass: "/(?:^|\\n)VERDICT: PASS\\s*$/"
      retry: fix
      max_loops: 2
---

# bugfix

Reproduce first, fix second. The reviewer re-runs the reproduction itself. The review passes
only when the last non-blank line of its reply is `VERDICT: PASS` (case is ignored). Anything else sends the fix
step round again with the review attached.
