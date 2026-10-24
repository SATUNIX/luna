// Template `implement`: a FINITE task. A specification, a backlog and acceptance checks go in;
// steps continue until every required acceptance check passes (judged by the trusted
// supervisor in a clean, network-less gate container from definitions held in the run
// directory), then an independent review if acceptance.review is set, then the run succeeds.
//
// Template interface (lib/engine.ts calls these; self-improve adds runStep/onStepsDone):
//   describe()            what `templates` shows
//   defaults()            closed defaults merged under the user's contract
//   validate(c, {err, warn})  extra rules
//   seed(ctx)             once, before the first step: publish worker-visible files
//   stepPrompt(args)      the text a worker session gets
//   evaluate(ctx)         trusted judgement of an accepted head: { results, allRequiredPass }
//   promotion.targets(contract, cfg, sha)   what promotion would do
import { type AcceptanceEvaluation, type RunAcceptanceOptions, runAcceptance } from "../acceptance.ts";
import type { ContractDraft, ProblemSink, RunContract } from "../contract.ts";
import type { RunState } from "../lifecycle.ts";
import { promotionTargets } from "../promotion.ts";
import type { StepContext, StepPromptArgs } from "../engine.ts";
import { type Template, type TemplateDescription, FINITE_DEFAULTS, backlogLines, checkLines, clip, resultLines, untrusted, zoneRules } from "./common.ts";

const describe = (): TemplateDescription => ({
  id: "implement",
  title: "Implement a task",
  summary: "Build or change something to a specification, until the acceptance checks pass and an independent review approves it. Finite: it ends when the criteria are met, or a limit is reached.",
  finite: true,
  requires: ["objective.title", "objective.spec or objective.specFile", "acceptance.checks (at least one required check)"],
  optional: ["inputs.repository (start from an existing repository; otherwise from an empty one)", "objective.backlog", "acceptance.overlay (held-out tests)", "permissions.network.egress (dependency downloads through the proxy)", "promotion"],
});

function validate(contract: ContractDraft, { err }: ProblemSink): void {
  if (!contract.objective.spec.trim()) err("objective.spec", "is required for a finite task: give the specification inline (spec) or as a file (specFile)");
  if (!contract.acceptance.checks.some((k) => k.required)) err("acceptance.checks", "needs at least one required check: a finite run ends when its acceptance criteria pass, so it needs something to pass");
}

/** The task as a fresh session first sees it. */
export function taskBlock(contract: RunContract, state: Pick<RunState, "tasks"> | null | undefined): string {
  const lines = [`# Task: ${contract.objective.title}`, "", "You are working on a bounded task for an operator who is not watching. Work until every acceptance check passes.", "", clip(contract.objective.spec, 30_000), ""];
  if (contract.objective.backlog.length) lines.push("## Backlog", ...backlogLines(contract, state?.tasks), "");
  lines.push("## Acceptance (judged by the supervisor, not by you)", ...checkLines(contract), "");
  if (contract.acceptance.review) lines.push("When the checks pass, an independent reviewer compares your change with the original specification. Tests you write are welcome but they are not the criteria: the reviewer and the supervisor's checks are.", "");
  lines.push("## Ground rules", ...zoneRules(contract), "- Commit after each logical change and run `git push origin HEAD`; the supervisor also snapshots your workspace when you stop.", "- /run/contract.json is the machine-readable version of this task; /run/spec.md is the specification.");
  return lines.join("\n");
}

function verifiedBlock(evaluation: StepPromptArgs["evaluation"]): string[] {
  if (!evaluation) return [];
  const lines = ["## Verified state (from the supervisor's checks)", ...resultLines(evaluation.results), ""];
  for (const r of evaluation.results.filter((x) => !x.pass && x.tail)) lines.push(untrusted(`check ${r.id} output`, r.tail, 1500), "");
  return lines;
}

export function stepPrompt({ contract, state, step, fresh, briefing, evaluation, feedback }: StepPromptArgs): string {
  const lines: string[] = [];
  if (fresh) {
    if (briefing) lines.push(briefing, "");
    lines.push(taskBlock(contract, state), "");
    // A briefing already lists the verified results; the failing outputs are still shown, quarantined.
    if (evaluation && (briefing || step > 1)) lines.push(...(briefing ? evaluation.results.filter((x) => !x.pass && x.tail).flatMap((r) => [untrusted(`check ${r.id} output`, r.tail, 1500), ""]) : verifiedBlock(evaluation)));
  } else {
    lines.push(...verifiedBlock(evaluation));
    if (state?.tasks?.length) lines.push("## Task board (the supervisor's)", ...backlogLines(contract, state.tasks), "");
  }
  if (feedback?.length) lines.push("## Notes from the supervisor", ...feedback.map((f) => `- ${f}`), "");
  lines.push(fresh && step === 1 && !briefing ? "Begin. Commit and push as you go, and stop when you believe every acceptance check passes." : "Continue the task. Fix what the failing checks show, keep changes scoped, commit and push. Stop when you believe every acceptance check passes.");
  return lines.join("\n");
}

export async function seed(ctx: StepContext): Promise<void> {
  ctx.publish("acceptance.md", `# Acceptance checks\n\nThese are judged by the supervisor, not by you.\n\n${checkLines(ctx.contract).join("\n")}\n`);
}

/** Trusted judgement: run every check on the accepted head. */
export function evaluate({ rt, contract, sha, step, dir, runRoot, log }: RunAcceptanceOptions): Promise<AcceptanceEvaluation> {
  return runAcceptance({ rt, contract, sha, step, dir, runRoot, log });
}

const template: Template = {
  id: "implement",
  describe,
  defaults: FINITE_DEFAULTS,
  validate,
  seed,
  stepPrompt,
  evaluate,
  promotion: { targets: promotionTargets },
  finite: true,
};

export default template;
