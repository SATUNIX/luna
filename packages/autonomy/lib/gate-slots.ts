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
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
 * Take one of `limit` host-wide gate slots. Waits, polling, until a slot is free. Limit 0 (or
 * negative) is unbounded: no directory, no file, no child.
 */
export async function acquireGateSlot({ home, limit, pollMs = 500, onWait }: AcquireGateSlotOptions): Promise<GateSlot> {
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
    await sleep(pollMs);
  }
}
