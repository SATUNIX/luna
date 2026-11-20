// A host-wide bound on how many acceptance gates run at once for one user. The per-run lock
// (runlock.ts) guarantees a single supervisor per run; this bounds how many of those supervisors
// may run their gate at the same time, so several runs on one host do not starve each other's
// CPU and IO during the expensive part of a cycle. The gate container and its checks are
// unchanged: this only decides when a gate may start.
//
// A slot is held by a long-lived `flock` child on stateHome()/gate-slots/slot-<n>.lock. It is
// released by closing the child's stdin (its `cat` exits, so `flock` releases) or by killing the
// child; if the supervisor dies the pipe closes and the slot frees by itself. `limit <= 0` is
// unbounded and touches nothing.
//
// Worker slots (below) generalise this from a count to weighted bounds: how many workers, and how
// many CPUs, GiB of memory and dollars of per-step spend all running workers may take together. A
// worker takes its share of every bound in one pass or none of it, and waits like a gate.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GateWaitInterrupted } from "./errors.ts";

export const GATE_SLOTS_ENV = "PI_AUTONOMY_GATE_SLOTS";
export const DEFAULT_GATE_SLOTS = 2;

/** The configured slot count: 2 by default; 0 for unbounded; anything else falls back to 2. */
export function resolveGateSlots(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GATE_SLOTS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_GATE_SLOTS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_GATE_SLOTS;
}

/** One held slot. `release` is idempotent. */
export interface GateSlot {
  readonly index: number;
  release(): void;
}

export interface AcquireGateSlotOptions {
  home: string;
  limit: number;
  pollMs?: number;
  /** Called once per attempt while all slots are busy; a throw rejects the acquisition. */
  onWait?: () => void;
  /** Asked once per attempt while all slots are busy; true rejects with GateWaitInterrupted. */
  shouldStop?: () => Promise<boolean> | boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Try one slot: resolves the holder child when `flock` locked it, null when the slot is busy, and
 * rejects when `flock` could not be spawned or failed for a reason other than lock contention (a
 * permission error, `ENOLCK`, an unsupported filesystem). A missing binary or a broken invocation
 * must fail loudly, not poll forever.
 *
 * util-linux `flock -n` reports ordinary contention by exiting 1 with no stderr; every other
 * failure prints a diagnostic. So only a quiet exit 1 (or the documented conflict text) is a busy
 * slot.
 */
const LOCK_CONFLICT = /failed to get lock|Resource temporarily unavailable/i;

function trySlot(lockFile: string): Promise<ChildProcess | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["-n", "-x", lockFile, "sh", "-c", "printf held; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stderr = "";
    const done = (held: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(held ? child : null);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("held")) done(true); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    // `close` (not `exit`) so the stderr collected above is complete before deciding.
    child.on("close", (code: number | null) => {
      const busy = (code === 1 && stderr.trim() === "") || LOCK_CONFLICT.test(stderr);
      if (busy) done(false);
      else fail(new Error(`flock on ${lockFile} failed (exit ${code ?? "signal"}): ${stderr.trim() || "no diagnostic"}`));
    });
    child.on("error", (error: Error) => { fail(error); });
  });
}

/**
 * Take one of `limit` host-wide gate slots. Waits, polling, until a slot is free or `shouldStop`
 * says to give up (GateWaitInterrupted). Limit 0 (or negative) is unbounded: no directory, no file,
 * no child.
 */
export async function acquireGateSlot({ home, limit, pollMs = 500, onWait, shouldStop }: AcquireGateSlotOptions): Promise<GateSlot> {
  if (limit <= 0) return { index: -1, release: () => {} };
  const dir = path.join(home, "gate-slots");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    for (let i = 0; i < limit; i++) {
      const child = await trySlot(path.join(dir, `slot-${i}.lock`));
      if (!child) continue;
      let released = false;
      return {
        index: i,
        release: () => {
          if (released) return;
          released = true;
          try { child.stdin?.end(); } catch { /* the child exited first */ }
          child.kill();
        },
      };
    }
    onWait?.();
    if (shouldStop && (await shouldStop())) throw new GateWaitInterrupted();
    await sleep(pollMs);
  }
}

// --- worker slots ---------------------------------------------------------------------------------
//
// Each bound is a pool of unit lock files under stateHome()/worker-slots/<pool>-<i>.lock: `worker`
// (one unit per worker), `cpu` (one per CPU), `memory` (one per GiB) and `usd` (one per dollar of
// the run's per-step budget). The supervisor holds each unit file open and takes its lock with a
// short-lived `flock -n <fd>` on that open file description, so the lock lasts until the
// supervisor closes the file, or dies. One pass locks every free unit, keeps what the worker needs
// from each pool and closes the rest; if any pool is short it closes everything and waits. Nothing
// is held while waiting, so two waiting runs cannot deadlock.

export const WORKER_SLOTS_ENV = "PI_AUTONOMY_WORKER_SLOTS";
export const WORKER_CPUS_ENV = "PI_AUTONOMY_WORKER_CPUS";
export const WORKER_MEMORY_ENV = "PI_AUTONOMY_WORKER_MEMORY";
export const WORKER_USD_ENV = "PI_AUTONOMY_WORKER_USD";
/** Pools larger than this are refused: each unit is one open file and one lock per pass. */
export const MAX_POOL_UNITS = 1024;

/** Host-wide worker bounds; 0 is unbounded for each. */
export interface WorkerBounds { slots: number; cpus: number; memoryGiB: number; usd: number }

/** GiB in an engine-style quantity ("512m", "8g", "2048"; a bare number is bytes, as for --memory). */
export function quantityGiB(value: string | number): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(String(value));
  if (!m) return Number.NaN;
  const scale: Record<string, number> = { "": 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 };
  return (Number(m[1]) * (scale[(m[2] ?? "").toLowerCase()] ?? Number.NaN)) / 2 ** 30;
}

/**
 * The bounds the environment sets. Unset or empty is 0 (unbounded). A value that does not parse
 * throws, naming the variable: a mistyped limit must not silently mean "no limit".
 */
export function resolveWorkerBounds(env: NodeJS.ProcessEnv = process.env): WorkerBounds {
  const read = (name: string, parse: (raw: string) => number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return 0;
    const n = parse(raw.trim());
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name}=${JSON.stringify(raw)} is not a non-negative amount`);
    const units = Math.floor(n);
    if (units > MAX_POOL_UNITS) throw new Error(`${name}=${JSON.stringify(raw)} is more than ${String(MAX_POOL_UNITS)} units`);
    return units;
  };
  const whole = (raw: string): number => (/^\d+$/.test(raw) ? Number(raw) : Number.NaN);
  return {
    slots: read(WORKER_SLOTS_ENV, whole),
    cpus: read(WORKER_CPUS_ENV, (raw) => Number(raw)),
    memoryGiB: read(WORKER_MEMORY_ENV, (raw) => (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) : quantityGiB(raw))),
    usd: read(WORKER_USD_ENV, (raw) => Number(raw)),
  };
}

/** One pool a worker draws from: `want` of its `limit` units. */
export interface UnitPool { name: "worker" | "cpu" | "memory" | "usd"; limit: number; want: number }

/** What one worker needs from the bounded pools, rounded up to whole units. Unbounded pools are left out. */
export function workerPools(bounds: WorkerBounds, need: { cpus: string | number; memory: string | number; perStepUsd: number }): UnitPool[] {
  const pools: UnitPool[] = [];
  const add = (name: UnitPool["name"], limit: number, amount: number): void => {
    if (limit <= 0) return;
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`the worker's ${name} need (${String(amount)}) is not a number`);
    pools.push({ name, limit, want: Math.max(1, Math.ceil(amount)) });
  };
  add("worker", bounds.slots, 1);
  add("cpu", bounds.cpus, Number(need.cpus));
  add("memory", bounds.memoryGiB, quantityGiB(need.memory));
  add("usd", bounds.usd, need.perStepUsd);
  return pools;
}

/** Units held for one worker. `release` is idempotent. */
export interface WorkerSlot {
  readonly units: Readonly<Record<string, number>>;
  release(): void;
}

/** One pass: lock every free unit of every pool, keep what is wanted, close the rest; null when any pool is short. */
function tryWorkerUnits(dir: string, pools: readonly UnitPool[]): WorkerSlot | null {
  const files = pools.flatMap((p) => Array.from({ length: p.limit }, (_, i) => ({ pool: p.name, file: path.join(dir, `${p.name}-${String(i)}.lock`) })));
  const fds: number[] = [];
  try {
    for (const f of files) fds.push(fs.openSync(f.file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600));
    // Child fds 3.. are the unit files; the child locks each open file description and exits.
    const fdArgs = fds.map((_, i) => String(i + 3));
    const r = spawnSync("sh", ["-c", 'for fd; do flock -n -x "$fd"; echo "$?"; done', "sh", ...fdArgs], { stdio: ["ignore", "pipe", "pipe", ...fds], encoding: "utf8" });
    if (r.error) throw r.error;
    const codes = r.stdout.trim().split("\n").map(Number);
    if (codes.length !== fds.length) throw new Error(`flock over ${dir} answered ${String(codes.length)} of ${String(fds.length)} units: ${r.stderr.trim() || "no diagnostic"}`);
    const bad = codes.find((c) => c !== 0 && c !== 1);
    if (bad !== undefined || (codes.includes(1) && r.stderr.trim() !== "" && !LOCK_CONFLICT.test(r.stderr))) throw new Error(`flock over ${dir} failed (exit ${String(bad ?? 1)}): ${r.stderr.trim() || "no diagnostic"}`);
    const keep = new Set<number>();
    const units: Record<string, number> = {};
    for (const p of pools) {
      const locked = files.map((f, i) => ({ f, i })).filter(({ f, i }) => f.pool === p.name && codes[i] === 0).slice(0, p.want);
      if (locked.length < p.want) { for (const fd of fds) fs.closeSync(fd); fds.length = 0; return null; }
      for (const { i } of locked) keep.add(i);
      units[p.name] = p.want;
    }
    const held = fds.filter((_, i) => keep.has(i));
    fds.forEach((fd, i) => { if (!keep.has(i)) fs.closeSync(fd); });
    fds.length = 0;
    let released = false;
    return { units, release: () => { if (released) return; released = true; for (const fd of held) { try { fs.closeSync(fd); } catch { /* already closed */ } } } };
  } catch (error) {
    for (const fd of fds) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    throw error;
  }
}

export interface AcquireWorkerSlotOptions {
  home: string;
  pools: readonly UnitPool[];
  pollMs?: number;
  onWait?: () => void;
  shouldStop?: () => Promise<boolean> | boolean;
}

/**
 * Take one worker's share of every bounded pool, waiting while any is short. No pools (nothing
 * bounded) returns at once and touches nothing. A worker that needs more than a pool holds can
 * never start, so that is an error rather than a wait. A stop while waiting rejects with
 * GateWaitInterrupted, as a gate wait does.
 */
export async function acquireWorkerSlot({ home, pools, pollMs = 5_000, onWait, shouldStop }: AcquireWorkerSlotOptions): Promise<WorkerSlot> {
  if (!pools.length) return { units: {}, release: () => {} };
  const tooBig = pools.find((p) => p.want > p.limit);
  if (tooBig) throw new Error(`one worker needs ${String(tooBig.want)} ${tooBig.name} units but the host bound is ${String(tooBig.limit)}: it can never start; raise the bound or shrink the worker`);
  const dir = path.join(home, "worker-slots");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    const slot = tryWorkerUnits(dir, pools);
    if (slot) return slot;
    onWait?.();
    if (shouldStop && (await shouldStop())) throw new GateWaitInterrupted("a worker slot");
    await sleep(pollMs);
  }
}
