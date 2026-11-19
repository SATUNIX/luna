// Trusted acceptance evaluation: the supervisor runs the contract's checks against a commit it
// accepted, in clean, network-less gate containers, from definitions in the run directory
// (never from files in the worker's repository), and records evidence for each. Worker-authored
// tests and reports are inputs to review, never the sole authority.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../../core/lib/guard.ts";
import type { AcceptanceCheck } from "./contract.ts";
import { canonicalJson, sha256, writeJsonAtomic } from "./fsutil.ts";

/** One acceptance check of the resolved contract (owned by lib/contract.ts). */
export type { AcceptanceCheck };

/** What the runtime reports for one check (runCheck) or service probe (serviceHealth). */
export interface RawCheckOutcome {
  readonly exitCode?: number | null | undefined;
  readonly timedOut?: boolean | undefined;
  readonly seconds?: number | undefined;
  readonly tail?: string | undefined;
  readonly detail?: string | undefined;
  /** Per-step timings from the gate's result.json: written in the gate container, so unchecked. */
  readonly steps?: unknown;
  readonly ok?: boolean | undefined;
  readonly error?: boolean | undefined;
  /** The gate's log files kept for this check (absolute paths under the `logDir` it was given). */
  readonly logs?: readonly string[] | undefined;
}

/** The runtime calls acceptance makes (lib/runtime.ts, tests/fake-runtime.ts). */
export interface AcceptanceRuntime {
  now(): number;
  /** `logDir`: where to keep this check's full gate logs, which the next check's gate would wipe. */
  runCheck(o: { check: AcceptanceCheck; sha: string; logDir?: string | undefined }): Promise<RawCheckOutcome>;
  serviceHealth(o: { check: AcceptanceCheck }): Promise<RawCheckOutcome>;
}

export interface CheckStep {
  name: string;
  code: number;
  seconds: number;
}

/** One check's evidence file. */
export interface CheckResult {
  id: string;
  type: string;
  required: boolean;
  sha: string;
  step: number;
  pass: boolean;
  exitCode: number;
  timedOut: boolean;
  seconds: number;
  definitionDigest: string;
  tail: string;
  steps?: CheckStep[];
  /** The check's full gate logs, relative to the run directory (`steps/<n>/checks/<id>.logs/`). */
  logs?: string[];
  at: string;
}

/** A check result with its evidence file, relative to the run directory. */
export interface CheckEvidence extends CheckResult {
  evidence: string;
}

export interface AcceptanceEvaluation {
  sha: string;
  step: number;
  at: string;
  results: CheckEvidence[];
  allRequiredPass: boolean;
}

/** The compact evaluation kept in state.json. */
export interface EvaluationSummary {
  sha: string;
  step: number;
  at: string;
  allRequiredPass: boolean;
  results: Pick<CheckEvidence, "id" | "required" | "pass" | "exitCode" | "timedOut" | "seconds" | "evidence">[];
}

export interface RunAcceptanceOptions {
  rt: AcceptanceRuntime;
  contract: { readonly acceptance: { readonly checks: readonly AcceptanceCheck[] } };
  sha: string;
  step: number;
  /** Where evidence files go. */
  dir: string;
  /** The run directory, so evidence paths in state are relative to it. */
  runRoot?: string | undefined;
  log?: ((line: string) => void) | undefined;
  only?: readonly string[] | undefined;
}

/** The most a kept gate log may hold; a larger one keeps its last part, after a marker line. */
export const GATE_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** The most gate files kept per check. */
export const GATE_LOG_MAX_FILES = 16;
const GATE_LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:log|json)$/;

/**
 * Copy the gate's top-level log and result files out of its scratch directory (one shared directory,
 * wiped before every check) into `to`, so a later gate cannot destroy them. The gate container ran
 * the worker's code and wrote `from`, so only regular files with a plain name are taken (judged on
 * the open descriptor), a symlink is never followed (O_NOFOLLOW), and each copy is bounded. Returns the files written.
 */
export function keepGateLogs(from: string, to: string, maxBytes = GATE_LOG_MAX_BYTES): string[] {
  let names: string[];
  try { names = fs.readdirSync(from).filter((n) => GATE_LOG_NAME.test(n)).sort().slice(0, GATE_LOG_MAX_FILES); } catch { return []; }
  fs.rmSync(to, { recursive: true, force: true });
  const kept: string[] = [];
  for (const name of names) {
    // Open first, then judge the descriptor: a stat of the path before the open could describe a
    // different file than the one opened. O_NOFOLLOW refuses a link, O_NONBLOCK keeps a FIFO from
    // blocking the open, and fstat on the descriptor refuses anything but a regular file.
    let fd: number;
    try { fd = fs.openSync(path.join(from, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { continue; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) continue;
      const size = st.size;
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      const read = length > 0 ? fs.readSync(fd, buf, 0, length, size - length) : 0;
      const body = buf.subarray(0, read);
      fs.mkdirSync(to, { recursive: true });
      const dest = path.join(to, name);
      fs.writeFileSync(dest, size > maxBytes ? Buffer.concat([Buffer.from(`...[${size - length} bytes cut; the last ${length} kept]...\n`), body]) : body, { mode: 0o600 });
      kept.push(dest);
    } finally { fs.closeSync(fd); }
  }
  return kept;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max / 4)}\n...[${s.length - max} characters cut]...\n${s.slice(-(max * 3) / 4)}`);

/** Run every check for `sha` and write one evidence file per check. */
export async function runAcceptance({ rt, contract, sha, step, dir, runRoot, log = () => {}, only }: RunAcceptanceOptions): Promise<AcceptanceEvaluation> {
  fs.mkdirSync(dir, { recursive: true });
  const root = runRoot ?? path.dirname(path.dirname(path.dirname(dir)));
  const results: CheckEvidence[] = [];
  const checks = contract.acceptance.checks.filter((c) => !only || only.includes(c.id));
  // Command checks first (they judge the code), then service health (which judges the deployment).
  const ordered = [...checks.filter((c) => c.type !== "service-health"), ...checks.filter((c) => c.type === "service-health")];
  for (const check of ordered) {
    const started = rt.now();
    let raw: RawCheckOutcome;
    try {
      raw = check.type === "service-health" ? await rt.serviceHealth({ check }) : await rt.runCheck({ check, sha, logDir: path.join(dir, `${check.id}.logs`) });
    } catch (error) {
      raw = { exitCode: 125, timedOut: false, tail: `the check could not run: ${error instanceof Error ? error.message : String(error)}`, error: true };
    }
    const pass = check.type === "service-health" ? Boolean(raw.ok) : raw.exitCode === 0 && !raw.timedOut && !raw.error;
    const result: CheckResult = {
      id: check.id, type: check.type, required: check.required, sha, step, pass,
      exitCode: raw.exitCode ?? (pass ? 0 : 1), timedOut: Boolean(raw.timedOut),
      seconds: raw.seconds ?? Math.round((rt.now() - started) / 1000),
      definitionDigest: sha256(canonicalJson(check)),
      tail: clip(raw.tail ?? raw.detail ?? "", 4000),
      ...(Array.isArray(raw.steps) ? { steps: raw.steps.slice(0, 20).map((x: unknown) => stepOf(x)) } : {}),
      ...(raw.logs?.length ? { logs: raw.logs.map((f) => path.relative(root, f)) } : {}),
      at: new Date(rt.now()).toISOString(),
    };
    const file = path.join(dir, `${check.id}.json`);
    writeJsonAtomic(file, result);
    results.push({ ...result, evidence: path.relative(root, file) });
    log(`check ${check.id}: ${pass ? "PASS" : "FAIL"}${result.timedOut ? " (timed out)" : ""}`);
  }
  const allRequiredPass = contract.acceptance.checks.filter((c) => c.required).every((c) => results.find((r) => r.id === c.id)?.pass === true) && checks.length === contract.acceptance.checks.length;
  return { sha, step, at: new Date(rt.now()).toISOString(), results, allRequiredPass };
}

/** One gate step as recorded, from an unchecked result.json entry (same conversions as always). */
function stepOf(x: unknown): CheckStep {
  const step = isRecord(x) ? x : {};
  return { name: String(step["name"]).slice(0, 60), code: Number(step["code"]), seconds: Number(step["seconds"]) || 0 };
}

/** The compact form kept in state.json (the tail stays in the evidence file). */
export function summariseEvaluation(ev: AcceptanceEvaluation): EvaluationSummary {
  return { sha: ev.sha, step: ev.step, at: ev.at, allRequiredPass: ev.allRequiredPass, results: ev.results.map(({ id, required, pass, exitCode, timedOut, seconds, evidence }) => ({ id, required, pass, exitCode, timedOut, seconds, evidence })) };
}
