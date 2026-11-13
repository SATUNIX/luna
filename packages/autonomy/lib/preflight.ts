// Pre-flight: never start model work on a red base. The host runs the acceptance gate on the
// integration head a cycle would start from (unless that exact head already passed) and classifies
// a failure before anyone is paid to work on it:
//   infra          provider, network, registry, disk or container trouble: back off, do not rerun now
//   deterministic  the check cannot run here (command missing, permission): a person diagnoses it
//   product        the code fails its own checks: one host-built repair cycle, then a person
//   flake          a check the operator lists in templateOptions.knownFlakes failed once and passed
//                  on one confirmation run; the first failure is kept next to the confirmation
// A failure that is not a listed flake is never rerun until green: that is not acceptance.
// tests/autonomy-lean-smoke.ts pins every class.

import type { AcceptanceEvaluation } from "./acceptance.ts";

export type FailureClass = "infra" | "deterministic" | "flake-candidate" | "product";

export type BaseVerdict =
  | { verdict: "green" }
  | { verdict: "flake"; failing: string[] }
  | { verdict: "infra" | "deterministic" | "product"; failing: string[]; reason: string };

type Result = AcceptanceEvaluation["results"][number];

const INFRA = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|\bHTTP\/?[\d.]*\s+(?:429|50[234])\b|\bstatus(?: code)?[:= ]+(?:429|50[234])\b|\b(?:429|50[234])\s+(?:too many requests|bad gateway|service unavailable|gateway time-?out)|\b(?:api|registry|provider)\b.{0,20}rate.?limit|rate.?limit exceeded|too many requests|ENOSPC|no space left|network is unreachable|temporary failure in name resolution|cannot connect to the docker|could not run|toomanyrequests|registry.*(unavailable|timeout)/i;
/** Output that shows the code ran and failed its own assertions: a timeout alongside it is not host trouble. */
const PRODUCT_FAILURE = /AssertionError|\bFAIL\b|\bnot ok\b|\d+ (?:tests? )?failed|\bexpected\b.*\b(?:got|received|to)\b/i;
const DETERMINISTIC = /command not found|not found in \$?PATH|EACCES|permission denied|exec format error|executable file not found|ENOENT.*spawn/i;

/** The failing check names: `id` for a check without steps, `id/step` for each failed step. */
export function failingNames(results: readonly Result[]): string[] {
  return results.flatMap((r) => (r.pass ? [] : r.steps?.some((s) => s.code !== 0) ? r.steps.filter((s) => s.code !== 0).map((s) => `${r.id}/${s.name}`) : [r.id]));
}

/** Classify a red evaluation. `knownFlakes` are check ids or `id/step` names. */
export function classifyFailure(results: readonly Result[], knownFlakes: readonly string[] = []): FailureClass {
  const red = results.filter((r) => !r.pass);
  if (red.length === 0) return "product";
  if (red.every((r) => INFRA.test(r.tail) || (r.timedOut && !PRODUCT_FAILURE.test(r.tail)))) return "infra";
  if (red.every((r) => r.exitCode === 126 || r.exitCode === 127 || DETERMINISTIC.test(r.tail))) return "deterministic";
  const names = failingNames(results);
  if (names.length > 0 && names.every((name) => knownFlakes.some((k) => k === name || name.startsWith(`${k}/`)))) return "flake-candidate";
  return "product";
}

export interface PreflightRun {
  /** Run the gate; `label` names the evidence directory (first, confirm). */
  run: (label: "first" | "confirm") => Promise<AcceptanceEvaluation>;
  knownFlakes: readonly string[];
}

/** Gate the base once, classify a failure, and spend one confirmation run only on a listed flake. */
export async function preflight({ run, knownFlakes }: PreflightRun): Promise<BaseVerdict> {
  const first = await run("first");
  if (first.allRequiredPass) return { verdict: "green" };
  const failing = failingNames(first.results);
  const kind = classifyFailure(first.results, knownFlakes);
  if (kind === "flake-candidate") {
    const again = await run("confirm");
    return again.allRequiredPass ? { verdict: "flake", failing } : { verdict: "product", failing: failingNames(again.results), reason: `${failing.join(", ")} is a listed flake but failed again on the confirmation run` };
  }
  const reason = kind === "infra" ? "provider, network or host trouble (see the first run's evidence)" : kind === "deterministic" ? "a check cannot run in this environment (command missing or permission denied)" : "the base fails its own checks";
  return { verdict: kind, failing, reason };
}
