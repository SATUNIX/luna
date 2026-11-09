/**
 * Effort ledger: the shared, cross-process record of delegation for one scope (one user turn of
 * a root session, or one autonomous step).
 *
 * Every child a launch point starts, at any depth, reserves against the SAME ledger file, so
 * descendants never get a fresh budget: the root's concurrent-live, total-invocation and scout
 * limits bound the whole tree. Reservations are atomic (an exclusive lock file around
 * read-modify-write) so two siblings racing for the last slot cannot both win.
 *
 * Accounting rules (docs/effort.md):
 *  - a reservation charges one child execution (an automatic retry or a resumed run is a new
 *    execution and reserves again; polling an existing child is not a launch and never reserves);
 *  - charges are never refunded, including when the child fails or never starts;
 *  - `live` counts descendants that hold a slot right now (the root is excluded);
 *  - "discretionary" launches (the model-callable delegation tools) obey the tier limits;
 *  - "recovery" launches spend a separate, small budget that only opens while the trusted
 *    recovery extension has recovery active, and only for read-only roles;
 *  - "mandatory" launches (completion review, validators) are required by verification policy,
 *    so they are always allowed up to a fixed bound and never draw on the discretionary budget;
 *  - "user" launches are ones the person typed (a /workflow command): they are not the agent's own
 *    initiative, so only the platform ceilings bound them, and they never draw on the tier budget;
 *  - "workflow" launches are the agents of a script-workflow run. They are charged to the session's
 *    workflow ledger, a separate file that the per-turn scope rotation never replaces, against the
 *    run's own scope (opened with openRun and named by its run id plus the run token only the engine
 *    holds): at most `concurrent` live per run, `totalPerRun` per run and `sessionTotal` across the
 *    session's runs. They never count toward the tier budget or the session ceiling. A "concurrency"
 *    denial means "wait for a slot"; every other denial is final for the request.
 *    A model-started YAML run also has a plan: its worst case is charged to `plannedUsed` when its
 *    scope opens, up to the tier's allowance, which then caps the run as well. The charge lives here,
 *    so neither the per-turn rotation nor a reload refreshes it; only a user message does
 *    (resetPlanned), including one sent by an extension, and a run that spends less gets nothing back. An approved script opens no plan and has no cap.
 *
 * Effort budgets govern cost and behaviour, not security: the ledger is a file the session can
 * write, so a hostile process with shell access in the same account could tamper with it. The
 * hard boundary is the container or the firewall, never this file (docs/effort.md).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TierLimits } from "./policy.ts";

export type LaunchKind = "discretionary" | "recovery" | "mandatory" | "user" | "workflow";

export interface LiveEntry {
  id: string;
  kind: LaunchKind;
  role: string;
  scout: boolean;
  requesterTier: string;
  pid: number | null;
  reservedAt: number;
  /** The workflow run the slot belongs to (workflow launches only). */
  runId?: string;
}

export interface Charge {
  id: string;
  at: number;
  kind: LaunchKind;
  role: string;
  scout: boolean;
  outcome?: string;
}

/** One workflow run's pinned scope. Only a hash of its token is stored. */
export interface WorkflowRun {
  tokenHash: string;
  used: number;
  openedAt: number;
  /** Planned runs only: the tier allowance, which holds the run below `totalPerRun`. */
  cap?: number;
  /** Planned runs only: the worst case charged to this run so far, which a renewed allowance does not clear. */
  planned?: number;
}

/** The workflow limits a workflow ledger is created with. */
export interface WorkflowInit {
  concurrent: number;
  totalPerRun: number;
  sessionTotal: number;
}

/** The workflow part of a session's workflow ledger: the limits, the session's use, and each run. */
export interface WorkflowSection extends WorkflowInit {
  used: number;
  /** Agents planned in the current user request; absent until the first plan. */
  plannedUsed?: number;
  runs: Record<string, WorkflowRun>;
}

export interface LedgerData {
  schemaVersion: 1;
  scope: string;
  createdAt: number;
  /** The root's tier when the scope opened; a snapshot, never raised by later effort changes. */
  tier: string;
  limits: TierLimits;
  recovery: { maxInvocations: number; maxConcurrent: number; roles: string[]; active: boolean };
  /** Total children charged in earlier scopes of the same root session (for the session ceiling). */
  sessionTotalBefore: number;
  sessionCeiling: number;
  mandatoryMax: number;
  /** Platform ceilings, the only bound on user-directed launches. */
  ceilings: TierLimits;
  total: number;
  userUsed: number;
  scouts: number;
  recoveryUsed: number;
  mandatoryUsed: number;
  live: LiveEntry[];
  charges: Charge[];
  /** Present only on a session's workflow ledger. */
  workflow?: WorkflowSection;
}

export type DenialCode = "no-ledger" | "concurrency" | "total" | "scouts" | "tier" | "session-ceiling" | "recovery-closed" | "recovery-budget" | "recovery-role" | "mandatory-budget" | "run-scope" | "plan-allowance" | "invalid";

export interface Denial {
  ok: false;
  code: DenialCode;
  reason: string;
}

export interface Granted {
  ok: true;
  id: string;
}

export interface ReserveRequest {
  kind: LaunchKind;
  role: string;
  scout?: boolean | undefined;
  /** The tier of the process asking (a child asks with its own, lower-or-equal tier). */
  requesterTier: string;
  /** That tier's own limits: a child's request is bounded by the tighter of these and the ledger's. */
  requesterLimits: TierLimits;
  /** A short label of the tier for messages, e.g. "E3 Standard". */
  requesterLabel: string;
  /** Whether the requested role is read-only (recovery launches accept only those). */
  readOnly?: boolean | undefined;
  /** Workflow launches: the run the agent belongs to, and the token openRun returned for it. */
  runId?: string | undefined;
  runToken?: string | undefined;
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const RESERVATION_ORPHAN_MS = 120_000;
const MAX_CHARGES = 200;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// A stale lock (its holder crashed or stalled for longer than LOCK_STALE_MS) is broken under a second, short-lived
// lock, and only after looking at the main lock again while holding it. Without that, two waiters that both saw
// the same stale lock could each remove "it": the second removal deletes the first waiter's FRESH lock, and both
// enter the critical section and grant the last slot twice. A break lock left behind by a crash is itself stale
// after a moment.
const LOCK_BREAK_STALE_MS = 3_000;

function breakStaleLock(lock: string): void {
  const breaker = `${lock}.break`;
  try {
    fs.writeFileSync(breaker, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - fs.statSync(breaker).mtimeMs > LOCK_BREAK_STALE_MS) fs.rmSync(breaker, { force: true });
    } catch {
      /* gone already */
    }
    return; // another waiter is breaking it (or we just cleared a dead breaker): the caller looks again
  }
  try {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(lock).mtimeMs;
    } catch {
      return; // released meanwhile
    }
    if (Date.now() - mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

/**
 * Run `fn` holding the ledger's exclusive lock (O_EXCL lock file; a lock older than 15 s is stale and is broken
 * by one waiter at a time). The lock carries this acquisition's own token, and is removed only if it still does.
 */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = `${process.pid}:${crypto.randomUUID()}\n`;
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(lock).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code === "ENOENT") continue; // the holder released it between our attempt and the stat
        throw statError;
      }
      // A break that fails throws, and one that leaves the lock in place still reaches the deadline.
      if (Date.now() - mtimeMs > LOCK_STALE_MS) breakStaleLock(lock);
      if (Date.now() > deadline) throw new Error(`timed out waiting for the effort ledger lock ${lock}`, { cause: error });
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    // Only our own lock: if a stall let someone break it and take over, theirs is not ours to remove.
    try {
      if (fs.readFileSync(lock, "utf8") === token) fs.rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function isWorkflowRun(value: unknown): value is WorkflowRun {
  return isRecord(value) && typeof value.tokenHash === "string" && isCount(value.used) && typeof value.openedAt === "number" && (value.cap === undefined || isCount(value.cap)) && (value.planned === undefined || isCount(value.planned));
}

function isWorkflowSection(value: unknown): value is WorkflowSection {
  if (!isRecord(value) || !isCount(value.concurrent) || !isCount(value.totalPerRun) || !isCount(value.sessionTotal) || !isCount(value.used) || (value.plannedUsed !== undefined && !isCount(value.plannedUsed))) return false;
  const runs = value.runs;
  return isRecord(runs) && !Array.isArray(runs) && Object.values(runs).every(isWorkflowRun);
}

// Checks the version and the two lists (and the workflow section, which reserve reads field by
// field), nothing more: the ledger is this session's own file, and the budget it carries governs
// cost, not security (see the header).
function isLedgerData(value: unknown): value is LedgerData {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.live) && Array.isArray(value.charges) && (value.workflow === undefined || isWorkflowSection(value.workflow));
}

export function readLedger(file: string): LedgerData | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isLedgerData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLedger(file: string, data: LedgerData): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

type LedgerInit = Pick<LedgerData, "scope" | "tier" | "limits" | "recovery" | "sessionTotalBefore" | "sessionCeiling" | "mandatoryMax" | "ceilings"> & { workflow?: WorkflowInit };

export function createLedger(file: string, init: LedgerInit): LedgerData {
  const data = freshLedger(init);
  withLock(file, () => writeLedger(file, data));
  return data;
}

/**
 * Create the ledger only when no file exists at `file` (checked and written under the lock). An
 * existing file is never replaced, even an unreadable one: a tampered or corrupt ledger must keep
 * refusing (code "no-ledger") rather than come back as a fresh, empty budget. Returns whether it
 * created the file.
 */
export function createLedgerIfAbsent(file: string, init: LedgerInit): boolean {
  return withLock(file, () => {
    try {
      fs.lstatSync(file);
      return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    writeLedger(file, freshLedger(init));
    return true;
  });
}

function freshLedger(init: LedgerInit): LedgerData {
  const { workflow, ...rest } = init;
  return {
    schemaVersion: 1,
    ...rest,
    ...(workflow ? { workflow: { concurrent: workflow.concurrent, totalPerRun: workflow.totalPerRun, sessionTotal: workflow.sessionTotal, used: 0, runs: {} } } : {}),
    recovery: { ...init.recovery, active: false },
    createdAt: Date.now(),
    userUsed: 0,
    total: 0,
    scouts: 0,
    recoveryUsed: 0,
    mandatoryUsed: 0,
    live: [],
    charges: [],
  };
}

/** Drop reservations that will never settle: a dead process, or a slot that never got a pid. */
function reap(data: LedgerData, now: number): void {
  data.live = data.live.filter((entry) => {
    if (entry.pid !== null) return processAlive(entry.pid);
    return now - entry.reservedAt < RESERVATION_ORPHAN_MS;
  });
}

const deny = (code: DenialCode, reason: string): Denial => ({ ok: false, code, reason });

/** A run id: short, and safe in a file name and a message. */
export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const hashToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

function tokenMatches(tokenHash: string, token: string): boolean {
  const a = Buffer.from(tokenHash, "utf8");
  const b = Buffer.from(hashToken(token), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A planned run's worst case, and the tier allowance it is charged against and capped at. */
export interface RunPlan {
  planned: number;
  allowance: number;
  /** A short label of the tier for messages, e.g. "E3 Standard". */
  label: string;
}

/**
 * Open a workflow run's scope in a workflow ledger (one created with `workflow` limits). A run id is
 * opened once: opening it again is refused, so a second caller can neither reset the run's count
 * nor replace its token. Returns the run token, which every reservation for the run must carry.
 * With a `plan` the charge and the open are one step under the lock: a refused plan spends nothing.
 */
export function openRun(file: string, runId: string, now = Date.now(), newToken: () => string = () => crypto.randomBytes(24).toString("hex"), plan?: RunPlan): { ok: true; runToken: string } | Denial {
  if (!RUN_ID_RE.test(runId)) return deny("invalid", `"${runId.slice(0, 80)}" is not a valid workflow run id (letters, digits, ".", "_" and "-", at most 64)`);
  if (plan && !isCount(plan.planned)) return deny("invalid", "a planned run's worst case must be a non-negative whole number of agents");
  try {
    return withLock(file, () => {
      const data = readLedger(file);
      if (!data) return deny("no-ledger", "the workflow ledger is missing or unreadable, so the run cannot be budgeted");
      if (!data.workflow) return deny("run-scope", "this ledger is not a workflow ledger");
      if (Object.hasOwn(data.workflow.runs, runId)) return deny("run-scope", `workflow run "${runId}" already has a scope; a run id is opened once`);
      if (plan) {
        const planned = data.workflow.plannedUsed ?? 0;
        if (planned + plan.planned > plan.allowance) {
          const remaining = plan.allowance - planned;
          const why =
            remaining <= 0
              ? `no workflow of any size fits this request: ${plan.label} allows ${plan.allowance} planned agents a request and ${planned} are already planned. The allowance renews on the next user message; raise it with /effort.`
              : `this workflow can start up to ${plan.planned} agents, but only up to ${remaining} more would fit this request: ${plan.label} allows ${plan.allowance} planned agents a request (${planned} already planned). Plan fewer agents, or raise effort with /effort.`;
          return deny("plan-allowance", why);
        }
        data.workflow.plannedUsed = planned + plan.planned;
      }
      const runToken = newToken();
      data.workflow.runs[runId] = { tokenHash: hashToken(runToken), used: 0, openedAt: now, ...(plan ? { cap: plan.allowance, planned: plan.planned } : {}) };
      writeLedger(file, data);
      return { ok: true as const, runToken };
    });
  } catch (error) {
    return deny("no-ledger", `the workflow ledger could not be updated (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Charge more to an open planned run: a plan's expansion, which the host only knows once a step has
 * answered. The same allowance and the same run: over the allowance, or past what the run's cap can
 * still start once its unstarted planned agents are counted, is refused with nothing charged. Only the holder of the run's token can charge it.
 */
export function chargeRun(file: string, runId: string, runToken: string, plan: RunPlan): { ok: true } | Denial {
  if (!isCount(plan.planned)) return deny("invalid", "a planned run's worst case must be a non-negative whole number of agents");
  try {
    return withLock(file, () => {
      const data = readLedger(file);
      if (!data) return deny("no-ledger", "the workflow ledger is missing or unreadable, so the expansion cannot be budgeted");
      const wf = data.workflow;
      const run = wf && Object.hasOwn(wf.runs, runId) ? wf.runs[runId] : undefined;
      if (!wf || run?.cap === undefined || !tokenMatches(run.tokenHash, runToken)) return deny("run-scope", "no open planned workflow run matches this request (unknown run id or wrong run token)");
      const planned = wf.plannedUsed ?? 0;
      const allowance = Math.min(plan.allowance, run.cap);
      // Retries can take `used` past what was planned; until then the unstarted plan still holds its place.
      const committed = Math.max(run.used, run.planned ?? 0);
      if (planned + plan.planned > allowance || committed + plan.planned > allowance) {
        const inRequest = allowance - planned;
        const inRun = allowance - committed;
        const why =
          inRequest <= 0
            ? `no workflow of any size fits this request: ${plan.label} allows ${allowance} a request and ${planned} are already planned. The allowance renews on the next user message; raise it with /effort.`
            : inRun <= 0
              ? `this run has started or planned ${committed} of its ${allowance} agents, so it cannot expand; a new plan can still start up to ${inRequest}.`
              : `up to ${Math.min(inRequest, inRun)} more agents would fit: ${plan.label} allows ${allowance} a request (${planned} planned, ${committed} started or planned here). Plan less, or raise effort with /effort.`;
        return deny("plan-allowance", why);
      }
      wf.plannedUsed = planned + plan.planned;
      run.planned = committed + plan.planned;
      writeLedger(file, data);
      return { ok: true as const };
    });
  } catch (error) {
    return deny("no-ledger", `the workflow ledger could not be updated (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** A new user request: plans may be charged again. Failing leaves the charge, which only refuses more. */
export function resetPlanned(file: string): void {
  try {
    withLock(file, () => {
      const data = readLedger(file);
      if (!data?.workflow?.plannedUsed) return;
      data.workflow.plannedUsed = 0;
      writeLedger(file, data);
    });
  } catch {
    /* the allowance stays spent */
  }
}

/** Atomically reserve a slot, or say exactly why not. A grant charges the ledger permanently. */
export function reserve(file: string, request: ReserveRequest, now = Date.now(), newId: () => string = () => `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`): Granted | Denial {
  if (!/^(discretionary|recovery|mandatory|user|workflow)$/.test(request.kind)) return deny("invalid", `unknown launch kind "${request.kind}"`);
  try {
    return withLock(file, () => {
      const data = readLedger(file);
      if (!data) return deny("no-ledger", "the effort ledger for this request is missing or unreadable, so delegation cannot be budgeted");
      reap(data, now);
      const id = newId();
      const scout = Boolean(request.scout);
      const entry: LiveEntry = { id, kind: request.kind, role: request.role, scout, requesterTier: request.requesterTier, pid: null, reservedAt: now };
      const live = data.live.filter((e) => e.kind === request.kind);

      if (request.kind === "workflow") {
        const wf = data.workflow;
        if (!wf) return deny("run-scope", "workflow launches need the session's workflow ledger and an open run scope");
        const runId = request.runId;
        const run = runId !== undefined && Object.hasOwn(wf.runs, runId) ? wf.runs[runId] : undefined;
        if (!runId || !run || typeof request.runToken !== "string" || !tokenMatches(run.tokenHash, request.runToken)) return deny("run-scope", `no open workflow run matches this request (unknown run id or wrong run token)`);
        if (wf.used >= wf.sessionTotal) return deny("session-ceiling", `workflow runs in this session have started ${wf.used} agents, the session limit (${wf.sessionTotal}). Start a new session for more.`);
        const perRun = Math.min(run.cap ?? wf.totalPerRun, wf.totalPerRun);
        if (run.used >= perRun) return deny("total", `workflow run "${runId}" has started ${run.used} agents, the per-run limit (${perRun}); retries and failed agents count.`);
        const liveRun = data.live.filter((e) => e.kind === "workflow" && e.runId === runId).length;
        if (liveRun >= wf.concurrent) return deny("concurrency", `${liveRun} agents of workflow run "${runId}" are already running (limit ${wf.concurrent}). Wait for one to finish.`);
        run.used++;
        wf.used++;
        entry.runId = runId;
      } else if (request.kind === "user") {
        if (data.userUsed >= data.ceilings.maxTotal) return deny("total", `this request has already run ${data.userUsed} user-directed children, the platform ceiling (${data.ceilings.maxTotal})`);
        if (live.length >= data.ceilings.maxConcurrent) return deny("concurrency", `${live.length} user-directed children are already running (platform ceiling ${data.ceilings.maxConcurrent})`);
        data.userUsed++;
      } else if (request.kind === "mandatory") {
        if (data.mandatoryUsed >= data.mandatoryMax) return deny("mandatory-budget", `the mandatory verification budget for this request is used up (${data.mandatoryUsed}/${data.mandatoryMax})`);
        data.mandatoryUsed++;
      } else if (request.kind === "recovery") {
        if (!data.recovery.active) return deny("recovery-closed", "recovery launches are only available while the recovery extension has recovery active");
        if (!data.recovery.roles.includes(request.role) || request.readOnly === false) return deny("recovery-role", `recovery may only start read-only roles (${data.recovery.roles.join(", ")}); "${request.role}" is not one`);
        if (data.recoveryUsed >= data.recovery.maxInvocations) return deny("recovery-budget", `the recovery budget is used up (${data.recoveryUsed}/${data.recovery.maxInvocations}); stop and report what is blocking instead of retrying`);
        if (live.length >= data.recovery.maxConcurrent) return deny("recovery-budget", `${live.length} recovery child(ren) already running (limit ${data.recovery.maxConcurrent})`);
        data.recoveryUsed++;
      } else {
        // Discretionary: the tighter of the ledger's (root snapshot) and the requester's own tier.
        const limits: TierLimits = {
          maxConcurrent: Math.min(data.limits.maxConcurrent, request.requesterLimits.maxConcurrent),
          maxTotal: Math.min(data.limits.maxTotal, request.requesterLimits.maxTotal),
          maxScouts: Math.min(data.limits.maxScouts, request.requesterLimits.maxScouts),
        };
        const liveNow = data.live.filter((e) => e.kind === "discretionary").length;
        if (limits.maxTotal === 0) return deny("tier", `${request.requesterLabel} does not delegate (no child invocations are allowed). Do the work directly, or ask the user to raise effort with /effort.`);
        if (data.sessionTotalBefore + data.total >= data.sessionCeiling) return deny("session-ceiling", `this session has started ${data.sessionTotalBefore + data.total} children, the platform ceiling. Finish directly or start a new session.`);
        if (data.total >= limits.maxTotal) return deny("total", `child invocations for this request are used up (${data.total}/${limits.maxTotal} at ${request.requesterLabel}; retries and failed children count). Continue directly, or ask the user to raise effort with /effort.`);
        if (liveNow >= limits.maxConcurrent) return deny("concurrency", `${liveNow} child(ren) are already running (limit ${limits.maxConcurrent} at ${request.requesterLabel}). Wait for one to finish; the limit counts live descendants at any depth.`);
        if (scout && data.scouts >= limits.maxScouts) return deny("scouts", `scout invocations for this request are used up (${data.scouts}/${limits.maxScouts} at ${request.requesterLabel}); scouts count within the shared total.`);
        data.total++;
        if (scout) data.scouts++;
      }
      data.live.push(entry);
      data.charges.push({ id, at: now, kind: request.kind, role: request.role, scout });
      if (data.charges.length > MAX_CHARGES) data.charges = data.charges.slice(-MAX_CHARGES);
      writeLedger(file, data);
      return { ok: true as const, id };
    });
  } catch (error) {
    return deny("no-ledger", `the effort ledger could not be updated (${error instanceof Error ? error.message : String(error)}); refusing to launch a child without a budget check`);
  }
}

/** Record the child's pid so a dead child's slot can be reclaimed. Best-effort. */
export function attach(file: string, id: string, pid: number | undefined): void {
  if (!pid) return;
  try {
    withLock(file, () => {
      const data = readLedger(file);
      const entry = data?.live.find((e) => e.id === id);
      if (data && entry) {
        entry.pid = pid;
        writeLedger(file, data);
      }
    });
  } catch {
    /* the slot is reclaimed by the orphan timer instead */
  }
}

/** Release the concurrency slot. The charge stays: a failed or cancelled child is never refunded. */
export function settle(file: string, id: string, outcome: string): void {
  try {
    withLock(file, () => {
      const data = readLedger(file);
      if (!data) return;
      data.live = data.live.filter((e) => e.id !== id);
      const charge = data.charges.find((c) => c.id === id);
      if (charge) charge.outcome = outcome;
      writeLedger(file, data);
    });
  } catch {
    /* an unreadable ledger cannot be settled; the reaper handles the slot */
  }
}

export function setRecoveryActive(file: string, active: boolean): void {
  try {
    withLock(file, () => {
      const data = readLedger(file);
      if (!data) return;
      data.recovery.active = active;
      writeLedger(file, data);
    });
  } catch {
    /* recovery stays closed */
  }
}

export interface Usage {
  live: number;
  total: number;
  scouts: number;
  recoveryUsed: number;
  mandatoryUsed: number;
}

export function usageOf(data: LedgerData | null): Usage {
  return { live: data?.live.filter((e) => e.kind === "discretionary").length ?? 0, total: data?.total ?? 0, scouts: data?.scouts ?? 0, recoveryUsed: data?.recoveryUsed ?? 0, mandatoryUsed: data?.mandatoryUsed ?? 0 };
}
