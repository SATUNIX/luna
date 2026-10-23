// Exactly ONE supervisor owns a run. The lock is a file in the run directory holding the owner's
// pid, process start time, host name and a heartbeat. A duplicate `start` (or `resume`) refuses
// while the owner is alive; after a crash the lock is stale, and the next supervisor takes it
// over, removes the orphans (lib/runtime.ts) and continues.
//
// Liveness, in order of trust:
//   same host    pid alive AND process start time equal to the recorded one (a reused pid has a
//                different start time). If the start time cannot be read, fall back to the heartbeat.
//   other host   heartbeat age only (clock skew larger than staleMs would defeat this; documented).
// A same-host owner that is alive but silent is "wedged": it is never taken over automatically,
// because two supervisors on one run would repeat side effects.
//
// Takeover is atomic: a taker first creates (O_EXCL) a claim file named after the stale lock's
// token and inode, so only one taker at a time may move that lock aside; it then re-reads the lock
// and moves it only if it is still the same file, and checks the moved file again, putting it back
// (link, which never overwrites) if it turns out to be a newer lock. A claim left by a taker that
// crashed is removed once it is older than staleMs.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainObject } from "./fsutil.ts";
import { parseJson } from "../../core/lib/guard.ts";

/** supervisor.lock: who holds the run. */
export type LockRecord = {
  schemaVersion: 1;
  pid: number;
  /** processStartTime of the holder, or null when it could not be read. */
  startTime: string | null;
  host: string;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
};

export type LockState = "alive" | "stale" | "wedged";

export interface LockAssessment {
  state: LockState;
  why: string;
}

/** What `inspect` reports: the holder (null when the file is unreadable) and its liveness. */
export interface LockInspection extends LockAssessment {
  holder: LockRecord | null;
}

export type AcquireResult =
  | { acquired: true; tookOver?: Partial<LockRecord> & { why: string } }
  | { acquired: false; reason: string; holder?: LockRecord | null };

export interface RunLock {
  readonly token: string;
  readonly held: boolean;
  /** Who holds the lock and whether they are alive; null when there is no lock. */
  inspect(): LockInspection | null;
  acquire(): AcquireResult;
  /** Refresh the heartbeat. Returns false when the lock is no longer ours. */
  heartbeat(): boolean;
  start(onLost?: () => void): void;
  release(): void;
}

export interface RunLockOptions {
  file: string;
  host?: string;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  startTimeOf?: (pid: number) => string | null;
  staleMs?: number;
  heartbeatMs?: number;
}

/**
 * The lock file's record. The fields liveness is judged on are checked; a file that fails is
 * treated like an unparseable one (being written, or corrupt).
 */
function asLockRecord(v: unknown): LockRecord | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.pid !== "number" || typeof v.host !== "string" || typeof v.token !== "string") return null;
  if (v.startTime !== null && v.startTime !== undefined && typeof v.startTime !== "string") return null;
  if (v.heartbeatAt !== undefined && typeof v.heartbeatAt !== "string") return null;
  return v as LockRecord;
}

/** A stable identifier of a running process's start, or null when unavailable. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return `proc:${rest[19] ?? "undefined"}`; // field 22 (starttime, clock ticks since boot); rest starts at field 3
  } catch { /* not Linux, or no such process */ }
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const text = r.status === 0 ? r.stdout.trim() : "";
    return text ? `ps:${text}` : null;
  } catch { return null; }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Judge a lock record. Pure given its inputs. */
export function assessLock(
  rec: Pick<LockRecord, "pid" | "host"> & { startTime?: string | null; heartbeatAt?: string },
  { host, now, isAlive = pidAlive, startTimeOf = processStartTime, staleMs }: { host: string; now: number; isAlive?: (pid: number) => boolean; startTimeOf?: (pid: number) => string | null; staleMs: number },
): LockAssessment {
  const age = now - Date.parse(rec.heartbeatAt ?? "0");
  if (rec.host === host) {
    if (!isAlive(rec.pid)) return { state: "stale", why: `process ${rec.pid} no longer exists` };
    const start = startTimeOf(rec.pid);
    if (rec.startTime && start) {
      if (start !== rec.startTime) return { state: "stale", why: `pid ${rec.pid} was reused by another process` };
      return age > staleMs ? { state: "wedged", why: `process ${rec.pid} is alive but has not written a heartbeat for ${Math.round(age / 1000)}s` } : { state: "alive", why: `process ${rec.pid} is running` };
    }
    return age > staleMs ? { state: "stale", why: `process ${rec.pid} exists but its start time cannot be verified and the heartbeat is ${Math.round(age / 1000)}s old` } : { state: "alive", why: `process ${rec.pid} is running` };
  }
  return age > staleMs ? { state: "stale", why: `held from ${rec.host}; heartbeat ${Math.round(age / 1000)}s old` } : { state: "alive", why: `held from ${rec.host}; heartbeat ${Math.round(age / 1000)}s old` };
}

export function createRunLock({ file, host = os.hostname(), pid = process.pid, now = () => Date.now(), isAlive = pidAlive, startTimeOf = processStartTime, staleMs = 120_000, heartbeatMs = 5000 }: RunLockOptions): RunLock {
  const token = randomBytes(8).toString("hex");
  const startTime = startTimeOf(pid);
  let timer: NodeJS.Timeout | null = null;
  let held = false;

  const record = (at: string): LockRecord => ({ schemaVersion: 1, pid, startTime, host, token, acquiredAt: at, heartbeatAt: at });
  const read = (): LockRecord | null => { try { return asLockRecord(parseJson(fs.readFileSync(file, "utf8"))); } catch { return null; } };
  /** The lock file's inode and record, read through one descriptor; null when there is no file. */
  const snapshot = (at: string): { ino: number; mtimeMs: number; rec: LockRecord | null } | null => {
    let fd: number;
    try { fd = fs.openSync(at, "r"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      try { const st = fs.statSync(at); return { ino: st.ino, mtimeMs: st.mtimeMs, rec: null }; } catch { return null; }
    }
    try {
      const st = fs.fstatSync(fd);
      let rec: LockRecord | null = null;
      try { rec = asLockRecord(parseJson(fs.readFileSync(fd, "utf8"))); } catch { /* corrupt or being written */ }
      return { ino: st.ino, mtimeMs: st.mtimeMs, rec };
    } finally { fs.closeSync(fd); }
  };
  const sameLock = (a: { ino: number; rec: LockRecord | null } | null, b: { ino: number; rec: LockRecord | null }): boolean =>
    a !== null && a.ino === b.ino && (a.rec?.token ?? null) === (b.rec?.token ?? null);
  const writeAtomic = (rec: LockRecord): void => {
    const tmp = `${file}.${token}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
    fs.renameSync(tmp, file);
  };

  const judge = ({ mtimeMs, rec }: { mtimeMs: number; rec: LockRecord | null }): LockInspection => {
    if (!rec) {
      const young = now() - mtimeMs < 10_000;
      return { holder: null, state: young ? "alive" : "stale", why: young ? "lock is being written" : "lock file is corrupt" };
    }
    return { holder: rec, ...assessLock(rec, { host, now: now(), isAlive, startTimeOf, staleMs }) };
  };

  const lock: RunLock = {
    token,
    get held() { return held; },
    inspect() {
      const snap = snapshot(file);
      return snap ? judge(snap) : null;
    },
    acquire() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let tookOver: (Partial<LockRecord> & { why: string }) | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.writeFileSync(file, `${JSON.stringify(record(new Date(now()).toISOString()))}\n`, { flag: "wx" });
          held = true;
          return { acquired: true, ...(tookOver ? { tookOver } : {}) };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const snap = snapshot(file);
        if (!snap) continue; // vanished between the attempts
        const seen = judge(snap);
        if (seen.state !== "stale") return { acquired: false, reason: seen.state === "wedged" ? `run is owned by a wedged supervisor: ${seen.why}. Stop that process, then resume.` : `run is already being supervised (${seen.why})`, holder: seen.holder };
        // Only the taker holding the claim for this exact stale lock may move it aside.
        const claim = `${file}.takeover-${snap.rec?.token ?? "unreadable"}-${snap.ino}`;
        try { fs.writeFileSync(claim, `${token}\n`, { flag: "wx" }); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          try { if (Date.now() - fs.statSync(claim).mtimeMs > staleMs) fs.rmSync(claim, { force: true }); } catch { /* gone already */ }
          continue; // another taker is mid-takeover
        }
        const aside = `${file}.stale-${token}`;
        try {
          if (!sameLock(snapshot(file), snap)) continue; // replaced since it was judged
          try { fs.renameSync(file, aside); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
          if (!sameLock(snapshot(aside), snap)) {
            // A newer lock was moved by mistake: put it back without overwriting anything.
            try { fs.linkSync(aside, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
            continue;
          }
          tookOver = { ...(seen.holder ?? {}), why: seen.why };
        } finally {
          try { fs.rmSync(aside, { force: true }); } catch { /* best effort */ }
          try { fs.rmSync(claim, { force: true }); } catch { /* best effort */ }
        }
      }
      return { acquired: false, reason: "could not acquire the run lock (contention)" };
    },
    heartbeat() {
      const rec = read();
      if (rec?.token !== token) { held = false; return false; }
      writeAtomic({ ...rec, heartbeatAt: new Date(now()).toISOString() });
      return true;
    },
    start(onLost) {
      const interval = setInterval(() => { if (!lock.heartbeat()) { clearInterval(interval); timer = null; onLost?.(); } }, heartbeatMs);
      interval.unref();
      timer = interval;
    },
    release() {
      if (timer) { clearInterval(timer); timer = null; }
      const rec = read();
      if (rec?.token === token) fs.rmSync(file, { force: true });
      held = false;
    },
  };
  return lock;
}
