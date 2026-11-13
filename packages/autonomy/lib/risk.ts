// Risk tiers for the merge decision. The HOST classifies a cycle from the paths it actually
// changed (never from the worker's report), and the tier decides how much model review the
// cycle gets. One review is the ordinary price; tiers only move it up or down:
//
//   R0  prose and static files only (docs, images, this run's own records): no model review.
//       The acceptance gate (format, links, leak scan, docs checks) still has to be green.
//       Conservative: a path is R0 only when it matches a known prose shape, and an unknown
//       path is never R0. Starts fully reviewed: skipping the review is opt-in through
//       templateOptions.integration.r0Review (see r0Reviewed).
//   R1  ordinary code and configuration: one review.
//   R2  recovery, concurrency, persistence, shared-interface or authorisation paths: the same
//       one review, which must also answer one specialist question about those paths.
//   R3  permissions, budgets, credentials, the charter, gate policy and release machinery: not
//       merged by an unattended cycle. The owner/steward route (a proposal, then a person)
//       applies, exactly as for the control paths in lib/review.ts, unless the operator opted
//       in with allowControlChanges, in which case it gets the one ordinary review.
//
// A path the host cannot classify (empty, absolute, `..`, a control character) is R3, and a
// change with no paths to classify is R1: unknown escalates, it never relaxes.
// tests/autonomy-lean-smoke.ts pins each rule (a table of paths per tier).

import { createHash } from "node:crypto";
import { hasControlChar } from "./glob.ts";

export type RiskTier = "R0" | "R1" | "R2" | "R3";
/** What the specialist question of an R2 change is about. */
export type SpecialistTopic = "recovery" | "concurrency" | "persistence" | "interface" | "authorisation";

export interface RiskClassification {
  tier: RiskTier;
  /** One line per reason the tier is what it is, for the log, the receipt and the review input. */
  reasons: string[];
  /** The R3 paths (with why), when the tier is R3. */
  r3: string[];
  /** The R2 paths, and the topics the specialist question covers. */
  r2: string[];
  topics: SpecialistTopic[];
}

interface Rule { re: RegExp; why: string; topic?: SpecialistTopic }

// R3: authority, money, secrets, policy of the gate, release. Matched on the lower-cased path.
const R3_RULES: readonly Rule[] = [
  { re: /^autonomy\/charter\.md$/, why: "the charter" },
  { re: /^\.github\//, why: "repository, CI and release configuration" },
  { re: /(^|\/)(\.npmrc|\.yarnrc(\.ya?ml)?|bunfig\.toml|\.pnpmfile\.[cm]?js|pnpm-workspace\.yaml)$/, why: "package-manager configuration" },
  { re: /(^|\/)(gate\.sh|check-all[^/]*|prepush-scan[^/]*|wiring\.ts|check-map\.ts|leak-scan[^/]*|scan-suppressions\.json|\.semgrepignore|\.gitleaks\.toml|eslint\.config\.[a-z]+|tsconfig[^/]*\.json)$/, why: "gate policy" },
  { re: /^packages\/autonomy\/lib\/(boundary|contract|containment|egress-proxy|worker-env|runcfg|reconfigure|promotion)\.ts$|^packages\/autonomy\/(relay\.ts|image\/)/, why: "autonomy permissions, budgets or boundary" },
  { re: /^packages\/autonomy\/lib\/(risk|review|acceptance|attempts|triggers|manager|runtime|rpc|engine|board|hostrepo|templates\/[^/]+)\.ts$|^packages\/autonomy\/(cli|supervisor)\.ts$|^packages\/autonomy\/(seed|prompts)\//, why: "the merge gate, risk and attempt policy, run wiring, charter seed or worker instructions" },
  { re: /^packages\/extensions\/src\/(tool-firewall|security-level|approval)[^/]*\//, why: "permissions (tool firewall, security level)" },
  { re: /(^|\/)(credentials?|secrets?)[^/]*\.([cm]?[jt]s|json|sh)$|(^|\/)\.env(\.|$)/, why: "credentials" },
  { re: /^docs\/(releasing|security-standard|repository-topology)\.md$|^packages\/core\/(distribution|sources)\.json$|(^|\/)release[^/]*\.(ts|sh|json|ya?ml)$/, why: "release and distribution policy" },
];

// R2: the places where a plausible-looking change breaks recovery, ordering or stored data.
const R2_RULES: readonly Rule[] = [
  { re: /(^|\/)[^/]*(recover|resume|restart|retry|rollback|checkpoint)[^/]*\.([cm]?[jt]s|sh)$/, why: "recovery", topic: "recovery" },
  { re: /(^|\/)[^/]*(lock|lease|queue|slot|mutex|concurren|integrat|supervisor|engine|cycle|lifecycle)[^/]*\.([cm]?[jt]s|sh)$/, why: "concurrency and lifecycle", topic: "concurrency" },
  { re: /(^|\/)[^/]*(store|ledger|journal|state|persist|migrat|snapshot|meter|usage|fsutil|gitmirror|mirror)[^/]*\.([cm]?[jt]s|sh)$/, why: "persistence", topic: "persistence" },
  { re: /(^|\/)schema\/|\.schema\.json$|(^|\/)packages\/core\/lib\/[^/]+\.ts$|(^|\/)rpc\.ts$/, why: "shared interface", topic: "interface" },
  { re: /(^|\/)[^/]*(auth|approv|permission|firewall|security|sandbox|redact)[^/]*\.([cm]?[jt]s|sh|json)$/, why: "authorisation", topic: "authorisation" },
];

// A test file is ordinary code whatever it is named after: it checks the machinery, it is not the machinery.
const TESTS = /(^|\/)(tests?|__tests__)\//;

// R0: prose and static assets only. Agent-facing instructions are not prose here: they steer behaviour.
const PROSE = /\.(md|txt|rst|png|jpe?g|gif|svg|webp|ico)$/;
const AGENT_INSTRUCTIONS = /(^|\/)(agents|claude|skill)\.md$|(^|\/)(prompts|skills|agents|workflows|seed)\//;

/** Why a path cannot be classified, or null. */
function unclassifiable(file: string): string | null {
  if (!file) return "an empty path";
  if (file.startsWith("/") || /^[a-z]:/i.test(file)) return `${JSON.stringify(file.slice(0, 80))} is absolute`;
  if (file.split("/").includes("..")) return `${JSON.stringify(file.slice(0, 80))} climbs out of the repository`;
  if (hasControlChar(file) || file.length > 1024) return "a path with control characters or over 1024 characters";
  return null;
}

/** True when a changed path is an R0 shape: a prose or static file in docs/, a top-level document, or one of this run's records. */
function isProse(lower: string, records: (file: string) => boolean, original: string): boolean {
  if (records(original)) return true;
  if (AGENT_INSTRUCTIONS.test(lower) || !PROSE.test(lower)) return false;
  return lower.startsWith("docs/") || !lower.includes("/");
}

export interface RiskInput {
  files: readonly string[];
  /** True for a record-shaped file under this run's own record directories (review.ts isReviewRecord). */
  isRecord?: ((file: string) => boolean) | undefined;
  /** Operator-listed control paths that are R3 as well (a regular expression per glob, from lib/glob.ts). */
  controlPaths?: readonly RegExp[] | undefined;
}

/** Classify a cycle from its changed paths. Pure: the same paths always give the same tier. */
export function classifyRisk({ files, isRecord = () => false, controlPaths = [] }: RiskInput): RiskClassification {
  const r3: string[] = [];
  const r2: string[] = [];
  const topics = new Set<SpecialistTopic>();
  const unknown: string[] = [];
  let nonProse = 0;
  for (const file of files) {
    const bad = unclassifiable(file);
    if (bad) { r3.push(`${bad} (unclassifiable)`); continue; }
    const lower = file.toLowerCase();
    const r3hit = R3_RULES.find((r) => r.re.test(lower));
    if (r3hit) { r3.push(`${file} (${r3hit.why})`); continue; }
    if (controlPaths.some((re) => re.test(file))) { r3.push(`${file} (operator control path)`); continue; }
    const r2hit = TESTS.test(lower) ? undefined : R2_RULES.find((r) => r.re.test(lower));
    if (r2hit && !isProse(lower, isRecord, file)) {
      r2.push(`${file} (${r2hit.why})`);
      if (r2hit.topic) topics.add(r2hit.topic);
      continue;
    }
    if (!isProse(lower, isRecord, file)) { nonProse++; unknown.push(file); }
  }
  if (r3.length) return { tier: "R3", reasons: r3.slice(0, 10), r3: r3.slice(0, 10), r2: r2.slice(0, 10), topics: [...topics] };
  if (r2.length) return { tier: "R2", reasons: r2.slice(0, 10), r3: [], r2: r2.slice(0, 10), topics: [...topics] };
  if (files.length === 0) return { tier: "R1", reasons: ["no changed paths to classify: not treated as prose"], r3: [], r2: [], topics: [] };
  if (nonProse > 0) return { tier: "R1", reasons: [`ordinary code or configuration (${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? ", ..." : ""})`], r3: [], r2: [], topics: [] };
  return { tier: "R0", reasons: ["prose and static files only"], r3: [], r2: [], topics: [] };
}

/**
 * Whether an R0 cycle still gets the model review. `rate` is templateOptions.integration.r0Review:
 * 1 (the default) reviews every R0 cycle, 0 none, and a value between reviews that share of
 * them, chosen from the cycle head so the same head always gets the same answer.
 */
export function r0Reviewed(rate: number, head: string): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket = createHash("sha256").update(head).digest().readUInt32BE(0) / 0x1_0000_0000;
  return bucket < rate;
}

/** The one question an R2 review answers about the topics its paths touch. */
export function specialistQuestion(topics: readonly SpecialistTopic[]): string {
  const ask: Record<SpecialistTopic, string> = {
    recovery: "after a crash or restart at any point in the changed code, does the run resume or fail safe without losing or duplicating work",
    concurrency: "can two actors (a second cycle, a restart, a concurrent writer) interleave here and break an ordering, a lock or a single-writer rule",
    persistence: "can stored state written by the old code still be read, and can a partial write or a restart leave it inconsistent",
    interface: "does every consumer of the changed shared interface or schema still work, including older data and callers",
    authorisation: "does the change widen what any actor may do or see, or remove a check that gated an action",
  };
  const chosen = topics.length ? topics : (["recovery", "concurrency", "persistence", "interface", "authorisation"] as const);
  return `Specialist question for the changed recovery, concurrency, persistence, shared-interface or authorisation paths: ${chosen.map((t) => ask[t]).join("; and ")}?`;
}
