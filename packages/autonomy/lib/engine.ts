// The generic run engine. It owns everything that must not vary between kinds of run: the
// lifecycle and its persistence, the single-owner lock, the boundary checks, budgets and hard
// limits, control commands (pause, resume, steer, cancel, answer, reconfigure), the worker
// session, trusted acceptance evaluation, independent review, bounded recovery, promotion and
// evidence. A template (lib/templates/*) supplies the prompts and, for self-improve, its own
// step. Everything that touches containers, git transport, the clock or a model comes in
// through the runtime `rt` (lib/runtime.ts for real, packages/autonomy/tests/fake-runtime.ts
// for the offline tests), which implement the Runtime interface below.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../../core/lib/guard.ts";
import { type AcceptanceEvaluation, type AcceptanceRuntime, type CheckEvidence, type RunAcceptanceOptions, runAcceptance, summariseEvaluation } from "./acceptance.ts";
import { buildBriefing } from "./briefing.ts";
import { type Budget, type GenerationSettings, type RunContract, contractDigest, isStoredContract, workerContract } from "./contract.ts";
import { type EffortApi, taskMementoAllowance } from "./effort.ts";
import type { HostRepo } from "./hostrepo.ts";
import type { IngestResult } from "./gitmirror.ts";
import { type BlockerRecord, type BudgetReason, type GenerationRecord, type MementoDecision, type PendingAnswer, type RunState, type RunStatus, type TransitionInfo, applyResultsToBoard, resumeAction, transition } from "./lifecycle.ts";
import type { Complete } from "./manager.ts";
import { type PromotionRun, type PromotionTarget, runPromotions } from "./promotion.ts";
import { type Blocker, type RpcFrame, type UiResponse, activityLine, operatorDecision } from "./rpc.ts";
import type { RunConfig } from "./runcfg.ts";
import type { RunLock } from "./runlock.ts";
import type { RunStore } from "./store.ts";
import type { TaskReview, TaskReviewBundle } from "./review.ts";
import { currentTarget, decideRecovery, newlyPassing } from "./recovery.ts";
import { planReconfigure } from "./reconfigure.ts";
import { type Measured, type TakenNotebook, HIDDEN_CHARS, WORKER_NOTEBOOK, appendGeneration, readNotebook, renderNotebook, takeWorkerNotebook } from "./notebook.ts";
import { clip } from "./templates/common.ts";
import { BoundaryError, LockLost } from "./errors.ts";
import { writeJsonAtomic } from "./fsutil.ts";

export const IDLE_MINUTES = 20; // a worker session that emits nothing for this long is treated as stalled
export const MAX_ACTIVITY_LINES = 60;
const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];

export { BoundaryError, LockLost };

// --- the runtime (rt) ---------------------------------------------------------------------------

/** How a worker session's process ended. */
export interface WorkerExit {
  readonly code: number;
}

/** What the supervisor sends a worker session (pi's RPC input). */
export type WorkerMessage = { type: "prompt" | "steer"; message: string } | { type: "abort" } | UiResponse;

/** A running worker session (one container running `pi --mode rpc`). */
export interface WorkerAgent {
  readonly name: string;
  send(msg: WorkerMessage): void;
  stop(): Promise<void>;
  readonly exited: Promise<WorkerExit | undefined>;
}

export interface StartWorkerOptions {
  step: number;
  attempt: number;
  resetWorkspace: boolean;
  effort: RunState["effort"];
  /** Every RPC frame the session emits. */
  onEvent: (ev: RpcFrame) => void;
}

/** What prepare and bringUp are given. */
export interface ZoneContext {
  contract: RunContract;
  cfg: RunConfig;
  state: RunState;
  log: (line: string) => void;
}

/** The boundary probe's report (tests/boundary-probe.ts prints it; the runtime validates it). */
export interface BoundaryReport {
  pass: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/** The worker's branch as a bundle file, or why it could not be had. */
export type WorkerBundle = { bundle: string; error?: undefined } | { error: string; bundle?: undefined };

/**
 * Everything that touches containers, git transport, the clock or a model. lib/runtime.ts
 * (DockerRuntime) is the real one, packages/autonomy/tests/fake-runtime.ts the offline one.
 */
export interface Runtime extends AcceptanceRuntime {
  readonly repo: HostRepo;
  /** How often the supervisor wakes while a worker turn runs. */
  readonly tickMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
  preflight(contract: RunContract): Promise<void>;
  prepare(ctx: ZoneContext): Promise<{ readonly baseSha?: string | null | undefined } | null | undefined>;
  /** Bring the zone up and probe the boundary. */
  bringUp(ctx: ZoneContext): Promise<BoundaryReport | null | undefined>;
  tearDown(): Promise<void>;
  /** Remove the containers a previous supervisor left; returns their names. */
  cleanupOrphans(): Promise<string[]>;
  startWorker(o: StartWorkerOptions): WorkerAgent;
  snapshotWork(o: { message: string }): Promise<void>;
  fetchWorkerBundle(): Promise<WorkerBundle>;
  setWorkerBranch(sha: string, extraRefs?: readonly string[]): Promise<void>;
  deploy(o: { sha: string }): Promise<void>;
  /** Metered spend so far, in USD. */
  usageUsd(): number | Promise<number>;
  /** The independent task review. Fail-closed: anything but an APPROVE verdict does not approve. */
  review(bundle: TaskReviewBundle): Promise<TaskReview>;
  /** A host-side model call whose spend is metered with the run's. */
  complete(model: string, opts?: { timeoutMs?: number }): Complete;
  /** Why the worker cannot be used (e.g. the kit harness did not load), or null. */
  workerProblem?(): string | null;
}

// --- templates ----------------------------------------------------------------------------------

/** What a template's seed, runStep and onStepsDone are given. */
export interface StepContext {
  engine: Engine;
  contract: RunContract;
  cfg: RunConfig;
  state: RunState;
  rt: Runtime;
  repo: HostRepo;
  store: RunStore;
  log: (line: string) => void;
  step: number;
  effort: RunState["effort"];
  save: (fn?: (s: RunState) => void) => void;
  /** Write a read-only file the worker sees under /run. */
  publish: (name: string, text: string) => void;
}

export interface StepPromptArgs {
  contract: RunContract;
  state: RunState;
  step: number;
  fresh: boolean;
  briefing: string | null;
  evaluation: AcceptanceEvaluation | null;
  feedback: string[];
}

/** The parts of a template (lib/templates/*) the engine calls. */
export interface EngineTemplate {
  /** Once, before the first step: publish worker-visible files. */
  seed?: ((ctx: StepContext) => Promise<void> | void) | undefined;
  /** The text a worker session gets (finite templates). */
  stepPrompt?: ((args: StepPromptArgs) => string) | undefined;
  /** Trusted judgement of an accepted head; runAcceptance when absent. */
  evaluate?: ((o: RunAcceptanceOptions) => Promise<AcceptanceEvaluation>) | undefined;
  /** A template that drives its own step (self-improve) instead of the engine's task step. */
  runStep?: ((ctx: StepContext) => Promise<void>) | undefined;
  /** Called when max_steps is reached; returning "handled" means the template ended the run itself. */
  onStepsDone?: ((ctx: StepContext) => Promise<unknown>) | undefined;
  promotion: { targets: (contract: RunContract, cfg: RunConfig, sha: string) => PromotionTarget[] };
}

export interface EngineDeps {
  /** Write the run's results to `out` (lib/export.ts), after a success. */
  exportRun?: ((o: { engine: Engine; out: string }) => unknown) | undefined;
}

/** Apply `fn` to the state, stamp it and write state.json (Engine.save, and promoteRun without an engine). */
function saveState(store: RunStore, state: RunState, now: number, fn?: (s: RunState) => void): void {
  if (fn) fn(state);
  state.updatedAt = new Date(now).toISOString();
  store.writeState(state);
}

/** What promotion needs: the run's records and its mirror, but no worker runtime (cli.ts `promote` has none). */
export interface PromoteOptions {
  contract: RunContract;
  cfg: RunConfig;
  store: RunStore;
  repo: HostRepo;
  template: Pick<EngineTemplate, "promotion">;
  state: RunState;
  now: () => number;
  log: (line: string) => void;
  sha: string;
  approved: boolean;
}

/** Carry out (or, unapproved, hold) the template's promotion targets for `sha`, and record the outcome in state.json. */
export function promoteRun({ contract, cfg, store, repo, template, state, now, log, sha, approved }: PromoteOptions): PromotionRun {
  const save = (fn?: (s: RunState) => void): void => { saveState(store, state, now(), fn); };
  const targets = template.promotion.targets(contract, cfg, sha);
  const r = runPromotions({ repo, contract, cfg, state, sha, approved, targets, save, log });
  save((s) => { s.promotion.status = r.status; s.promotion.error = r.error ?? null; s.promotion.targets = r.targets.map((t) => ({ key: t.key, description: t.description })); });
  return r;
}

export interface EngineOptions {
  contract: RunContract;
  cfg: RunConfig;
  store: RunStore;
  rt: Runtime;
  template: EngineTemplate;
  lock?: RunLock | null;
  effortApi?: EffortApi | null | undefined;
  deps?: EngineDeps;
  log?: ((line: string) => void) | undefined;
}

/** The engine's view of one worker session. `say` is null for a session a template drives itself. */
export interface WorkerSession {
  attempt: number;
  agent: WorkerAgent;
  settled: boolean;
  exited: WorkerExit | null;
  blocker: Blocker | null;
  dead: boolean;
  lastEventAt: number;
  activity: string[];
  say: ((message: string) => void) | null;
}

/** Why the next fresh session starts; its briefing says so. */
type StartReason = "first" | "supervisor_restart" | "resumed" | "answer" | "continue" | "crash" | "session_ended" | "hard_restart" | "generation";

/** Which of a generation's boxes ran out. */
type GenerationBox = GenerationRecord["box"];

/** How a worker turn ended (waitTurn). */
type TurnEnd =
  | { end: "interrupted" | "settled" | "step_budget" | "idle" }
  | { end: "limit"; limit: BudgetReason }
  | { end: "blocked"; blocker: Blocker }
  | { end: "exited"; exit: WorkerExit }
  | { end: "unusable"; problem: string }
  | { end: "generation"; box: GenerationBox };

/** What evaluateStep is told about a step that ended a generation. */
interface GenerationEnd {
  box: GenerationBox;
  notebook: TakenNotebook;
}

/** syncFromWorker: the ingest result, or why the worker's branch could not be fetched. */
export type SyncResult = (IngestResult & { error?: undefined }) | { error: string; head: string; moved: false; diverged?: undefined; violation?: undefined };

/** The check results a step is judged on: a fresh evaluation, or the stored one when the head did not move. */
interface StepEvaluation {
  allRequiredPass: boolean;
  results: ReadonlyArray<Pick<CheckEvidence, "id" | "required" | "pass" | "exitCode"> & { tail?: string }>;
}

/** Every budget limit is a number (a resolved contract's budget, not a draft's). */
const isCompleteBudget = (b: Budget | Budget<undefined>): b is Budget => [b.totalUsd, b.perStepUsd, b.maxSteps, b.maxMinutes].every((v) => typeof v === "number");

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const textField = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class Engine {
  contract: RunContract;
  cfg: RunConfig;
  store: RunStore;
  rt: Runtime;
  template: EngineTemplate;
  lock: RunLock | null;
  effortApi: EffortApi | null | undefined;
  deps: EngineDeps;
  repo: HostRepo;
  log: (line: string) => void;
  #state: RunState | null = null;
  session: WorkerSession | null = null;
  lastTickAt: number | null = null;
  lockLost = false;
  signalled = false;
  pendingFeedback: string[] = [];
  startReason: StartReason = "first";
  lastEvaluation: AcceptanceEvaluation | null = null;
  lastActivity: string[] = [];
  uiAnswered = 0;

  constructor({ contract, cfg, store, rt, template, lock = null, effortApi, deps = {}, log }: EngineOptions) {
    this.contract = contract;
    this.cfg = cfg;
    this.store = store;
    this.rt = rt;
    this.template = template;
    this.lock = lock;
    this.effortApi = effortApi;
    this.deps = deps;
    this.repo = rt.repo;
    this.log = log ?? ((line) => { store.log(line); rt.log?.(line); });
  }

  /** The live run state; set by run() (or by a caller that drives promote() itself). */
  get state(): RunState {
    if (!this.#state) throw new Error(`run ${this.store.run} has no state loaded`);
    return this.#state;
  }

  set state(value: RunState | null) { this.#state = value; }

  // --- state helpers ----------------------------------------------------------------------------
  save(fn?: (s: RunState) => void): void { saveState(this.store, this.state, this.rt.now(), fn); }

  go(to: RunStatus, info: TransitionInfo = {}): void {
    const next = transition(this.state, to, { at: new Date(this.rt.now()).toISOString(), ...info });
    // In place, so every holder of `this.state` (a step that started before the transition) keeps seeing the live record.
    for (const k of Object.keys(this.state)) if (!(k in next)) Reflect.deleteProperty(this.state, k);
    Object.assign(this.state, next);
    this.store.writeState(this.state);
    this.log(`state ${to}${info.reason ? ` (${info.reason})` : ""}`);
  }

  get status(): RunStatus { return this.state.status; }
  get active(): boolean { return this.state.status === "running" || this.state.status === "recovering"; }
  stepDir(n: number = this.state.step): string { return path.join(this.store.p.steps, String(n).padStart(2, "0")); }

  /** Accrue active minutes and check the contract has not changed under the run. */
  tick(): void {
    const now = this.rt.now();
    if (this.lastTickAt !== null && this.active) this.state.usage.minutes += (now - this.lastTickAt) / 60_000;
    this.lastTickAt = now;
    this.verifyContractIntact();
  }

  /** Spend only ever goes up: the higher of what state recorded and what the meters show now. */
  async refreshUsage(): Promise<void> {
    const metered = await this.rt.usageUsd();
    if (metered > this.state.usage.usd) this.state.usage.usd = metered;
  }

  verifyContractIntact(): void {
    let digest: string | null;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.store.p.contract, "utf8"));
      digest = isStoredContract(raw) ? contractDigest(raw) : null; // not a contract at all: it cannot match
    } catch { digest = null; }
    if (digest !== this.state.contractDigest) throw new BoundaryError(`contract.json no longer matches the digest recorded when the run started (${digest ? digest.slice(0, 12) : "unreadable"} vs ${this.state.contractDigest.slice(0, 12)}): the run's definition was changed underneath it`);
  }

  limitReached({ atStepBoundary = false }: { atStepBoundary?: boolean } = {}): BudgetReason | null {
    const s = this.state;
    const b = s.limits.budget;
    if (s.usage.usd >= b.totalUsd) return "total_usd";
    if (s.usage.minutes >= b.maxMinutes) return "max_minutes";
    if (atStepBoundary && s.usage.steps >= b.maxSteps) return "max_steps";
    return null;
  }

  ctx(): StepContext {
    const publish = (name: string, text: string): void => { fs.mkdirSync(this.store.p.public, { recursive: true }); fs.writeFileSync(path.join(this.store.p.public, path.basename(name)), text, { mode: 0o444 }); };
    return { engine: this, contract: this.contract, cfg: this.cfg, state: this.state, rt: this.rt, repo: this.repo, store: this.store, log: this.log, step: this.state.step, effort: this.state.effort, save: (fn) => { this.save(fn); }, publish };
  }

  // --- the run ---------------------------------------------------------------------------------
  /** Run (or resume) the supervisor loop until the run ends or parks. Returns the final state. */
  async run({ takeover = false }: { takeover?: boolean } = {}): Promise<RunState> {
    let crashed = false;
    this.state = this.store.readState();
    try {
      if (this.lock) this.lock.start(() => { this.lockLost = true; });
      this.verifyContractIntact();
      if (takeover) {
        const removed = await this.rt.cleanupOrphans();
        if (removed.length) this.log(`removed ${removed.length} orphaned container(s) left by the previous supervisor: ${removed.join(", ")}`);
        this.save((s) => { s.worker = null; });
        this.startReason = "supervisor_restart";
      }
      if (this.status === "setup") await this.setup();
      else if (!["succeeded", "failed", "cancelled"].includes(this.status) && !(this.status === "budget_exhausted" && !this.store.pending().some((m) => m.kind === "reconfigure"))) await this.bringUp(); // the probe runs again on every resume
      if (this.status === "ready") this.go("running", { reason: "starting" });
      await this.loop();
    } catch (error) {
      if (isRecord(error) && error["simulateKill"]) { crashed = true; throw error; }
      await this.handleFatal(error);
    } finally {
      // A supervisor that lost its lock must not touch state or containers: another one owns the run now.
      if (!crashed && !this.lockLost) {
        try { await this.stopWorker("supervisor exit"); } catch { /* best effort */ }
        try { await this.rt.tearDown(); } catch (e) { this.log(`teardown: ${errorText(e)}`); }
        try { this.save(); } catch { /* ignore */ }
        this.lock?.release();
      }
    }
    return this.state;
  }

  async handleFatal(error: unknown): Promise<void> {
    if (error instanceof LockLost) { this.log("lock lost: another supervisor took over this run; stopping without touching state"); throw error; }
    if (error instanceof BoundaryError) {
      this.log(`BOUNDARY VIOLATION: ${error.message}`);
      try { await this.stopWorker("boundary violation"); } catch { /* ignore */ }
      if (TERMINAL.includes(this.status) || this.status === "budget_exhausted") { this.save((s) => { s.lastError = error.message; }); return; }
      this.go("failed", { reason: "boundary_violation", detail: error.message });
      return;
    }
    this.log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    try { this.save((s) => { s.lastError = errorText(error).slice(0, 1000); }); } catch { /* ignore */ }
    throw error; // the run stays in its state and can be resumed
  }

  async setup(): Promise<void> {
    const { rt, contract } = this;
    const setup = (this.state.setup ??= {});
    await rt.preflight(contract);
    if (!setup.preparedAt) {
      const prep = await rt.prepare({ contract, cfg: this.cfg, state: this.state, log: this.log });
      this.save((s) => { const st = (s.setup ??= {}); st.preparedAt = new Date(rt.now()).toISOString(); st.base = prep?.baseSha ?? null; });
      this.log(`workspace prepared${prep?.baseSha ? ` from ${prep.baseSha.slice(0, 12)}` : ""}`);
    }
    if (this.template.seed) await this.template.seed(this.ctx());
    await this.bringUp();
    this.go("ready", { reason: "setup complete" });
  }

  /** The worker's read-only copy of the contract carries the run's CURRENT effort and budgets (state), so a reconfigure and the boundary probe agree. */
  publishWorkerContract(): void {
    const effective = { ...this.contract, effort: this.state.effort, budget: this.state.limits.budget };
    writeJsonAtomic(path.join(this.store.p.public, "contract.json"), workerContract(effective, { boundaryDigest: this.state.boundaryDigest }), { mode: 0o444 });
  }

  async bringUp(): Promise<void> {
    this.publishWorkerContract();
    const report = await this.rt.bringUp({ contract: this.contract, cfg: this.cfg, state: this.state, log: this.log });
    if (report && !report.pass) {
      const bad = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).slice(0, 6);
      throw new BoundaryError(`the boundary probe failed (${bad.length} check(s)): ${bad.join("; ")}`);
    }
    this.save((s) => { s.setup ??= {}; s.setup.boundaryVerifiedAt = new Date(this.rt.now()).toISOString(); s.setup.boundaryChecks = report?.checks.length ?? 0; });
  }

  // --- the loop --------------------------------------------------------------------------------
  async loop(): Promise<void> {
    for (;;) {
      this.tick();
      if (this.lockLost) throw new LockLost();
      await this.applyControl();
      if (this.signalled) { this.log("signal: stopping; the run stays resumable"); return; }
      const st = this.status;
      if (TERMINAL.includes(st)) return;
      if (st === "budget_exhausted") return;
      if (st === "ready") { this.go("running", { reason: "resumed" }); continue; }
      if (st === "paused" || st === "blocked") { await this.rt.sleep(this.rt.tickMs); continue; } // parked: waiting for a control command
      await this.refreshUsage();
      const limit = this.limitReached({ atStepBoundary: true });
      if (limit) {
        await this.exhausted(limit);
        if ((["budget_exhausted", "succeeded", "failed", "cancelled"] as readonly RunStatus[]).includes(this.status)) return;
        continue;
      }
      const problem = this.rt.workerProblem?.();
      if (problem) { await this.stopWorker("worker unusable"); this.go("failed", { reason: "worker_unavailable", detail: problem }); return; }
      if (this.template.runStep) await this.template.runStep(this.ctx());
      else await this.taskStep();
      this.save();
    }
  }

  async exhausted(reason: BudgetReason): Promise<void> {
    if (reason === "max_steps" && this.template.onStepsDone) {
      const handled = await this.template.onStepsDone(this.ctx());
      if (handled === "handled") return;
    }
    await this.stopWorker(`limit ${reason}`);
    await this.syncFromWorker({ silent: true }).catch(() => {});
    this.go("budget_exhausted", { reason, detail: `spent $${this.state.usage.usd.toFixed(2)}, ${this.state.usage.steps} steps, ${Math.round(this.state.usage.minutes)} minutes` });
  }

  // --- control commands -------------------------------------------------------------------------
  async applyControl({ only }: { only?: readonly string[] } = {}): Promise<void> {
    for (const msg of this.store.pending()) {
      if (only && !only.includes(msg.kind)) continue;
      // The payload is whoever wrote the control file's: each field is checked where it is used.
      const p = isRecord(msg.payload) ? msg.payload : {};
      try {
        switch (msg.kind) {
          case "cancel": await this.cancel(textField(p["reason"]) ?? "operator"); break;
          case "pause":
            if (this.active || this.status === "ready") {
              await this.stopWorker("paused");
              await this.syncFromWorker({ silent: true }).catch(() => {});
              this.go("paused", { reason: textField(p["reason"]) ?? "operator", by: "operator" });
            }
            break;
          case "unpause":
            if (this.status === "paused") { this.startReason = "resumed"; this.go("running", { reason: "resumed", by: "operator" }); }
            break;
          case "steer": this.steer((textField(p["message"]) ?? "").slice(0, 2000)); break;
          case "answer": this.answer(p); break;
          case "reconfigure": this.reconfigure(p); break;
          default: break;
        }
      } finally { this.store.ack(msg.name); }
      this.save();
    }
  }

  async cancel(reason: string): Promise<void> {
    if (TERMINAL.includes(this.status)) return;
    await this.stopWorker("cancelled");
    await this.syncFromWorker({ silent: true }).catch(() => {});
    this.go("cancelled", { reason: "operator", detail: reason, by: "operator" });
  }

  steer(message: string): void {
    if (!message.trim()) return;
    this.state.steers = [...(this.state.steers ?? []), { at: new Date(this.rt.now()).toISOString(), message }].slice(-50);
    if (this.session && !this.session.dead && this.active && this.session.say) this.session.say(`Operator steering (authoritative): ${message}`);
    else this.pendingFeedback.push(`Operator steering (authoritative): ${message}`);
    this.log(`steer recorded (${message.length} characters)`);
  }

  answer(p: Record<string, unknown>): void {
    if (this.status !== "blocked") { this.log("answer ignored: the run is not blocked"); return; }
    const text = textField(p["text"]);
    const approve = Boolean(p["approve"]);
    const deny = Boolean(p["deny"]);
    const r = resumeAction(this.state, { answer: text, approve, deny });
    if (!r.ok) { this.log(`answer refused: ${r.message}`); return; }
    const q = this.state.blocker;
    const pending: PendingAnswer = { text: (text ?? "").slice(0, 2000), ...(q ? { question: q.question, kind: q.kind } : {}), ...(approve ? { approved: true } : deny ? { approved: false } : {}), at: new Date(this.rt.now()).toISOString() };
    this.state.pendingAnswer = pending;
    this.startReason = "answer";
    this.go("running", { reason: "answered", by: "operator" });
  }

  reconfigure(p: Record<string, unknown>): void {
    const changes = p["changes"];
    const by = textField(p["by"]) ?? "operator";
    const plan = planReconfigure({ contract: this.contract, state: this.state, changes, effort: this.effortApi });
    const at = new Date(this.rt.now()).toISOString();
    // A plan only passes when the resolver found no budget problem, so its budget is complete; checked again rather than assumed.
    const budget = plan.ok && isCompleteBudget(plan.next.limits.budget) ? plan.next.limits.budget : null;
    if (!plan.ok || !budget) {
      const problems = plan.ok ? ["budget: the reconfigured budget is incomplete"] : plan.problems;
      this.state.reconfigurations = [...this.state.reconfigurations, { at, by, refused: problems }].slice(-200); this.log(`reconfigure refused: ${problems.join("; ")}`); return;
    }
    const { limits } = this.state;
    this.state.reconfigurations = [...this.state.reconfigurations, { at, by, before: { effort: this.state.effort, budget: limits.budget, recovery: limits.recovery }, after: { ...plan.after, budget }, reason: textField(p["reason"]) ?? null }].slice(-200);
    this.state.effort = plan.next.effort;
    this.state.limits = { budget, recovery: plan.next.limits.recovery };
    this.publishWorkerContract();
    this.log(`reconfigured: ${Object.keys(isRecord(changes) ? changes : {}).join(", ")}`);
    if (this.status === "budget_exhausted") this.go("paused", { reason: "limits raised", by: "reconfigure" });
  }

  // --- worker session ---------------------------------------------------------------------------
  startSession({ step }: { step: number }): WorkerSession {
    const attempt = (this.state.sessions ?? 0) + 1;
    // The agent is attached once the runtime has started it; the closures below see it through `session`.
    const session: Omit<WorkerSession, "agent"> & { agent: WorkerAgent | null } = {
      attempt, agent: null, settled: false, exited: null, blocker: null, dead: false, lastEventAt: this.rt.now(), activity: [],
      say: (message) => { session.agent?.send(session.settled ? { type: "prompt", message } : { type: "steer", message }); },
    };
    const unattended = this.contract.permissions.unattended;
    const onEvent = (ev: RpcFrame): void => {
      session.lastEventAt = this.rt.now();
      if (ev.type === "agent_start") session.settled = false;
      if (ev.type === "agent_settled") session.settled = true;
      if (ev.type === "extension_ui_request") {
        const d = operatorDecision({ id: ev["id"], method: ev["method"], title: ev["title"], message: ev["message"], options: ev["options"], prefill: ev["prefill"] }, unattended);
        if (d.action === "reply") { if (d.reply) session.agent?.send(d.reply); this.uiAnswered++; }
        else if (d.action === "block" && !session.blocker) session.blocker = d.blocker;
      }
      const line = activityLine({ ...ev, at: this.rt.now() });
      if (line) { session.activity.push(line); if (session.activity.length > MAX_ACTIVITY_LINES) session.activity.shift(); }
    };
    // A generation without progress under resetOnNoProgress: the worker's branch already points at the accepted head; its workspace follows.
    const resetWorkspace = this.state.generations?.resetPending === true;
    const live: WorkerSession = Object.assign(session, { agent: this.rt.startWorker({ step, attempt, resetWorkspace, effort: this.state.effort, onEvent }) });
    if (this.state.generations && resetWorkspace) this.state.generations.resetPending = false;
    void live.agent.exited.then((e) => { live.exited = e ?? { code: 1 }; live.dead = true; });
    this.state.sessions = attempt;
    this.save((s) => { s.worker = { container: live.agent.name, attempt, step, startedAt: new Date(this.rt.now()).toISOString() }; });
    this.session = live;
    return live;
  }

  /** Register a session that a template drives itself (self-improve's cycle loop), so pause, cancel and exit can stop it. */
  adoptAgent(agent: WorkerAgent): WorkerSession {
    this.session = { attempt: this.state.sessions ?? 0, agent, settled: false, exited: null, blocker: null, dead: false, lastEventAt: this.rt.now(), activity: [], say: null };
    void agent.exited.then(() => { if (this.session?.agent === agent) this.session.dead = true; });
    this.save((s) => { s.worker = { container: agent.name, attempt: s.sessions ?? 0, step: s.step, startedAt: new Date(this.rt.now()).toISOString() }; });
    return this.session;
  }

  async stopWorker(why: string): Promise<void> {
    const s = this.session;
    this.session = null;
    if (this.#state) this.#state.worker = null;
    if (!s) return;
    this.lastActivity = s.activity;
    if (s.dead) return;
    s.dead = true;
    try { await s.agent.stop(); } catch (e) { this.log(`stopping the worker: ${errorText(e)}`); }
    this.log(`worker session stopped (${why})`);
  }

  /** Wait for the current turn to end. Control commands, limits and the worker's own events end it. */
  async waitTurn(session: WorkerSession, stepStartUsd: number): Promise<TurnEnd> {
    for (;;) {
      await this.rt.sleep(this.rt.tickMs);
      this.tick();
      if (this.lockLost) throw new LockLost();
      await this.refreshUsage();
      await this.applyControl();
      if (!this.active || this.signalled) return { end: "interrupted" };
      const limit = this.limitReached();
      if (limit) return { end: "limit", limit };
      if (session.blocker) return { end: "blocked", blocker: session.blocker };
      if (session.exited) return { end: "exited", exit: session.exited };
      const box = this.generationBox();
      if (box) return { end: "generation", box };
      if (session.settled) return { end: "settled" };
      if (this.state.usage.usd - stepStartUsd >= this.state.limits.budget.perStepUsd) { session.agent.send({ type: "abort" }); return { end: "step_budget" }; }
      if ((this.rt.now() - session.lastEventAt) / 60_000 >= IDLE_MINUTES) return { end: "idle" };
      const problem = this.rt.workerProblem?.();
      if (problem) return { end: "unusable", problem };
    }
  }

  // --- one step of a finite task ----------------------------------------------------------------
  async taskStep(): Promise<void> {
    const s = this.state;
    const n = s.step + 1;
    s.step = n;
    s.phase = "work";
    this.save();
    this.log(`step ${n} starting`);
    const stepStartUsd = s.usage.usd;
    if (this.generationSettings() && !s.generations) this.save((st) => { st.generations = { current: 1, startMinutes: st.usage.minutes, startUsd: st.usage.usd, startHead: this.repo.head(), history: [] }; });
    let session = this.session;
    const fresh = !session || session.dead;
    let briefing: string | null = null;
    if (!session || session.dead) {
      // The box ran out while no worker was live (a pause, restart or limit during the grace period):
      // rotate with whatever notebook is in the workspace instead of starting a worker only to ask it for one.
      const spent = this.generationBox();
      if (spent) {
        if (this.session) await this.stopWorker("generation box already spent");
        const notebook = takeWorkerNotebook(this.store.p.work);
        // The previous step was already judged (its worker crashed or exited): rotate with that step's
        // action instead of judging the same head again, which would count a second stall.
        const judged = s.generations?.judged;
        const latest = s.acceptance.latest;
        if (judged?.step === n - 1 && latest) {
          const ev: StepEvaluation = { ...latest, results: this.lastEvaluation?.results ?? latest.results };
          await this.rotateGeneration({ box: spent, notebook }, { head: this.repo.head(), ev, action: judged.action });
        } else {
          s.usage.steps = n;
          this.save();
          await this.evaluateStep({ n, crashed: false, generation: { box: spent, notebook } });
          return;
        }
      }
      if (!(this.startReason === "first" && n === 1)) briefing = await this.briefing(this.startReason);
      session = this.startSession({ step: n });
      if (this.status === "recovering") this.go("running", { reason: "recovery session started" });
    }
    const { stepPrompt } = this.template;
    if (!stepPrompt) throw new Error(`template ${this.contract.template} has neither runStep nor stepPrompt`);
    const feedback = this.pendingFeedback.splice(0);
    const message = stepPrompt({ contract: this.contract, state: this.state, step: n, fresh, briefing, evaluation: this.lastEvaluation, feedback });
    if (fresh) session.agent.send({ type: "prompt", message });
    else session.say?.(message);
    session.settled = false;
    session.lastEventAt = this.rt.now();
    this.startReason = "continue";

    const res = await this.waitTurn(session, stepStartUsd);
    s.usage.steps = n;
    await this.refreshUsage();
    if (res.end === "interrupted") { this.save(); return; }
    if (res.end === "limit") { await this.stopWorker(`limit ${res.limit}`); this.save(); return; } // the loop ends the run with the limit's outcome
    if (res.end === "unusable") { await this.stopWorker("worker unusable"); this.go("failed", { reason: "worker_unavailable", detail: res.problem }); return; }
    if (res.end === "blocked") { await this.enterBlocked(res.blocker); return; }
    if (res.end === "generation") { await this.endGeneration(session, n, res.box, stepStartUsd); return; }
    let crashed = false;
    if (res.end === "exited") {
      crashed = res.exit.code !== 0;
      this.lastActivity = session.activity; this.session = null; s.worker = null;
      this.startReason = crashed ? "crash" : "session_ended";
    }
    if (res.end === "step_budget") this.pendingFeedback.push(`The per-step budget of $${s.limits.budget.perStepUsd} was reached, so your turn was stopped. Commit what works.`);
    if (res.end === "idle") this.pendingFeedback.push(`No activity for ${IDLE_MINUTES} minutes; your turn was treated as stalled.`);
    this.save();
    await this.evaluateStep({ n, crashed });
  }

  async enterBlocked(blocker: BlockerRecord): Promise<void> {
    const s = this.state;
    await this.stopWorker("blocked");
    await this.syncFromWorker({ silent: true }).catch(() => {});
    s.pendingQuestions = [...(s.pendingQuestions ?? []), { ...blocker, at: new Date(this.rt.now()).toISOString() }].slice(-20);
    this.flushUi({ blocked: 1 });
    this.go("blocked", { reason: blocker.kind, blocker, by: "supervisor" });
  }

  flushUi({ blocked = 0 }: { blocked?: number } = {}): void {
    const ui = this.state.ui ?? { autoAnswered: 0, blocked: 0 };
    this.state.ui = { autoAnswered: ui.autoAnswered + this.uiAnswered, blocked: ui.blocked + blocked };
    this.uiAnswered = 0;
  }

  /** Bring the worker's commits in: snapshot, bundle, accept only fast-forwards inside the write areas. */
  async syncFromWorker({ silent = false }: { silent?: boolean } = {}): Promise<SyncResult> {
    const { rt, repo, contract } = this;
    try { await rt.snapshotWork({ message: `checkpoint: step ${this.state.step}` }); } catch (e) { if (!silent) this.log(`snapshot: ${errorText(e)}`); }
    const r = await rt.fetchWorkerBundle();
    if (r.error !== undefined) { if (!silent) this.log(`bundle: ${r.error}`); return { error: r.error, head: repo.head(), moved: false }; }
    const res = repo.ingest(r.bundle, { areas: contract.permissions.writeAreas });
    if (res.violation) this.log(`refused: the worker's commits touch paths outside permissions.writeAreas: ${res.violation.slice(0, 8).join(", ")}`);
    if (res.diverged) this.log("the worker's branch diverged from the accepted head; not accepted");
    return res;
  }

  writeStepSummary(n: number, extra: Record<string, unknown>): void {
    const s = this.state;
    const latest = s.acceptance.latest;
    writeJsonAtomic(path.join(this.stepDir(n), "summary.json"), { step: n, at: new Date(this.rt.now()).toISOString(), status: s.status, head: this.repo.head(), usd: s.usage.usd, minutes: Math.round(s.usage.minutes * 10) / 10, results: latest?.results.map(({ id, pass, exitCode }) => ({ id, pass, exitCode })) ?? [], ...extra });
    s.artefacts = [...s.artefacts.filter((a) => !(a.kind === "step-summary" && a.step === n)), { kind: "step-summary", path: path.join("steps", String(n).padStart(2, "0"), "summary.json"), step: n, at: new Date(this.rt.now()).toISOString() }];
  }

  async evaluateStep({ n, crashed, generation }: { n: number; crashed: boolean; generation?: GenerationEnd | undefined }): Promise<void> {
    const { contract, repo } = this;
    const s = this.state;
    const sync = await this.syncFromWorker();
    const head = repo.head();
    const lastHead = s.recovery.lastHead ?? s.setup?.base ?? null;
    const moved = head !== lastHead;
    s.recovery.lastHead = head;
    this.flushUi();

    // Acceptance: judged by the supervisor on the accepted head, from definitions outside the worker's reach.
    s.phase = "acceptance";
    let ev: StepEvaluation;
    const latest = s.acceptance.latest;
    if (latest?.sha !== head) {
      if (contract.permissions.network.services.length) await this.rt.deploy({ sha: head });
      const fresh = await (this.template.evaluate ?? runAcceptance)({ rt: this.rt, contract, sha: head, step: n, dir: path.join(this.stepDir(n), "checks"), runRoot: this.store.p.root, log: this.log });
      this.save((st) => {
        st.acceptance.latest = summariseEvaluation(fresh);
        st.acceptance.history = [...st.acceptance.history, { step: n, sha: head, allRequiredPass: fresh.allRequiredPass }].slice(-20);
        for (const r of fresh.results) st.artefacts.push({ kind: "check-evidence", path: r.evidence, step: n, at: r.at });
        st.tasks = applyResultsToBoard(st.tasks, fresh.results, { step: n, at: fresh.at });
      });
      this.lastEvaluation = fresh;
      ev = fresh;
    } else {
      ev = { ...latest, results: this.lastEvaluation?.results ?? latest.results };
      this.log("no new accepted commits since the last evaluation; the previous results stand");
    }
    const violation = sync.violation?.length ? sync.violation : null;
    if (violation) this.pendingFeedback.push(`Your changes were NOT accepted: they touch paths outside the allowed write areas (${contract.permissions.writeAreas.join(", ")}): ${violation.slice(0, 10).join(", ")}. Revert those paths (a revert commit is fine) and keep your work inside the allowed areas.`);

    if (!violation) s.recovery.violations = 0; // consecutive means consecutive: a clean step ends the streak
    // Complete? All required checks pass on an accepted head, then the review (if required) approves.
    const alreadyRejected = s.acceptance.review.status === "rejected" && s.acceptance.review.sha === head;
    if (ev.allRequiredPass && !violation && !alreadyRejected) {
      s.phase = "review";
      if (await this.completeIfApproved({ head, ev, n })) return;
    }

    // Recovery: bounded, from verified facts only.
    const verified = newlyPassing(s.recovery.passingBefore, ev.results);
    s.recovery.passingBefore = ev.results.filter((r) => r.pass).map((r) => r.id);
    const target = currentTarget(s.tasks);
    const d = decideRecovery(s.recovery, s.limits.recovery, { verifiedProgress: verified.length > 0, activity: moved && !violation, violation: Boolean(violation), crashed, generation: Boolean(generation), target, complete: false });
    s.recovery = { ...s.recovery, ...d.recovery }; // decideRecovery returns a full copy of the counters it was given
    s.recovery.lastHead = head;
    s.recovery.passingBefore = ev.results.filter((r) => r.pass).map((r) => r.id);
    const rotated = generation ? await this.rotateGeneration(generation, { head, ev, action: d.action }) : null;
    if (!generation && s.generations) s.generations.judged = { step: n, action: d.action };
    this.writeStepSummary(n, { action: d.action, reason: d.reason, newlyPassing: verified, moved, violation: violation ?? null, crashed, ...(rotated ? { generation: rotated } : {}) });
    this.save();
    this.store.event(n, { type: "recovery", action: d.action, reason: d.reason, newlyPassing: verified, moved, violation: Boolean(violation), crashed });
    if (d.action === "stop") {
      this.log(`recovery: stop (${d.failure}): ${d.reason}`);
      await this.stopWorker("recovery exhausted");
      this.go("failed", { reason: d.failure, detail: d.reason });
      return;
    }
    if (d.action === "nudge") {
      this.log(`recovery: ${d.reason}`);
      this.pendingFeedback.push(nudgeText(ev, { moved, violation }));
    } else if (d.action === "restart") {
      this.log(`recovery: ${d.reason}`);
      await this.stopWorker("hard restart");
      this.startReason = generation ? "generation" : "hard_restart";
      if (this.status === "running") this.go("recovering", { reason: d.reason });
    }
    this.save();
  }

  // --- generations (Memento mode) ------------------------------------------------------------
  /**
   * The run's generations settings: the contract's, with maxGenerations capped to the Memento
   * allowance (mementoDecision). Null when the contract does not enable them (a contract.json without
   * the key has them off) or the run is allowed only one generation, which then has no box.
   */
  generationSettings(): GenerationSettings | null {
    const g = this.contract.generations;
    if (!g?.enabled) return null;
    const { maxGenerations } = this.mementoDecision(g);
    return maxGenerations > 1 ? { ...g, maxGenerations } : null;
  }

  /**
   * How many generations this run may use, decided once (the first time it is asked, at the first
   * step) and recorded in state.memento, so a resume or a later change to the opt-in file does not
   * change a run under way. It reads the same per-model opt-in (<agent dir>/pi-kit/autonomy.json),
   * profile rule and tier allowance `/effort memento` shows, for the worker model at the run's
   * effort tier, and runs min(contract, allowance) generations; an allowance of 0 runs the task as a
   * single generation. The reason is logged and written to the event log.
   */
  mementoDecision(g: GenerationSettings): MementoDecision {
    const s = this.state;
    if (s.memento) return s.memento;
    const tier = s.effort.tier;
    const a = taskMementoAllowance({ provider: this.contract.model.provider, model: this.contract.model.worker, tier, cwd: process.cwd() });
    const maxGenerations = Math.max(1, Math.min(g.maxGenerations, a.maxGenerations));
    const decision: MementoDecision = { requested: g.maxGenerations, allowance: a.maxGenerations, maxGenerations, reason: a.reason, model: a.model, profile: a.profile, tier, at: new Date(this.rt.now()).toISOString() };
    this.save((st) => { st.memento = decision; });
    for (const w of a.warnings) this.log(`memento: ${w}`);
    const verdict = maxGenerations <= 1
      ? "running as a single generation"
      : maxGenerations < g.maxGenerations ? `capped at ${maxGenerations}` : `running up to ${maxGenerations}`;
    this.log(`generations: the contract asks for ${g.maxGenerations}, the Memento allowance is ${a.maxGenerations} (${a.reason}): ${verdict}`);
    this.store.event(s.step, { type: "memento", ...decision });
    return decision;
  }

  /** Which box of the current generation has run out, or null. The last generation has no box: the run's own limits end it. */
  generationBox(): GenerationBox | null {
    const g = this.generationSettings();
    const gs = this.state.generations;
    if (!g || !gs || gs.current >= g.maxGenerations) return null;
    if (this.state.usage.minutes - gs.startMinutes >= g.iterationMinutes) return "minutes";
    if (g.iterationUsd !== null && this.state.usage.usd - gs.startUsd >= g.iterationUsd) return "usd";
    return null;
  }

  /**
   * The current generation's box ran out: ask the worker for its notebook, give it the grace period
   * (the run's limits, the per-step budget, control commands and the lock still apply), stop it, take the notebook out of
   * the workspace, then judge the step like any other (evaluateStep), which rotates the generation.
   */
  async endGeneration(session: WorkerSession, n: number, box: GenerationBox, stepStartUsd: number): Promise<void> {
    const g = this.generationSettings();
    const gs = this.state.generations;
    if (!g || !gs) return;
    this.log(`generation ${gs.current} of ${g.maxGenerations}: its ${box} box ran out; asking for the notebook`);
    session.say?.(notebookRequest(gs.current, g));
    session.settled = false;
    session.lastEventAt = this.rt.now();
    const graceEnd = this.rt.now() + g.graceMinutes * 60_000;
    for (;;) {
      await this.rt.sleep(this.rt.tickMs);
      this.tick();
      if (this.lockLost) throw new LockLost();
      await this.refreshUsage();
      await this.applyControl();
      if (!this.active || this.signalled) { this.save(); return; }
      const limit = this.limitReached();
      if (limit) { await this.stopWorker(`limit ${limit}`); this.save(); return; } // the loop ends the run with the limit's outcome
      if (this.state.usage.usd - stepStartUsd >= this.state.limits.budget.perStepUsd) { session.agent.send({ type: "abort" }); this.log("the per-step budget ran out during the grace period"); break; }
      if (session.settled || session.dead || session.blocker || this.rt.now() >= graceEnd) break;
    }
    // Stopped before the notebook is read, so the worker cannot swap the file while the supervisor reads it.
    await this.stopWorker(`generation ${gs.current} ended`);
    const notebook = takeWorkerNotebook(this.store.p.work);
    this.save();
    await this.evaluateStep({ n, crashed: false, generation: { box, notebook } });
  }

  /**
   * Append the ended generation's notebook (with the supervisor's measurements) and start the next
   * generation's box. A notebook that is missing or malformed is replaced by an empty one, so the
   * measurements still reach the next generation and the numbering stays aligned.
   */
  async rotateGeneration(end: GenerationEnd, { head, ev, action }: { head: string; ev: StepEvaluation; action: string }): Promise<GenerationRecord | null> {
    const g = this.generationSettings();
    const s = this.state;
    const gs = s.generations;
    if (!g || !gs) return null;
    const measured: Measured = {
      checks: ev.results.map(({ id, pass }) => ({ id, pass })),
      head,
      changedFiles: gs.startHead ? this.repo.changedPaths(gs.startHead, head).length : 0,
      minutes: Math.round((s.usage.minutes - gs.startMinutes) * 10) / 10,
      usd: Math.max(0, Math.round((s.usage.usd - gs.startUsd) * 100) / 100),
    };
    const problems: string[] = [];
    let appended = false;
    try {
      const opts = { maxChars: g.notebookMaxChars, now: () => new Date(this.rt.now()) };
      const r = end.notebook.ok ? appendGeneration(this.store.p.notebook, end.notebook.text, measured, opts) : null;
      if (r?.ok) appended = true;
      else {
        problems.push(...(r ? r.problems : end.notebook.ok ? [] : [end.notebook.problem]));
        appendGeneration(this.store.p.notebook, { state: "" }, measured, opts);
      }
    } catch (e) { problems.push(`notebook.json: ${errorText(e)}`); }
    // A generation without progress spends a hard restart (decideRecovery); with resetOnNoProgress the next one starts from the accepted head.
    let reset = false;
    if (action === "restart" && g.resetOnNoProgress) {
      try { await this.rt.setWorkerBranch(head); reset = true; } catch (e) { problems.push(`reset to the accepted head: ${errorText(e)}`); }
    }
    // Problems can quote worker text (a JSON parse error quotes the input): controls are dropped before they are saved or logged.
    const shown = problems.map((p) => clip(p.replace(HIDDEN_CHARS, (ch) => (ch === "\n" || ch === "\t" ? " " : "")), 300)).slice(0, 10);
    const record: GenerationRecord = { generation: gs.current, at: new Date(this.rt.now()).toISOString(), box: end.box, notebook: appended, problems: shown, action, reset };
    s.generations = { current: gs.current + 1, startMinutes: s.usage.minutes, startUsd: s.usage.usd, startHead: head, history: [...gs.history, record].slice(-20), resetPending: reset };
    this.startReason = "generation";
    this.log(`generation ${record.generation} ended (${end.box} box): notebook ${appended ? "appended" : `not usable (${shown.join("; ") || "unknown"})`}${reset ? "; the next generation starts from the accepted head" : ""}`);
    this.store.event(s.step, { type: "generation", ...record });
    this.save();
    return record;
  }

  /** All required checks pass. Review if required, then succeed. Returns true when the run ended. */
  async completeIfApproved({ head, ev, n }: { head: string; ev: StepEvaluation; n: number }): Promise<boolean> {
    const { contract, repo } = this;
    const s = this.state;
    if (contract.acceptance.review) {
      const start = s.setup?.base ?? null;
      const bundle: TaskReviewBundle = {
        run: contract.run, title: contract.objective.title, spec: contract.objective.spec, backlog: contract.objective.backlog,
        results: ev.results.map(({ id, required, pass, exitCode, tail }) => ({ id, required, pass, exitCode, tail })),
        gitLog: start ? repo.logSince(start, head) : repo.logOneline(null, head, 40), diff: start ? repo.diffText(start, head) : "", sha: head,
      };
      let verdict: TaskReview;
      try { verdict = await this.rt.review(bundle); } catch (e) { verdict = { verdict: "REJECT", reason: `review unavailable (${errorText(e)}); not approved`, concerns: [], failed: true }; }
      await this.refreshUsage();
      const attempts = (s.acceptance.review.attempts ?? 0) + 1;
      const approved = verdict.verdict === "APPROVE";
      this.save((st) => { st.acceptance.review = { ...st.acceptance.review, required: true, status: approved ? "approved" : "rejected", verdict: verdict.verdict, reason: verdict.reason, concerns: verdict.concerns, sha: head, at: new Date(this.rt.now()).toISOString(), attempts }; });
      this.store.event(n, { type: "review", verdict: verdict.verdict, reason: verdict.reason });
      if (!approved) {
        this.pendingFeedback.push(`The independent review did not approve the change: ${clip(verdict.reason, 600)}${verdict.concerns.length ? ` Concerns: ${verdict.concerns.join("; ")}` : ""} Address these against the ORIGINAL specification, then stop.`);
        if (attempts >= s.limits.recovery.maxAttemptsPerStep) {
          await this.stopWorker("review rejected");
          this.go("failed", { reason: "review_rejected", detail: `${attempts} reviews did not approve: ${verdict.reason}` });
          return true;
        }
        return false;
      }
    }
    this.save((st) => { st.tasks = applyResultsToBoard(st.tasks, ev.results, { step: n, complete: true }); });
    await this.stopWorker("acceptance passed");
    this.writeStepSummary(n, { action: "complete", reason: "acceptance passed" });
    this.save();
    this.go("succeeded", { reason: "acceptance_passed", detail: `${ev.results.filter((r) => r.pass).length}/${ev.results.length} checks passed at ${head.slice(0, 12)}` });
    await this.afterSuccess(head);
    return true;
  }

  /** Promotion (when the contract lets the supervisor do it unasked) and automatic outputs. Failures are recorded, not fatal: the run did succeed. */
  async afterSuccess(head: string): Promise<void> {
    this.save((s) => { s.phase = "promotion"; });
    try { await this.promote({ sha: head, approved: false }); } catch (e) { this.log(`promotion: ${errorText(e)}`); }
    const { exportRun } = this.deps;
    if (exportRun) {
      for (const d of this.contract.permissions.outputs.destinations) {
        try { await exportRun({ engine: this, out: d.path }); this.log(`results exported to ${d.path}`); } catch (e) { this.log(`export to ${d.path} failed: ${errorText(e)}`); }
      }
    }
    this.save((s) => { s.phase = null; });
  }

  /** Promote `sha` per the contract. `approved` is the operator's explicit approval (the `promote` command). */
  async promote({ sha, approved }: { sha: string; approved: boolean }): Promise<PromotionRun> {
    return promoteRun({ contract: this.contract, cfg: this.cfg, store: this.store, repo: this.repo, template: this.template, state: this.state, now: () => this.rt.now(), log: this.log, sha, approved });
  }

  /** The briefing a fresh session gets: verified state, operator words, and quarantined traces. */
  async briefing(why: string): Promise<string> {
    const { repo, state, contract } = this;
    const head = repo.head();
    const start = state.setup?.base;
    const answer = state.pendingAnswer;
    const steers = (state.steers ?? []).slice(-5).map((x) => x.message);
    const gs = state.generations;
    const g = this.generationSettings();
    const reasons: Record<string, string> = { generation: `its generation's time box ran out; you are generation ${gs?.current ?? "?"} of ${g?.maxGenerations ?? "?"}, a fresh worker continuing from the previous generation's notebook`, hard_restart: "it was restarted by the supervisor's recovery", crash: "it crashed", supervisor_restart: "the supervisor was restarted", resumed: "the run was paused and resumed", answer: "the run was blocked on a question and has now been answered", session_ended: "it ended", continue: "it ended" };
    const text = buildBriefing({ contract, state, why: reasons[why] ?? why, head, log: repo.logOneline(start ?? null, head), changed: start ? repo.changedPaths(start, head) : [], activity: this.lastActivity, answer, steers, notebook: g ? this.latestNotebook() : null });
    if (answer) this.save((s) => { s.pendingAnswer = null; });
    return text;
  }

  /** The latest generation's notebook, rendered for a briefing; null when there is none or the file does not parse. */
  latestNotebook(): string | null {
    try {
      const entry = readNotebook(this.store.p.notebook).at(-1);
      return entry ? renderNotebook(entry) : null;
    } catch (e) { this.log(`notebook.json: ${errorText(e)}; the briefing carries no notebook`); return null; }
  }
}

/** What the worker is told when its generation's box runs out. */
function notebookRequest(generation: number, g: GenerationSettings): string {
  return [
    `Your generation's time box has run out (generation ${generation} of ${g.maxGenerations}). A fresh worker will continue in this same workspace from your notebook.`,
    `Stop what you are doing, commit and push what works, then write your notebook as JSON to ${WORKER_NOTEBOOK} in the workspace root (it is never committed), within ${g.graceMinutes} minute(s):`,
    '{"schema": 1, "state": "<where the work stands>", "tried": ["<strategy>"], "failures": ["<what failed and why>"], "do_not_retry": ["<dead end>"], "next": ["<next step>"], "self_reported": ["<what you believe works>"]}',
    `Keep it under ${g.notebookMaxChars} characters; the supervisor measures the checks itself and drops anything else. Then stop.`,
  ].join("\n");
}

function nudgeText(ev: StepEvaluation, { moved, violation }: { moved: boolean; violation: readonly string[] | null }): string {
  const failing = ev.results.filter((r) => !r.pass && r.required).map((r) => r.id);
  if (violation) return "Your last step made no accepted progress because it touched paths outside the allowed write areas.";
  return `Your last step ended without ${moved ? "any check newly passing" : "changing the accepted code"}. Required checks still failing: ${failing.join(", ") || "none listed"}. Read the check output above, make one concrete change that fixes the first failure, commit and push it. If you are stuck on something only a person can decide, ask with ask_human instead of stopping.`;
}
