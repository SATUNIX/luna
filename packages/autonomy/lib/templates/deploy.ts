// Template `deploy`: build, test and deploy INSIDE the run's isolated zone. Like `implement`, but
// the supervisor also starts run-scoped services (permissions.network.services: images pinned by
// tag or digest from the contract's allowlist, hardened like every other container, on the run's
// internal network only) and acceptance may include service health checks. Workers reach the
// services by name. Deploying to anything outside the zone is promotion, which is separate and
// needs a pre-authorised destination or an operator command; a worker never does it.
import type { ContractDraft, ProblemSink } from "../contract.ts";
import type { StepPromptArgs } from "../engine.ts";
import { type Template, type TemplateDescription, FINITE_DEFAULTS } from "./common.ts";
import implement, { evaluate, seed, stepPrompt as implementPrompt } from "./implement.ts";
import { promotionTargets } from "../promotion.ts";

const describe = (): TemplateDescription => ({
  id: "deploy",
  title: "Build and deploy in the zone",
  summary: "Like implement, plus run-scoped services (databases, web servers, queues) that the supervisor starts on the run's internal network so the worker can build, deploy and test against them. Nothing leaves the zone.",
  finite: true,
  requires: ["objective.title", "objective.spec or objective.specFile", "acceptance.checks", "permissions.network.services (at least one)", "permissions.network.serviceImages (the allowlist those images come from)"],
  optional: ["service-health acceptance checks", "permissions.network.egress", "promotion (a separate, pre-authorised step; in-zone deployment is not promotion)"],
});

function validate(contract: ContractDraft, api: ProblemSink): void {
  implement.validate(contract, api);
  if (!contract.permissions.network.services.length) api.err("permissions.network.services", "the deploy template needs at least one run service; use the implement template for work without services");
  if (contract.permissions.network.services.length && !contract.acceptance.checks.some((k) => k.type === "service-health" && k.required)) {
    api.warn("acceptance.checks", "no required service-health check: the run can succeed without proving any service is up");
  }
}

function stepPrompt(args: StepPromptArgs): string {
  const base = implementPrompt(args);
  if (!args.fresh) return base;
  const services = args.contract.permissions.network.services;
  const extra = ["", "## Services", ...services.map((s) => `- ${s.name}: reachable at http://${s.name}:${s.port} from your container${s.workspaceMounts.length ? `; it serves ${s.workspaceMounts.map((m) => `${m.source} (a read-only copy of that directory of your workspace, refreshed by the supervisor after each of your steps) at ${m.target}`).join(", ")}` : ""}`), "Deploy by building into the paths above and by talking to the services over the internal network. Restarting or replacing a service, or exposing anything outside the zone, is not available to you."];
  return `${base}\n${extra.join("\n")}`;
}

const template: Template = {
  id: "deploy",
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
