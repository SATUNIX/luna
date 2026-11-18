// Template `dispatch`: a self-improve run (same cycles, gate, merge review, integration branch and
// publication) whose queue is the steward board. Each cycle claims the top ready item of the run's
// streams for one of its engineers, in turn, under control/board.lock (assignee, claimedAt and
// in_progress in one write), works that one item, and reports it with a `Board:` line; a merged
// cycle that reports the item done records submittedAt and the integration head on it. The
// per-cycle claim lives in lib/dispatch.ts; everything else is self-improve's machinery.
import { validateDispatchOptions } from "../dispatch.ts";
import { promotionTargets } from "../promotion.ts";
import { type Template, type TemplateDescription } from "./common.ts";
import { defaults as cycleDefaults, onStepsDone, runStep, seed, validate as validateCycles } from "./self-improve.ts";

const describe = (): TemplateDescription => ({
  id: "dispatch",
  title: "Work a steward board's stream in cycles",
  summary: "Self-improve cycles whose work is the steward board: each cycle claims the top ready item of the run's streams for one of its engineers (atomically, under the board lock), works that one item, and is merged into the integration branch after passing the acceptance checks and a merge review. A merged cycle that reports the item done records its submission on the board. An empty queue sleeps with no model call.",
  finite: false,
  requires: ["inputs.repository (the repository to work on)", "templateOptions.dispatch.streams (the board streams to take items from)", "templateOptions.dispatch.engineers (the agent names cycles claim as, in turn)", "promotion policy (none, local-branch or push)"],
  optional: ["the self-improve options (templateOptions.integration, limits, gate, knownFlakes, emptyQueueSleepMinutes)"],
});

const template: Template = {
  id: "dispatch",
  describe,
  defaults: () => ({ ...cycleDefaults(), objective: { title: "Dispatch steward board items", spec: "Work the steward board item claimed for each cycle until its acceptance is met, with tests and evidence." } }),
  validate: (contract, problems) => {
    validateCycles(contract, problems);
    validateDispatchOptions(contract.templateOptions, problems);
  },
  seed,
  runStep,
  onStepsDone,
  promotion: { targets: promotionTargets },
  finite: false,
};

export default template;
