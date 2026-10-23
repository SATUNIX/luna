---
name: feature
description: Scout → plan → implement → review, looping implement↔review until the reviewer passes (max 2 loops).
inputs:
  goal:
    description: What to build or change, with acceptance criteria if you have them
    required: true
  area:
    description: Where in the repo to look (optional hint)
    default: the whole repository
steps:
  - id: scout
    agent: scout
    task: |
      Map the code relevant to this goal: {{inputs.goal}}
      Look in: {{inputs.area}}
      Report: the files and symbols involved (path:line), how this area is tested, and any
      conventions the change must follow. Facts only, no plan.
  - id: plan
    agent: planner
    skills: [task-decomposition]
    task: |
      Goal: {{inputs.goal}}

      Scout findings:
      {{steps.scout.output}}

      Produce a concrete implementation plan: numbered steps, exact files, and the
      verification command for each step. Keep it minimal.
  - id: implement
    agent: implementer
    skills: [patch-hygiene]
    task: |
      Implement this plan for the goal "{{inputs.goal}}":

      {{steps.plan.output}}

      Reviewer feedback from the previous attempt (empty on the first pass):
      {{steps.review.output?}}

      Run the verification commands from the plan and report what you ran and the results.
  - id: review
    agent: reviewer
    task: |
      Review the change made for: {{inputs.goal}}

      Plan it should follow:
      {{steps.plan.output}}

      Implementer's report:
      {{steps.implement.output}}

      Inspect the actual diff (git diff) and run the relevant checks yourself.
      End your reply with a last line that is exactly VERDICT: PASS or VERDICT: FAIL.
    gate:
      pass: "/(?:^|\\n)VERDICT: PASS\\s*$/"
      retry: implement
      max_loops: 2
---

# feature

The standard delegated change. The scout and planner are read-only. The implementer edits.
The reviewer is the gate: the last non-blank line of its reply must be `VERDICT: PASS` (case is
ignored), or the implementer runs again with the review as feedback (at most 2 more times). Any other last line,
including an echoed template such as `VERDICT: PASS or FAIL`, counts as a failed review.

Run it with `/workflow run feature goal="add rate limiting to the /api/orders endpoint"`, or
ask the agent to use `workflow_run`.
