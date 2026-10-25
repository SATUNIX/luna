// Template `self-improve`: the original behaviour of packages/autonomy, now ONE optional
// template. Repeated cycles (review, plan, improve, verify, record) on a repository, each merged
// into one configurable integration branch only when it completes, passes the acceptance checks
// (the gate) and passes a merge review; fix / improve / consolidate modes; a manager model that
// is asked only on triggers (lib/triggers.ts, lib/manager.ts); a stop when reviews keep
// finding nothing. Nothing is published unless the contract's promotion policy and destinations
// say so, and by default only into a LOCAL branch.
//
// A "step" of the engine is one cycle. The in-session control loop is lib/cycle.ts (unchanged);
// this module wires it to the engine: seeding the integration branch, starting and closing
// cycles, the merge decision, and the run's end (cycles done, or nothing found several times).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CheckEvidence, runAcceptance, summariseEvaluation } from "../acceptance.ts";
import type { ContractDraft, ProblemSink, RunContract } from "../contract.ts";
import { type CycleDecision, type CycleOutcome, type CycleResult, type CycleRuntime, runCycle } from "../cycle.ts";
import { isPositiveCpus, isPositiveSize } from "../containment.ts";
import { LockLost } from "../errors.ts";
import * as gm from "../gitmirror.ts";
import type { RunState, SelfImproveState } from "../lifecycle.ts";
import { decide } from "../manager.ts";
import { promotionTargets } from "../promotion.ts";
import { CHARTER_PATH, type CycleReview, REVIEW_DIFF_BUDGET, controlChanges, reviewCriticalPaths, reviewCycle, scriptTargets } from "../review.ts";
import { globProblem } from "../glob.ts";
import type { RunConfig } from "../runcfg.ts";
import { type ReportMode, type ReportOutcome, nothingFoundInARow, reportOutcome } from "../triggers.ts";
import { isPlainObject, writeJsonAtomic } from "../fsutil.ts";
import type { StepContext } from "../engine.ts";
import { type Template, type TemplateDescription, checkLines } from "./common.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pad = (n: number): string => String(n).padStart(2, "0");

export const SELF_IMPROVE_LIMITS = { softMinutes: 180, hardMinutes: 300, idleMinutes: 20, noCommitMinutes: 90, managerCallsPerCycle: 3, redGatesInARow: 2, guardEscalations: 3, nothingFoundToStop: 3 };

/** One finished cycle, as state.selfImprove.history and steps/NN/cycle.json record it. */
export interface CycleEntry {
  n: number;
  outcome: CycleOutcome;
  reason: string;
  attempts: number;
  /** The integration head the cycle started from. */
  start: string;
  head: string;
  gate: "skipped" | "green" | "red";
  gateFailing: string[];
  reportOutcome: ReportOutcome | null;
  mode: ReportMode | null;
  merged: boolean;
  mergeReason: string;
  review: CycleReview["verdict"] | null;
  costUsd: number;
  decisions: Array<Pick<CycleDecision, "decision" | "reason" | "triggers">>;
  startedAt: string;
  endedAt: string;
}

/** The acceptance gate of one cycle: skipped when the cycle made no commits. */
interface CycleGate {
  skipped: boolean;
  green: boolean;
  results: CheckEvidence[];
}

/** Whether a cycle merges, and why. */
interface MergeDecision {
  merge: boolean;
  reason: string;
  review?: CycleReview["verdict"];
  merged?: boolean;
}

/** The run configuration with the integration branch the template's validation requires. */
type SelfImproveConfig = RunConfig & { readonly integrationBranch: string };

/** The context's config, narrowed: a self-improve contract always names its integration branch. */
function siConfig(cfg: RunConfig): SelfImproveConfig {
  const { integrationBranch } = cfg;
  if (integrationBranch === null) throw new Error("the self-improve template needs templateOptions.integration.branch");
  return { ...cfg, integrationBranch };
}

/** state.selfImprove, which seed creates before any cycle runs. */
function siState(state: RunState): SelfImproveState {
  if (!state.selfImprove) throw new Error("state.selfImprove is missing: the self-improve template was not seeded");
  return state.selfImprove;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const describe = (): TemplateDescription => ({
  id: "self-improve",
  title: "Improve a repository in cycles",
  summary: "Repeated improvement cycles on a repository: each cycle reviews, plans, improves and verifies, and is merged into one integration branch after passing the acceptance checks and a merge review. Ends on the cycle, budget or time limit, or when several reviews in a row find nothing to do. Optional: it is one template among several.",
  finite: false,
  requires: ["inputs.repository (the repository to improve)", "promotion policy (none, local-branch or push)"],
  optional: ["templateOptions.integration.branch (default pi-autonomy/integration)", "templateOptions.limits", "inputs.references"],
});

const defaults = (): Record<string, unknown> => ({
  objective: { title: "Autonomous improvement", spec: "Find and fix real, evidenced problems in this repository, and improve it where the need is demonstrated." },
  // No default check: what "good" means is the operator's to define for their repository (the kit's own gate script is /opt/autonomy/gate.sh in the default image).
  acceptance: { review: true, checks: [], overlay: [] },
  permissions: { writeAreas: ["**"], network: { egress: [], services: [], serviceImages: [] }, credentials: { names: [] }, outputs: { destinations: [] }, unattended: { authorised: false, autoApprove: false } },
  model: { provider: "openrouter" },
  effort: "standard",
  budget: { totalUsd: 100, perStepUsd: 5, maxSteps: 50, maxMinutes: 14_400 },
  recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 8 },
  promotion: { policy: "local-branch", destinations: [], requiresOperatorApproval: false },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, perStepHardUsd: null, limits: { ...SELF_IMPROVE_LIMITS }, gate: { memory: "6g", cpus: "4" } },
});

function validate(contract: ContractDraft, { err, warn }: ProblemSink): void {
  const repo = contract.inputs.repository;
  if (!repo) err("inputs.repository", "the self-improve template improves an existing repository: set inputs.repository (path or url, and ref)");
  const t = contract.templateOptions;
  const ib = isPlainObject(t["integration"]) ? t["integration"]["branch"] : undefined;
  const allowed = ["integration", "perStepHardUsd", "limits", "gate"];
  for (const key of Object.keys(t)) if (!allowed.includes(key)) warn(`templateOptions.${key}`, "unknown key ignored");
  // The acceptance gate's container limits (runcfg.ts): a 0 would start it unlimited (containment.ts limitProblems).
  const gate = t["gate"];
  if (gate !== undefined && !isPlainObject(gate)) err("templateOptions.gate", "must be an object with memory and cpus");
  else if (gate !== undefined) {
    const { memory, cpus } = gate;
    if (memory !== undefined && !(typeof memory === "string" && isPositiveSize(memory))) err("templateOptions.gate.memory", 'must be a size above zero, like "6g": the container engines read 0 as no limit');
    if (cpus !== undefined && !(typeof cpus === "string" ? isPositiveCpus(cpus) : typeof cpus === "number" && cpus > 0)) err("templateOptions.gate.cpus", 'must be a number above zero, like "4": the container engines read 0 as no limit');
  }
  const integration = isPlainObject(t["integration"]) ? t["integration"] : {};
  const controlPaths = integration["controlPaths"];
  if (controlPaths !== undefined) {
    if (!Array.isArray(controlPaths) || controlPaths.length > 100) err("templateOptions.integration.controlPaths", "must be an array of at most 100 repository path globs");
    else for (const [i, glob] of controlPaths.entries()) { const problem = globProblem(glob); if (problem) err(`templateOptions.integration.controlPaths[${i}]`, problem); }
  }
  const allowControl = integration["allowControlChanges"];
  if (allowControl !== undefined && typeof allowControl !== "boolean") err("templateOptions.integration.allowControlChanges", "must be true or false");
  if (allowControl === true) warn("templateOptions.integration.allowControlChanges", `cycles may change ${CHARTER_PATH}, the controlPaths and package.json scripts; the merge review is then the only check on them`);
  if (typeof ib !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(ib) || ib.includes("..") || ib.endsWith("/") || ib.endsWith(".lock")) err("templateOptions.integration.branch", "must be a valid branch name");
  else if (["main", "master", "head", "trunk", "develop", "development", "production", "prod", "stable"].includes(ib.toLowerCase()) || /^(release|releases|hotfix|refs)(\/|$)/i.test(ib) || ib === repo?.ref) err("templateOptions.integration.branch", `"${ib}" is a protected name or the base ref; the integration branch is a separate branch a person reviews and merges from`);
  const l = isPlainObject(t["limits"]) ? t["limits"] : {};
  // A limit that is not a number fails the checks below (runtimeConfig would silently use the default).
  const limit = (key: keyof typeof SELF_IMPROVE_LIMITS): number => { const v = Object.hasOwn(l, key) ? l[key] : SELF_IMPROVE_LIMITS[key]; return typeof v === "number" ? v : NaN; };
  const [idleMinutes, noCommitMinutes, softMinutes, hardMinutes, nothingFoundToStop] = [limit("idleMinutes"), limit("noCommitMinutes"), limit("softMinutes"), limit("hardMinutes"), limit("nothingFoundToStop")];
  if (!(idleMinutes > 0 && noCommitMinutes > 0 && softMinutes > 0 && hardMinutes > softMinutes)) err("templateOptions.limits", "must be positive, with hardMinutes > softMinutes");
  if (!Number.isInteger(nothingFoundToStop) || nothingFoundToStop < 1) err("templateOptions.limits.nothingFoundToStop", "must be an integer >= 1");
  const perStepUsd = contract.budget.perStepUsd ?? NaN;
  const totalUsd = contract.budget.totalUsd ?? NaN;
  const hardOption = t["perStepHardUsd"] ?? 2 * perStepUsd;
  const hard = typeof hardOption === "number" ? hardOption : NaN;
  if (!(hard >= perStepUsd) || !(totalUsd >= hard)) err("templateOptions.perStepHardUsd", "must satisfy budget.perStepUsd <= perStepHardUsd <= budget.totalUsd");
  const p = contract.promotion;
  if (p.policy === "none") warn("promotion.policy", 'policy "none": merged cycles stay in the run\'s own mirror; use `export` to take them out. A later run cannot continue this run\'s integration branch.');
  if (p.policy === "local-branch") for (const d of p.destinations) if (d.branch !== ib) err("promotion.destinations", `a self-improve local-branch destination must be the integration branch "${String(ib)}"`);
  if (p.policy === "push") for (const d of p.destinations) if (d.branch !== ib) err("promotion.destinations", `a self-improve push destination must be the integration branch "${String(ib)}" (the working branch is never published)`);
  if (!contract.acceptance.checks.some((k) => k.required)) err("acceptance.checks", "needs at least one required check: the gate every cycle must pass (for example { \"id\": \"tests\", \"run\": [\"npm\", \"test\"] })");
}

// --- seeding ----------------------------------------------------------------------------------------
const backlogRows = (contract: RunContract): string => contract.objective.backlog.map((i) => `| ${i.id} | open | P2 | ${(i.detail ? `**${i.title}.** ${i.detail}` : i.title).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ")} | Operator's brief |`).join("\n");

/** Integration branch: adopted from the destination, or created from the base with the seed files; the working branch at its head. */
async function seed(ctx: StepContext): Promise<void> {
  const { repo, contract, store, log, rt } = ctx;
  const cfg = siConfig(ctx.cfg);
  const g = repo.git();
  const base = g(["rev-parse", `refs/base/${cfg.baseRef}`]);
  if (gm.remoteHasRunTags(g, cfg)) throw new Error(`tags ${cfg.tagPrefix}* already exist on the integration remote; pick a new run id`);
  const vars = { RUN: cfg.run, BRANCH: cfg.integrationBranch, BASE: base.slice(0, 12), BASE_REF: cfg.baseRef, DATE: new Date(rt.now()).toISOString().slice(0, 10), OBJECTIVE: contract.objective.spec, CHECKS: checkLines(contract).join("\n"), BACKLOG_ROWS: backlogRows(contract) };
  const seedArgs = { seedDir: path.join(PKG, "seed"), tmpDir: store.p.tmp, vars };
  const sync = gm.syncIntegration(g, cfg);
  if (sync.state === "absent" || sync.head === null) { // head is null exactly when the branch is absent
    gm.seedBranch(g, cfg, seedArgs);
    log(`created ${cfg.integrationBranch} from ${cfg.baseRef} ${base.slice(0, 12)} with the seed files`);
  } else {
    log(`continuing ${cfg.integrationBranch} at ${sync.head.slice(0, 12)}`);
    if (gm.fileAt(g, sync.head, "autonomy/CHARTER.md") === null) gm.seedBranch(g, cfg, { ...seedArgs, parent: sync.head });
    const m = gm.mergeBaseIntoIntegration(g, cfg);
    if (m.merged) log(`merged ${cfg.baseRef} ${base.slice(0, 12)} into ${cfg.integrationBranch} (${m.sha.slice(0, 12)})`);
    if (!m.merged && m.conflict) log(`${cfg.baseRef} does not merge cleanly into ${cfg.integrationBranch}; continuing without it (merge it by hand to bring it in)`);
  }
  const head = gm.startCycleBranch(g, cfg);
  await rt.setWorkerBranch(head, []);
  ctx.save((s) => { s.selfImprove = { history: [], merged: 0, lastGoodSha: head, seedSha: head, current: null, lastPushed: null }; (s.setup ??= {}).base = head; });
  publishNow(ctx);
}

/** Cycle-level publication: only when the contract lets the supervisor publish unasked, and only to the listed destination. */
function publishNow(ctx: StepContext): void {
  const { repo, contract, state, log } = ctx;
  const p = contract.promotion;
  if (p.policy === "none" || p.requiresOperatorApproval) return;
  const si = siState(state);
  try {
    const r = gm.publish(repo.git(), siConfig(ctx.cfg), si.lastPushed);
    si.lastPushed = r.state;
    if (si.publishError) { log("publish recovered"); si.publishError = null; }
  } catch (e) {
    const message = errorMessage(e);
    if (message !== si.publishError) log(`publish failed (will retry): ${message}`);
    si.publishError = message;
  }
}

// --- one cycle ----------------------------------------------------------------------------------------
const cycleDir = (cfg: Pick<RunConfig, "run">, n: number): string => `autonomy/cycles/${cfg.run}/${pad(n)}`;

function cyclePrompt(ctx: StepContext, n: number): string {
  const { state, contract } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const last = si.history.at(-1);
  const dir = (k: number): string => cycleDir(cfg, k);
  let previous = "This is the first cycle of this run; earlier runs' cycles, if any, are recorded under autonomy/cycles/.";
  if (last) {
    previous = `Cycle ${pad(last.n)} ended ${last.outcome} (${last.reason}); acceptance ${last.gate}${last.gate === "red" ? ` (failing: ${last.gateFailing?.join(", ") || "see the check output"})` : ""}; `;
    if (last.merged) {
      previous += `merged into ${cfg.integrationBranch}. Its report is ${dir(last.n)}/report.md.`;
      if (last.mode === "improve") previous += " It was an improve cycle, so this cycle starts with a consolidation pass over what it changed (bugs, edge cases, missing tests, docs drift, leftover complexity) before anything else.";
      if (last.reportOutcome === "nothing found") previous += ` Its review found nothing to do${nothingFoundInARow(si.history) > 1 ? ` (${nothingFoundInARow(si.history)} cycles in a row)` : ""}; look where it did not (its review.md says what it checked), and consider improve mode.`;
    } else if (last.gate === "skipped") previous += last.outcome === "reset" ? `its work was abandoned (tag ${cfg.tagPrefix}abandoned-${pad(last.n)}).` : "it made no commits.";
    else previous += `not merged into ${cfg.integrationBranch}: ${last.mergeReason}. This cycle starts without that work. Its commits, report and handoff are on \`origin/attempts/${cfg.run}/cycle-${pad(last.n)}\`: read its ${dir(last.n)}/report.md and HANDOFF.md there first, and bring over what is sound (cherry-pick, fix what the rejection names, re-verify) before new work.`;
  }
  const b = state.limits.budget;
  const egress = contract.permissions.network.egress.map((e) => e.host);
  const vars: Record<string, unknown> = { NN: pad(n), CYCLE: n, CYCLES: b.maxSteps, RUN: cfg.run, BRANCH: cfg.branch, INTEGRATION: cfg.integrationBranch, CYCLE_DIR: dir(n), BASE_REF: cfg.baseRef,
    BUDGET_USD: b.perStepUsd, HARD_BUDGET_USD: contract.templateOptions["perStepHardUsd"] ?? 2 * b.perStepUsd, SOFT_HOURS: +(cfg.limits.softMinutes / 60).toFixed(1), HARD_HOURS: +(cfg.limits.hardMinutes / 60).toFixed(1), PREVIOUS: previous,
    NETWORK_NOTE: egress.length ? ` and the hosts the run lists (${egress.join(", ")}, through a proxy)` : "" };
  const text = fs.readFileSync(path.join(PKG, "prompts", "cycle.md"), "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  const feedback = ctx.engine.pendingFeedback.splice(0);
  return feedback.length ? `${text}\n\nNotes from the operator:\n${feedback.map((f) => `- ${f}`).join("\n")}` : text;
}

/** Adapt the engine's runtime to what lib/cycle.ts expects. */
function cycleRuntime(ctx: StepContext, { n, resume, startSha, dir }: { n: number; resume: boolean; startSha: string; dir: string }): CycleRuntime {
  const { engine, rt, repo, contract, state, store } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const g = repo.git();
  const branchRef = `refs/heads/${cfg.branch}`;
  let firstLaunch = true;
  const pendingControl = () => store.pending().some((m) => m.kind === "cancel" || m.kind === "pause");
  return {
    tickMs: rt.tickMs,
    now: () => rt.now(),
    sleep: async (ms: number) => {
      await rt.sleep(ms);
      engine.tick();
      if (engine.lockLost) throw new LockLost();
      await engine.refreshUsage();
      await engine.applyControl({ only: ["steer", "reconfigure"] });
    },
    uiPolicy: contract.permissions.unattended,
    onAutoAnswer: () => { engine.uiAnswered++; },
    startAgent: ({ attempt, onEvent }) => {
      const reset = firstLaunch && !resume;
      firstLaunch = false;
      state.sessions = (state.sessions ?? 0) + 1;
      ctx.log(`cycle ${pad(n)} session ${attempt} starting${reset ? " (workspace reset to the branch)" : ""}`);
      const agent = rt.startWorker({ step: n, attempt: state.sessions, resetWorkspace: reset, effort: state.effort, onEvent });
      engine.adoptAgent(agent);
      return agent;
    },
    headSha: async () => repo.head(),
    reportExists: async () => repo.fileAt(branchRef, `${dir}/report.md`) !== null,
    meterUsd: async () => { await engine.refreshUsage(); return state.usage.usd; },
    totalUsd: async () => { await engine.refreshUsage(); return state.usage.usd; },
    stopRequested: () => engine.signalled || pendingControl(),
    manager: async (bundle) => {
      const d = await decide(bundle, rt.complete(cfg.managerModel));
      const file = path.join(engine.stepDir(n), "decisions.jsonl");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date(rt.now()).toISOString(), triggers: bundle.triggers, ...d })}\n`);
      return d;
    },
    extras: async () => ({ gitLog: gm.logSince(g, startSha, branchRef), plan: repo.fileAt(branchRef, `${dir}/plan.md`), handoff: repo.fileAt(branchRef, "autonomy/HANDOFF.md") }),
    gates: async () => si.history.map((h) => h.gate).filter((x) => x === "green" || x === "red"),
    resetToLastGood: async () => {
      await engine.syncFromWorker({ silent: true });
      const res = gm.resetBranch(g, cfg, { abandonedTag: `abandoned-${pad(n)}` });
      publishNow(ctx);
      await rt.setWorkerBranch(res.to, []);
      ctx.log(`reset ${cfg.branch} ${res.from.slice(0, 12)} -> ${res.to.slice(0, 12)} (abandoned head tagged ${cfg.tagPrefix}abandoned-${pad(n)})`);
    },
    publish: async () => {
      const r = await engine.syncFromWorker({ silent: true });
      if (r.error && r.error !== si.lastSyncError) ctx.log(`sync from worker: ${r.error}`);
      si.lastSyncError = r.error ?? null;
      publishNow(ctx);
    },
    log: (line: string) => ctx.log(line),
  };
}

async function runStep(ctx: StepContext): Promise<void> {
  const { engine, rt, repo, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const g = repo.git();
  if (!si.current && nothingFoundInARow(si.history) >= cfg.limits.nothingFoundToStop) { await finalize(ctx, "backlog_exhausted"); return; }
  const resume = Boolean(si.current);
  const n = si.current?.n ?? si.history.length + 1;
  const dir = cycleDir(cfg, n);
  fs.mkdirSync(engine.stepDir(n), { recursive: true });
  if (!resume) {
    const sync = gm.syncIntegration(g, cfg);
    if (sync.state === "diverged") { engine.go("failed", { reason: "integration_diverged", detail: `${cfg.integrationBranch} at the destination (${sync.remote.slice(0, 12)}) and here (${sync.head.slice(0, 12)}) have diverged; reconcile them, then start a new run` }); return; }
    if (sync.state === "absent") throw new Error(`${cfg.integrationBranch} exists neither here nor at the destination`);
    if (sync.state === "adopted") log(`${cfg.integrationBranch} moved at the destination; continuing from ${sync.head.slice(0, 12)}`);
    const head = gm.startCycleBranch(g, cfg);
    const last = si.history.at(-1);
    const extra = last && !last.merged && last.head !== head ? [`refs/tags/${cfg.tagPrefix}cycle-${pad(last.n)}`] : [];
    await rt.setWorkerBranch(head, extra);
    log(`cycle ${pad(n)} branch set to ${cfg.integrationBranch} ${head.slice(0, 12)}`);
  }
  const startSha = si.current?.startSha ?? repo.head();
  si.current = { n, startedAt: si.current?.startedAt ?? new Date(rt.now()).toISOString(), startSha };
  state.step = n;
  state.phase = "work";
  ctx.save();
  log(`cycle ${pad(n)}/${state.limits.budget.maxSteps} ${resume ? "resuming" : "starting"}; spent $${state.usage.usd.toFixed(2)} of $${state.limits.budget.totalUsd}`);
  const prompt = cyclePrompt(ctx, n);
  const restartBriefing = resume ? `The previous session of this cycle was interrupted. Re-read autonomy/HANDOFF.md and this cycle's files under ${dir}/, check \`git status\` and \`git log\`, then continue the cycle from where it stopped.${state.pendingAnswer ? `\n\n${await engine.briefing("answer")}` : ""}` : undefined;
  const runCfg = { ...cfg, budget: { ...cfg.budget, totalUsd: state.limits.budget.totalUsd, perCycleUsd: state.limits.budget.perStepUsd }, cycles: state.limits.budget.maxSteps };
  const result = await runCycle({ n, cfg: runCfg, rt: cycleRuntime(ctx, { n, resume, startSha, dir }), prompt, cycleDir: dir, restartBriefing });
  await engine.refreshUsage();
  if (result.outcome === "blocked") { // the cycle stays current; the answer resumes it
    if (!result.blocker) throw new Error(`cycle ${pad(n)} ended blocked without a blocker`);
    await engine.enterBlocked(result.blocker);
    return;
  }
  const control = engine.signalled || engine.store.pending().some((m) => m.kind === "cancel" || m.kind === "pause");
  if (result.outcome === "aborted" && control) return; // interrupted by a command or a signal: the cycle stays current for resume
  await closeCycle(ctx, n, result);
  if (result.outcome === "aborted" && /^manager:/.test(result.reason)) {
    engine.go("blocked", { reason: "external", blocker: { kind: "external", id: `manager-${n}`, method: "manager", question: `The manager model stopped the run for a person to look at: ${result.reason.replace(/^manager:\s*/, "")}. Resume with --answer "<what to do>" to continue, or cancel.`, options: [] } });
  }
}

/** Acceptance checks on the cycle head, tag, merge decision and integration; port of the v0 close-out. */
async function closeCycle(ctx: StepContext, n: number, result: CycleResult): Promise<void> {
  const { engine, rt, repo, contract, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const g = repo.git();
  await engine.syncFromWorker({ silent: true });
  const sha = repo.head();
  const start = g(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
  const changed = sha !== start;
  let gate: CycleGate = { skipped: true, green: false, results: [] };
  if (changed) {
    log(`cycle ${pad(n)} acceptance on ${sha.slice(0, 12)}`);
    const ev = await runAcceptance({ rt, contract, sha, step: n, dir: path.join(engine.stepDir(n), "checks"), runRoot: ctx.store.p.root, log });
    gate = { skipped: false, green: ev.allRequiredPass, results: ev.results };
    ctx.save((s) => {
      s.acceptance.latest = summariseEvaluation(ev);
      s.acceptance.history = [...s.acceptance.history, { step: n, sha, allRequiredPass: ev.allRequiredPass }].slice(-20);
      for (const r of ev.results) s.artefacts.push({ kind: "check-evidence", path: r.evidence, step: n, at: r.at });
    });
  }
  const failing = gate.results.flatMap((r) => (r.steps?.length ? r.steps.filter((x) => x.code !== 0).map((x) => x.name) : r.pass ? [] : [r.id]));
  const declared = result.outcome === "completed" ? reportOutcome(repo.fileAt(sha, `${cycleDir(cfg, n)}/report.md`)) : { outcome: null, mode: null };
  const current = si.current;
  if (!current) throw new Error(`cycle ${pad(n)} is closing but no cycle is current`);
  repo.tag(`cycle-${pad(n)}`, sha);
  const merge = await mergeDecision(ctx, n, { result, sha, start, changed, gate });
  if (merge.merge) {
    const r = gm.integrate(g, cfg, sha);
    merge.merged = r.merged;
    if (!r.merged) merge.reason = r.reason;
  }
  if (merge.merged) { si.lastGoodSha = sha; si.merged = (si.merged ?? 0) + 1; }
  publishNow(ctx);
  const entry: CycleEntry = { n, outcome: result.outcome, reason: result.reason, attempts: result.attempts, start, head: sha, gate: gate.skipped ? "skipped" : gate.green ? "green" : "red", gateFailing: failing,
    reportOutcome: declared.outcome, mode: declared.mode, merged: Boolean(merge.merged), mergeReason: merge.reason, review: merge.review ?? null, costUsd: +result.costUsd.toFixed(4),
    decisions: result.decisions.map(({ decision, reason, triggers }) => ({ decision, reason, triggers })), startedAt: current.startedAt, endedAt: new Date(rt.now()).toISOString() };
  writeJsonAtomic(path.join(engine.stepDir(n), "cycle.json"), entry);
  engine.flushUi();
  ctx.save((s) => {
    const record = siState(s);
    record.history.push(entry);
    record.current = null;
    s.usage.steps = n;
    s.phase = null;
    s.artefacts.push({ kind: "cycle", path: path.join("steps", pad(n), "cycle.json"), step: n, at: entry.endedAt });
  });
  engine.writeStepSummary(n, { action: "cycle", outcome: entry.outcome, gate: entry.gate, merged: entry.merged });
  ctx.save();
  log(`cycle ${pad(n)} done: ${entry.outcome}, gate ${entry.gate}${failing.length ? ` (${failing.join(", ")})` : ""}, $${entry.costUsd}; tagged ${cfg.tagPrefix}cycle-${pad(n)}; ${entry.merged ? `merged into ${cfg.integrationBranch}` : `not merged (${entry.mergeReason})`}`);
}

/** templateOptions.integration's review-input options (validated in validate()). */
function integrationOptions(contract: RunContract): { controlPaths: string[]; allowControlChanges: boolean } {
  const integration = contract.templateOptions["integration"];
  const o = isPlainObject(integration) ? integration : {};
  const paths = o["controlPaths"];
  return {
    controlPaths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [],
    allowControlChanges: o["allowControlChanges"] === true,
  };
}

/** The files the root package.json and every changed package.json name in their scripts, on either side of the cycle. */
function gateEntries(files: readonly string[], before: (f: string) => string | null, after: (f: string) => string | null): string[] {
  const manifests = new Set(["package.json", ...files.filter((f) => f.endsWith("/package.json"))]);
  return [...manifests].flatMap((f) => {
    const dir = f === "package.json" ? "" : f.slice(0, -"/package.json".length);
    return [...scriptTargets(before(f), dir), ...scriptTargets(after(f), dir)];
  });
}

/** Only a completed cycle with commits and a green gate is reviewed; only a MERGE verdict merges. */
async function mergeDecision(ctx: StepContext, n: number, { result, sha, start, changed, gate }: { result: CycleResult; sha: string; start: string; changed: boolean; gate: CycleGate }): Promise<MergeDecision> {
  const { rt, repo, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  if (!changed) return { merge: false, reason: "no commits" };
  if (result.outcome !== "completed") return { merge: false, reason: `cycle ${result.outcome} (${result.reason})` };
  if (!gate.green) return { merge: false, reason: "acceptance checks failed" };
  // Review inputs are never worker-authored (lib/review.ts): control-path changes and an
  // over-budget diff are refused by the host before any model is asked, even with review off.
  const options = integrationOptions(ctx.contract);
  const files = repo.changedPaths(start, sha);
  const control = controlChanges({ files, before: (f) => repo.fileAt(start, f), after: (f) => repo.fileAt(sha, f), controlPaths: options.controlPaths });
  if (control.length && !options.allowControlChanges) return { merge: false, reason: `changes a control path the cycle may not merge (templateOptions.integration.allowControlChanges is off): ${control.slice(0, 10).join("; ")}` };
  // Read whole or not at all: an over-budget or unreadable diff (git failure, timeout, output cap)
  // is a REJECT, never an empty or clipped diff that looks under budget.
  const read = repo.reviewDiff(start, sha, REVIEW_DIFF_BUDGET);
  if (!read.ok && read.reason === "over-budget") return { merge: false, reason: `the diff without lockfiles (${read.detail}) exceeds the merge review's budget of ${REVIEW_DIFF_BUDGET} characters; a larger change is never reviewed in part. Split the work across cycles` };
  if (!read.ok) return { merge: false, reason: `the diff could not be read in full (${read.detail}); a cycle whose diff the host cannot read is never merged` };
  const diff = read.text;
  if (!cfg.integration.review) return { merge: true, reason: "checks passed (review disabled)" };
  const at = (file: string): string | null => repo.fileAt(sha, file);
  const dir = cycleDir(cfg, n);
  log(`cycle ${pad(n)} merge review (${cfg.reviewModel})`);
  const review = await reviewCycle({
    run: cfg.run, cycle: n, outcome: result.outcome, integrationBranch: cfg.integrationBranch, gateSteps: gate.results.map((r) => ({ name: r.id })),
    // The charter is the host-held integration head's (the cycle's start), never the cycle's own.
    charter: repo.fileAt(start, CHARTER_PATH), report: at(`${dir}/report.md`), verify: at(`${dir}/verify.md`), gitLog: repo.logSince(start, sha), diff,
    criticalPaths: reviewCriticalPaths(files, gateEntries(files, (f) => repo.fileAt(start, f), at)),
  }, rt.complete(cfg.reviewModel, { timeoutMs: 300_000 }), { sleep: (ms) => rt.sleep(ms) });
  await ctx.engine.refreshUsage();
  writeJsonAtomic(path.join(ctx.engine.stepDir(n), "review.json"), { at: new Date(rt.now()).toISOString(), model: cfg.reviewModel, ...review });
  const reason = `review ${review.verdict}: ${review.reason}${review.concerns.length ? ` Concerns: ${review.concerns.join("; ")}` : ""}`;
  return { merge: review.verdict === "MERGE", reason, review: review.verdict };
}

/** The end of a non-finite run: cycles done or nothing left to find. Evidence is a green acceptance run on the integration head. */
async function finalize(ctx: StepContext, reason: string): Promise<void> {
  const { engine, rt, repo, contract, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const head = repo.git()(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
  await engine.stopWorker("run complete");
  const before = state.acceptance.latest;
  if (before?.sha !== head || !before.allRequiredPass) {
    const step = state.step || state.usage.steps;
    const ev = await runAcceptance({ rt, contract, sha: head, step, dir: path.join(engine.stepDir(step), "final-checks"), runRoot: ctx.store.p.root, log });
    ctx.save((s) => { s.acceptance.latest = summariseEvaluation(ev); for (const r of ev.results) s.artefacts.push({ kind: "check-evidence", path: r.evidence, step, at: r.at }); });
  }
  ctx.save((s) => { s.acceptance.review = { required: false, status: "skipped", note: "self-improve reviews every merged cycle instead" }; });
  if (!state.acceptance.latest?.allRequiredPass) { engine.go("failed", { reason: "final_gate_red", detail: `${reason}: the acceptance checks do not pass on ${cfg.integrationBranch} ${head.slice(0, 12)}` }); return; }
  engine.go("succeeded", { reason, detail: `${siState(state).merged} cycle(s) merged into ${cfg.integrationBranch} at ${head.slice(0, 12)}` });
  publishNow(ctx);
  await engine.afterSuccess(head);
}

async function onStepsDone(ctx: StepContext): Promise<"handled"> {
  await finalize(ctx, "cycles_done");
  return "handled";
}

const template: Template = {
  id: "self-improve",
  describe,
  defaults,
  validate,
  seed,
  runStep,
  onStepsDone,
  promotion: { targets: promotionTargets },
  finite: false,
};

export default template;
