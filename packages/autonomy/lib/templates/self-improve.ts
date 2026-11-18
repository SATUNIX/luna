// Template `self-improve`: the original behaviour of packages/autonomy, now ONE optional
// template. Repeated cycles (review, plan, improve, verify, record) on a repository, each merged
// into one configurable integration branch when it has commits, passes the acceptance checks
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
import { type AcceptanceEvaluation, type CheckEvidence, runAcceptance, summariseEvaluation } from "../acceptance.ts";
import { type BoardItem, type BoardReport, BoardLockBusy, type StewardBoard, WORK_PRECEDENCE, assignedItems, boardPrompt, parseBoardReport, readBoard } from "../board.ts";
import { type CycleClaim, type DispatchOptions, claimForCycle, cycleEngineer, cycleRotation, dispatchBoardPrompt, dispatchOptions, recordSubmission, reviseSubmissions } from "../dispatch.ts";
import { ATTEMPTS_PER_ITEM, recordAttempts, withoutWithheld } from "../attempts.ts";
import { bookkeepingPaths } from "../bookkeeping.ts";
import { NOTE_LIMIT as NOTE_CHARS, WORKER_NOTE, clearNote, previousRecord, readNote, writeReceipt } from "../receipt.ts";
import { type BaseVerdict, preflight } from "../preflight.ts";
import { queueWork } from "../queue.ts";
import type { Budget, ContractDraft, ProblemSink, RunContract } from "../contract.ts";
import { type CycleDecision, type CycleOutcome, type CycleResult, type CycleRuntime, runCycle } from "../cycle.ts";
import { isPositiveCpus, isPositiveSize } from "../containment.ts";
import { LockLost } from "../errors.ts";
import * as gm from "../gitmirror.ts";
import type { RunState, SelfImproveState } from "../lifecycle.ts";
import { decide } from "../manager.ts";
import { reviewBlocker } from "../rpc.ts";
import { promotionTargets } from "../promotion.ts";
import { CHARTER_PATH, type CycleReview, REVIEW_DIFF_BUDGET, controlChanges, isReviewRecord, reviewCriticalPaths, reviewCycle, reviewRecordDirectories, scriptTargets, upstreamMergeScope } from "../review.ts";
import { isNewReport, ledgerCommits, uncoveredCommits, unknownShas } from "../ledger.ts";
import { globProblem, globToRegExp } from "../glob.ts";
import { type RiskClassification, classifyRisk, r0Reviewed, specialistQuestion } from "../risk.ts";
import type { RunConfig } from "../runcfg.ts";
import { type ReportMode, type ReportOutcome, nothingFoundInARow, reportOutcome } from "../triggers.ts";
import { isPlainObject, readJson, writeJsonAtomic } from "../fsutil.ts";
import type { StepContext } from "../engine.ts";
import { type Template, type TemplateDescription, checkLines } from "./common.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pad = (n: number): string => String(n).padStart(2, "0");
const PUBLISH_BLOCKED_RESUME = "Remove the identifier and resume";
const PUBLISH_BLOCKED_STOP = "Stop the run";
const PUBLISH_BLOCKED_STOP_REASON = "publish_blocked_stopped";

export const SELF_IMPROVE_LIMITS = { softMinutes: 180, hardMinutes: 300, idleMinutes: 20, noCommitMinutes: 90, managerCallsPerCycle: 3, autoRestartsPerCycle: 3, redGatesInARow: 2, guardEscalations: 3, nothingFoundToStop: 3 };

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
  /** Board items this cycle's non-merge made the host stop offering (lib/attempts.ts); the steward re-files them under a new ID. */
  withheldItems?: string[];
  /** True when the publish-blocked answer's rollback discarded this cycle's local-only history. */
  discarded?: boolean;
  review: CycleReview["verdict"] | null;
  /** The host's risk tier for the cycle, from the paths it changed (lib/risk.ts), and why. */
  risk?: Pick<RiskClassification, "tier" | "reasons">;
  costUsd: number;
  decisions: Array<Pick<CycleDecision, "decision" | "reason" | "triggers">>;
  startedAt: string;
  endedAt: string;
  upstream?: gm.UpstreamSync;
  board?: BoardReport[];
  /** Board: IDs the report claimed that were not on the cycle's board snapshot (judged without them). */
  unknownClaims?: string[];
  /** The contract digest and the limits this cycle ran under, so a change between cycles is visible. */
  effective?: { contractDigest: string; limits: typeof SELF_IMPROVE_LIMITS & { budget: Budget } };
  /** Metered spend by role (worker, manager, review) for this cycle, and the rows left unresolved (error, aborted, non-200, unmetered). */
  meter?: { byRole: Record<string, number>; rows: number; unresolved: number };
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
  risk?: RiskClassification;
  /** No reviewer gave a usable reply: the cycle is parked (review-pending), not recorded as rejected. */
  reviewUnavailable?: string;
  merged?: boolean;
  unknownClaims?: string[];
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

/**
 * The dispatch options of a `dispatch` run (lib/dispatch.ts), or null for a self-improve run. A
 * dispatch run is a self-improve run whose cycles each claim one board item (templates/dispatch.ts).
 */
function dispatchOf(contract: RunContract): DispatchOptions | null {
  if (contract.template !== "dispatch") return null;
  const options = dispatchOptions(contract);
  if (!options) throw new Error("the dispatch template needs templateOptions.dispatch with streams and engineers");
  return options;
}

const describe = (): TemplateDescription => ({
  id: "self-improve",
  title: "Improve a repository in cycles",
  summary: "Repeated improvement cycles on a repository: each cycle reviews, plans, improves and verifies, and is merged into one integration branch after passing the acceptance checks and a merge review. Ends on the cycle, budget or time limit, or when several reviews in a row find nothing to do. Optional: it is one template among several.",
  finite: false,
  requires: ["inputs.repository (the repository to improve)", "promotion policy (none, local-branch or push)"],
  optional: ["templateOptions.integration.branch (default pi-autonomy/integration)", "templateOptions.integration.upstream (sync before each cycle)", "templateOptions.limits", "inputs.references"],
});

export const defaults = (): Record<string, unknown> => ({
  objective: { title: "Autonomous improvement", spec: "Find and fix real, evidenced problems in this repository, and improve it where the need is demonstrated." },
  // No default check: what "good" means is the operator's to define for their repository (the kit's own gate script is /opt/autonomy/gate.sh in the default image).
  acceptance: { review: true, checks: [], overlay: [] },
  permissions: { writeAreas: ["**"], network: { egress: [], services: [], serviceImages: [] }, credentials: { names: [] }, outputs: { destinations: [] }, unattended: { authorised: false, autoApprove: false } },
  model: { provider: "openrouter" },
  effort: "standard",
  budget: { totalUsd: 100, perStepUsd: 5, maxSteps: 50, maxMinutes: 14_400 },
  recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 8 },
  promotion: { policy: "local-branch", destinations: [], requiresOperatorApproval: false },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, perStepHardUsd: null, limits: { ...SELF_IMPROVE_LIMITS }, gate: { memory: "8g", cpus: "8" } },
});

export function validate(contract: ContractDraft, { err, warn }: ProblemSink): void {
  const repo = contract.inputs.repository;
  if (!repo) err("inputs.repository", "the self-improve template improves an existing repository: set inputs.repository (path or url, and ref)");
  const t = contract.templateOptions;
  const ib = isPlainObject(t["integration"]) ? t["integration"]["branch"] : undefined;
  // `dispatch` is the dispatch template's own option (templates/dispatch.ts validates it).
  const allowed = ["integration", "perStepHardUsd", "limits", "gate", "knownFlakes", "emptyQueueSleepMinutes", ...(contract.template === "dispatch" ? ["dispatch"] : [])];
  for (const key of Object.keys(t)) if (!allowed.includes(key)) warn(`templateOptions.${key}`, "unknown key ignored");
  // The acceptance gate's container limits (runcfg.ts): a 0 would start it unlimited (containment.ts limitProblems).
  const gate = t["gate"];
  if (gate !== undefined && !isPlainObject(gate)) err("templateOptions.gate", "must be an object with memory and cpus");
  else if (gate !== undefined) {
    const { memory, cpus } = gate;
    if (memory !== undefined && !(typeof memory === "string" && isPositiveSize(memory))) err("templateOptions.gate.memory", 'must be a size above zero, like "8g": the container engines read 0 as no limit');
    if (cpus !== undefined && !(typeof cpus === "string" ? isPositiveCpus(cpus) : typeof cpus === "number" && cpus > 0)) err("templateOptions.gate.cpus", 'must be a number above zero, like "8": the container engines read 0 as no limit');
  }
  const flakes = t["knownFlakes"];
  if (flakes !== undefined && (!Array.isArray(flakes) || flakes.length > 50 || !flakes.every((f) => typeof f === "string" && /^[A-Za-z0-9._:/ -]{1,120}$/.test(f)))) err("templateOptions.knownFlakes", "must be an array of at most 50 check ids or `id/step` names: the only failures the pre-flight confirms with one more run");
  const sleepMinutes = t["emptyQueueSleepMinutes"];
  if (sleepMinutes !== undefined && !(typeof sleepMinutes === "number" && sleepMinutes >= 1 && sleepMinutes <= 1440)) err("templateOptions.emptyQueueSleepMinutes", "must be a number of minutes from 1 to 1440: how long an empty queue sleeps between looks, with no model call");
  const integration = isPlainObject(t["integration"]) ? t["integration"] : {};
  const controlPaths = integration["controlPaths"];
  if (controlPaths !== undefined) {
    if (!Array.isArray(controlPaths) || controlPaths.length > 100) err("templateOptions.integration.controlPaths", "must be an array of at most 100 repository path globs");
    else for (const [i, glob] of controlPaths.entries()) { const problem = globProblem(glob); if (problem) err(`templateOptions.integration.controlPaths[${i}]`, problem); }
  }
  const allowControl = integration["allowControlChanges"];
  if (allowControl !== undefined && typeof allowControl !== "boolean") err("templateOptions.integration.allowControlChanges", "must be true or false");
  const r0 = integration["r0Review"];
  if (r0 !== undefined && !(typeof r0 === "number" && r0 >= 0 && r0 <= 1)) err("templateOptions.integration.r0Review", "must be a number from 0 to 1: the share of prose-only (R0) cycles that still get the model review (1, the default, reviews all of them)");
  if (typeof r0 === "number" && r0 < 1) warn("templateOptions.integration.r0Review", "prose-only cycles are merged without a model review for the share that is not sampled; the acceptance checks still run");
  if (allowControl === true) warn("templateOptions.integration.allowControlChanges", `cycles may change ${CHARTER_PATH}, the controlPaths and package.json scripts; the merge review is then the only check on them`);
  if (typeof ib !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(ib) || ib.includes("..") || ib.endsWith("/") || ib.endsWith(".lock")) err("templateOptions.integration.branch", "must be a valid branch name");
  else if (["main", "master", "head", "trunk", "develop", "development", "production", "prod", "stable"].includes(ib.toLowerCase()) || /^(release|releases|hotfix|refs)(\/|$)/i.test(ib) || ib === repo?.ref) err("templateOptions.integration.branch", `"${ib}" is a protected name or the base ref; the integration branch is a separate branch a person reviews and merges from`);
  const upstream = integration["upstream"];
  if (upstream !== undefined && (typeof upstream !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(upstream) || upstream.includes("..") || upstream.endsWith("/") || upstream.endsWith(".lock") || upstream === ib)) err("templateOptions.integration.upstream", "must be a valid branch name different from integration.branch");
  const l = isPlainObject(t["limits"]) ? t["limits"] : {};
  // A limit that is not a number fails the checks below (runtimeConfig would silently use the default).
  const limit = (key: keyof typeof SELF_IMPROVE_LIMITS): number => { const v = Object.hasOwn(l, key) ? l[key] : SELF_IMPROVE_LIMITS[key]; return typeof v === "number" ? v : NaN; };
  const [idleMinutes, noCommitMinutes, softMinutes, hardMinutes, nothingFoundToStop] = [limit("idleMinutes"), limit("noCommitMinutes"), limit("softMinutes"), limit("hardMinutes"), limit("nothingFoundToStop")];
  if (!(idleMinutes > 0 && noCommitMinutes > 0 && softMinutes > 0 && hardMinutes > softMinutes)) err("templateOptions.limits", "must be positive, with hardMinutes > softMinutes");
  if (!Number.isInteger(nothingFoundToStop) || nothingFoundToStop < 1) err("templateOptions.limits.nothingFoundToStop", "must be an integer >= 1");
  if (!Number.isInteger(limit("autoRestartsPerCycle")) || limit("autoRestartsPerCycle") < 0) err("templateOptions.limits.autoRestartsPerCycle", "must be an integer >= 0");
  const perStepUsd = contract.budget.perStepUsd ?? NaN;
  const totalUsd = contract.budget.totalUsd ?? NaN;
  const hardOption = t["perStepHardUsd"] ?? 2 * perStepUsd;
  const hard = typeof hardOption === "number" ? hardOption : NaN;
  if (!(hard >= perStepUsd) || !(totalUsd >= hard)) err("templateOptions.perStepHardUsd", "must satisfy budget.perStepUsd <= perStepHardUsd <= budget.totalUsd");
  const p = contract.promotion;
  // The upstream is fetched from the integration remote (runcfg.ts integrationRemote): without one the sync could never run.
  if (typeof upstream === "string" && (p.policy === "none" || (p.policy === "push" && !p.destinations.some((d) => d.kind === "git-remote")))) err("templateOptions.integration.upstream", `the upstream is fetched from the promotion destination, and policy "${p.policy}" names none: set a local-branch or push destination, or remove the upstream`);
  if (p.policy === "none") warn("promotion.policy", 'policy "none": merged cycles stay in the run\'s own mirror; use `export` to take them out. A later run cannot continue this run\'s integration branch.');
  if (p.policy === "local-branch") for (const d of p.destinations) if (d.branch !== ib) err("promotion.destinations", `a self-improve local-branch destination must be the integration branch "${String(ib)}"`);
  if (p.policy === "push") for (const d of p.destinations) if (d.branch !== ib) err("promotion.destinations", `a self-improve push destination must be the integration branch "${String(ib)}" (the working branch is never published)`);
  if (!contract.acceptance.checks.some((k) => k.required)) err("acceptance.checks", "needs at least one required check: the gate every cycle must pass (for example { \"id\": \"tests\", \"run\": [\"npm\", \"test\"] })");
}

// --- seeding ----------------------------------------------------------------------------------------
const backlogRows = (contract: RunContract): string => contract.objective.backlog.map((i) => `| ${i.id} | open | P2 | ${(i.detail ? `**${i.title}.** ${i.detail}` : i.title).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ")} | Operator's brief |`).join("\n");

/** The placeholders of the seed files (seed/CHARTER.md, BACKLOG.md). */
function seedVars(cfg: SelfImproveConfig, contract: RunContract, base: string, now: number): Record<string, string> {
  const paths = bookkeepingPaths(cfg, 0);
  return { PROPOSALS_PATH: cfg.integrationUpstream ? "autonomy/proposals/<run>-<NN>-<slug>.md" : paths.proposals, RUN: cfg.run, BRANCH: cfg.integrationBranch, BASE: base.slice(0, 12), BASE_REF: cfg.baseRef, DATE: new Date(now).toISOString().slice(0, 10), OBJECTIVE: contract.objective.spec, CHECKS: checkLines(contract).join("\n"), BACKLOG_ROWS: backlogRows(contract) };
}

/**
 * The charter a stream's merge review judges against: this package's seed charter rendered for
 * the run, host-held like the trunk copy. A stream never rewrites the trunk's charter (seedBranch),
 * so the trunk can hold an older one whose priorities predate board-first precedence; judging a
 * stream against it would REJECT board work as a detour.
 */
function streamCharter(cfg: SelfImproveConfig, contract: RunContract, start: string, now: number): string {
  return gm.fill(fs.readFileSync(path.join(PKG, "seed", "CHARTER.md"), "utf8"), seedVars(cfg, contract, start, now));
}

/** Integration branch: adopted from the destination, or created from the base with the seed files; the working branch at its head. */
export async function seed(ctx: StepContext): Promise<void> {
  const { repo, contract, store, log, rt } = ctx;
  const cfg = siConfig(ctx.cfg);
  const g = repo.git();
  const base = g(["rev-parse", `refs/base/${cfg.baseRef}`]);
  if (gm.remoteHasRunTags(g, cfg)) throw new Error(`tags ${cfg.tagPrefix}* already exist on the integration remote; pick a new run id`);
  const paths = bookkeepingPaths(cfg, 0);
  const files: Record<string, string> = {};
  if (cfg.integrationUpstream) for (const [i, item] of contract.objective.backlog.entries()) {
    const slug = `${item.id}-${item.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "brief";
    files[paths.proposals.replace("<slug>", `${i + 1}-${slug}`)] = `# ${item.title}\n\nID: ${item.id}\nStatus: proposal\nSource: Operator's brief\n\n${item.detail ?? item.title}\n\nTreat this as a hypothesis to check against the code before acting.\n`;
  }
  const vars = seedVars(cfg, contract, base, rt.now());
  const seedArgs = { seedDir: path.join(PKG, "seed"), tmpDir: store.p.tmp, vars, files };
  const sync = gm.syncIntegration(g, cfg);
  if (sync.state === "absent" || sync.head === null) { // head is null exactly when the branch is absent
    gm.seedBranch(g, cfg, seedArgs);
    log(`created ${cfg.integrationBranch} from ${cfg.baseRef} ${base.slice(0, 12)} with the seed files`);
  } else {
    log(`continuing ${cfg.integrationBranch} at ${sync.head.slice(0, 12)}`);
    if (cfg.integrationUpstream || gm.fileAt(g, sync.head, "autonomy/CHARTER.md") === null) gm.seedBranch(g, cfg, { ...seedArgs, parent: sync.head });
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
  if (ctx.engine.stopRequested || p.policy === "none" || p.requiresOperatorApproval) return;
  const si = siState(state);
  try {
    const r = gm.publish(repo.git(), siConfig(ctx.cfg), si.lastPushed);
    si.lastPushed = r.state;
    // Nothing was pushed when the destination already holds the published state (for example after
    // a blocked-publication reset). Only a real push is a successful publish, so only it clears the
    // blocker and the streak; otherwise an unchanged state would silently reset the guard.
    if (!r.pushed) return;
    if (si.publishError) log("publish recovered");
    si.publishError = null;
    si.publishBlocker = null;
    si.publishBlockedCycles = 0;
  } catch (e) {
    const message = errorMessage(e);
    if (message !== si.publishError) log(`publish failed (will retry): ${message}`);
    si.publishError = message;
    // A generic failure must not erase a real leak-scan blocker; only a PublishBlocked sets it (a successful publish clears it above).
    if (e instanceof gm.PublishBlocked) si.publishBlocker = message;
  }
}

/**
 * The integration head recorded in the last successfully published refs state, or the seed when
 * nothing has been published yet. The state string is `for-each-ref` output: `<sha> <refname>`.
 */
function lastPublishedHead(si: SelfImproveState, integrationBranch: string): string {
  for (const line of (si.lastPushed ?? "").split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha !== undefined && ref === `refs/heads/${integrationBranch}`) return sha;
  }
  return si.seedSha;
}

/** The mergeReason the publish-blocked rollback writes on the cycles it discarded. */
const DISCARDED_BY_RESET = "discarded by the publish-blocked reset to ";

/**
 * Roll the local integration branch back to the last published state after the operator answers the
 * publish-blocked question. Merged-but-unpublished cycles cannot be pushed (the leak scan refuses
 * their commits, and publication is fast-forward only), and removing the identifier in a later
 * commit leaves the refused commit in the range. Discarding that local-only history is the only
 * way the answer can reach a publishable state; the next cycle redoes the work. The streak is left
 * set, so a cycle that reintroduces the identifier parks the run again as before.
 */
function resetToLastPublished(ctx: StepContext): void {
  const { repo, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(ctx.state);
  const g = repo.git();
  const ref = `refs/heads/${cfg.integrationBranch}`;
  const current = g(["rev-parse", ref]);
  const published = lastPublishedHead(si, cfg.integrationBranch);
  // The integration branch only ever fast-forwards, so the published head is an ancestor. A
  // non-ancestor would mean the remote moved independently; publishing will surface that itself.
  if (g(["merge-base", "--is-ancestor", published, current], { allowFail: true }) === null) return;
  if (published !== current) g(["update-ref", ref, published, current]);
  // The refused publish scanned the discarded cycle tags too, and with tag publication on (the
  // default) they would be scanned again and refuse the answer's push. Drop this run's tags for
  // the discarded history (cycle and abandoned tags alike); only tags that are not ancestors of
  // the published head are affected. This also runs when the branch is already back at the
  // published head: an unmerged answer cycle can leave a refused tag that a later clean push
  // would scan.
  const tagPrefix = `refs/tags/${cfg.tagPrefix}`;
  let dropped = 0;
  for (const line of g(["for-each-ref", "--format=%(objectname) %(refname)", `${tagPrefix}*`]).split("\n")) {
    const [sha, tagRef] = line.trim().split(/\s+/);
    if (sha === undefined || tagRef === undefined) continue;
    if (g(["merge-base", "--is-ancestor", sha, published], { allowFail: true }) === null && g(["update-ref", "-d", tagRef, sha], { allowFail: true }) !== null) dropped += 1;
  }
  // The next cycle's prompt reads the last entry, and telling the worker that the work is
  // integrated (or pointing at a report that is no longer on the branch) would hide the redo.
  // Keep `merged` as the historical fact (the cycle-start bundle logic also treats an unmerged
  // cycle's tag as fetchable, and the rollback just dropped those tags), but mark every entry
  // whose head is not an ancestor of the published head as discarded so the prompt says so.
  for (const entry of si.history) {
    if (g(["merge-base", "--is-ancestor", entry.head, published], { allowFail: true }) !== null) continue;
    entry.discarded = true;
    entry.mergeReason = `${DISCARDED_BY_RESET}${published.slice(0, 12)}`;
  }
  si.lastGoodSha = published;
  // Record the post-reset state so the cycle-start publish is a no-op for the integration branch:
  // discarding the unpublishable history must not itself look like a successful publish (the next
  // real push, after the answer cycle, is what clears the blocker and the streak).
  si.lastPushed = gm.refsState(g, cfg);
  if (published === current) {
    if (dropped > 0) log(`publication blocked: dropped ${String(dropped)} tag(s) for discarded history; the integration branch already matches the published ${published.slice(0, 12)}`);
    return;
  }
  log(`publication blocked: moved ${cfg.integrationBranch} from ${current.slice(0, 12)} back to the last published ${published.slice(0, 12)}${dropped > 0 ? `, dropping ${String(dropped)} tag(s)` : ""}; the unpublished merges are discarded and the next cycle redoes the work`);
}

// --- one cycle ----------------------------------------------------------------------------------------
const cycleDir = (cfg: Pick<RunConfig, "run">, n: number): string => `autonomy/cycles/${cfg.run}/${pad(n)}`;

function cyclePrompt(ctx: StepContext, n: number): string {
  const { state, contract } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const last = si.history.at(-1);
  const paths = bookkeepingPaths(cfg, n);
  // One board snapshot per cycle: a resumed cycle keeps the board it started with, so its claims
  // are judged against the assignments it was given, whatever the steward has written since.
  // An item whose ordinary attempt and repair are used up (lib/attempts.ts) is not offered again.
  // A dispatch cycle's snapshot is the one item runStep claimed for it; it never sees the whole board.
  const dispatch = dispatchOf(contract);
  const offered = readBoard(ctx.store.p.control);
  const board = si.current?.board ?? (si.current?.baseRed || dispatch ? { items: [] } : withoutWithheld(offered, si.itemAttempts));
  ctx.save(() => { if (si.current && !si.current.board) si.current.board = board; });
  // Streams and runs with a steward board take improvements from the board; other runs choose their own.
  const stewarded = Boolean(dispatch) || Boolean(cfg.integrationUpstream) || offered.items.length > 0;
  let previous = "This is the first cycle of this run; earlier runs' cycles, if any, are recorded under autonomy/cycles/.";
  const record = last ? previousRecord(ctx.engine.stepDir(last.n)) : null;
  if (last) {
    previous = `Cycle ${pad(last.n)} ended ${last.outcome} (${last.reason}); acceptance ${last.gate}${last.gate === "red" ? ` (failing: ${last.gateFailing?.join(", ") || "see the check output"})` : ""}; `;
    if (last.discarded) {
      previous += `its local work was discarded when the publish-blocked answer rolled ${cfg.integrationBranch} back to the last published head; redo it in this cycle instead of looking for its report on the branch.`;
    } else if (last.merged) {
      previous += `merged into ${cfg.integrationBranch}.${last.reason === "host close-out after session exit" ? " The worker exited before writing a note, so the host closed it out from the committed work; inspect its commits." : ""}`;
      if (last.mode === "improve") previous += " It was an improve cycle; consolidate its changes after the higher-priority gate, upstream conflict and board work.";
      if (last.reportOutcome === "nothing found") previous += ` Its review found nothing to do${nothingFoundInARow(si.history) > 1 ? ` (${nothingFoundInARow(si.history)} cycles in a row)` : ""}. Work only on what is assigned, failing or carried over.`;
    } else if (last.mergeReason.startsWith("the diff without lockfiles")) previous += `not merged into ${cfg.integrationBranch}: ${last.mergeReason}. This cycle starts without that work. Its commits are on \`origin/attempts/${cfg.run}/cycle-${pad(last.n)}\`: carry over only a reviewable subset (measure it as below; well under ${REVIEW_DIFF_BUDGET} characters); the rest stays on that branch for later cycles.`;
    else if (last.gate === "skipped") previous += last.outcome === "reset" ? `its work was abandoned (tag ${cfg.tagPrefix}abandoned-${pad(last.n)}).` : "it made no commits.";
    else previous += `not merged into ${cfg.integrationBranch}: ${last.mergeReason}. This cycle starts without that work. Its commits are on \`origin/attempts/${cfg.run}/cycle-${pad(last.n)}\`: bring over what is sound (cherry-pick, fix what the rejection names, re-verify), following the work precedence below.`;
    if (last.reportOutcome === "nothing found" && !last.merged) previous += ` Its note found nothing to do${nothingFoundInARow(si.history) > 1 ? ` (${nothingFoundInARow(si.history)} cycles in a row)` : ""}. Work only on what is assigned, failing or carried over.`;
    if (last.unknownClaims?.length) previous += ` Its report claimed board items that were not assigned to it (${last.unknownClaims.join(", ")}); name only the IDs listed under "Assigned work" in Board: lines.`;
  }
  if (record) previous += `\n\n${record}`;
  const kept = state.unaccepted;
  if (kept) previous += ` Worker commits the host refused to accept (${kept.why}${kept.stat ? `; ${kept.stat}` : ""}) are kept at ${kept.ref} (${kept.sha.slice(0, 12)}) in the host mirror for the operator; they are not on your branch and not part of the verified head.`;
  const b = state.limits.budget;
  const egress = contract.permissions.network.egress.map((e) => e.host);
  const start = (si.current?.startSha ?? ctx.repo.head()).slice(0, 12);
  const excludes = [":(exclude)package-lock.json", ...reviewRecordDirectories(cfg).map((d) => `:(exclude)${d}`)].map((x) => `"${x}"`).join(" ");
  const upstream = si.current?.upstream;
  const conflict = upstream?.outcome === "conflict" ? `\n\n## P0: upstream merge conflict\nThe host could not merge ${upstream.upstream} (${upstream.head}) cleanly. Before any assigned work, run \`git merge refs/upstream/trunk\`, resolve the conflicts preserving both sides' intent, and re-verify. Repair any red gate / broken branch first. The ref is supplied offline; no network is needed.` : "";
  const baseRed = si.current?.baseRed?.length ? `\n\n## P0: the base is red\nThe host's pre-flight gated ${start} before this cycle and these checks fail: ${si.current.baseRed.slice(0, 12).join(", ")}. This is a repair cycle: the host allows two for this head, then asks a person. Fix those failures and nothing else: no board items, no improvements. If you cannot, say what you found in the note and stop; a person is asked next.` : "";
  const focus = `${contract.objective.title}${contract.objective.spec ? `: ${contract.objective.spec}` : ""}`;
  // The plan the cycle derives from its own diff, so a check the host gate runs is run here too.
  const verifyPlan = `Derive this diff's checks with \`node packages/core/check-all.ts --for-changed="$(git diff --name-only ${start}..HEAD | tr '\\n' ',')"\`, run every planned check, and name any you skipped in the note.`;
  const vars: Record<string, unknown> = { NN: pad(n), CYCLE: n, CYCLES: b.maxSteps, RUN: cfg.run, BRANCH: cfg.branch, INTEGRATION: cfg.integrationBranch, NOTE_PATH: WORKER_NOTE, BASE_REF: cfg.baseRef, PROPOSALS_PATH: paths.proposals,
    START: start, DIFF_BUDGET: REVIEW_DIFF_BUDGET, HALF_DIFF_BUDGET: REVIEW_DIFF_BUDGET / 2, DIFF_MEASURE: `git diff --no-renames ${start}..HEAD -- . ${excludes} | wc -c`, RECORD_DIRS: reviewRecordDirectories(cfg).join(" and "),
    NOTE_LIMIT: NOTE_CHARS, PRECEDENCE: WORK_PRECEDENCE,
    STREAM: cfg.integrationUpstream ? `\n\nYour stream: ${focus}. Work only inside this stream's area. Problems you find elsewhere go into a proposal at \`${paths.proposals}\`, not this cycle.` : "",
    CHARTER_NOTE: cfg.integrationUpstream ? " Where its priorities or bookkeeping paths differ from this prompt, this prompt wins: the merge review judges streams against the current stream charter, which states the precedence below." : "",
    BOARD: `${baseRed}${conflict}${dispatch ? dispatchBoardPrompt(board, si.current?.engineer ?? cycleEngineer(dispatch, n), dispatch) : stewarded ? boardPrompt(board) : ""}`,
    IMPROVE_MODE: stewarded ? "is for assigned improvements; board items outrank cleanup. Make the assigned system" : "is for when the review finds nothing worth fixing. Make an existing system",
    OWN_IDEAS: stewarded ? ` Own new ideas go into \`${paths.proposals}\` as proposals, not into this cycle, unless they block an assigned item.` : "",
    BOARD_RECORD: board.items.length ? " For each board item worked on, add exactly one line `Board: <ID> done|progress|blocked - <one sentence>`, using only the IDs under \"Assigned work\"." : "",
    REVIEW_BOOKKEEPING: cfg.integrationUpstream ? `Your assigned board items are listed under "Assigned work" near the top of this prompt (there is no board file to read). Read this run's proposals under autonomy/proposals/${cfg.run}-*.md. Do not edit the shared autonomy/BACKLOG.md.` : "Read `autonomy/BACKLOG.md`.",
    RECORD_BOOKKEEPING: cfg.integrationUpstream ? `Write each new proposal to its own new file at ${paths.proposals}, choosing a short descriptive slug; never edit the shared autonomy/BACKLOG.md.` : "Update `autonomy/BACKLOG.md` (statuses, new items with evidence) if this run keeps one.",
    BUDGET_USD: b.perStepUsd, HARD_BUDGET_USD: contract.templateOptions["perStepHardUsd"] ?? 2 * b.perStepUsd, VERIFY_PLAN: verifyPlan, SOFT_HOURS: +(cfg.limits.softMinutes / 60).toFixed(1), HARD_HOURS: +(cfg.limits.hardMinutes / 60).toFixed(1), PREVIOUS: previous,
    NETWORK_NOTE: egress.length ? ` and the hosts the run lists (${egress.join(", ")}, through a proxy)` : "" };
  const text = fs.readFileSync(path.join(PKG, "prompts", "cycle.md"), "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  const queued = (state.backlog ?? []).filter((item) => item.deliveredCycle === undefined || item.deliveredCycle === n);
  const backlog = queued.length ? `\n\n## Steward backlog for this cycle\n${queued.map((item) => `- ${item.message}`).join("\n")}` : "";
  ctx.save(() => { for (const item of queued) item.deliveredCycle = n; });
  // A steer recorded while an earlier cycle was working was meant for that cycle (live steers reach
  // the session directly): it is passed on marked as such, never as a fresh authoritative order.
  const feedback = ctx.engine.pendingFeedback.splice(0).map((f) => (f.inStep && f.step !== undefined && f.step < n
    ? `Sent during cycle ${pad(f.step)}, which has ended; apply only if it is still relevant: ${f.text.replace(/^Operator steering \(authoritative\): /, "Operator steering: ")}`
    : f.text));
  const full = `${text}${backlog}`;
  // A publication the leak scan refused is passed to the NEXT cycle's worker: the run keeps cycling
  // until it is gone, so the cycle must know it is the reason. The blocker holds locations only.
  const blocked = si.publishBlocker
    ? `## Publication blocked (pre-push leak scan)\nThe pre-push leak scan refuses to publish this run's commits, so this cycle cannot be published. The blocker (locations only):\n${si.publishBlocker}\nYour first job this cycle is to stop adding that identifier: remove it, or if it is legitimate propose an exception; the run cannot publish until it is gone.\n\n`
    : "";
  const withNotes = feedback.length ? `${full}\n\nNotes from the operator:\n${feedback.map((f) => `- ${f}`).join("\n")}` : full;
  return `${blocked}${withNotes}`;
}

const overBudgetReason = (detail: string | undefined): string => `the diff without lockfiles and this run's record files (${detail ?? "over budget"}) exceeds the merge review's budget of ${REVIEW_DIFF_BUDGET} characters; a larger change is never reviewed in part. Split the work across cycles`;

/** The start..head diff the merge review will judge, measured whole (same exclusions and upstream-conflict scope) or reported over budget. Never throws. */
async function measureDiff(ctx: StepContext, startSha: string): Promise<{ head: string; characters: number | null; budget: number; overBudget: boolean; detail?: string }> {
  const { repo } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(ctx.state);
  const g = repo.git();
  const head = repo.head();
  const upstream = si.current?.upstream;
  const resolves = upstream?.outcome === "conflict" ? upstream.head : null;
  try {
    let files = repo.changedPaths(startSha, head);
    let from = startSha;
    let restrict = false;
    if (resolves) {
      const base = g(["merge-base", startSha, resolves], { allowFail: true });
      if (!base) return { head, characters: null, budget: REVIEW_DIFF_BUDGET, overBudget: false, detail: "no merge base between the integration branch and the upstream head" };
      files = upstreamMergeScope({ startToHead: files, upstreamToHead: repo.changedPaths(resolves, head), baseToUpstream: repo.changedPaths(base, resolves), startToUpstream: repo.changedPaths(startSha, resolves) }).own;
      from = resolves;
      restrict = true;
    }
    const read = repo.reviewDiff(from, head, REVIEW_DIFF_BUDGET, cfg, { files, restrict });
    if (read.ok) return { head, characters: read.text.length, budget: REVIEW_DIFF_BUDGET, overBudget: false };
    return { head, characters: read.characters ?? null, budget: REVIEW_DIFF_BUDGET, overBudget: read.reason === "over-budget", ...(read.detail ? { detail: read.detail } : {}) };
  } catch (e) {
    return { head, characters: null, budget: REVIEW_DIFF_BUDGET, overBudget: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Adapt the engine's runtime to what lib/cycle.ts expects. */
function cycleRuntime(ctx: StepContext, { n, resume, startSha, dir, onSalvage }: { n: number; resume: boolean; startSha: string; dir: string; onSalvage: (ev: AcceptanceEvaluation) => void }): CycleRuntime {
  const { engine, rt, repo, contract, state, store } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const g = repo.git();
  const branchRef = `refs/heads/${cfg.branch}`;
  // The workspace reset is owed until a session proves it started (its first RPC frame): a session
  // that dies in the entrypoint (for example on a dirty tree) is relaunched with the reset again.
  let resetPending = !resume;
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
    startAgent: ({ attempt, onEvent, say }) => {
      const reset = resetPending;
      state.sessions = (state.sessions ?? 0) + 1;
      ctx.log(`cycle ${pad(n)} session ${attempt} starting${reset ? " (workspace reset to the branch)" : ""}`);
      const started = (ev: Parameters<typeof onEvent>[0]): void => { resetPending = false; onEvent(ev); };
      const agent = rt.startWorker({ step: n, attempt: state.sessions, resetWorkspace: reset, effort: state.effort, onEvent: reset ? started : onEvent });
      engine.adoptAgent(agent, say);
      return agent;
    },
    headSha: async () => repo.head(),
    // A report already on the branch when the cycle began (a reused cycle directory) is not this cycle's: only a new or rewritten one counts.
    // The worker's note in the state home is the close-out. A worker that still commits a report.md (an older prompt on a resumed cycle) is honoured too.
    reportExists: async () => {
      return readNote(store.p.agentState) !== null || isNewReport(repo.fileAt(branchRef, `${dir}/report.md`), repo.fileAt(startSha, `${dir}/report.md`));
    },
    reportGaps: async () => {
      const report = repo.fileAt(branchRef, `${dir}/report.md`);
      if (report === null || report === repo.fileAt(startSha, `${dir}/report.md`)) return [];
      const upstream = si.current?.upstream;
      const also = upstream?.outcome === "conflict" ? [upstream.head] : [];
      return uncoveredCommits(report, ledgerCommits(g, startSha, branchRef, also), `${dir}/report.md`);
    },
    // The same start..head diff mergeDecision will judge, measured while the worker is still alive:
    // same exclusions (records and package-lock.json) and the same upstream-conflict scope. An
    // over-budget result carries the exact measured length (ReviewDiffRead.characters) so the
    // cycle can steer the worker before the session ends; mergeDecision stays the fail-closed
    // backstop. Never throws: an unreadable probe reports not-over-budget rather than breaking a cycle.
    diffBudget: () => measureDiff(ctx, startSha),
    meterUsd: async () => { await engine.refreshUsage(); return state.usage.usd; },
    totalUsd: async () => { await engine.refreshUsage(); return state.usage.usd; },
    stopRequested: () => engine.stopRequested || !engine.active || pendingControl() || engine.limitReached() !== null,
    onAutoRestart: (used) => { ctx.save(() => { if (si.current) si.current.autoRestarts = used; }); },
    salvageReport: async () => {
      const sha = repo.head();
      if (sha === startSha) return false;
      state.phase = "acceptance";
      engine.tick();
      const ev = await engine.withGateSlot(() => runAcceptance({ rt, contract, sha, step: n, dir: path.join(engine.stepDir(n), "salvage-checks"), runRoot: store.p.root, log: ctx.log }));
      state.phase = "work";
      engine.tick();
      if (!ev.allRequiredPass || engine.stopRequested || pendingControl()) return false;
      const report = `Outcome: partial\n\nHost close-out: the worker exited before recording report.md. Required acceptance checks passed at ${sha}. This is committed work only; completion and mode are unknown. Independent merge review is required.\n\n${repo.logSince(startSha, sha)}`;
      writeJsonAtomic(path.join(engine.stepDir(n), "salvaged-report.json"), { sha, report });
      onSalvage(ev);
      ctx.save((s) => { s.artefacts.push({ kind: "salvaged-report", path: path.join("steps", pad(n), "salvaged-report.json"), step: n, at: new Date(rt.now()).toISOString() }); });
      ctx.log(`cycle ${pad(n)} report synthesised from committed work at ${sha.slice(0, 12)}`);
      return true;
    },
    manager: async (bundle) => {
      const d = await decide(bundle, rt.complete(cfg.managerModel));
      const file = path.join(engine.stepDir(n), "decisions.jsonl");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date(rt.now()).toISOString(), triggers: bundle.triggers, ...d })}\n`);
      return d;
    },
    extras: async () => ({ gitLog: gm.logSince(g, startSha, branchRef), note: readNote(store.p.agentState) }),
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

export async function runStep(ctx: StepContext): Promise<void> {
  const { engine, rt, repo, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const g = repo.git();
  // Two merged cycles the leak scan has refused: stop adding unpublished merges and wait for a person.
  if (!si.current && (si.publishBlockedCycles ?? 0) >= 2) {
    // A stop answer ends through the same final gate as the other run stop reasons and keeps the
    // unpublished history: the rollback below discards it, and the operator who stops may want to
    // inspect that work. Any other answer permits one cycle after the rollback to the last published
    // head. If publication is still refused, publishBlocker and publishBlockedCycles stay set, so
    // the next runStep parks here again with a fresh question.
    const answer = state.pendingAnswer?.id === "publish-blocked" ? state.pendingAnswer : null;
    if (answer) {
      if (answer.approved === false || answer.text.trim().toLowerCase() === PUBLISH_BLOCKED_STOP.toLowerCase()) {
        ctx.save((s) => { s.pendingAnswer = null; });
        await finalize(ctx, PUBLISH_BLOCKED_STOP_REASON);
        return;
      }
      resetToLastPublished(ctx);
      // A submission recorded for a discarded merge names a commit no longer on the branch: reopen it.
      await reviseDispatchSubmissions(ctx);
      ctx.save((s) => { s.pendingAnswer = null; });
    } else {
      const detail = si.publishBlocker?.replace(/^publication blocked by pre-push leak scan:\s*/, "") ?? "the leak scan refused the commit";
      await engine.enterBlocked({ kind: "external", id: "publish-blocked", method: "publish", question: `Publication of ${si.publishBlockedCycles} merged cycle(s) is blocked by the pre-push leak scan at ${detail}; remove the identifier or stop the run.`, options: [PUBLISH_BLOCKED_RESUME, PUBLISH_BLOCKED_STOP] });
      return;
    }
  }
  // A person answered a base question (pre-flight found the base red, or the provider unavailable for long).
  const baseAnswer = !si.current && (state.pendingAnswer?.id === "base-red" || state.pendingAnswer?.id === "base-infra") ? state.pendingAnswer : null;
  if (baseAnswer) {
    ctx.save((s) => { s.pendingAnswer = null; });
    if (baseAnswer.approved === false || baseAnswer.text.trim().toLowerCase() === BASE_STOP.toLowerCase()) { await finalize(ctx, "base_red_stopped"); return; }
    // The person fixed the base or the host: look again, and allow one repair cycle for the head as it now is.
    ctx.save(() => { delete si.baseRepairs; delete si.preflight; si.infraWaits = 0; });
  }
  if (!si.current && nothingFoundInARow(si.history) >= cfg.limits.nothingFoundToStop) { await finalize(ctx, "backlog_exhausted"); return; }
  const resume = Boolean(si.current);
  const n = si.current?.n ?? si.history.length + 1;
  const dir = cycleDir(cfg, n);
  fs.mkdirSync(engine.stepDir(n), { recursive: true });
  let upstream = si.current?.upstream;
  let baseRed: string[] | undefined;
  let claimed: StewardBoard | undefined;
  let engineer: string | undefined;
  if (!resume) {
    let sync: gm.SyncResult;
    try { sync = gm.syncIntegration(g, cfg); }
    catch (e) {
      if (!cfg.integrationUpstream) throw e;
      const local = g(["rev-parse", "--verify", `refs/heads/${cfg.integrationBranch}`], { allowFail: true });
      if (!local) throw e;
      log(`integration fetch failed; retaining the local head: ${errorMessage(e)}`);
      sync = { state: "ahead", head: local };
    }
    if (sync.state === "diverged") {
      const rec = gm.reconcileIntegration(g, cfg, sync);
      if (rec.state === "conflict") {
        await engine.enterBlocked({ kind: "external", id: "integration-diverged", method: "integration", question: `${cfg.integrationBranch} at the destination (${rec.remote.slice(0, 12)}) and here (${rec.head.slice(0, 12)}) have diverged and the automatic rebase conflicts; reconcile them by hand, then answer to resume, or stop the run`, options: ["Reconciled by hand; resume", "Stop the run"] });
        return;
      }
      log(`${cfg.integrationBranch} diverged: rebased ${rec.commits} local commit(s) ${rec.from.slice(0, 12)} -> ${rec.head.slice(0, 12)} onto the destination ${rec.remote.slice(0, 12)}`);
      const rewritten = new Map(rec.mapping.map(({ from, to }) => [from, to]));
      const through = (sha: string): string => rewritten.get(sha) ?? sha;
      ctx.save((s) => {
        const record = siState(s);
        record.history = record.history.map((entry) => ({ ...entry, start: through(entry.start), head: through(entry.head) }));
        record.lastGoodSha = through(record.lastGoodSha);
        if (record.current) record.current.startSha = through(record.current.startSha);
        record.reconciliations = [...(record.reconciliations ?? []), { at: new Date(rt.now()).toISOString(), from: rec.from, remote: rec.remote, head: rec.head, commits: rec.commits }];
      });
      await reviseDispatchSubmissions(ctx, through);
    }
    if (sync.state === "absent") throw new Error(`${cfg.integrationBranch} exists neither here nor at the destination`);
    if (sync.state === "adopted") log(`${cfg.integrationBranch} moved at the destination; continuing from ${sync.head.slice(0, 12)}`);
    upstream = gm.syncUpstream(g, cfg);
    if (upstream) log(`cycle ${pad(n)} upstream ${upstream.upstream}: ${upstream.outcome}${upstream.outcome === "merged" || upstream.outcome === "fast_forward" ? ` ${upstream.sha}` : "head" in upstream ? ` ${upstream.head}` : " (continuing without upstream)"}`);
    const head = gm.startCycleBranch(g, cfg);
    // Never start model work on a red base, and never start a model to look for work that is not there.
    const base = await baseCheck(ctx, n, head);
    if (base === "parked") return;
    baseRed = base.repair;
    // A dispatch cycle claims its one item before the empty-queue test, under the board lock; a
    // repair cycle claims nothing. The claim becomes the cycle's board snapshot below.
    // The cycle's engineer comes first; when it has nothing, another engineer's open claim is
    // continued rather than the run idling on it. A board lock held past the bounded wait is a
    // busy writer, not a broken run: the poll counts as idle and the next tick retries.
    const dispatch = dispatchOf(ctx.contract);
    if (dispatch && !baseRed) {
      let claim: CycleClaim;
      try { claim = await claimForCycle(ctx.store.p.control, { options: dispatch, engineers: cycleRotation(dispatch, n), attempts: si.itemAttempts, at: new Date(rt.now()).toISOString() }); }
      catch (e) {
        if (!(e instanceof BoardLockBusy)) throw e;
        log(`cycle ${pad(n)} dispatch: the board lock is busy (${errorMessage(e)}); looking again next tick`);
        await rt.sleep(rt.tickMs);
        return;
      }
      claimed = claim.board;
      engineer = claim.engineer;
      const item = claim.board.items[0];
      if (item) log(`cycle ${pad(n)} dispatch: ${claim.outcome} ${item.id} for ${claim.engineer}`);
    }
    if (!baseRed && (await idleQueue(ctx, upstream, claimed))) return;
    const last = si.history.at(-1);
    const extra = last && !last.merged && !last.discarded && last.head !== head ? [`refs/tags/${cfg.tagPrefix}cycle-${pad(last.n)}`] : [];
    if (upstream?.outcome === "conflict") extra.push("refs/upstream/trunk");
    await rt.setWorkerBranch(head, extra);
    publishNow(ctx);
    log(`cycle ${pad(n)} branch set to ${cfg.integrationBranch} ${head.slice(0, 12)}`);
  }
  const startSha = si.current?.startSha ?? repo.head();
  si.current = { ...si.current, n, autoRestarts: si.current?.autoRestarts ?? 0, startedAt: si.current?.startedAt ?? new Date(rt.now()).toISOString(), startSha, ...(upstream ? { upstream } : {}), ...(baseRed ? { baseRed } : {}), ...(claimed ? { board: claimed } : {}), ...(engineer ? { engineer } : {}) };
  state.step = n;
  state.phase = "work";
  ctx.save();
  log(`cycle ${pad(n)}/${state.limits.budget.maxSteps} ${resume ? "resuming" : "starting"}; spent $${state.usage.usd.toFixed(2)} of $${state.limits.budget.totalUsd}`);
  const held = si.current.reviewPending;
  if (held) {
    // Parked on review-pending: the cycle already ended and its head is held, so the answer retries
    // the review; no worker session starts and the head cannot change before the close-out.
    if (state.pendingAnswer?.id === "review-pending") ctx.save((s) => { s.pendingAnswer = null; });
    ctx.save(() => { if (si.current) delete si.current.reviewPending; });
    await closeCycle(ctx, n, { ...held, decisions: [] });
    return;
  }
  await engine.applyControl({ only: ["backlog"] });
  if (!engine.active) return;
  if (!resume) clearNote(ctx.store.p.agentState); // a note from an earlier cycle is not this one's
  const prompt = cyclePrompt(ctx, n);
  if (state.unaccepted) ctx.save((s) => { s.unaccepted = null; });
  const restartBriefing = resume ? `The previous session of this cycle was interrupted. Read ${WORKER_NOTE} if it exists, check \`git status\` and \`git log\`, then continue the cycle from where it stopped.${state.pendingAnswer ? `\n\n${await engine.briefing("answer")}` : ""}` : undefined;
  const runCfg = { ...cfg, budget: { ...cfg.budget, totalUsd: state.limits.budget.totalUsd, perCycleUsd: state.limits.budget.perStepUsd }, cycles: state.limits.budget.maxSteps };
  let salvagedEvaluation: AcceptanceEvaluation | undefined;
  const result = await runCycle({ n, cfg: runCfg, rt: cycleRuntime(ctx, { n, resume, startSha, dir, onSalvage: (ev) => { salvagedEvaluation = ev; } }), prompt, cycleDir: dir, restartBriefing, autoRestartsUsed: si.current.autoRestarts ?? 0, bookkeeping: bookkeepingPaths(cfg, n) });
  await engine.refreshUsage();
  if (result.outcome === "blocked") { // the cycle stays current; the answer resumes it
    if (!result.blocker) throw new Error(`cycle ${pad(n)} ended blocked without a blocker`);
    await engine.enterBlocked(result.blocker);
    return;
  }
  const control = engine.stopRequested || !engine.active || engine.store.pending().some((m) => m.kind === "cancel" || m.kind === "pause");
  if (result.outcome === "aborted" && control) return; // interrupted by a command or a signal: the cycle stays current for resume
  await closeCycle(ctx, n, result, salvagedEvaluation);
  if (result.outcome === "aborted" && /^manager:/.test(result.reason)) {
    engine.go("blocked", { reason: "external", blocker: { kind: "external", id: `manager-${n}`, method: "manager", question: `The manager model stopped the run for a person to look at: ${result.reason.replace(/^manager:\s*/, "")}. Resume with --answer "<what to do>" to continue, or cancel.`, options: [] } });
  }
}

const BASE_STOP = "Stop the run";
const INFRA_WAITS_BEFORE_ASKING = 6;

/** The pre-flight and empty-queue options (templateOptions.knownFlakes, emptyQueueSleepMinutes). */
function leanOptions(contract: RunContract): { knownFlakes: string[]; sleepMs: number } {
  const flakes = contract.templateOptions["knownFlakes"];
  const minutes = contract.templateOptions["emptyQueueSleepMinutes"];
  return { knownFlakes: Array.isArray(flakes) ? flakes.filter((f): f is string => typeof f === "string") : [], sleepMs: (typeof minutes === "number" ? minutes : 15) * 60_000 };
}

/** The head already passed a trusted gate, so gating it again would add no evidence. */
function knownGreen(state: RunState, head: string): boolean {
  const si = siState(state);
  return state.acceptance.history.some((h) => h.sha === head && h.allRequiredPass) || (state.acceptance.latest?.sha === head && state.acceptance.latest.allRequiredPass) || (si.preflight?.sha === head && (si.preflight.verdict === "green" || si.preflight.verdict === "flake"));
}

/**
 * Gate the base before a cycle starts (lib/preflight.ts). "go" starts the cycle, with `repair` set
 * for the one host-built repair of a red product base; "parked" means the host slept or asked a
 * person and no model was called.
 */
async function baseCheck(ctx: StepContext, n: number, head: string): Promise<"parked" | { repair?: string[] }> {
  const { engine, rt, contract, state, log } = ctx;
  const si = siState(state);
  if (knownGreen(state, head)) return {};
  const wait = si.preflight;
  if (wait?.sha === head && wait.waitUntil !== undefined && rt.now() < wait.waitUntil) { await rt.sleep(rt.tickMs); return "parked"; }
  // A base already found red is not gated again: the same head would give the same answer.
  const redBefore = si.preflight?.sha === head && si.preflight.verdict === "product";
  if (!redBefore) { state.phase = "acceptance"; engine.tick(); log(`cycle ${pad(n)} pre-flight: gating base ${head.slice(0, 12)}`); }
  const verdict: BaseVerdict = redBefore ? { verdict: "product", failing: si.preflight?.failing ?? [], reason: "the base fails its own checks" } : await preflight({
    knownFlakes: leanOptions(contract).knownFlakes,
    // Each run keeps its own evidence directory, so a flake's first failure survives its confirmation run.
    run: (label) => engine.withGateSlot(async () => {
      const ev = await runAcceptance({ rt, contract, sha: head, step: n, dir: path.join(engine.stepDir(n), "preflight", label), runRoot: ctx.store.p.root, log });
      ctx.save((s) => { for (const r of ev.results) s.artefacts.push({ kind: "check-evidence", path: r.evidence, step: n, at: r.at }); });
      return ev;
    }),
  });
  if (!redBefore) ctx.save((s) => { s.phase = null; });
  if (engine.stopRequested) return "parked";
  const failing = "failing" in verdict ? verdict.failing : [];
  const record = { sha: head, at: new Date(rt.now()).toISOString(), verdict: verdict.verdict, failing };
  if (!redBefore) writeJsonAtomic(path.join(engine.stepDir(n), "preflight.json"), { ...record, ...("reason" in verdict ? { reason: verdict.reason } : {}) });
  if (verdict.verdict === "green" || verdict.verdict === "flake") {
    ctx.save(() => { si.preflight = record; si.infraWaits = 0; });
    if (verdict.verdict === "flake") log(`pre-flight: ${failing.join(", ")} failed once and passed on the confirmation run (listed flake); the first failure is kept under ${path.join("steps", pad(n), "preflight", "first")}`);
    return {};
  }
  if (verdict.verdict === "infra") {
    const waits = (si.infraWaits ?? 0) + 1;
    if (waits >= INFRA_WAITS_BEFORE_ASKING) {
      ctx.save(() => { si.preflight = record; si.infraWaits = 0; });
      await engine.enterBlocked({ kind: "external", id: "base-infra", method: "preflight", waiting: "waiting_provider", question: `The base ${head.slice(0, 12)} could not be gated ${waits} times in a row for host or provider reasons (${failing.join(", ")}); fix the host or provider, then answer to look again, or stop the run`, options: ["Fixed; look again", BASE_STOP] });
      return "parked";
    }
    const minutes = Math.min(60, 5 * 2 ** (waits - 1));
    ctx.save(() => { si.preflight = { ...record, waitUntil: rt.now() + minutes * 60_000 }; si.infraWaits = waits; });
    log(`pre-flight: ${verdict.reason}; no work starts, trying again in ${minutes} min`);
    return "parked";
  }
  const repairs = si.baseRepairs?.[head] ?? 0;
  if (verdict.verdict === "product" && repairs < ATTEMPTS_PER_ITEM) {
    ctx.save(() => { si.preflight = record; (si.baseRepairs ??= {})[head] = repairs + 1; });
    log(`pre-flight: base ${head.slice(0, 12)} is red (${failing.join(", ")}); repair cycle ${repairs + 1} of ${ATTEMPTS_PER_ITEM}, no other work`);
    return { repair: failing.length ? failing : ["the acceptance gate"] };
  }
  ctx.save(() => { si.preflight = record; });
  await engine.enterBlocked({ kind: "external", id: "base-red", method: "preflight", question: `The base ${head.slice(0, 12)} fails its own checks (${failing.join(", ")}): ${verdict.reason}${repairs ? `; ${repairs} repair cycle(s) did not fix it` : ""}. Evidence is under steps/${pad(n)}/preflight. Fix the base, then answer to look again, or stop the run`, options: ["Fixed; look again", BASE_STOP] });
  return "parked";
}

/** True when the queue is empty and the host slept: nothing is started, nothing is billed. */
async function idleQueue(ctx: StepContext, upstream: gm.UpstreamSync | undefined, claimed?: StewardBoard): Promise<boolean> {
  const { engine, rt, repo, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  await engine.applyControl({ only: ["backlog"] });
  if (!engine.active) return true;
  // A dispatch run is stewarded, and its only board work is the item it holds or just claimed.
  const dispatch = dispatchOf(ctx.contract) !== null;
  const offered = dispatch ? claimed ?? { items: [] } : readBoard(ctx.store.p.control);
  const stewarded = dispatch || Boolean(cfg.integrationUpstream) || offered.items.length > 0;
  const last = si.history.at(-1);
  const work = queueWork({
    stewarded, offered: withoutWithheld(offered, si.itemAttempts), backlogText: repo.fileAt(repo.head(), "autonomy/BACKLOG.md"), cycles: si.history.length,
    steerMessages: engine.pendingFeedback.length + (state.backlog ?? []).filter((m) => m.deliveredCycle === undefined).length,
    hostWork: upstream?.outcome === "conflict" || Boolean(si.publishBlocker) || Boolean(state.unaccepted),
    last: last ? { merged: last.merged, discarded: last.discarded, gate: last.gate, reportOutcome: last.reportOutcome } : undefined,
  });
  if (work) {
    if (si.idle) { log(`queue no longer empty (${work}); starting a cycle`); ctx.save(() => { delete si.idle; }); }
    return false;
  }
  const { sleepMs } = leanOptions(ctx.contract);
  const now = rt.now();
  if (!si.idle) {
    log(`queue empty: nothing assigned, failing or carried over; sleeping ${Math.round(sleepMs / 60_000)} min between looks with no model call`);
    ctx.save(() => { si.idle = { since: new Date(now).toISOString(), until: now + sleepMs, polls: 0 }; });
  } else if (now >= si.idle.until) {
    const polls = si.idle.polls + 1;
    ctx.save(() => { if (si.idle) { si.idle.polls = polls; si.idle.until = now + sleepMs; } });
    // A run with a board waits for the steward as long as it is allowed to run; a run without one ends when its backlog stays empty.
    if (!stewarded && polls >= cfg.limits.nothingFoundToStop) { await finalize(ctx, "backlog_exhausted"); return true; }
  }
  await rt.sleep(rt.tickMs);
  return true;
}

/** Acceptance checks on the cycle head, tag, merge decision and integration; port of the v0 close-out. */
async function closeCycle(ctx: StepContext, n: number, result: CycleResult, salvagedEvaluation?: AcceptanceEvaluation): Promise<void> {
  const { engine, rt, repo, contract, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const si = siState(state);
  const g = repo.git();
  await engine.syncFromWorker({ silent: true });
  const sha = repo.head();
  const start = g(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
  const changed = sha !== start;
  let gate: CycleGate = { skipped: true, green: false, results: [] };
  // The diff cap is enforced here, in code, before the gate or any model: an over-budget diff is never
  // reviewed in part, so the gate's minutes and the review's tokens would both be wasted on it.
  const early = changed && (result.outcome === "completed" || result.outcome === "partial") ? await measureDiff(ctx, start) : null;
  const tooBig = early?.overBudget === true ? overBudgetReason(early.characters === null ? early.detail : `${early.characters} characters`) : null;
  if (tooBig) log(`cycle ${pad(n)} diff over the review budget; no acceptance run and no review`);
  if (changed && !tooBig) {
    state.phase = "acceptance";
    engine.tick();
    log(`cycle ${pad(n)} acceptance on ${sha.slice(0, 12)}`);
    const ev = salvagedEvaluation?.sha === sha ? salvagedEvaluation : await engine.withGateSlot(() => runAcceptance({ rt, contract, sha, step: n, dir: path.join(engine.stepDir(n), "checks"), runRoot: ctx.store.p.root, log }));
    gate = { skipped: false, green: ev.allRequiredPass, results: ev.results };
    ctx.save((s) => {
      s.acceptance.latest = summariseEvaluation(ev);
      s.acceptance.history = [...s.acceptance.history, { step: n, sha, allRequiredPass: ev.allRequiredPass }].slice(-20);
      for (const r of ev.results) s.artefacts.push({ kind: "check-evidence", path: r.evidence, step: n, at: r.at });
    });
  }
  if (engine.stopRequested) return;
  const failing = gate.results.flatMap((r) => (r.steps?.length ? r.steps.filter((x) => x.code !== 0).map((x) => x.name) : r.pass ? [] : [r.id]));
  const salvaged = result.reason === "host close-out after session exit";
  // The worker's close-out is its note in the state home; a committed report.md still counts for a worker that writes one.
  const note = readNote(ctx.store.p.agentState);
  const report = note ?? repo.fileAt(sha, `${cycleDir(cfg, n)}/report.md`);
  const board = parseBoardReport(report);
  const declared = result.outcome === "completed" ? reportOutcome(report) : { outcome: null, mode: null };
  const current = si.current;
  if (!current) throw new Error(`cycle ${pad(n)} is closing but no cycle is current`);
  repo.tag(`cycle-${pad(n)}`, sha);
  const recovered = salvaged ? readJson(path.join(engine.stepDir(n), "salvaged-report.json")) : null;
  const salvage = isPlainObject(recovered) && recovered.sha === sha && typeof recovered.report === "string" ? recovered.report : undefined;
  if (salvaged && !salvage) throw new Error(`cycle ${pad(n)} host report is missing or does not match ${sha}`);
  const merge: MergeDecision = tooBig ? { merge: false, reason: tooBig } : await mergeDecision(ctx, n, { result, sha, start, changed, gate, salvage, failing, note });
  if (engine.stopRequested) return;
  if (merge.reviewUnavailable !== undefined) {
    // The work was never judged: keep the cycle current (its commits stay on the branch and under
    // the cycle tag) and park for a person; the answer re-runs the review, nothing is rejected.
    log(`cycle ${pad(n)} review unavailable; parked at ${sha.slice(0, 12)}`);
    ctx.save(() => { if (si.current) si.current.reviewPending = { outcome: result.outcome === "blocked" ? "aborted" : result.outcome, reason: result.reason, attempts: result.attempts, costUsd: result.costUsd, head: result.head }; });
    await engine.enterBlocked(reviewBlocker(merge.reviewUnavailable, sha));
    return;
  }
  if (merge.merge) {
    const r = gm.integrate(g, cfg, sha);
    merge.merged = r.merged;
    if (!r.merged) merge.reason = r.reason;
  }
  if (merge.merged) { si.lastGoodSha = sha; si.merged = (si.merged ?? 0) + 1; delete si.baseRepairs; } // a green head ends the repairs: a later rollback to a red head starts its allowance afresh
  if (merge.merged) await recordDispatchSubmission(ctx, n, board);
  publishNow(ctx);
  // A merged cycle the leak scan refused is one more unpublished cycle stacked; a non-merged cycle
  // leaves the count unchanged. Only a successful publish (in publishNow) clears it.
  if (merge.merged && si.publishBlocker) si.publishBlockedCycles = (si.publishBlockedCycles ?? 0) + 1;
  const entry: CycleEntry = { n, outcome: result.outcome, reason: result.reason, attempts: result.attempts, start, head: sha, gate: gate.skipped ? "skipped" : gate.green ? "green" : "red", gateFailing: failing,
    reportOutcome: declared.outcome, mode: declared.mode, merged: Boolean(merge.merged), mergeReason: merge.reason, review: merge.review ?? null, ...(merge.risk ? { risk: { tier: merge.risk.tier, reasons: merge.risk.reasons } } : {}), costUsd: +result.costUsd.toFixed(4),
    decisions: result.decisions.map(({ decision, reason, triggers }) => ({ decision, reason, triggers })), startedAt: current.startedAt, endedAt: new Date(rt.now()).toISOString(), board, ...(merge.unknownClaims?.length ? { unknownClaims: merge.unknownClaims } : {}), ...(current.upstream ? { upstream: current.upstream } : {}),
    effective: { contractDigest: state.contractDigest, limits: { ...SELF_IMPROVE_LIMITS, budget: state.limits.budget } },
    ...(rt.meterSummary ? (() => { const m = rt.meterSummary(n); return { meter: { byRole: Object.fromEntries(Object.entries(m.byRole).map(([k, v]) => [k, +v.toFixed(4)])), rows: m.rows, unresolved: m.unresolved } }; })() : {}) };
  // One ordinary attempt plus one repair per board item (lib/attempts.ts). A cycle is charged only for
  // the items its report claims that are on its board. With no such claim (a crash, an exhausted budget,
  // a no-change cycle, a provider outage) nothing is charged, except for a merge-level review REJECT,
  // which is a verdict on the assigned work; infrastructure and provider failures never withhold an item.
  const claimed = current.board ? board.filter((c) => current.board?.items.some((i) => i.id === c.id)).map((c) => c.id) : [];
  const worked = claimed.length ? claimed : current.board && entry.review === "REJECT" ? assignedItems(current.board).map((i) => i.id) : [];
  if (worked.length) {
    const withheld = recordAttempts(si.itemAttempts ??= {}, worked, { merged: entry.merged, reason: entry.mergeReason, at: entry.endedAt });
    for (const id of withheld) log(`board item ${id} is no longer offered: ${ATTEMPTS_PER_ITEM} attempt(s) did not merge (last: ${entry.mergeReason.slice(0, 200)})`);
    // Surfaced in the cycle record the steward reads, not only in the log.
    if (withheld.length) entry.withheldItems = withheld;
  }
  // The host's receipt and the worker's note go to the run state home, not the branch: the next cycle's briefing reads them from there.
  const previousCycle = si.history.at(-1);
  let changedPaths: string[] = [];
  if (changed) { try { changedPaths = repo.changedPaths(start, sha); } catch { changedPaths = []; } }
  writeReceipt(engine.stepDir(n), {
    run: cfg.run, cycle: n,
    items: { assigned: current.board ? assignedItems(current.board).map((i) => i.id) : [], claimed },
    start, head: sha, changedPaths, gate: entry.gate, gateFailing: failing,
    review: { verdict: entry.review, tier: entry.risk?.tier ?? null, reasons: entry.risk?.reasons.slice(0, 5) ?? [] },
    outcome: entry.outcome, merged: entry.merged, mergeReason: entry.mergeReason.slice(0, 600), costUsd: entry.costUsd, attempts: entry.attempts,
    lineage: { previousCycle: previousCycle?.n ?? null, previousMerged: previousCycle ? previousCycle.merged : null, itemAttempts: Object.fromEntries(worked.map((id) => [id, si.itemAttempts?.[id]?.attempts ?? 0])) },
    note: { outcome: declared.outcome, mode: declared.mode, present: note !== null }, at: entry.endedAt,
  }, note);
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
  engine.writeStepSummary(n, { action: "cycle", outcome: entry.outcome, gate: entry.gate, merged: entry.merged, ...(salvaged ? { report: path.join("steps", pad(n), "salvaged-report.json") } : {}) });
  ctx.save();
  log(`cycle ${pad(n)} done: ${entry.outcome}, gate ${entry.gate}${failing.length ? ` (${failing.join(", ")})` : ""}, $${entry.costUsd}; tagged ${cfg.tagPrefix}cycle-${pad(n)}; ${entry.merged ? `merged into ${cfg.integrationBranch}` : `not merged (${entry.mergeReason})`}`);
}

/**
 * A merged dispatch cycle whose note reports its claimed item `done`: record the submission
 * (submittedAt and the integration head) on the board, so the next cycle does not continue the
 * item. Never fails the close-out: a board that moved on is logged and left alone.
 */
async function recordDispatchSubmission(ctx: StepContext, n: number, reports: readonly BoardReport[]): Promise<void> {
  const dispatch = dispatchOf(ctx.contract);
  const current = siState(ctx.state).current;
  const item = current?.board?.items[0];
  if (!dispatch || !item || !reports.some((r) => r.id === item.id && r.status === "done")) return;
  const engineer = current?.engineer ?? cycleEngineer(dispatch, n);
  const cfg = siConfig(ctx.cfg);
  try {
    const sha = ctx.repo.git()(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
    const skipped = await recordSubmission(ctx.store.p.control, { id: item.id, engineer, sha, at: new Date(ctx.rt.now()).toISOString() });
    ctx.log(skipped ? `cycle ${pad(n)} dispatch: submission of ${item.id} not recorded: ${skipped}` : `cycle ${pad(n)} dispatch: ${item.id} submitted by ${engineer} at ${sha.slice(0, 12)}`);
  } catch (e) {
    ctx.log(`cycle ${pad(n)} dispatch: submission of ${item.id} not recorded: ${errorMessage(e)}`);
  }
}

/**
 * After the host rewrote or discarded integration history (the publish-blocked rollback, or the
 * rebase of a diverged branch): map each submission the run's engineers recorded through the
 * rewrite, and clear one whose commit is no longer on the integration branch, so its item is
 * worked again. Logged, never fatal: a board left behind is the steward's to correct.
 */
async function reviseDispatchSubmissions(ctx: StepContext, through: (sha: string) => string = (sha) => sha): Promise<void> {
  const dispatch = dispatchOf(ctx.contract);
  if (!dispatch) return;
  const cfg = siConfig(ctx.cfg);
  const g = ctx.repo.git();
  try {
    const head = g(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
    const revised = await reviseSubmissions(ctx.store.p.control, dispatch.engineers, (sha) => {
      const to = through(sha);
      return g(["merge-base", "--is-ancestor", to, head], { allowFail: true }) === null ? null : to;
    });
    for (const r of revised) ctx.log(r.to ? `dispatch: submission of ${r.id} moved ${r.from.slice(0, 12)} -> ${r.to.slice(0, 12)} with the rewritten integration history` : `dispatch: submission of ${r.id} at ${r.from.slice(0, 12)} cleared: the commit is no longer on ${cfg.integrationBranch}, so the item is worked again`);
  } catch (e) {
    ctx.log(`dispatch: submissions not re-checked after the integration history changed: ${errorMessage(e)}`);
  }
}

/** templateOptions.integration's review-input options (validated in validate()). */
function integrationOptions(contract: RunContract): { controlPaths: string[]; allowControlChanges: boolean; r0Review: number } {
  const integration = contract.templateOptions["integration"];
  const o = isPlainObject(integration) ? integration : {};
  const paths = o["controlPaths"];
  return {
    controlPaths: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [],
    allowControlChanges: o["allowControlChanges"] === true,
    r0Review: typeof o["r0Review"] === "number" ? o["r0Review"] : 1,
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

/** Completed or partial work with commits and a green gate is eligible; review fails closed. */
async function mergeDecision(ctx: StepContext, n: number, { result, sha, start, changed, gate, salvage, failing, note }: { note?: string | null | undefined; salvage?: string | undefined; result: CycleResult; sha: string; start: string; changed: boolean; gate: CycleGate; failing: readonly string[] }): Promise<MergeDecision> {
  const { rt, repo, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  if (!changed) return { merge: false, reason: "no commits" };
  if (result.outcome !== "completed" && result.outcome !== "partial") return { merge: false, reason: `cycle ${result.outcome} (${result.reason})` };
  // A red gate is never merged and cannot be waived, but it is still reviewed (PG-46): the review
  // judges the committed work and its concerns travel into the next cycle's prompt.
  const gateGreen = gate.green;
  const failingNote = `acceptance checks failed${failing.length ? ` (${failing.slice(0, 8).join(", ")})` : ""}`;
  // A host-closed partial cycle that never went green is not reviewed: the close-out reason and the
  // failing checks already travel to the next cycle, and there is no completed work to judge.
  if (!gateGreen && result.outcome !== "completed") return { merge: false, reason: failingNote };
  const upstream = siState(ctx.state).current?.upstream;
  const g = repo.git();
  const resolves = upstream?.outcome === "conflict" ? upstream.head : null;
  if (resolves && g(["merge-base", "--is-ancestor", resolves, sha], { allowFail: true }) === null) return { merge: false, reason: "upstream merge conflict was not resolved by merging refs/upstream/trunk" };
  // Review inputs are never worker-authored (lib/review.ts): control-path changes and an
  // over-budget diff are refused by the host before any model is asked, even with review off.
  // A cycle that merged the upstream head itself is judged on what it adds over BOTH parents
  // (review.ts upstreamMergeScope): upstream's own changes are not this cycle's work.
  const options = integrationOptions(ctx.contract);
  let files = repo.changedPaths(start, sha);
  if (resolves) {
    const base = g(["merge-base", start, resolves], { allowFail: true });
    if (!base) return { merge: false, reason: `no merge base between ${cfg.integrationBranch} and the upstream head ${resolves.slice(0, 12)}` };
    const scope = upstreamMergeScope({ startToHead: files, upstreamToHead: repo.changedPaths(resolves, sha), baseToUpstream: repo.changedPaths(base, resolves), startToUpstream: repo.changedPaths(start, resolves) });
    if (scope.dropped.length) return { merge: false, reason: `the upstream merge drops upstream changes (the cycle keeps the integration side of ${scope.dropped.length} path(s) upstream changed: ${scope.dropped.slice(0, 10).join(", ")}); resolve the conflict preserving both sides` };
    files = scope.own;
  }
  // A control path counts when the cycle head differs from every parent it is judged against.
  const parents = resolves ? [start, resolves] : [start];
  const control = files.flatMap((file) => {
    const hits = parents.map((p) => controlChanges({ files: [file], before: (f) => repo.fileAt(p, f), after: (f) => repo.fileAt(sha, f), controlPaths: options.controlPaths }));
    return hits.every((h) => h.length) ? hits[0] ?? [] : [];
  });
  if (control.length && !options.allowControlChanges) return { merge: false, reason: `changes a control path the cycle may not merge (templateOptions.integration.allowControlChanges is off): ${control.slice(0, 10).join("; ")}` };
  // The host's risk tier, from the paths the cycle changed. R3 is the owner/steward route: refused
  // here unless the operator opted in to control changes, and then it gets the one ordinary review (and no specialist question).
  const risk = classifyRisk({ files, isRecord: (f) => isReviewRecord(f, cfg), controlPaths: options.controlPaths.map((glob) => globToRegExp(glob)) });
  log(`cycle ${pad(n)} risk ${risk.tier}: ${risk.reasons.slice(0, 3).join("; ")}`);
  if (risk.tier === "R3" && !options.allowControlChanges) return { merge: false, reason: `R3 change (permissions, budgets, credentials, charter, gate policy or release) is for the owner/steward route, not an unattended merge: ${risk.r3.slice(0, 6).join("; ")}. Propose it in ${bookkeepingPaths(cfg, n).proposals}`, risk };
  // Read whole or not at all: an over-budget or unreadable diff (git failure, timeout, output cap)
  // is a REJECT, never an empty or clipped diff that looks under budget.
  const read = resolves ? repo.reviewDiff(resolves, sha, REVIEW_DIFF_BUDGET, cfg, { files, restrict: true }) : repo.reviewDiff(start, sha, REVIEW_DIFF_BUDGET, cfg, { files });
  if (!read.ok && read.reason === "over-budget") return { merge: false, reason: overBudgetReason(read.detail), risk };
  if (!read.ok) return { merge: false, reason: `the diff could not be read in full (${read.detail}); a cycle whose diff the host cannot read is never merged` };
  const diff = read.text;
  const at = (file: string): string | null => repo.fileAt(sha, file);
  const dir = cycleDir(cfg, n);
  const board = siState(ctx.state).current?.board ?? { items: [] };
  const workerReport = note ?? at(`${dir}/report.md`);
  const claims = parseBoardReport(workerReport);
  // Claims only choose which items the reviewer judges against: a stale or mistyped ID is a record
  // concern, never a reason to discard green work unreviewed. With no board, Board: lines are
  // recorded (closeCycle) and ignored here.
  const known = claims.filter((c) => board.items.some((i) => i.id === c.id));
  const unknownClaims = board.items.length ? claims.filter((c) => !known.includes(c)).map((c) => c.id) : [];
  const claimedItems: BoardItem[] = known.length ? known.flatMap((c) => board.items.filter((i) => i.id === c.id)) : assignedItems(board);
  const extra = unknownClaims.length ? { unknownClaims } : {};
  // Commits the report names must be commits of this cycle's diff: checked by the host before any model reads the report.
  if (!salvage) {
    const inRange = g(["log", "--format=%H", `--max-count=5000`, sha, `^${start}`, ...(resolves ? [`^${resolves}`] : [])], { allowFail: true }) ?? "";
    const phantom = unknownShas(workerReport, inRange.split("\n").map((l) => l.trim()).filter(Boolean));
    if (phantom.length) return { merge: false, reason: `${note === null || note === undefined ? `${dir}/report.md` : "the worker's note"} names commit(s) that are not in this cycle's diff: ${phantom.slice(0, 8).join(", ")}`, risk, ...extra };
  }
  // Deterministic claim check: a cycle whose diff holds nothing outside this run's own records has no work for a model
  // to judge. `Outcome: nothing found` merges on the checks alone; any other claim of work is refused unread.
  if (!files.some((f) => !isReviewRecord(f, cfg))) {
    const claimed = reportOutcome(salvage ?? workerReport).outcome;
    if (claimed === "nothing found") return gateGreen ? { merge: true, reason: "nothing found: the diff holds only this run's records; checks passed, no model review", risk, ...extra } : { merge: false, reason: failingNote, risk, ...extra };
    return { merge: false, reason: `the report says ${claimed ?? "it did the work"} but the cycle changed nothing outside this run's records; there is no work to review`, risk, ...extra };
  }
  // R0 (prose and static files only) starts fully reviewed; only the documented r0Review switch skips the model, never the acceptance checks.
  if (risk.tier === "R0" && !r0Reviewed(options.r0Review, sha)) {
    return gateGreen ? { merge: true, reason: `R0 (prose and static files only): checks passed, no model review (templateOptions.integration.r0Review ${options.r0Review})`, risk, ...extra } : { merge: false, reason: failingNote, risk, ...extra };
  }
  if (!cfg.integration.review && !salvage && result.outcome !== "partial") {
    return gateGreen ? { merge: true, reason: "checks passed (review disabled)", risk, ...extra } : { merge: false, reason: failingNote, risk, ...extra };
  }
  ctx.state.phase = "review";
  ctx.engine.tick();
  log(`cycle ${pad(n)} merge review (${cfg.reviewModel})`);
  const report = salvage ?? workerReport;
  // The host's ledger: what was committed, from git. The review treats it, not the worker's prose, as authoritative.
  const from = resolves ?? start;
  const code = files.filter((f) => !isReviewRecord(f, cfg) && f !== "package-lock.json");
  const ledger = g(["log", "--format=%h %s", sha, `^${start}`, ...(resolves ? [`^${resolves}`] : [])], { allowFail: true }) ?? "";
  const shortstat = code.length ? (g(["diff", "--shortstat", "--no-renames", from, sha, "--", ...code.map((f) => `:(top,literal)${f}`)], { allowFail: true }) ?? "(unreadable)") : "(no changes outside this run's records)";
  // Only a legacy committed report names commits; the host ledger is authoritative either way.
  const legacyReport = at(`${dir}/report.md`);
  const uncovered = legacyReport === null ? [] : uncoveredCommits(legacyReport, ledgerCommits(g, start, sha, resolves ? [resolves] : []), `${dir}/report.md`);
  const previousCycle = siState(ctx.state).history.at(-1);
  const context = [
    gateGreen ? null : `${failingNote}. The committed work was NOT merged; judge what is sound enough to carry forward and say so in your concerns.`,
    upstream ? `Upstream ${upstream.upstream} at cycle start: ${upstream.outcome}${"head" in upstream ? ` (${upstream.head.slice(0, 12)})` : ""}.` : null,
    resolves ? `This cycle resolves an upstream merge conflict (precedence 1): it was told to merge refs/upstream/trunk at ${resolves.slice(0, 12)} before any board work.` : null,
    previousCycle ? `Previous cycle ${pad(previousCycle.n)}: ${previousCycle.outcome}, gate ${previousCycle.gate}${previousCycle.gate === "red" && previousCycle.gateFailing.length ? ` (failing: ${previousCycle.gateFailing.slice(0, 8).join(", ")})` : ""}, ${previousCycle.merged ? "merged" : `not merged: ${previousCycle.mergeReason.slice(0, 600)}`}.${previousCycle.merged || previousCycle.gate === "skipped" ? "" : " This cycle was told to bring over what is sound from that attempt."}` : "This is the run's first cycle.",
    unknownClaims.length ? `The report claims board items that are not on this cycle's board: ${unknownClaims.join(", ")}. They are not judged; treat them as a record concern.` : null,
  ].filter((l): l is string => l !== null);
  const reviewReport = result.outcome === "partial" ? `Outcome: partial\n\nHost close-out: cycle stopped with ${result.reason}. ${gateGreen ? "Required checks passed on committed work; judge progress, not a claim of completion." : `${failingNote}; judge the committed work and what is sound enough to carry forward, not a claim of completion.`}\n\nWorker report:\n${report ?? "(missing)"}` : report;
  const review = await reviewCycle({
    run: cfg.run, cycle: n, outcome: result.outcome, integrationBranch: cfg.integrationBranch, gateSteps: gate.results.map((r) => ({ name: r.id })), gateGreen, gateFailing: failing,
    bookkeeping: bookkeepingPaths(cfg, n),
    board: claimedItems,
    assignedBoard: assignedItems(board),
    // The charter is the host-held integration head's (the cycle's start), never the cycle's own.
    charter: cfg.integrationUpstream ? streamCharter(cfg, ctx.contract, start, rt.now()) : repo.fileAt(start, CHARTER_PATH), report: reviewReport, verify: at(`${dir}/verify.md`), gitLog: repo.logSince(start, sha, resolves ? [resolves] : []), diff, recordStat: read.recordStat,
    ledger, shortstat, uncovered, context, claimsFromReport: known.length > 0,
    risk: { tier: risk.tier, reasons: risk.reasons },
    ...(risk.tier === "R2" ? { specialist: specialistQuestion(risk.topics) } : {}),
    criticalPaths: reviewCriticalPaths(files, gateEntries(files, (f) => repo.fileAt(start, f), at)),
  }, rt.complete(cfg.reviewModel, { timeoutMs: 300_000, role: "review" }), { sleep: (ms) => rt.sleep(ms), fallback: rt.complete(cfg.managerModel, { timeoutMs: 300_000, role: "review" }) });
  await ctx.engine.refreshUsage();
  writeJsonAtomic(path.join(ctx.engine.stepDir(n), "review.json"), { at: new Date(rt.now()).toISOString(), model: review.fallbackUsed ? cfg.managerModel : cfg.reviewModel, risk: { tier: risk.tier, reasons: risk.reasons }, ...review });
  const reason = `${gateGreen ? "" : `${failingNote}; `}review${review.fallbackUsed ? " (by the fallback reviewer, the manager model)" : ""} ${review.verdict}: ${review.reason}${review.concerns.length ? ` Concerns: ${review.concerns.join("; ")}` : ""}`;
  return { merge: gateGreen && review.verdict === "MERGE", reason, review: review.verdict, ...(review.unavailable ? { reviewUnavailable: review.reason } : {}), risk, ...extra };
}

/** The end of a non-finite run: cycles done, nothing left to find, or an operator stop after blocked publication. Evidence is a green acceptance run on the integration head. */
async function finalize(ctx: StepContext, reason: string): Promise<void> {
  const { engine, rt, repo, contract, state, log } = ctx;
  const cfg = siConfig(ctx.cfg);
  const head = repo.git()(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
  await engine.stopWorker("run complete");
  const before = state.acceptance.latest;
  if (before?.sha !== head || !before.allRequiredPass) {
    state.phase = "acceptance";
    engine.tick();
    const step = state.step || state.usage.steps;
    const ev = await engine.withGateSlot(() => runAcceptance({ rt, contract, sha: head, step, dir: path.join(engine.stepDir(step), "final-checks"), runRoot: ctx.store.p.root, log }));
    ctx.save((s) => { s.acceptance.latest = summariseEvaluation(ev); for (const r of ev.results) s.artefacts.push({ kind: "check-evidence", path: r.evidence, step, at: r.at }); });
  }
  if (engine.stopRequested) { await engine.applyControl(); return; }
  ctx.save((s) => { s.acceptance.review = { required: false, status: "skipped", note: "self-improve reviews every merged cycle instead" }; });
  if (!state.acceptance.latest?.allRequiredPass) { engine.go("failed", { reason: "final_gate_red", detail: `${reason}: the acceptance checks do not pass on ${cfg.integrationBranch} ${head.slice(0, 12)}` }); return; }
  engine.go("succeeded", { reason, detail: `${siState(state).merged} cycle(s) merged into ${cfg.integrationBranch} at ${head.slice(0, 12)}` });
  publishNow(ctx);
  await engine.afterSuccess(head);
}

export async function onStepsDone(ctx: StepContext): Promise<"handled"> {
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
