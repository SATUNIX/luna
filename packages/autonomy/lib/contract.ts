// The versioned run contract (schemaVersion 1): one declarative document that says what a run
// is for, what it may touch and when it is finished. Hand-written validation (no dependencies)
// so the supervisor can run on plain Node; schema/run-contract.schema.json documents the same
// shape for other tools and tests/autonomy-contract-smoke.ts checks that the two agree.
//
// resolveContract(raw, opts) -> { ok, contract, problems, legacy }
//   - problems: [{ level: "error" | "warning", path, message }]
//   - ok: no errors. `contract` is the fully resolved document (defaults filled, spec inlined,
//     effort snapshotted as canonical tier ids) even when there are errors, for display only.
//
// Fail-closed rules (docs/autonomy.md, "The run contract"):
//   - unknown top-level keys are errors;
//   - unknown or malformed keys under permissions, generations, promotion, authorisation are errors;
//   - unknown keys elsewhere are warnings;
//   - anything absent defaults to the closed choice (no egress, no services, no unattended
//     approval, no promotion), never to a wider one;
//   - credential values never appear in a contract: names only, and credential-shaped strings
//     are rejected wherever they occur.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, clone, deepMerge, isPlainObject, sha256 } from "./fsutil.ts";
import { globProblem, hasControlChar } from "./glob.ts";
import { FORBIDDEN_SOURCES, isPositiveCpus, isPositiveSize } from "./containment.ts";
import { EFFORT_UNAVAILABLE, type EffortApi, effortApi } from "./effort.ts";
import { TEMPLATES, templateIds } from "./templates/index.ts";
import { isPublicIpLiteral, isIpLiteral, canonicalIp, classifyAddress, normaliseHost } from "./netaddr.ts";

export const SCHEMA_VERSION = 1;

export const TOP_LEVEL_KEYS = ["schemaVersion", "run", "template", "objective", "inputs", "acceptance", "permissions", "model", "providerSettings", "effort", "budget", "recovery", "generations", "promotion", "runtime", "templateOptions", "authorisation"];

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const CHECK_ID = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const RESERVED_HOSTNAMES = new Set(["inference", "egress-proxy", "relay", "localhost", "worker", "agent", "supervisor", "gate"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CRED_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// Well-known credentials of services that are not inference providers (see providerSettings.apiKeyEnv).
const NON_INFERENCE_KEY = /^(?:GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITLAB_TOKEN|GL_TOKEN|CI_JOB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|PYPI_TOKEN|TWINE_PASSWORD|AWS_[A-Z0-9_]+|AZURE_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|DOCKER_[A-Z0-9_]*(?:PASSWORD|TOKEN)|KUBECONFIG|SSH_[A-Z0-9_]+|GPG_[A-Z0-9_]+|SLACK_[A-Z0-9_]+|STRIPE_[A-Z0-9_]+)$/;
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,120}$/;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const REFERENCE_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const IMAGE_REF = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** A zero or negative --memory/--cpus: both container engines read 0 as "no limit" (containment.ts limitProblems). */
const ZERO_LIMIT = "must be above zero: the container engines read 0 as no limit";
const HEX64 = /^[a-f0-9]{64}$/;

// Branch names a run may never treat as its integration or promotion target: they are the
// places a person merges to, and a run must not be able to move them.
const PROTECTED_BRANCHES = new Set(["main", "master", "head", "trunk", "develop", "development", "production", "prod", "stable"]);
const isProtectedBranch = (b: string): boolean => PROTECTED_BRANCHES.has(b.toLowerCase()) || /^(release|releases|hotfix)(\/|$)/i.test(b) || /^refs\//.test(b);

export const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bsk-or-[A-Za-z0-9_-]{10,}/, /\bglpat-[A-Za-z0-9_-]{10,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // scheme://user:password@host
];

export const DEFAULT_RUNTIME: Readonly<RuntimeSettings> = {
  engine: "podman",
  image: "pi-autonomy:local",
  memory: "6g",
  cpus: "4",
  pids: 1024,
  tmpSize: "4g",
  user: "host",
  mirrorSeconds: 30,
  gitIdentity: { name: "pi autonomy", email: "pi-autonomy@localhost" },
};

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

/** What a provider id implies: its upstream, the key variable and pi login it uses, and whether it reports cost. */
export interface ProviderPreset {
  upstream: string | null;
  apiKeyEnv: string | null;
  authName: string | null;
  reportsCost: boolean;
}

const PROVIDERS = {
  openrouter: { upstream: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", authName: "openrouter", reportsCost: true },
  "openai-compatible": { upstream: null, apiKeyEnv: null, authName: null, reportsCost: false },
} as const satisfies Record<string, ProviderPreset>;
export const providerIds = (): string[] => Object.keys(PROVIDERS);
const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && Object.hasOwn(PROVIDERS, v);
const isTemplateId = (v: unknown): v is TemplateId => typeof v === "string" && Object.hasOwn(TEMPLATES, v);

export function urlProblem(value: unknown, { allowed = ["https", "ssh"] }: { allowed?: readonly string[] } = {}): string | null {
  if (typeof value !== "string" || !value.trim()) return "must be a non-empty string";
  if (value.length > 500) return "is longer than 500 characters";
  if (/\s/.test(value) || hasControlChar(value)) return "must not contain whitespace or control characters";
  if (value.startsWith("-")) return 'must not start with "-"';
  if (/^(ext|fd)::/i.test(value) || /^file:/i.test(value)) return "uses an unsupported transport";
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (m) {
    const scheme = (m[1] ?? "").toLowerCase();
    if (!allowed.includes(scheme)) return `must use ${allowed.join(" or ")}`;
    let url;
    try { url = new URL(value); } catch { return "is not a valid URL"; }
    if (url.password || (scheme === "https" && url.username)) return "must not embed credentials";
    if (!url.hostname) return "has no host";
    return null;
  }
  if (allowed.includes("ssh") && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return null;
  return `must be a ${allowed.join(" or ")} URL${allowed.includes("ssh") ? " (or user@host:path)" : ""}`;
}

const isUrlLike = (v: unknown): boolean => typeof v === "string" && (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(v));

function pathProblem(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return "must be a non-empty string";
  if (hasControlChar(p)) return "must not contain control characters";
  if (p.startsWith("-")) return 'must not start with "-"';
  return null;
}

function relativePathProblem(p: unknown): string | null {
  const base = pathProblem(p);
  if (base) return base;
  const s = String(p);
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s)) return "must be relative to the workspace";
  if (s.split(/[\\/]/).includes("..")) return 'must not contain ".." segments';
  return null;
}

interface Collector extends ProblemSink {
  problems: Problem[];
}

/** Builds the problem list and small typed readers around it. */
function collector(): Collector {
  const problems: Problem[] = [];
  return {
    problems,
    err: (p, message) => { problems.push({ level: "error", path: p, message }); },
    warn: (p, message) => { problems.push({ level: "warning", path: p, message }); },
  };
}

function scanSecrets(value: unknown, where: string, c: ProblemSink): void {
  if (typeof value === "string") {
    if (SECRET_PATTERNS.some((re) => re.test(value))) c.err(where, "looks like a credential; contracts carry credential NAMES only (permissions.credentials.names), never values");
  } else if (Array.isArray(value)) (value as unknown[]).forEach((v, i) => { scanSecrets(v, `${where}[${i}]`, c); });
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) scanSecrets(v, `${where}.${k}`, c);
}

function checkKeys(obj: Record<string, unknown>, where: string, allowed: readonly string[], { strict }: { strict: boolean }, c: ProblemSink): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    if (strict) c.err(`${where}.${key}`, `unknown key (safety-critical sections reject unknown keys so nothing can be widened silently); allowed: ${allowed.join(", ")}`);
    else c.warn(`${where}.${key}`, "unknown key ignored");
  }
}

function asObject(v: unknown, where: string, c: ProblemSink): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) { c.err(where, "must be an object"); return {}; }
  return v;
}

interface NumOptions { min?: number; max?: number; int?: boolean }

function num(v: unknown, where: string, c: ProblemSink, opts: NumOptions & { def: number }): number;
function num(v: unknown, where: string, c: ProblemSink, opts?: NumOptions & { def?: number | undefined }): number | undefined;
function num(v: unknown, where: string, c: ProblemSink, { min = -Infinity, max = Infinity, int = false, def }: NumOptions & { def?: number | undefined } = {}): number | undefined {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) { c.err(where, "must be a number"); return def; }
  if (int && !Number.isInteger(v)) { c.err(where, "must be an integer"); return def; }
  if (v < min || v > max) { c.err(where, `must be between ${min} and ${max}`); return def; }
  return v;
}

interface StrOptions { re?: RegExp; max?: number; what?: string }

function str(v: unknown, where: string, c: ProblemSink, opts: StrOptions & { def: string }): string;
function str(v: unknown, where: string, c: ProblemSink, opts?: StrOptions & { def?: string | undefined }): string | undefined;
function str(v: unknown, where: string, c: ProblemSink, { re, def, max = 500, what }: StrOptions & { def?: string | undefined } = {}): string | undefined {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || !v.trim()) { c.err(where, "must be a non-empty string"); return def; }
  if (v.length > max) { c.err(where, `is longer than ${max} characters`); return def; }
  if (re && !re.test(v)) { c.err(where, what ?? `does not match ${String(re)}`); return def; }
  return v;
}

function bool(v: unknown, where: string, c: ProblemSink, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") { c.err(where, "must be true or false"); return def; }
  return v;
}

function arr(v: unknown, where: string, c: ProblemSink, { max = 200 }: { max?: number } = {}): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { c.err(where, "must be an array"); return []; }
  const list = v as unknown[];
  if (list.length > max) { c.err(where, `has more than ${max} entries`); return list.slice(0, max); }
  return list;
}

/** String(v), for unvalidated JSON input quoted in a problem or kept for display. */
function asText(v: unknown): string {
  switch (typeof v) {
    case "string": return v;
    case "number": case "boolean": case "bigint": return String(v);
    case "symbol": return v.toString();
    case "undefined": return "undefined";
    case "function": return "function";
    case "object": return v === null ? "null" : Array.isArray(v) ? (v as unknown[]).map((x) => (x === null || x === undefined ? "" : asText(x))).join(",") : "[object Object]";
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && (v as unknown[]).every((a) => typeof a === "string");

const argvOrShell = (run: unknown, where: string, c: ProblemSink): CheckCommand | unknown[] => {
  if (typeof run === "string") {
    if (!run.trim()) c.err(where, "must not be empty");
    else if (run.length > 4000) c.err(where, "is longer than 4000 characters");
    return run;
  }
  if (isStringArray(run) && run.length && run.length <= 100 && run.every((a) => a.length <= 4000 && !a.includes("\0"))) return run;
  c.err(where, "must be a non-empty argv array of strings, or a shell command string");
  // Kept for display only (the contract has an error): the input as it was, or its string form.
  return Array.isArray(run) ? (run as unknown[]) : asText(run ?? "");
};

// --- the resolved contract ---------------------------------------------------------------------
//
// RunContract is a contract that resolved without errors. A resolution with errors still returns
// the document for display (ContractDraft): the same shape, except that a value which failed its
// check may be missing (undefined) or, where the input is passed through unchecked, unknown.
// Every RunContract is a ContractDraft, so code that only displays a contract takes the draft.

/** One validator finding. An empty path means the contract as a whole. */
export interface Problem {
  level: "error" | "warning";
  path: string;
  message: string;
}

/** How templates report findings while validating (lib/templates/*.ts `validate`). */
export interface ProblemSink {
  err: (path: string, message: string) => void;
  warn: (path: string, message: string) => void;
}

export type TemplateId = keyof typeof TEMPLATES;
export type ProviderId = keyof typeof PROVIDERS;

export interface BacklogItem {
  id: string;
  title: string;
  detail?: string;
  /** Check ids that must pass for the item to be done. */
  acceptance?: string[];
}

export interface Objective {
  title: string;
  spec: string;
  specFile?: string;
  specSha256?: string;
  backlog: BacklogItem[];
}

/** The repository a run works on: a local path or a URL (exactly one), and the ref to start from. */
export interface RepositoryInput {
  path?: string;
  url?: string;
  ref: string;
}

export interface Inputs {
  repository: RepositoryInput | null;
  /** Read-only reference repositories by name: absolute paths or URLs. */
  references: Record<string, string>;
}

/** An argv array, or a shell command string. */
export type CheckCommand = string | string[];

interface CheckCommon {
  id: string;
  required: boolean;
  timeoutMinutes: number;
  description?: string;
}

export interface CommandCheck extends CheckCommon {
  type: "command";
  run: CheckCommand;
  cwd?: string;
  service?: never;
  path?: never;
  expectStatus?: never;
}

export interface ServiceHealthCheck extends CheckCommon {
  type: "service-health";
  service: string;
  path: string;
  expectStatus: number;
  run?: never;
  cwd?: never;
}

export type AcceptanceCheck = CommandCheck | ServiceHealthCheck;
export type CheckType = AcceptanceCheck["type"];

/** A check as resolved when the contract has errors: `type` is whatever the input said. */
export interface DraftCheck extends CheckCommon {
  type: unknown;
  /** Unchecked input when the check has an error. */
  run?: CheckCommand | unknown[];
  cwd?: string;
  service?: string | undefined;
  path?: string;
  expectStatus?: number;
}

/** A held-out file copied into the run directory; sha256 is recorded when the run is created. */
export interface OverlayEntry {
  source: string;
  target: string;
  sha256?: string;
}

export interface Acceptance<C = AcceptanceCheck> {
  checks: C[];
  overlay: OverlayEntry[];
  review: boolean;
}

export interface EgressRule {
  host: string;
  ports: number[];
  plainGet: boolean;
}

interface HealthTiming {
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
}

/** A service's health check: an HTTP path or a command run inside the service container. */
export type ServiceHealth = HealthTiming & ({ path: string; expectStatus: number; cmd?: never } | { cmd: string[]; path?: never; expectStatus?: never });

export interface DraftServiceHealth extends HealthTiming {
  path?: string | undefined;
  expectStatus?: number;
  cmd?: string[];
}

interface ServiceCommon {
  name: string;
  image: string;
  env: Record<string, string>;
  /** Container variable -> credential NAME (permissions.credentials.names). */
  credentialEnv: Record<string, string>;
  workspaceMounts: Array<{ source: string; target: string }>;
  command?: string[];
  restartOnDeploy: boolean;
  tmpfs: string[];
  user?: string;
  memory?: string;
  cpus?: string;
}

/** A run service the supervisor starts (deploy template). */
export interface ServiceSpec extends ServiceCommon {
  port: number;
  health: ServiceHealth;
}

export interface DraftServiceSpec extends ServiceCommon {
  port: number | undefined;
  health: DraftServiceHealth;
}

export interface ExportDestination {
  kind: "export-dir";
  path: string;
}

export interface UnattendedSettings {
  authorised: boolean;
  autoApprove: boolean;
}

export interface Permissions<S = ServiceSpec> {
  writeAreas: string[];
  network: { egress: EgressRule[]; services: S[]; serviceImages: string[] };
  credentials: { names: string[] };
  outputs: { destinations: ExportDestination[] };
  unattended: UnattendedSettings;
}

export interface ModelSettings<P = ProviderId> {
  provider: P;
  worker: string;
  manager: string;
  review: string;
  extra: string[];
}

/** USD per million tokens, for a provider that does not report cost. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface ProviderSettings<H = never> {
  upstream: string | H;
  apiKeyEnv: string | H;
  /** A pi login (auth.json entry) used for the provider's own service; absent (or undefined) when none. */
  authName?: string | undefined;
  headers: Record<string, string>;
  pricing: Record<string, ModelPricing>;
}

/** Effort tier ids (core's canonical ids), the requested tier and its cap. */
export interface EffortChoice {
  tier: string;
  cap: string;
}

export interface Budget<H = never> {
  totalUsd: number | H;
  perStepUsd: number | H;
  maxSteps: number | H;
  maxMinutes: number | H;
}

export interface RecoverySettings {
  softNudges: number;
  hardRestarts: number;
  maxAttemptsPerStep: number;
}

/**
 * Generations ("Memento mode"): the worker works in time-boxed generations and each hands a
 * notebook to a fresh worker (engine.ts, notebook.ts). Off unless `enabled` is true.
 */
export interface GenerationSettings {
  enabled: boolean;
  /** A generation ends after this many active minutes. */
  iterationMinutes: number;
  /** ...or once it has spent this much (USD); null: minutes only. */
  iterationUsd: number | null;
  /** Generations in all; the last one is not time-boxed. */
  maxGenerations: number;
  /** How long the worker has to write its notebook once its box ends. */
  graceMinutes: number;
  /** A generation without progress hands the next one the accepted head, not its leftovers. */
  resetOnNoProgress: boolean;
  /** The cap on one notebook, in characters of its JSON form. */
  notebookMaxChars: number;
}

export const GENERATION_LIMITS = { minMinutes: 5, maxMinutes: 240, maxGenerations: 8, minNotebookChars: 1000, maxNotebookChars: 6000 } as const;

export const PROMOTION_POLICIES = ["none", "local-branch", "push"] as const;
export type PromotionPolicy = (typeof PROMOTION_POLICIES)[number];

export interface LocalBranchDestination {
  kind: "local-branch";
  repo?: string;
  branch: string;
}

export interface GitRemoteDestination<H = never, U = never> {
  kind: "git-remote";
  url: string | U;
  tags: boolean;
  branch: string | H;
}

export type PromotionDestination = LocalBranchDestination | GitRemoteDestination;

export interface Promotion {
  policy: PromotionPolicy;
  destinations: PromotionDestination[];
  requiresOperatorApproval: boolean;
}

export interface DraftPromotion {
  policy: unknown;
  destinations: Array<LocalBranchDestination | GitRemoteDestination<undefined, unknown>>;
  requiresOperatorApproval: boolean;
}

export interface RuntimeSettings {
  engine: "podman" | "docker";
  image: string;
  memory: string;
  cpus: string;
  pids: number;
  tmpSize: string;
  /** "host" (the operator's uid:gid) or "uid:gid". */
  user: string;
  mirrorSeconds: number;
  gitIdentity: { name: string; email: string };
}

/** The operator's authorisation of a boundary, as written into the contract by `plan --authorise`. */
export interface ContractAuthorisation<H = never> {
  boundaryDigest: string | H;
  by: string | H;
  at: string | H;
}

/** A contract that resolved without errors (and contract.json of a run). */
export interface RunContract {
  schemaVersion: typeof SCHEMA_VERSION;
  run: string;
  template: TemplateId;
  objective: Objective;
  inputs: Inputs;
  acceptance: Acceptance;
  permissions: Permissions;
  model: ModelSettings;
  providerSettings: ProviderSettings;
  effort: EffortChoice;
  budget: Budget;
  recovery: RecoverySettings;
  /** Absent only in a contract.json written before generations existed (read as disabled). */
  generations?: GenerationSettings | undefined;
  promotion: Promotion;
  runtime: RuntimeSettings;
  templateOptions: Record<string, unknown>;
  authorisation: ContractAuthorisation | null;
}

/** A resolved contract that may have errors: for display (plan, boundary) only. */
export interface ContractDraft {
  schemaVersion: typeof SCHEMA_VERSION;
  run: string;
  template: unknown;
  objective: Objective;
  inputs: Inputs;
  acceptance: Acceptance<DraftCheck>;
  permissions: Permissions<DraftServiceSpec>;
  model: ModelSettings<string>;
  providerSettings: ProviderSettings<undefined>;
  effort: EffortChoice;
  budget: Budget<undefined>;
  recovery: RecoverySettings;
  generations?: GenerationSettings | undefined;
  promotion: DraftPromotion;
  runtime: RuntimeSettings;
  templateOptions: Record<string, unknown>;
  authorisation: ContractAuthorisation<undefined> | null;
}

export interface ResolveOptions {
  /** Directory relative paths (specFile, repository, references, overlay sources) resolve against. */
  baseDir?: string;
  /** The effort API (tests inject one); core's when absent. */
  effort?: EffortApi | null | undefined;
  /** Check that the referenced paths exist. */
  checkFs?: boolean;
}

/** resolveContract's result: `contract` is a RunContract only when there are no errors. */
export type Resolution =
  | { ok: true; contract: RunContract; problems: Problem[]; legacy: boolean }
  | { ok: false; contract: ContractDraft | null; problems: Problem[]; legacy: boolean };

/** An unvalidated contract document (parsed JSON, or legacyToRaw's mapping of a v0 file). */
export type RawContract = Record<string, unknown>;

// --- sections ---------------------------------------------------------------------------------

function readObjective(raw: unknown, opts: ResolveOptions, c: ProblemSink): Objective {
  const o = asObject(raw, "objective", c);
  checkKeys(o, "objective", ["title", "spec", "specFile", "backlog"], { strict: false }, c);
  const out: Omit<Objective, "backlog"> = { title: str(o.title, "objective.title", c, { max: 200 }) ?? "", spec: "" };
  if (!out.title) c.err("objective.title", "is required");
  if (o.spec !== undefined && o.specFile !== undefined) c.err("objective", "give spec (inline text) or specFile, not both");
  if (typeof o.spec === "string") {
    if (o.spec.length > 200_000) c.err("objective.spec", "is longer than 200000 characters");
    out.spec = o.spec;
  } else if (o.spec !== undefined) c.err("objective.spec", "must be a string");
  if (o.specFile !== undefined) {
    const problem = relativePathProblem(o.specFile);
    if (problem || typeof o.specFile !== "string") c.err("objective.specFile", problem ?? "must be a non-empty string");
    else {
      out.specFile = o.specFile;
      if (opts.baseDir) {
        const file = path.resolve(opts.baseDir, o.specFile);
        try {
          out.spec = fs.readFileSync(file, "utf8");
          if (out.spec.length > 200_000) c.err("objective.specFile", "is longer than 200000 characters");
          out.specSha256 = sha256(out.spec);
        } catch (e) { c.err("objective.specFile", `cannot read ${file}: ${errorCode(e)}`); }
      }
    }
  }
  const backlog: BacklogItem[] = [];
  const seen = new Set<string>();
  for (const [i, item] of arr(o.backlog, "objective.backlog", c, { max: 200 }).entries()) {
    const where = `objective.backlog[${i}]`;
    if (!isPlainObject(item)) { c.err(where, "must be an object"); continue; }
    checkKeys(item, where, ["id", "title", "detail", "acceptance"], { strict: false }, c);
    const id = str(item.id, `${where}.id`, c, { re: ITEM_ID, what: "must be 1-41 characters of letters, digits, . _ -" });
    if (id && seen.has(id)) c.err(`${where}.id`, `duplicate backlog id "${id}"`);
    if (id) seen.add(id);
    const entry: BacklogItem = { id: id ?? "", title: str(item.title, `${where}.title`, c, { max: 300 }) ?? "" };
    if (!entry.title) c.err(`${where}.title`, "is required");
    if (item.detail !== undefined) {
      const detail = str(item.detail, `${where}.detail`, c, { max: 20_000 });
      if (detail !== undefined) entry.detail = detail;
    }
    if (item.acceptance !== undefined) {
      entry.acceptance = arr(item.acceptance, `${where}.acceptance`, c, { max: 50 }).filter((a, j): a is string => typeof a === "string" || (c.err(`${where}.acceptance[${j}]`, "must be a check id"), false));
    }
    backlog.push(entry);
  }
  return { ...out, backlog };
}

/** An fs error's code, else its message (for "cannot read" problems). */
function errorCode(e: unknown): string {
  if (e instanceof Error) return (e as NodeJS.ErrnoException).code ?? e.message;
  return String(e);
}

function readRepository(raw: unknown, where: string, c: ProblemSink, opts: ResolveOptions): RepositoryInput | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) { c.err(where, "must be an object or null"); return null; }
  checkKeys(raw, where, ["path", "url", "ref"], { strict: false }, c);
  if ((raw.path === undefined) === (raw.url === undefined)) { c.err(where, "give exactly one of path (a local repository) or url"); return null; }
  const location: { path?: string; url?: string } = {};
  if (raw.path !== undefined) {
    const problem = pathProblem(raw.path);
    if (problem || typeof raw.path !== "string") c.err(`${where}.path`, problem ?? "must be a non-empty string");
    else location.path = opts.baseDir && !path.isAbsolute(raw.path) ? path.resolve(opts.baseDir, raw.path) : raw.path;
  } else {
    const problem = urlProblem(raw.url);
    if (problem || typeof raw.url !== "string") c.err(`${where}.url`, problem ?? "must be a non-empty string");
    else location.url = raw.url;
  }
  const out: RepositoryInput = { ...location, ref: str(raw.ref, `${where}.ref`, c, { re: REF_NAME, def: "HEAD", what: "must be a branch, tag or HEAD (letters, digits, . _ - /)" }) };
  if (out.ref && (out.ref.includes("..") || out.ref.endsWith("/") || out.ref.endsWith(".lock"))) c.err(`${where}.ref`, "is not a valid ref name");
  return out;
}

function readInputs(raw: unknown, c: ProblemSink, opts: ResolveOptions): Inputs {
  const o = asObject(raw, "inputs", c);
  checkKeys(o, "inputs", ["repository", "references"], { strict: false }, c);
  const out: Inputs = { repository: readRepository(o.repository, "inputs.repository", c, opts), references: {} };
  const refs = asObject(o.references, "inputs.references", c);
  for (const [name, src] of Object.entries(refs)) {
    if (!REFERENCE_NAME.test(name)) { c.err(`inputs.references.${name}`, "bad reference name (lowercase letters, digits, . _ -)"); continue; }
    const problem = pathProblem(src);
    if (problem || typeof src !== "string") c.err(`inputs.references.${name}`, problem ?? "must be a non-empty string");
    else out.references[name] = opts.baseDir && !path.isAbsolute(src) && !isUrlLike(src) ? path.resolve(opts.baseDir, src) : src;
  }
  return out;
}

function readAcceptance(raw: unknown, c: ProblemSink, opts: ResolveOptions, _template: unknown): Acceptance<DraftCheck> {
  const o = asObject(raw, "acceptance", c);
  checkKeys(o, "acceptance", ["checks", "overlay", "review"], { strict: false }, c);
  const out: Acceptance<DraftCheck> = { checks: [], overlay: [], review: bool(o.review, "acceptance.review", c, true) };
  const seen = new Set<string>();
  for (const [i, check] of arr(o.checks, "acceptance.checks", c, { max: 100 }).entries()) {
    const where = `acceptance.checks[${i}]`;
    if (!isPlainObject(check)) { c.err(where, "must be an object"); continue; }
    checkKeys(check, where, ["id", "type", "run", "cwd", "timeoutMinutes", "required", "description", "service", "path", "expectStatus"], { strict: false }, c);
    const id = str(check.id, `${where}.id`, c, { re: CHECK_ID, what: "must be 1-41 characters: lowercase letters, digits, . _ -" }) ?? "";
    if (id && seen.has(id)) c.err(`${where}.id`, `duplicate check id "${id}"`);
    seen.add(id);
    const type = check.type ?? "command";
    if (type !== "command" && type !== "service-health") c.err(`${where}.type`, 'must be "command" or "service-health"');
    const entry: DraftCheck = { id, type, required: bool(check.required, `${where}.required`, c, true), timeoutMinutes: num(check.timeoutMinutes, `${where}.timeoutMinutes`, c, { min: 1, max: 240, int: true, def: 15 }) };
    if (check.description !== undefined) {
      const description = str(check.description, `${where}.description`, c, { max: 500 });
      if (description !== undefined) entry.description = description;
    }
    if (type === "command") {
      if (check.run === undefined) c.err(`${where}.run`, "is required for a command check");
      else entry.run = argvOrShell(check.run, `${where}.run`, c);
      if (check.cwd !== undefined) {
        const problem = relativePathProblem(check.cwd);
        if (problem || typeof check.cwd !== "string") c.err(`${where}.cwd`, problem ?? "must be a non-empty string"); else entry.cwd = check.cwd;
      }
    } else {
      entry.service = str(check.service, `${where}.service`, c, { re: SERVICE_NAME, what: "must name a declared service" });
      entry.path = str(check.path, `${where}.path`, c, { def: "/", max: 300 });
      if (entry.path && !entry.path.startsWith("/")) c.err(`${where}.path`, 'must start with "/"');
      entry.expectStatus = num(check.expectStatus, `${where}.expectStatus`, c, { min: 100, max: 599, int: true, def: 200 });
      if (check.run !== undefined) c.err(`${where}.run`, "a service-health check takes service/path/expectStatus, not run");
    }
    out.checks.push(entry);
  }
  for (const [i, ov] of arr(o.overlay, "acceptance.overlay", c, { max: 200 }).entries()) {
    const where = `acceptance.overlay[${i}]`;
    if (!isPlainObject(ov)) { c.err(where, "must be an object"); continue; }
    checkKeys(ov, where, ["source", "target"], { strict: false }, c);
    const sp = pathProblem(ov.source); const tp = relativePathProblem(ov.target);
    if (sp) c.err(`${where}.source`, sp);
    if (tp) c.err(`${where}.target`, tp);
    else if (String(ov.target).split("/")[0] === ".git") c.err(`${where}.target`, "must not target .git");
    // The file is copied into the run directory and mounted into check containers that run the worker's code: never a credential store or system path.
    const source = typeof ov.source === "string" ? ov.source : null;
    const resolvedSource = !sp && source !== null ? (opts.baseDir && !path.isAbsolute(source) ? path.resolve(opts.baseDir, source) : source) : null;
    if (resolvedSource && FORBIDDEN_SOURCES.some((re) => re.test(resolvedSource))) c.err(`${where}.source`, `${resolvedSource} is a credential store or system path: held-out files come from the task's own files, never from there`);
    else if (!sp && !tp && resolvedSource !== null && typeof ov.target === "string") out.overlay.push({ source: resolvedSource, target: ov.target.replace(/^\.\//, "") });
  }
  return out;
}

function readServices(raw: unknown, images: readonly string[], c: ProblemSink): DraftServiceSpec[] {
  const list: DraftServiceSpec[] = [];
  const seen = new Set<string>();
  for (const [i, s] of arr(raw, "permissions.network.services", c, { max: 10 }).entries()) {
    const where = `permissions.network.services[${i}]`;
    if (!isPlainObject(s)) { c.err(where, "must be an object"); continue; }
    checkKeys(s, where, ["name", "image", "env", "credentialEnv", "port", "command", "workspaceMounts", "restartOnDeploy", "tmpfs", "user", "health", "memory", "cpus"], { strict: true }, c);
    const name = str(s.name, `${where}.name`, c, { re: SERVICE_NAME, what: "must be a lowercase DNS label (2-31 characters)" }) ?? "";
    if (RESERVED_HOSTNAMES.has(name)) c.err(`${where}.name`, `"${name}" is reserved`);
    if (seen.has(name)) c.err(`${where}.name`, `duplicate service name "${name}"`);
    seen.add(name);
    const image = str(s.image, `${where}.image`, c, { re: IMAGE_REF, what: "is not a valid image reference", max: 300 }) ?? "";
    if (image) {
      const pinned = /@sha256:[a-f0-9]{64}$/.test(image) || (/:[\w][\w.-]*$/.test(image.split("/").pop() ?? "") && !/:latest$/.test(image));
      if (!pinned) c.err(`${where}.image`, "must be pinned by a tag (not :latest) or a sha256 digest");
      if (!images.includes(image)) c.err(`${where}.image`, `is not in permissions.network.serviceImages (the allowlist of images the supervisor may start)`);
    }
    const port = num(s.port, `${where}.port`, c, { min: 1, max: 65535, int: true });
    const env: Record<string, string> = {};
    const credentialEnv: Record<string, string> = {};
    const workspaceMounts: Array<{ source: string; target: string }> = [];
    if (port === undefined) c.err(`${where}.port`, "is required");
    for (const [k, v] of Object.entries(asObject(s.env, `${where}.env`, c))) {
      if (!ENV_NAME.test(k)) c.err(`${where}.env.${k}`, "bad environment variable name");
      else if (typeof v !== "string") c.err(`${where}.env.${k}`, "must be a string");
      else env[k] = v;
    }
    for (const [k, v] of Object.entries(asObject(s.credentialEnv, `${where}.credentialEnv`, c))) {
      if (!ENV_NAME.test(k)) c.err(`${where}.credentialEnv.${k}`, "bad environment variable name");
      else if (typeof v !== "string" || !CRED_NAME.test(v)) c.err(`${where}.credentialEnv.${k}`, "must be a credential NAME (upper-case, as listed in permissions.credentials.names)");
      else credentialEnv[k] = v;
    }
    let command: string[] | undefined;
    if (s.command !== undefined) {
      if (isStringArray(s.command) && s.command.length) command = s.command;
      else c.err(`${where}.command`, "must be a non-empty argv array of strings");
    }
    for (const [j, m] of arr(s.workspaceMounts, `${where}.workspaceMounts`, c, { max: 5 }).entries()) {
      const mw = `${where}.workspaceMounts[${j}]`;
      if (!isPlainObject(m)) { c.err(mw, "must be an object"); continue; }
      checkKeys(m, mw, ["source", "target"], { strict: true }, c);
      const sp = relativePathProblem(m.source);
      if (sp) c.err(`${mw}.source`, `${sp} (a path inside the worker workspace; mounted read-only)`);
      if (typeof m.target !== "string" || !m.target.startsWith("/") || m.target.includes("..") || hasControlChar(m.target)) c.err(`${mw}.target`, "must be an absolute path inside the service container");
      if (!sp && typeof m.source === "string" && typeof m.target === "string" && m.target.startsWith("/")) workspaceMounts.push({ source: m.source.replace(/^\.\//, ""), target: m.target });
    }
    const restartOnDeploy = bool(s.restartOnDeploy, `${where}.restartOnDeploy`, c, false);
    const tmpfs: string[] = [];
    for (const [j, t] of arr(s.tmpfs, `${where}.tmpfs`, c, { max: 5 }).entries()) {
      if (typeof t !== "string" || !t.startsWith("/") || t.includes("..") || t.includes(",") || hasControlChar(t)) c.err(`${where}.tmpfs[${j}]`, "must be an absolute path inside the service container (a size-limited tmpfs; the root filesystem stays read-only)");
      else tmpfs.push(t);
    }
    let user: string | undefined;
    if (s.user !== undefined) {
      user = str(s.user, `${where}.user`, c, { re: /^\d+:\d+$/, what: 'must be "uid:gid" (services never run as root: 0 is refused below)' });
      if (user && (user.startsWith("0:") || user.endsWith(":0") || user === "0:0")) { c.err(`${where}.user`, "must not be root"); user = undefined; }
    }
    const h = asObject(s.health, `${where}.health`, c);
    checkKeys(h, `${where}.health`, ["path", "cmd", "expectStatus", "intervalSeconds", "timeoutSeconds", "retries"], { strict: true }, c);
    const health: DraftServiceHealth = { intervalSeconds: num(h.intervalSeconds, `${where}.health.intervalSeconds`, c, { min: 1, max: 300, int: true, def: 5 }), timeoutSeconds: num(h.timeoutSeconds, `${where}.health.timeoutSeconds`, c, { min: 1, max: 300, int: true, def: 5 }), retries: num(h.retries, `${where}.health.retries`, c, { min: 1, max: 100, int: true, def: 12 }) };
    if (h.path !== undefined && h.cmd !== undefined) c.err(`${where}.health`, "give path (HTTP) or cmd, not both");
    if (h.path !== undefined) { health.path = str(h.path, `${where}.health.path`, c, { max: 300 }); if (health.path && !health.path.startsWith("/")) c.err(`${where}.health.path`, 'must start with "/"'); health.expectStatus = num(h.expectStatus, `${where}.health.expectStatus`, c, { min: 100, max: 599, int: true, def: 200 }); }
    else if (h.cmd !== undefined) { if (isStringArray(h.cmd) && h.cmd.length) health.cmd = h.cmd; else c.err(`${where}.health.cmd`, "must be a non-empty argv array of strings"); }
    else c.err(`${where}.health`, "needs path (HTTP check) or cmd (run inside the service container)");
    // Key order as before: name, image, port, env, credentialEnv, workspaceMounts, command, restartOnDeploy, tmpfs, user, health, memory, cpus.
    const entry: DraftServiceSpec = { name, image, port, env, credentialEnv, workspaceMounts, ...(command ? { command } : {}), restartOnDeploy, tmpfs, ...(user !== undefined ? { user } : {}), health };
    if (s.memory !== undefined) {
      const memory = str(s.memory, `${where}.memory`, c, { re: /^\d+[kmg]?$/i, what: "must look like 512m or 2g" });
      if (memory !== undefined && !isPositiveSize(memory)) c.err(`${where}.memory`, ZERO_LIMIT);
      else if (memory !== undefined) entry.memory = memory;
    }
    if (s.cpus !== undefined) {
      const cpus = str(asText(s.cpus), `${where}.cpus`, c, { re: /^\d+(\.\d+)?$/, what: "must be a number" });
      if (cpus !== undefined && !isPositiveCpus(cpus)) c.err(`${where}.cpus`, ZERO_LIMIT);
      else if (cpus !== undefined) entry.cpus = cpus;
    }
    list.push(entry);
  }
  return list;
}

function readEgress(raw: unknown, c: ProblemSink): EgressRule[] {
  const list: EgressRule[] = [];
  const seen = new Set<string | null>();
  for (const [i, e] of arr(raw, "permissions.network.egress", c, { max: 50 }).entries()) {
    const where = `permissions.network.egress[${i}]`;
    if (!isPlainObject(e)) { c.err(where, "must be an object"); continue; }
    checkKeys(e, where, ["host", "ports", "plainGet"], { strict: true }, c);
    let host = typeof e.host === "string" ? normaliseHost(e.host) : null;
    if (host && isIpLiteral(host)) host = canonicalIp(host); // stored in one spelling, so the allowlist compares like with like
    let ok = Boolean(host);
    if (!host) c.err(`${where}.host`, "must be a host name (no scheme, port, path, user info or wildcard)");
    else if (isIpLiteral(host)) {
      if (!isPublicIpLiteral(host)) { c.err(`${where}.host`, `${host} is a ${classifyAddress(host)} address; egress to private, loopback, link-local or metadata addresses is never allowed (declare a run service instead)`); ok = false; }
    } else if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) { c.err(`${where}.host`, "is not a valid fully qualified domain name"); ok = false; }
    else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) { c.err(`${where}.host`, "is a local name; egress is for public hosts only"); ok = false; }
    const ports: number[] = [];
    for (const [j, p] of arr(e.ports ?? [443], `${where}.ports`, c, { max: 10 }).entries()) {
      const v = num(p, `${where}.ports[${j}]`, c, { min: 1, max: 65535, int: true });
      if (v !== undefined) ports.push(v);
    }
    if (!ports.length) c.err(`${where}.ports`, "needs at least one port");
    const plainGet = bool(e.plainGet, `${where}.plainGet`, c, false);
    if (host && seen.has(host)) c.err(`${where}.host`, `duplicate egress host "${host}"`);
    seen.add(host);
    if (ok && host) list.push({ host, ports: [...new Set(ports)].sort((a, b) => a - b), plainGet });
  }
  return list;
}

function readPermissions(raw: unknown, c: ProblemSink, template: unknown): Permissions<DraftServiceSpec> {
  const o = asObject(raw, "permissions", c);
  checkKeys(o, "permissions", ["writeAreas", "network", "credentials", "outputs", "unattended"], { strict: true }, c);
  const out: Permissions<DraftServiceSpec> = { writeAreas: [], network: { egress: [], services: [], serviceImages: [] }, credentials: { names: [] }, outputs: { destinations: [] }, unattended: { authorised: false, autoApprove: false } };
  const areas = o.writeAreas === undefined ? ["**"] : arr(o.writeAreas, "permissions.writeAreas", c, { max: 100 });
  for (const [i, g] of areas.entries()) {
    const problem = globProblem(g);
    if (problem || typeof g !== "string") c.err(`permissions.writeAreas[${i}]`, problem ?? "must be a non-empty string"); else out.writeAreas.push(g);
  }
  if (!out.writeAreas.length) c.err("permissions.writeAreas", "needs at least one glob (default [\"**\"], the whole workspace)");

  const n = asObject(o.network, "permissions.network", c);
  checkKeys(n, "permissions.network", ["egress", "services", "serviceImages"], { strict: true }, c);
  out.network.egress = readEgress(n.egress, c);
  for (const [i, img] of arr(n.serviceImages, "permissions.network.serviceImages", c, { max: 20 }).entries()) {
    if (typeof img !== "string" || !IMAGE_REF.test(img)) c.err(`permissions.network.serviceImages[${i}]`, "is not a valid image reference"); else out.network.serviceImages.push(img);
  }
  out.network.services = readServices(n.services, out.network.serviceImages, c);
  if (out.network.services.length && template && template !== "deploy") c.err("permissions.network.services", `run services are part of the deploy template; template "${asText(template)}" declares none`);

  const cr = asObject(o.credentials, "permissions.credentials", c);
  checkKeys(cr, "permissions.credentials", ["names"], { strict: true }, c);
  for (const [i, name] of arr(cr.names, "permissions.credentials.names", c, { max: 30 }).entries()) {
    if (typeof name !== "string" || !CRED_NAME.test(name)) c.err(`permissions.credentials.names[${i}]`, "must be an upper-case environment variable name; values are never written in a contract");
    else out.credentials.names.push(name);
  }
  for (const s of out.network.services) for (const cred of Object.values(s.credentialEnv)) if (!out.credentials.names.includes(cred)) c.err(`permissions.network.services.${s.name}.credentialEnv`, `${cred} is not declared in permissions.credentials.names`);

  const outp = asObject(o.outputs, "permissions.outputs", c);
  checkKeys(outp, "permissions.outputs", ["destinations"], { strict: true }, c);
  for (const [i, d] of arr(outp.destinations, "permissions.outputs.destinations", c, { max: 10 }).entries()) {
    const where = `permissions.outputs.destinations[${i}]`;
    if (!isPlainObject(d)) { c.err(where, "must be an object"); continue; }
    checkKeys(d, where, ["kind", "path"], { strict: true }, c);
    if (d.kind !== "export-dir") c.err(`${where}.kind`, 'must be "export-dir"');
    const problem = pathProblem(d.path);
    if (problem) c.err(`${where}.path`, problem);
    else if (!path.isAbsolute(String(d.path))) c.err(`${where}.path`, "must be an absolute path");
    if (d.kind === "export-dir" && !problem && typeof d.path === "string") out.outputs.destinations.push({ kind: "export-dir", path: d.path });
  }

  const u = asObject(o.unattended, "permissions.unattended", c);
  checkKeys(u, "permissions.unattended", ["authorised", "autoApprove"], { strict: true }, c);
  out.unattended = { authorised: bool(u.authorised, "permissions.unattended.authorised", c, false), autoApprove: bool(u.autoApprove, "permissions.unattended.autoApprove", c, false) };
  if (out.unattended.autoApprove && !out.unattended.authorised) c.err("permissions.unattended", "autoApprove requires authorised: true (approvals are only answered automatically inside an authorised unattended zone)");
  return out;
}

function readModel(rawModel: unknown, rawProvider: unknown, c: ProblemSink): { model: ModelSettings<string>; providerSettings: ProviderSettings<undefined> } {
  const m = asObject(rawModel, "model", c);
  checkKeys(m, "model", ["provider", "worker", "manager", "review", "extra"], { strict: false }, c);
  const provider = str(m.provider, "model.provider", c, { def: "openrouter", max: 40 });
  if (!Object.hasOwn(PROVIDERS, provider)) c.err("model.provider", `unknown provider "${provider}"; known: ${providerIds().join(", ")}`);
  const preset: ProviderPreset = isProviderId(provider) ? PROVIDERS[provider] : PROVIDERS["openai-compatible"];
  const modelId = (v: unknown, where: string, def: string | undefined): string | undefined => {
    const s = str(v, where, c, { def, max: 121 });
    if (s && (!MODEL_ID.test(s) || /:online\b/i.test(s))) { c.err(where, "is not a plain model id (no :online variants)"); return def; }
    return s;
  };
  const worker = modelId(m.worker, "model.worker", provider === "openrouter" ? DEFAULT_MODEL : undefined);
  if (!worker) c.err("model.worker", `is required for provider "${provider}"`);
  const manager = modelId(m.manager, "model.manager", worker) ?? worker ?? "";
  const out: ModelSettings<string> = { provider, worker: worker ?? "", manager, review: modelId(m.review, "model.review", undefined) ?? manager, extra: [] };
  for (const [i, e] of arr(m.extra, "model.extra", c, { max: 10 }).entries()) {
    const s = modelId(e, `model.extra[${i}]`, undefined);
    if (s) out.extra.push(s);
  }

  const p = asObject(rawProvider, "providerSettings", c);
  checkKeys(p, "providerSettings", ["upstream", "apiKeyEnv", "authName", "headers", "pricing"], { strict: false }, c);
  const settings: ProviderSettings<undefined> = { upstream: str(p.upstream, "providerSettings.upstream", c, { def: preset.upstream ?? undefined, max: 300 }), apiKeyEnv: str(p.apiKeyEnv, "providerSettings.apiKeyEnv", c, { def: preset.apiKeyEnv ?? undefined, re: CRED_NAME, what: "must be an upper-case environment variable NAME (the value is read from the operator's environment, never from the contract)" }), authName: str(p.authName, "providerSettings.authName", c, { def: preset.authName ?? undefined, max: 60 }), headers: {}, pricing: {} };
  if (!settings.upstream) c.err("providerSettings.upstream", `is required for provider "${provider}"`);
  else {
    const problem = urlProblem(settings.upstream, { allowed: ["https"] });
    if (problem) c.err("providerSettings.upstream", problem);
  }
  // A pi login (auth.json entry) is the operator's credential for that provider's own service. The relay sends the key
  // it finds to `upstream`, so a login may never be pointed at another destination: not a different login, and not the
  // provider's own login sent to a different host.
  if (settings.authName) {
    if (settings.authName !== preset.authName) c.err("providerSettings.authName", `${preset.authName ? `must be ${JSON.stringify(preset.authName)}` : "is not available"} for provider "${provider}": a pi login is only ever used for its own provider`);
    else if (settings.upstream !== preset.upstream) {
      if (p.authName !== undefined && p.authName !== null) c.err("providerSettings.authName", `cannot be combined with a custom upstream (${String(settings.upstream)}): the login would be sent there. Use apiKeyEnv with a variable that holds a key for that service`);
      else settings.authName = undefined;
    }
  }
  if (provider === "openai-compatible" && !settings.apiKeyEnv) c.err("providerSettings.apiKeyEnv", 'is required for provider "openai-compatible"');
  // The relay sends the value of this variable to `upstream`: it is an inference provider's API key, never the operator's
  // credential for source hosting, registries or clouds (a contract someone else wrote must not be able to point one at a host).
  if (settings.apiKeyEnv && NON_INFERENCE_KEY.test(settings.apiKeyEnv)) c.err("providerSettings.apiKeyEnv", `${settings.apiKeyEnv} is a credential for another service; providerSettings.apiKeyEnv names an inference provider's API key`);
  for (const [k, v] of Object.entries(asObject(p.headers, "providerSettings.headers", c))) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || typeof v !== "string" || v.length > 200) c.err(`providerSettings.headers.${k}`, "must be a short header name with a short string value");
    else if (/^(authorization|proxy-authorization|cookie|x-api-key)$/i.test(k)) c.err(`providerSettings.headers.${k}`, "credential headers are set by the relay from the operator's key, never by the contract");
    else settings.headers[k] = v;
  }
  // A price is a finite number >= 0: null, "5" or true would compare >= 0 in JavaScript and leave spend unmetered.
  const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const [model, pr] of Object.entries(asObject(p.pricing, "providerSettings.pricing", c))) {
    const input = isPlainObject(pr) ? pr.inputPerMTok : undefined;
    const output = isPlainObject(pr) ? pr.outputPerMTok : undefined;
    if (!isPrice(input) || !isPrice(output)) c.err(`providerSettings.pricing.${model}`, "must be { inputPerMTok, outputPerMTok } in USD per million tokens");
    else settings.pricing[model] = { inputPerMTok: input, outputPerMTok: output };
  }
  if (!preset.reportsCost) {
    // Spend cannot be metered without a price, and an unmetered run cannot honour its budget.
    for (const id of new Set([out.worker, out.manager, out.review, ...out.extra].filter(Boolean))) {
      // Own keys only: a model id such as "constructor" must not find Object.prototype's.
      if (!Object.hasOwn(settings.pricing, id)) c.err("providerSettings.pricing", `provider "${provider}" does not report cost; give pricing for ${id} so the budget can be enforced`);
    }
  }
  return { model: out, providerSettings: settings };
}

function readEffort(raw: unknown, c: ProblemSink, effort: EffortApi | null): EffortChoice {
  if (!effort) { c.err("effort", EFFORT_UNAVAILABLE); return { tier: "standard", cap: "standard" }; }
  const def = ((): string => { try { return effort.loadEffortPolicy().default; } catch { return "standard"; } })();
  const request = raw === undefined || raw === null ? { tier: def } : typeof raw === "string" || typeof raw === "number" ? { tier: raw } : raw;
  if (!isPlainObject(request)) { c.err("effort", "must be a tier name (E1..E5, minimal..exhaustive) or { tier, cap }"); return { tier: def, cap: def }; }
  checkKeys(request, "effort", ["tier", "cap"], { strict: false }, c);
  const tier = effort.normalizeTier(request.tier ?? def);
  if (!tier) { c.err("effort.tier", `${JSON.stringify(request.tier)} is not an effort tier (E1..E5 or minimal, focused, standard, thorough, exhaustive)`); return { tier: def, cap: def }; }
  const cap = request.cap === undefined ? tier : effort.normalizeTier(request.cap);
  if (!cap) { c.err("effort.cap", `${JSON.stringify(request.cap)} is not an effort tier`); return { tier, cap: tier }; }
  if (effort.clampTier(tier, cap) !== tier) c.err("effort", `tier ${tier} is above its cap ${cap}`);
  return { tier, cap };
}

function readBudget(raw: unknown, c: ProblemSink): Budget<undefined> {
  const b = asObject(raw, "budget", c);
  checkKeys(b, "budget", ["totalUsd", "perStepUsd", "maxSteps", "maxMinutes"], { strict: false }, c);
  const out: Budget<undefined> = {
    totalUsd: num(b.totalUsd, "budget.totalUsd", c, { min: 0.01, max: 100_000 }),
    perStepUsd: num(b.perStepUsd, "budget.perStepUsd", c, { min: 0.01, max: 100_000 }),
    maxSteps: num(b.maxSteps, "budget.maxSteps", c, { min: 1, max: 1000, int: true }),
    maxMinutes: num(b.maxMinutes, "budget.maxMinutes", c, { min: 1, max: 43_200, int: true }),
  };
  for (const k of ["totalUsd", "perStepUsd", "maxSteps", "maxMinutes"] as const) if (out[k] === undefined && (b[k] === undefined || b[k] === null)) c.err(`budget.${k}`, "is required (every run is bounded by money, steps and time)");
  if (out.totalUsd !== undefined && out.perStepUsd !== undefined && out.perStepUsd > out.totalUsd) c.err("budget.perStepUsd", "must not exceed budget.totalUsd");
  return out;
}

function readRecovery(raw: unknown, c: ProblemSink): RecoverySettings {
  const r = asObject(raw, "recovery", c);
  checkKeys(r, "recovery", ["softNudges", "hardRestarts", "maxAttemptsPerStep"], { strict: false }, c);
  return {
    softNudges: num(r.softNudges, "recovery.softNudges", c, { min: 0, max: 10, int: true, def: 2 }),
    hardRestarts: num(r.hardRestarts, "recovery.hardRestarts", c, { min: 0, max: 5, int: true, def: 1 }),
    maxAttemptsPerStep: num(r.maxAttemptsPerStep, "recovery.maxAttemptsPerStep", c, { min: 1, max: 100, int: true, def: 8 }),
  };
}

function readGenerations(raw: unknown, c: ProblemSink): GenerationSettings {
  const g = asObject(raw, "generations", c);
  checkKeys(g, "generations", ["enabled", "iterationMinutes", "iterationUsd", "maxGenerations", "graceMinutes", "resetOnNoProgress", "notebookMaxChars"], { strict: true }, c);
  const L = GENERATION_LIMITS;
  return {
    enabled: bool(g.enabled, "generations.enabled", c, false),
    iterationMinutes: num(g.iterationMinutes, "generations.iterationMinutes", c, { min: L.minMinutes, max: L.maxMinutes, int: true, def: 30 }),
    iterationUsd: num(g.iterationUsd, "generations.iterationUsd", c, { min: 0.01, max: 100_000 }) ?? null,
    maxGenerations: num(g.maxGenerations, "generations.maxGenerations", c, { min: 1, max: L.maxGenerations, int: true, def: 4 }),
    graceMinutes: num(g.graceMinutes, "generations.graceMinutes", c, { min: 1, max: 30, int: true, def: 3 }),
    resetOnNoProgress: bool(g.resetOnNoProgress, "generations.resetOnNoProgress", c, false),
    notebookMaxChars: num(g.notebookMaxChars, "generations.notebookMaxChars", c, { min: L.minNotebookChars, max: L.maxNotebookChars, int: true, def: L.maxNotebookChars }),
  };
}

/** Generations only divide the run's budget: no box may be larger than the limit it sits inside. */
function checkGenerationsWithinBudget(g: GenerationSettings, b: Budget<undefined>, c: ProblemSink): void {
  if (!g.enabled) return;
  if (b.maxMinutes !== undefined && g.iterationMinutes > b.maxMinutes) c.err("generations.iterationMinutes", `must not exceed budget.maxMinutes (${b.maxMinutes}): generations cannot raise the budget`);
  if (g.iterationUsd !== null && b.totalUsd !== undefined && g.iterationUsd > b.totalUsd) c.err("generations.iterationUsd", `must not exceed budget.totalUsd (${b.totalUsd}): generations cannot raise the budget`);
  if (g.graceMinutes >= g.iterationMinutes) c.err("generations.graceMinutes", "must be less than generations.iterationMinutes");
}

const isPromotionPolicy = (v: unknown): v is PromotionPolicy => (PROMOTION_POLICIES as readonly unknown[]).includes(v);

function readPromotion(raw: unknown, c: ProblemSink, _inputs: Inputs, run: string): DraftPromotion {
  const p = asObject(raw, "promotion", c);
  checkKeys(p, "promotion", ["policy", "destinations", "requiresOperatorApproval"], { strict: true }, c);
  const policy = p.policy === undefined ? "none" : p.policy;
  if (!isPromotionPolicy(policy)) c.err("promotion.policy", 'must be "none", "local-branch" or "push"');
  const out: DraftPromotion = { policy, destinations: [], requiresOperatorApproval: bool(p.requiresOperatorApproval, "promotion.requiresOperatorApproval", c, true) };
  for (const [i, d] of arr(p.destinations, "promotion.destinations", c, { max: 5 }).entries()) {
    const where = `promotion.destinations[${i}]`;
    if (!isPlainObject(d)) { c.err(where, "must be an object"); continue; }
    if (policy === "local-branch") {
      checkKeys(d, where, ["kind", "repo", "branch"], { strict: true }, c);
      if (d.kind !== "local-branch") c.err(`${where}.kind`, 'must be "local-branch"');
      let repo: string | undefined;
      if (d.repo !== undefined) { const problem = pathProblem(d.repo); if (problem || typeof d.repo !== "string") c.err(`${where}.repo`, problem ?? "must be a non-empty string"); else repo = d.repo; }
      const entry: LocalBranchDestination = { kind: "local-branch", ...(repo !== undefined ? { repo } : {}), branch: str(d.branch, `${where}.branch`, c, { re: BRANCH_NAME, def: `pi/${run || "run"}`, what: "is not a valid branch name" }) };
      if (entry.branch && (entry.branch.includes("..") || entry.branch.endsWith("/") || entry.branch.endsWith(".lock") || isProtectedBranch(entry.branch))) c.err(`${where}.branch`, `"${entry.branch}" is a protected or invalid branch name; a run never moves the branches a person merges to`);
      out.destinations.push(entry);
    } else if (policy === "push") {
      checkKeys(d, where, ["kind", "url", "branch", "tags"], { strict: true }, c);
      if (d.kind !== "git-remote") c.err(`${where}.kind`, 'must be "git-remote"');
      const problem = urlProblem(d.url);
      const tags = bool(d.tags, `${where}.tags`, c, false);
      if (problem) c.err(`${where}.url`, problem);
      const branch = str(d.branch, `${where}.branch`, c, { re: BRANCH_NAME, what: "is not a valid branch name" });
      const entry: GitRemoteDestination<undefined, unknown> = { kind: "git-remote", url: d.url, tags, branch };
      if (!branch) c.err(`${where}.branch`, "is required for a push destination");
      else if (branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock") || isProtectedBranch(branch)) c.err(`${where}.branch`, `"${branch}" is a protected or invalid branch name; promote to a review branch, never to a protected one`);
      out.destinations.push(entry);
    } else c.err(where, `policy "${asText(policy)}" takes no destinations`);
  }
  if (policy === "push" && !out.destinations.length) c.err("promotion.destinations", 'policy "push" needs at least one git-remote destination (nothing is ever pushed to an unlisted remote)');
  if (policy === "push" && !out.requiresOperatorApproval) c.warn("promotion.requiresOperatorApproval", "false: the supervisor will push to the listed remotes without asking again; the boundary authorisation is the only approval");
  return out;
}

function readRuntime(raw: unknown, c: ProblemSink): RuntimeSettings {
  const r = asObject(raw, "runtime", c);
  checkKeys(r, "runtime", Object.keys(DEFAULT_RUNTIME), { strict: false }, c);
  const out: RuntimeSettings = { ...clone(DEFAULT_RUNTIME) };
  if (r.engine !== undefined) { if (r.engine !== "podman" && r.engine !== "docker") c.err("runtime.engine", '"podman" or "docker"'); else out.engine = r.engine; }
  out.image = str(r.image, "runtime.image", c, { re: IMAGE_REF, def: out.image, what: "is not a valid image reference", max: 300 });
  out.memory = str(r.memory, "runtime.memory", c, { re: /^\d+[kmg]?$/i, def: out.memory, what: "must look like 512m or 6g" });
  out.cpus = str(r.cpus === undefined ? undefined : asText(r.cpus), "runtime.cpus", c, { re: /^\d+(\.\d+)?$/, def: out.cpus, what: "must be a number" });
  if (!isPositiveSize(out.memory)) c.err("runtime.memory", ZERO_LIMIT);
  if (!isPositiveCpus(out.cpus)) c.err("runtime.cpus", ZERO_LIMIT);
  out.pids = num(r.pids, "runtime.pids", c, { min: 16, max: 100_000, int: true, def: out.pids });
  out.tmpSize = str(r.tmpSize, "runtime.tmpSize", c, { re: /^\d+[kmg]?$/i, def: out.tmpSize, what: "must look like 512m or 4g" });
  out.user = str(r.user, "runtime.user", c, { re: /^(host|\d+:\d+)$/, def: out.user, what: 'must be "host" or "uid:gid"' });
  out.mirrorSeconds = num(r.mirrorSeconds, "runtime.mirrorSeconds", c, { min: 1, max: 3600, int: true, def: out.mirrorSeconds });
  const gi = asObject(r.gitIdentity, "runtime.gitIdentity", c);
  out.gitIdentity = { name: str(gi.name, "runtime.gitIdentity.name", c, { def: out.gitIdentity.name, max: 100 }), email: str(gi.email, "runtime.gitIdentity.email", c, { def: out.gitIdentity.email, max: 200 }) };
  return out;
}

function readAuthorisation(raw: unknown, c: ProblemSink): ContractAuthorisation<undefined> | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) { c.err("authorisation", "must be an object { boundaryDigest, by, at }"); return null; }
  checkKeys(raw, "authorisation", ["boundaryDigest", "by", "at"], { strict: true }, c);
  const out: ContractAuthorisation<undefined> = { boundaryDigest: str(raw.boundaryDigest, "authorisation.boundaryDigest", c, { re: HEX64, what: "must be the 64-character hex boundary digest printed by `plan`" }), by: str(raw.by, "authorisation.by", c, { max: 200 }), at: str(raw.at, "authorisation.at", c, { max: 40 }) };
  if (!out.by) c.err("authorisation.by", "is required (who authorised this boundary)");
  if (out.at && Number.isNaN(Date.parse(out.at))) c.err("authorisation.at", "must be an ISO date-time");
  if (!out.at) c.err("authorisation.at", "is required");
  return out;
}

// --- legacy v0 -------------------------------------------------------------------------------

const LEGACY_KEYS = ["run", "cycles", "model", "managerModel", "provider", "upstream", "image", "engine", "gitRemote", "baseRef", "integration", "extraModels", "references", "gitIdentity", "budget", "limits", "mirrorSeconds", "container", "gate", "promotion", "authorisation"];

/** Does this look like the pre-contract configuration file (cycles / gitRemote / integration)? */
export function looksLegacy(raw: unknown): boolean {
  return isPlainObject(raw) && raw.schemaVersion === undefined && raw.template === undefined && ["cycles", "gitRemote", "integration", "managerModel", "baseRef", "limits", "container", "gate"].some((k) => k in raw);
}

/** `o[key]` of an unvalidated value, or undefined when `o` is not an object (as `o?.[key]` on a v0 file). */
const field = (o: unknown, key: string): unknown => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined);
/** `{ ...v }` of an unvalidated value (an object's own enumerable keys; nothing for null or undefined). */
const spread = (v: unknown): Record<string, unknown> => Object.assign({}, v);

/**
 * Map the v0 config onto the self-improve template. v0 relied on a built-in private remote and
 * always published; both are gone, so a v0 file must now state its remote and promotion policy.
 *
 * The v0 values are copied as they are: resolveContract validates the result like any contract.
 */
export function legacyToRaw(v0: RawContract, c: ProblemSink): RawContract {
  checkKeys(v0, "config", LEGACY_KEYS, { strict: false }, c);
  c.warn("config", "deprecated v0 config shape: mapped onto the self-improve template. Write a schemaVersion 1 contract instead (`pi-autonomy init --template self-improve`).");
  if (typeof v0.gitRemote !== "string" || !v0.gitRemote.trim()) c.err("gitRemote", "is required: there is no default remote any more. Name the repository the run improves and publishes to.");
  const policy = v0.promotion;
  if (!isPromotionPolicy(policy)) c.err("promotion", 'is required in a v0 config now: "none", "local-branch" or "push" (v0 always pushed to its built-in remote; state it explicitly)');
  const cycles = v0.cycles ?? 50;
  const limits: Record<string, unknown> = { softMinutes: 180, hardMinutes: 300, idleMinutes: 20, noCommitMinutes: 90, managerCallsPerCycle: 3, redGatesInARow: 2, guardEscalations: 3, nothingFoundToStop: 3, ...spread(v0.limits) };
  const budget: Record<string, unknown> = { perCycleUsd: 5, perCycleHardUsd: null, totalUsd: 100, ...spread(v0.budget) };
  // Arithmetic on unvalidated v0 values, as before: a wrong type surfaces as a contract error once mapped.
  const perCycleUsd = budget.perCycleUsd as number;
  const perCycleHardUsd = budget.perCycleHardUsd ?? 2 * perCycleUsd;
  const remote = v0.gitRemote;
  const integration: Record<string, unknown> = { branch: "experimental/main", review: true, ...spread(v0.integration) };
  const ref = v0.baseRef ?? "main";
  const hardMinutes = limits.hardMinutes;
  const maxMinutesWanted = typeof cycles === "number" && Number.isFinite(cycles) && typeof hardMinutes === "number" && Number.isFinite(hardMinutes) ? Math.ceil(cycles * hardMinutes) : 43_200;
  if (maxMinutesWanted > 43_200) c.warn("cycles", "cycles x limits.hardMinutes exceeds 30 days; the run's total time is capped at 43200 minutes");
  const model = v0.model ?? DEFAULT_MODEL;
  const manager = v0.managerModel ?? DEFAULT_MODEL;
  const gate = v0.gate ?? {};
  const raw: RawContract = {
    schemaVersion: 1,
    run: v0.run,
    template: "self-improve",
    objective: { title: `Autonomous improvement of ${typeof remote === "string" ? remote.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() : "the repository"}` },
    inputs: { repository: isUrlLike(remote) ? { url: remote, ref } : { path: remote, ref }, references: v0.references ?? {} },
    permissions: { unattended: { authorised: true, autoApprove: true } },
    model: { provider: v0.provider ?? "openrouter", worker: model, manager, review: integration.reviewModel ?? manager, extra: v0.extraModels ?? [] },
    providerSettings: v0.upstream ? { upstream: v0.upstream } : {},
    budget: { totalUsd: budget.totalUsd, perStepUsd: budget.perCycleUsd, maxSteps: cycles, maxMinutes: Math.min(maxMinutesWanted, 43_200) },
    acceptance: { review: integration.review !== false, checks: [{ id: "gate", run: ["/opt/autonomy/gate.sh"], timeoutMinutes: field(gate, "timeoutMinutes") ?? 60, required: true }] },
    runtime: { ...(v0.engine ? { engine: v0.engine } : {}), ...(v0.image ? { image: v0.image } : {}), ...(v0.mirrorSeconds ? { mirrorSeconds: v0.mirrorSeconds } : {}), ...(v0.gitIdentity ? { gitIdentity: v0.gitIdentity } : {}), ...spread(v0.container) },
    templateOptions: { integration: { branch: integration.branch, review: integration.review !== false }, perStepHardUsd: perCycleHardUsd, limits, gate: { memory: field(gate, "memory") ?? field(v0.container, "memory") ?? "6g", cpus: field(gate, "cpus") ?? "4" } },
  };
  if (policy === "push") raw.promotion = { policy: "push", requiresOperatorApproval: false, destinations: [{ kind: "git-remote", url: remote, branch: integration.branch, tags: true }] };
  else if (policy === "local-branch") raw.promotion = { policy: "local-branch", destinations: [{ kind: "local-branch", ...(isUrlLike(remote) ? {} : { repo: remote }), branch: integration.branch }] };
  else raw.promotion = { policy: "none" };
  if (v0.authorisation) raw.authorisation = v0.authorisation;
  return raw;
}

// --- resolution --------------------------------------------------------------------------------

/**
 * Validate and resolve a contract.
 * @param rawInput the parsed JSON
 */
export function resolveContract(rawInput: unknown, opts: ResolveOptions = {}): Resolution {
  const c = collector();
  const effort = effortApi(opts.effort);
  let legacy = false;
  if (!isPlainObject(rawInput)) {
    c.err("", "the contract must be a JSON object");
    return { ok: false, contract: null, problems: c.problems, legacy };
  }
  let raw: RawContract = rawInput;
  if (looksLegacy(raw)) { legacy = true; raw = legacyToRaw(raw, c); }
  else if (raw.schemaVersion !== SCHEMA_VERSION) c.err("schemaVersion", `must be ${SCHEMA_VERSION} (got ${JSON.stringify(raw.schemaVersion)}); a config without schemaVersion is read as the deprecated v0 shape only when it has v0 keys (cycles, gitRemote, integration, ...)`);
  checkKeys(raw, "", TOP_LEVEL_KEYS, { strict: true }, c);

  const templateId = raw.template;
  const template = isTemplateId(templateId) ? TEMPLATES[templateId] : null;
  if (!template) c.err("template", `must be one of ${templateIds().join(", ")} (got ${JSON.stringify(templateId)})`);
  const mergedValue = template ? deepMerge(template.defaults(), stripUndefined(raw)) : stripUndefined(raw);
  const merged = isPlainObject(mergedValue) ? mergedValue : {};

  const run = str(merged.run, "run", c, { re: RUN_ID, what: "must be 3-41 characters: lowercase letters, digits and - (it names branches and containers)" }) ?? "";
  if (merged.run === undefined || merged.run === null) c.err("run", "is required");
  if (merged.objective === undefined || merged.objective === null) c.err("objective", "is required");
  const objective = readObjective(merged.objective, opts, c);
  const inputs = readInputs(merged.inputs, c, opts);
  const acceptance = readAcceptance(merged.acceptance, c, opts, templateId);
  const permissions = readPermissions(merged.permissions, c, templateId);
  const { model, providerSettings } = readModel(merged.model, merged.providerSettings, c);
  const generations = readGenerations(merged.generations, c);
  const contract: ContractDraft = {
    schemaVersion: SCHEMA_VERSION, run, template: templateId, objective, inputs, acceptance, permissions, model, providerSettings,
    effort: readEffort(merged.effort, c, effort),
    budget: readBudget(merged.budget, c),
    recovery: readRecovery(merged.recovery, c),
    generations,
    promotion: readPromotion(merged.promotion, c, inputs, run),
    runtime: readRuntime(merged.runtime, c),
    templateOptions: asObject(merged.templateOptions, "templateOptions", c),
    authorisation: readAuthorisation(merged.authorisation, c),
  };

  // Cross-field rules.
  checkGenerationsWithinBudget(generations, contract.budget, c);
  if (generations.enabled && templateId === "self-improve") c.err("generations.enabled", "generations apply to the finite templates (implement, deploy); self-improve drives its own cycles");
  const checkIds = new Set(acceptance.checks.map((k) => k.id));
  for (const [i, item] of objective.backlog.entries()) for (const id of item.acceptance ?? []) if (!checkIds.has(id)) c.err(`objective.backlog[${i}].acceptance`, `unknown check id "${id}"`);
  const serviceNames = new Set(permissions.network.services.map((s) => s.name));
  for (const [i, k] of acceptance.checks.entries()) if (k.type === "service-health" && (k.service === undefined || !serviceNames.has(k.service))) c.err(`acceptance.checks[${i}].service`, `"${String(k.service)}" is not a declared service (permissions.network.services)`);
  if (permissions.network.serviceImages.length && !permissions.network.services.length) c.warn("permissions.network.serviceImages", "images are allowlisted but no service uses them");
  if (template) {
    const api: ProblemSink = { err: c.err, warn: c.warn };
    template.validate(contract, api);
  }
  if (contract.promotion.policy === "local-branch" && !inputs.repository?.path && !contract.promotion.destinations.some((d) => d.kind === "local-branch" && d.repo) && template && template.id !== "self-improve") {
    c.err("promotion", 'policy "local-branch" needs a local repository: use inputs.repository.path or set promotion.destinations[].repo');
  }
  if (opts.checkFs) checkFilesystem(contract, c);
  scanSecrets(rawInput, "", c);
  if (c.problems.some((p) => p.level === "error")) return { ok: false, contract, problems: c.problems, legacy };
  // No errors: every value the readers could leave unset has been set. Proved here rather than
  // assumed, so a gap in the readers fails closed instead of starting a run on half a contract.
  if (!isComplete(contract)) {
    c.err("", "internal error: the contract resolved without errors but is incomplete");
    return { ok: false, contract, problems: c.problems, legacy };
  }
  return { ok: true, contract, problems: c.problems, legacy };
}

/** Whether a draft without errors has every value a RunContract requires. */
function isComplete(d: ContractDraft): d is RunContract {
  const b = d.budget;
  const ps = d.providerSettings;
  const a = d.authorisation;
  return isTemplateId(d.template)
    && isProviderId(d.model.provider)
    && typeof ps.upstream === "string" && typeof ps.apiKeyEnv === "string"
    && [b.totalUsd, b.perStepUsd, b.maxSteps, b.maxMinutes].every((v) => typeof v === "number")
    && d.acceptance.checks.every((k) => (k.type === "command" ? k.run !== undefined && (typeof k.run === "string" || isStringArray(k.run)) : k.type === "service-health" && typeof k.service === "string" && typeof k.path === "string" && typeof k.expectStatus === "number"))
    && d.permissions.network.services.every((s) => typeof s.port === "number" && (typeof s.health.path === "string" ? typeof s.health.expectStatus === "number" : Array.isArray(s.health.cmd)))
    && isPromotionPolicy(d.promotion.policy)
    && d.promotion.destinations.every((x) => x.kind === "local-branch" || (typeof x.url === "string" && typeof x.branch === "string"))
    && (a === null || (typeof a.boundaryDigest === "string" && typeof a.by === "string" && typeof a.at === "string"));
}

function stripUndefined(v: RawContract): unknown {
  return JSON.parse(JSON.stringify(v)) as unknown;
}

function checkFilesystem(contract: ContractDraft, c: ProblemSink): void {
  const repo = contract.inputs.repository;
  if (repo?.path) {
    if (!fs.existsSync(repo.path)) c.err("inputs.repository.path", `${repo.path} does not exist`);
    else if (!fs.existsSync(path.join(repo.path, ".git")) && !fs.existsSync(path.join(repo.path, "HEAD"))) c.err("inputs.repository.path", `${repo.path} is not a git repository`);
  }
  for (const [name, src] of Object.entries(contract.inputs.references)) if (!isUrlLike(src) && !fs.existsSync(src)) c.err(`inputs.references.${name}`, `${src} does not exist`);
  for (const [i, ov] of contract.acceptance.overlay.entries()) if (!fs.existsSync(ov.source)) c.err(`acceptance.overlay[${i}].source`, `${ov.source} does not exist`);
  for (const [i, d] of contract.promotion.destinations.entries()) if (d.kind === "local-branch" && d.repo && !fs.existsSync(d.repo)) c.err(`promotion.destinations[${i}].repo`, `${d.repo} does not exist`);
}

/** Digest of the whole resolved contract (run identity), excluding the authorisation record. */
export function contractDigest(contract: ContractDraft): string {
  const { authorisation: _authorisation, ...rest } = contract;
  return sha256(canonicalJson(rest));
}

/** Errors first, one per line, for CLI and error messages. */
export function formatProblems(problems: readonly Problem[]): string {
  const order = { error: 0, warning: 1 };
  return [...problems].sort((a, b) => order[a.level] - order[b.level]).map((p) => `${p.level === "error" ? "error" : "warning"}: ${p.path || "(contract)"}: ${p.message}`).join("\n");
}

/**
 * Whether a value read back from a run directory is a contract.json. The supervisor wrote it from a
 * resolved contract (read-only file mode) and loadRunContract checks its digest against state.json,
 * so it is not re-validated field by field: this checks that it is one at all.
 */
export function isStoredContract(value: unknown): value is RunContract {
  return isPlainObject(value) && value.schemaVersion === SCHEMA_VERSION && typeof value.run === "string" && isTemplateId(value.template);
}

/** The copy of the contract the worker reads (see workerContract). */
export interface WorkerContract {
  schemaVersion: typeof SCHEMA_VERSION;
  sanitised: true;
  run: string;
  template: TemplateId;
  objective: Objective;
  acceptance: { review: boolean; checks: Array<{ id: string; type: CheckType; required: boolean; description: string | undefined; timeoutMinutes: number; run?: CheckCommand | undefined; cwd?: string | undefined }> };
  unattended: UnattendedSettings;
  boundaryDigest?: string;
  permissions: {
    writeAreas: string[];
    network: { egress: Array<{ host: string; ports: number[] }>; services: Array<{ name: string; port: number; healthPath: string | null }> };
    egress: string[];
    remotes: string[];
    unattended: UnattendedSettings;
  };
  model: { worker: string };
  effort: EffortChoice;
  budget: Budget;
}

/**
 * The copy the worker may read (mounted read-only at /run/contract.json): no credentials, no promotion
 * remotes, no supervisor-only settings.
 *
 * The worker's tool firewall reads this file to enter unattended mode (packages/extensions/src/tool-firewall/
 * unattended.ts), and reads exactly these fields: a top-level `unattended` and `boundaryDigest`, and
 * `permissions.egress` (host names) and `permissions.remotes` (git remotes it may push to). The worker's only
 * remote is `origin`, the run's own bare repository; promotion happens on the host. tests/autonomy-boundary-smoke.ts
 * feeds this output to the real reader, so the two cannot drift apart unnoticed.
 *
 * @param contract the resolved contract
 * @param o.boundaryDigest the digest of the boundary the operator authorised
 */
export function workerContract(contract: RunContract, { boundaryDigest }: { boundaryDigest?: string | undefined } = {}): WorkerContract {
  const services = contract.permissions.network.services;
  return {
    schemaVersion: contract.schemaVersion,
    sanitised: true,
    run: contract.run,
    template: contract.template,
    objective: contract.objective,
    acceptance: { review: contract.acceptance.review, checks: contract.acceptance.checks.map(({ id, type, required, description, timeoutMinutes, run, cwd }) => ({ id, type, required, description, timeoutMinutes, ...(type === "command" ? { run, cwd } : {}) })) },
    unattended: contract.permissions.unattended,
    ...(boundaryDigest ? { boundaryDigest } : {}),
    permissions: {
      writeAreas: contract.permissions.writeAreas,
      network: { egress: contract.permissions.network.egress.map(({ host, ports }) => ({ host, ports })), services: services.map(({ name, port, health }) => ({ name, port, healthPath: health.path ?? null })) },
      // The hosts a worker's own commands may reach: the allowed egress hosts, and its run-scoped services by name.
      egress: [...contract.permissions.network.egress.map(({ host }) => host), ...services.map(({ name }) => name)],
      remotes: ["origin"],
      unattended: contract.permissions.unattended,
    },
    model: { worker: contract.model.worker },
    effort: contract.effort,
    budget: contract.budget,
  };
}

export { PROVIDERS, isProtectedBranch };
