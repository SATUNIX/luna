// The post-mortem: one file, <run>/postmortem.json, that the supervisor writes whenever it records
// a failure (the run fails, or the supervisor stops on an error), so the cause can be read in one
// place instead of pieced together from state.json, the host event log and supervisor.log. Each
// failure replaces the previous file; the host event log keeps every failure event.
//
// Schema version 1:
//
//   v, run, at, code, detail     the failure (code is the failure reason, `supervisor_error` or
//                                `boundary_violation`, as in the `failure` host event)
//   status, template, step, phase, cycle (the self-improve or dispatch cycle, or null)
//   usage { usd, minutes, steps }, budgetUsd
//   worker                       the worker container this supervisor last started, or null
//   failingChecks                the required acceptance checks failing in the latest evaluation
//   lastError                    the last fatal error state.json recorded, or null
//   events                       this run's last 20 host events (lib/events.ts), oldest first
//   logTail                      the last 20 lines of supervisor.log
//
// Free text (detail, lastError, log lines) is made one visible line and passes through the kit's
// secret redaction, as host event text does. Writing is best effort: a post-mortem that cannot be
// written is logged and never changes what happens to the run. Pinned by
// tests/autonomy-lifecycle-smoke.ts.
import fs from "node:fs";
import { type HostEvent, readEvents, redactEventText } from "./events.ts";
import { writeJsonAtomic } from "./fsutil.ts";
import { redactSecrets } from "./notebook.ts";
import type { RunState } from "./lifecycle.ts";
import type { RunStore } from "./store.ts";

export const POSTMORTEM_SCHEMA_VERSION = 1;
export const POSTMORTEM_EVENTS = 20;
export const POSTMORTEM_LOG_LINES = 20;
/** The most read from the end of supervisor.log for its tail. */
const LOG_TAIL_BYTES = 64 * 1024;

export interface Postmortem {
  v: typeof POSTMORTEM_SCHEMA_VERSION;
  run: string;
  at: string;
  code: string;
  detail: string;
  status: string;
  template: string;
  step: number;
  phase: string | null;
  cycle: number | null;
  usage: { usd: number; minutes: number; steps: number };
  budgetUsd: number;
  worker: string | null;
  failingChecks: string[];
  lastError: string | null;
  events: HostEvent[];
  logTail: string[];
}

/** The last `lines` lines of a supervisor-written log, redacted; empty when it cannot be read. */
function logTail(file: string, lines: number): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return [];
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let text = buf.toString("utf8");
    if (len < st.size) text = text.slice(text.indexOf("\n") + 1); // the first line read may be cut
    // Redacted as one text before splitting, so a secret over several lines (a private key in a stack) is caught whole.
    const all = redactSecrets(text).text.split("\n").filter((l) => l.trim() !== "");
    return all.slice(-lines).map((l) => redactEventText(l));
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** This run's newest host events, oldest first; empty when the log cannot be read. */
function lastEvents(store: RunStore, limit: number): HostEvent[] {
  try { return readEvents(store.home, { run: store.run, limit }).events; } catch { return []; }
}

/** What the post-mortem of `state` failing with `code` says. */
export function buildPostmortem(store: RunStore, state: RunState, code: string, detail: string, at: string, lastWorker: string | null = null): Postmortem {
  const latest = state.acceptance.latest;
  return {
    v: POSTMORTEM_SCHEMA_VERSION,
    run: store.run,
    at,
    code,
    detail: redactEventText(detail),
    status: state.status,
    template: state.template,
    step: state.step,
    phase: state.phase,
    cycle: state.selfImprove?.current?.n ?? null,
    usage: { usd: state.usage.usd, minutes: state.usage.minutes, steps: state.usage.steps },
    budgetUsd: state.limits.budget.totalUsd,
    worker: state.worker?.container ?? lastWorker, // a failing run has usually stopped its worker (state.worker null) first
    failingChecks: latest ? latest.results.filter((r) => r.required && !r.pass).map((r) => r.id) : [],
    lastError: state.lastError ? redactEventText(state.lastError) : null,
    events: lastEvents(store, POSTMORTEM_EVENTS),
    logTail: logTail(store.p.log, POSTMORTEM_LOG_LINES),
  };
}

/** Write <run>/postmortem.json (mode 0600). Best effort: false, with a log line, when it cannot be written. */
export function writePostmortem(store: RunStore, state: RunState, code: string, detail: string, at: string, log: (line: string) => void, lastWorker: string | null = null): boolean {
  try {
    writeJsonAtomic(store.p.postmortem, buildPostmortem(store, state, code, detail, at, lastWorker), { mode: 0o600 });
    return true;
  } catch (e) {
    log(`post-mortem not written: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
