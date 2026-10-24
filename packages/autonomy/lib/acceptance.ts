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
}

/** The runtime calls acceptance makes (lib/runtime.ts, tests/fake-runtime.ts). */
export interface AcceptanceRuntime {
  now(): number;
  runCheck(o: { check: AcceptanceCheck; sha: string }): Promise<RawCheckOutcome>;
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

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max / 4)}\n...[${s.length - max} characters cut]...\n${s.slice(-(max * 3) / 4)}`);

/** Run every check for `sha` and write one evidence file per check. */
export async function runAcceptance({ rt, contract, sha, step, dir, runRoot, log = () => {}, only }: RunAcceptanceOptions): Promise<AcceptanceEvaluation> {
  fs.mkdirSync(dir, { recursive: true });
  const results: CheckEvidence[] = [];
  const checks = contract.acceptance.checks.filter((c) => !only || only.includes(c.id));
  // Command checks first (they judge the code), then service health (which judges the deployment).
  const ordered = [...checks.filter((c) => c.type !== "service-health"), ...checks.filter((c) => c.type === "service-health")];
  for (const check of ordered) {
    const started = rt.now();
    let raw: RawCheckOutcome;
    try {
      raw = check.type === "service-health" ? await rt.serviceHealth({ check }) : await rt.runCheck({ check, sha });
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
      at: new Date(rt.now()).toISOString(),
    };
    const file = path.join(dir, `${check.id}.json`);
    writeJsonAtomic(file, result);
    results.push({ ...result, evidence: path.relative(runRoot ?? path.dirname(path.dirname(path.dirname(dir))), file) });
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
