// tool-firewall: the autonomy gate in front of every tool call.
//
// Each call is parsed into what it would actually do (shell.ts, classify.ts), placed in a tier
// (low / medium / high / critical) with reasons, checked against the session's history
// (trajectory.ts), and decided by the matrix below. Human decisions become calibrated
// precedents (feedback.ts); in auto mode a small model judges medium actions (judge.ts).
//
//   tier      manual      auto (coding)                           once-only (pentest / strict security)
//   low       allow       allow                                   allow
//   medium    ask         judge: allow, or block + tell the agent ask
//   high      ask         exact repeat of a grant / learned exact       ask, no grants (deny headless)
//                         action; else the judge when you allowed
//                         similar (grant or approved families); a judge
//                         block asks you with how it differs
//   critical  deny        deny                                    deny
//
// Headless (subagents, print mode) asks go to the human-console broker and fail closed.
import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSafe, rotateFileSafe, writeFileSafe } from "./shared/safe-fs.ts";
import { classifyToolCall, describeFamilies, effectiveTier, familiesFromSignature, maxTier, needsOperator, signatureOf, summarize, type Assessment, type ClassifyEnv, type Finding, type Tier } from "./classify.ts";
import { agentDir, configPath, feedbackPath, homeDir, knownHostsMeta, legacyAutoModePath, readConfig, resolveMode, resolvePolicy, tmpRoots, workspaceRoot, writeConfig, type FirewallConfig } from "./config.ts";
import { appendFeedback, exactStatus, forget, learnable, listLearned, operatorApproved, precedentsFor, redact, scopeRecords, readFeedback, statusFor, type FeedbackRecord } from "./feedback.ts";
import { appendJudgement, computeStats, distillInBackground, profileFor, readProfile, resetProfile, statsLine, distill } from "./profile.ts";
import { isUncertainBlock, runJudge, type Completer, type Verdict } from "./judge.ts";
import { loadSession, recordAction, rootSessionId, saveSession, trajectoryFindings, type SessionGrant, type SessionState } from "./trajectory.ts";
import { addApproval, describeScope, findExact, floorFor, readApprovals, reportProblems, revokeApprovals, sessionApprovals, similarApprovals, SESSION_APPROVAL_TTL_MS, type Approval, type ApprovalsView } from "./approvals.ts";
import { createUnattended, unattendedDenial, type ProvenanceIo, type UnattendedState } from "./unattended.ts";
import { loadConsoleKey, requestDigest, verifyAnswer } from "./console-auth.ts";
import { buildCard, buildDetail, CARD_MAX_LINES, CHOICE_ALLOW_ONCE, CHOICE_DENY_TELL, choicesFor, isSessionChoice, type CardExtras } from "./card.ts";

import { profileDefault, REGISTRY_KEY, resolveSecurity, securityPath, type SecuritySnapshot } from "./security-level.ts";
import { atRootTerminal, chooseAtTerminal, registerSecurityCommand } from "./security-command.ts";
import { disableCompanionInstalls } from "./companion-installs.ts";

type Decision = "allow" | "ask" | "deny";
/** Tools a kit child process (PI_KIT_INTERNAL_CHILD=1) is always denied. */
export const ROOT_ONLY_TOOLS: ReadonlySet<string> = new Set(["workflow"]);

const EFFORT_KEY = Symbol.for("pi-kit.effort");

/**
 * True when the effort extension reports ultracode standing mode with workflow runs pre-authorised
 * (the operator answered Yes to its No-first select this session; docs/effort.md, "Ultracode").
 * Read through the registry with type guards only; anything else is false.
 */
export function workflowPreauthorised(): boolean {
  try {
    const registry: unknown = Reflect.get(globalThis, EFFORT_KEY);
    if (typeof registry !== "object" || registry === null) return false;
    const read: unknown = Reflect.get(registry, "standing");
    if (typeof read !== "function") return false;
    const state: unknown = Reflect.apply(read, registry, []);
    return typeof state === "object" && state !== null && Reflect.get(state, "on") === true && Reflect.get(state, "preauthorised") === true;
  } catch {
    return false;
  }
}

type ToolRule = { decision?: Decision; risk_class?: string };

type CommandRule = { pattern: string; flags?: string; risk_class?: string; reason?: string; re?: RegExp };

type RuleSet = { deny: CommandRule[]; ask: CommandRule[] };

type FirewallPolicy = {
  defaults: { unknown: Decision };
  tools: Record<string, ToolRule>;
  // Operator rules: matched in every policy, against the raw command and each parsed step.
  command_rules: RuleSet;
  // Extra rules for the strict pentest policy, matched against the raw command text.
  pentest: RuleSet;
};

export type FirewallDeps = {
  // Model call for the auto-mode judge (tests inject a stub).
  complete?: Completer | null;
};

// An invalid policy has no safe subset: a lost deny may cover any call. Deny everything
// until the operator repairs the file, including normally trusted pi identities.
const BUILTIN_FALLBACK: FirewallPolicy = {
  defaults: { unknown: "deny" },
  tools: {},
  command_rules: { deny: [], ask: [] },
  pentest: { deny: [], ask: [] },
};

let cachedPolicy: FirewallPolicy = BUILTIN_FALLBACK;
let cachedPolicyPath: string | null = null;
let cachedPolicyDigest = "";
let cachedPolicyLabel = "builtin-fallback";
let lastPolicyWarnings: string[] = [];
// Rules we changed but still enforce (e.g. stateful flags dropped) — NOT skips.
let lastPolicyAdjustments: string[] = [];

function workspacePath(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

// Anything that is an object (arrays included): the shape every loose read below starts from.
// True when the project auto-mode.json exists and does not already read {enabled: true}, so
// /auto on rewriting it would change that file's own value (whatever PI_KIT_AUTO_MODE says).
function legacyPinnedOff(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  try {
    const raw: unknown = JSON.parse(text);
    return !(isRecord(raw) && raw.enabled === true);
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// `value.key` for a value of unknown shape: undefined unless it is an object.
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The shipped starter policy lives inside the extension so it travels into every generated
// surface and installed profile.
function embeddedPolicyCandidates(): string[] {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL("./default-policy.json", import.meta.url)));
  } catch {
    /* import.meta.url unavailable */
  }
  candidates.push(workspacePath("extensions", "tool-firewall", "default-policy.json"));
  candidates.push(workspacePath("kit", "policies", "default.json"));
  return candidates;
}

function policyPath(): string | null {
  const configured = process.env.PI_KIT_FIREWALL_POLICY?.trim();
  if (configured) return configured;
  for (const candidate of embeddedPolicyCandidates()) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function auditPath(): string {
  return process.env.PI_KIT_FIREWALL_AUDIT_LOG || workspacePath(".pi", "tool-firewall-audit.jsonl");
}

function normalizeDecision(value: unknown): Decision | null {
  return value === "allow" || value === "ask" || value === "deny" ? value : null;
}

// Invalid rules invalidate the whole policy; diagnostics explain what must be repaired.
function compileCommandRules(rules: unknown, listLabel: string): CommandRule[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) {
    lastPolicyWarnings.push(`${listLabel} is not an array — policy invalid`);
    return [];
  }
  const out: CommandRule[] = [];
  rules.forEach((rule: unknown, index) => {
    if (!isRecord(rule)) {
      lastPolicyWarnings.push(`${listLabel}[${index}] is not an object — policy invalid`);
      return;
    }
    const pattern = rule.pattern;
    if (typeof pattern !== "string") {
      lastPolicyWarnings.push(`${listLabel}[${index}] has no string "pattern" — policy invalid`);
      return;
    }
    // Stateful flags (g/y) make RegExp.test carry lastIndex across calls, so a rule that
    // should deny can be skipped on a later text (fail open). Strip them before compiling.
    for (const [key, value] of Object.entries(rule)) {
      if (!["pattern", "flags", "risk_class", "reason"].includes(key) || typeof value !== "string") lastPolicyWarnings.push(`${listLabel}[${index}].${key} is invalid`);
    }
    const rawFlags = typeof rule.flags === "string" ? rule.flags : "";
    const flags = rawFlags.replace(/[gy]/g, "");
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (error) {
      lastPolicyWarnings.push(`${listLabel}[${index}] pattern is invalid regex (${errorText(error)}) — policy invalid: ${pattern}`);
      return;
    }
    if (flags !== rawFlags) {
      lastPolicyAdjustments.push(`${listLabel}[${index}] dropped stateful regex flag(s) from "${rawFlags}" — they make matching order-dependent, but the rule is still enforced`);
    }
    out.push({ pattern, flags, risk_class: typeof rule.risk_class === "string" ? rule.risk_class : "unknown", reason: typeof rule.reason === "string" ? rule.reason : pattern, re });
  });
  return out;
}

function checkPolicyObject(value: unknown, label: string, keys?: string[]): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    lastPolicyWarnings.push(`${label} is not an object`);
    return false;
  }
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) lastPolicyWarnings.push(`${label}.${key} is unrecognised`);
  return true;
}

function normalizePolicy(value: unknown): FirewallPolicy {
  if (!checkPolicyObject(value, "policy", ["version", "_comment", "defaults", "tools", "command_rules", "policies"])) return BUILTIN_FALLBACK;
  const raw = value;
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) lastPolicyWarnings.push("unsupported policy version");
  if (raw._comment !== undefined && typeof raw._comment !== "string") lastPolicyWarnings.push("policy._comment is not a string");
  if (raw.defaults !== undefined && checkPolicyObject(raw.defaults, "defaults", ["unknown"]) && !normalizeDecision(raw.defaults.unknown)) lastPolicyWarnings.push("defaults.unknown is invalid");
  const tools: Record<string, ToolRule> = {};
  if (raw.tools !== undefined && checkPolicyObject(raw.tools, "tools")) for (const [name, rule] of Object.entries(raw.tools)) {
    if (!checkPolicyObject(rule, `tools.${name}`, ["decision", "risk_class"])) continue;
    const decision = normalizeDecision(rule.decision);
    if (!decision || (rule.risk_class !== undefined && typeof rule.risk_class !== "string")) {
      lastPolicyWarnings.push(`tools.${name} has an invalid decision or risk_class`);
      continue;
    }
    // Define own properties even for names such as __proto__.
    Object.defineProperty(tools, name, { value: { decision, risk_class: typeof rule.risk_class === "string" ? rule.risk_class : "unknown" }, enumerable: true });
  }
  const commandRules = raw.command_rules;
  if (commandRules !== undefined) checkPolicyObject(commandRules, "command_rules", ["deny", "ask"]);
  if (raw.policies !== undefined) checkPolicyObject(raw.policies, "policies", ["pentest"]);
  const pentest = field(raw.policies, "pentest");
  if (pentest !== undefined) checkPolicyObject(pentest, "policies.pentest", ["command_rules"]);
  const pentestRules = field(pentest, "command_rules");
  if (pentestRules !== undefined) checkPolicyObject(pentestRules, "policies.pentest.command_rules", ["deny", "ask"]);
  const policy: FirewallPolicy = {
    defaults: { unknown: normalizeDecision(field(raw.defaults, "unknown")) || "ask" },
    tools,
    command_rules: { deny: compileCommandRules(field(commandRules, "deny"), "command_rules.deny"), ask: compileCommandRules(field(commandRules, "ask"), "command_rules.ask") },
    pentest: { deny: compileCommandRules(field(pentestRules, "deny"), "policies.pentest.command_rules.deny"), ask: compileCommandRules(field(pentestRules, "ask"), "policies.pentest.command_rules.ask") },
  };
  return lastPolicyWarnings.length ? BUILTIN_FALLBACK : policy;
}

type PolicySource = { file: string | null; text?: string; digest: string; error?: string };

function policySource(): PolicySource {
  const file = policyPath();
  try {
    if (!file) throw new Error("no policy file found");
    const text = fs.readFileSync(file, "utf8");
    return { file, text, digest: crypto.createHash("sha256").update(text).digest("hex") };
  } catch (error) {
    return { file, digest: "unreadable", error: errorText(error) };
  }
}

function reloadPolicy(source = policySource()): void {
  lastPolicyWarnings = [];
  lastPolicyAdjustments = [];
  cachedPolicyPath = source.file;
  cachedPolicyDigest = source.digest;
  let policy = BUILTIN_FALLBACK;
  try {
    if (source.text === undefined) throw new Error(source.error);
    const parsed: unknown = JSON.parse(source.text);
    policy = normalizePolicy(parsed);
  } catch (error) {
    lastPolicyWarnings.push(`policy cannot be loaded: ${errorText(error)}`);
  }
  cachedPolicy = policy;
  if (lastPolicyWarnings.length) {
    try { process.stderr.write(`tool-firewall: invalid policy; fail-closed (deny all): ${lastPolicyWarnings.join("; ")}\n`); } catch { /* diagnostics cannot weaken enforcement */ }
  }
  cachedPolicyLabel = cachedPolicy === BUILTIN_FALLBACK ? "fail-closed (deny all)" : source.file || "fail-closed";
}

function getPolicy(ctx?: ExtensionContext): FirewallPolicy {
  const source = policySource();
  if (source.file !== cachedPolicyPath || source.digest !== cachedPolicyDigest) {
    reloadPolicy(source);
    if (lastPolicyWarnings.length) {
      audit({ event: "policy_load_error", warnings: lastPolicyWarnings });
      const warning = `tool-firewall: WARNING — invalid policy; fail-closed (deny all): ${lastPolicyWarnings.join("; ")}`;
      try { ctx?.ui?.notify?.(warning, "warning"); } catch { /* stderr already reported it; enforcement continues */ }
    }
  }
  return cachedPolicy;
}

function policyRevision(): string {
  return `${cachedPolicyPath ?? ""}:${cachedPolicyDigest}`;
}

function ruleCount(policy: FirewallPolicy): number {
  return Object.keys(policy.tools).length + policy.command_rules.deny.length + policy.command_rules.ask.length + policy.pentest.deny.length + policy.pentest.ask.length;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(entries.sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => [k, sortJson(v)]));
}

// Deep-freezes approved tool arguments. A later mutation then throws (extensions are ES
// modules, so strict mode) and pi turns the throw into a blocked call: fail closed.
// Byte arrays cannot be frozen and are left as they are.
function seal(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value)) return;
  seen.add(value);
  for (const k of Object.keys(value)) {
    try {
      seal(Reflect.get(value, k), seen);
    } catch {
      /* getter threw */
    }
  }
  try {
    Object.freeze(value);
  } catch {
    /* exotic object */
  }
}

// The test hook's OS facts: each one present must be a function, or the real OS facts are used.
function isProvenanceIo(v: unknown): v is ProvenanceIo {
  return isRecord(v) && ["getuid", "mountinfo", "writable", "namespaces", "subuid"].every((k) => v[k] === undefined || typeof v[k] === "function");
}

function actionHash(toolName: string, input: unknown): string {
  return crypto.createHash("sha256").update(stableJson({ toolName, input })).digest("hex");
}

// The hash a workflow run's console broker groups requests and keeps run grants and denials by.
// A relative path or a shell command means a different action in another checkout, so it also
// binds the resolved cwd and workspace root: a run grant in one worktree never approves the same
// input in another. (actionHash stays input-only: the audit log and tool-capture join on it.)
function runActionHash(toolName: string, input: unknown, cwd: string, workspace: string): string {
  return crypto.createHash("sha256").update(stableJson({ toolName, input, cwd: path.resolve(cwd), workspace: path.resolve(workspace) })).digest("hex");
}

// EFF-6: like the judgements file, the audit log is renamed to <file>.1 (one old copy, replacing the
// previous one) before an append once it passes 4 MiB.
const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024;

function audit(record: Record<string, unknown>): void {
  try {
    const filePath = auditPath();
    // The default log is in the workspace a cloned repository controls, so it is written without
    // following symlinks from the workspace root down (./shared/safe-fs.ts); an operator-set
    // PI_KIT_FIREWALL_AUDIT_LOG is trusted. tests/workspace-symlink-smoke.ts pins this.
    const options = process.env.PI_KIT_FIREWALL_AUDIT_LOG ? { mode: 0o600 } : { root: process.cwd(), mode: 0o600 };
    try {
      rotateFileSafe(filePath, AUDIT_ROTATE_BYTES, options);
    } catch {
      /* a refused rotation leaves the append below to refuse too */
    }
    appendFileSafe(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, options);
  } catch {
    /* the audit log must never break a tool call */
  }
}

function toolNameFrom(event: unknown): string {
  const name: unknown = field(event, "toolName") || field(event, "name") || "unknown";
  return String(name);
}

function commandTextFrom(input: unknown): string | null {
  const command = field(input, "command") ?? field(input, "cmd") ?? field(input, "script");
  return typeof command === "string" ? command : null;
}

// Collapse quote/backslash fragmentation before regex rules (`r''m`, `r\m`).
function deobfuscateShellText(command: string): string {
  return command.replace(/'{2,}|"{2,}/g, "").replace(/\\(?=[A-Za-z])/g, "");
}

function regexFindings(policy: FirewallPolicy, policyName: string, a: Assessment): Finding[] {
  const command = a.command;
  if (command === undefined) return [];
  const out: Finding[] = [];
  const texts = new Set([command, deobfuscateShellText(command), ...a.segments.map((s) => s.text)]);
  const sets: { rules: RuleSet; label: string }[] = [{ rules: policy.command_rules, label: "policy rule" }];
  if (policyName === "pentest") sets.push({ rules: policy.pentest, label: "pentest rule" });
  for (const { rules, label } of sets) {
    for (const rule of rules.deny) if ([...texts].some((t) => rule.re?.test(t))) out.push({ tier: "critical", effect: "security_control", code: "policy_deny_rule", detail: `${label}: ${rule.reason}`, key: `rule ${rule.pattern}` });
    for (const rule of rules.ask) if ([...texts].some((t) => rule.re?.test(t))) out.push({ tier: "high", effect: "unknown_exec", code: "policy_ask_rule", detail: `${label}: ${rule.reason}`, key: `rule ${rule.pattern}` });
  }
  return out;
}

function humanConsoleRoot(): string {
  return process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim() || workspacePath(".pi", "human-console");
}

// `unavailable` is set when the request could not even be filed (the console directory cannot be
// created or written): the outcome is UNCERTAIN, never "the operator declined".
type BrokerResult = { approved: boolean; timedOut: boolean; aborted?: boolean | undefined; unavailable?: string; timeoutMs?: number; choice?: string | undefined; note?: string | undefined };

// Headless requests go to the human console. `choices` lets a console that supports them offer
// the same menu as the interactive card (allow once / allow for the session / deny / deny and
// tell); an older console answers yes/no, which is treated as allow once / deny. The wait is always
// bounded: by PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS (default 15 minutes; subagents get a shorter one from
// their launcher) and by the turn's abort signal, so nothing waits on a console that is not there.
// A workflow agent (a kit child the subagent runner started for a script-workflow run) carries
// its run id in PI_KIT_WORKFLOW_RUN_ID. Its requests name the run and the exact action hash (tool,
// input, cwd and workspace root: runActionHash), so the console's run-scoped broker can group them, keep denials and count distinct approvals per run.
const WORKFLOW_RUN_ID = /^wf-[a-z0-9-]{1,60}$/;
function workflowRunOf(): string | undefined {
  const runId = process.env.PI_KIT_WORKFLOW_RUN_ID;
  return process.env.PI_KIT_INTERNAL_CHILD === "1" && typeof runId === "string" && WORKFLOW_RUN_ID.test(runId) ? runId : undefined;
}

function brokerApproval(toolName: string, input: unknown, tier: Tier, reason: string, body: string, note: string | null, ctx: ExtensionContext, signal?: AbortSignal, choices?: string[], hash?: string): Promise<BrokerResult> {
  const root = humanConsoleRoot();
  const pending = path.join(root, "pending");
  const resolved = path.join(root, "resolved");
  const id = crypto.randomUUID();
  const timeoutMs = Math.max(1, Number(process.env.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) || 900000);
  // Subagent launchers name the agent on the context (not part of pi's declared shape).
  const agentName = field(field(ctx, "agent"), "name") || field(ctx, "agentName");
  const titleAgent: unknown = agentName || (process.env.PI_KIT_INTERNAL_CHILD ? "subagent" : "headless session");
  const workflowRun = workflowRunOf();
  // The console and its answers sit where the agent works, so an answer counts only when the console
  // signed it with its key, bound to these exact pending bytes (console-auth.ts). Without a usable key
  // no answer could be accepted: report that at once instead of waiting for a timeout.
  const key = loadConsoleKey({ create: false });
  if (!key.ok) return Promise.resolve({ approved: false, timedOut: false, unavailable: `the human console's answer key cannot be used (${key.why})`, timeoutMs });
  const pendingText = JSON.stringify({ id, kind: "approval", createdAt: new Date().toISOString(), requester: { pid: process.pid, sessionId: sessionIdOf(ctx), agent: agentName || "root" }, toolName, input, riskClass: tier, reason, title: `Approve tool call? (${String(titleAgent)})`, body, choices, autoModeRationale: note, timeoutMs, ...(workflowRun !== undefined && hash !== undefined ? { workflowRun, actionHash: hash } : {}) });
  const digest = requestDigest(pendingText);
  try {
    fs.mkdirSync(pending, { recursive: true });
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(path.join(pending, `${id}.json`), pendingText);
  } catch (error) {
    return Promise.resolve({ approved: false, timedOut: false, unavailable: `could not file the request in the human console at ${root} (${errorText(error)})`, timeoutMs });
  }
  audit({ event: "human_console_pending", toolName, id });
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    // finish() only runs from the interval callback, so `timer` (declared below) is always set by then.
    const finish = (result: BrokerResult) => {
      clearInterval(timer);
      try {
        fs.unlinkSync(path.join(pending, `${id}.json`));
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(path.join(resolved, `${id}.json`));
      } catch {
        /* already gone */
      }
      resolve({ timeoutMs, ...result });
    };
    const timer = setInterval(() => {
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(path.join(resolved, `${id}.json`), "utf8"));
      } catch {
        value = undefined; /* waiting */
      }
      if (value !== undefined) {
        const checked = verifyAnswer(key.key, { id, requestDigest: digest }, value);
        if (checked.ok) {
          const choice = checked.answer !== null && choices?.includes(checked.answer) ? checked.answer : undefined;
          const note = checked.note?.trim() ? checked.note.trim().slice(0, 500) : undefined;
          // Audit is best-effort (it swallows its own errors) and MUST never throw; finish()
          // is called regardless and MUST stay unconditional so the promise always settles.
          audit({ event: "human_console_resolved", toolName, id, approved: checked.approved, choice });
          finish({ approved: checked.approved, timedOut: false, choice, note });
          return;
        }
        // A forged, foreign or rewritten answer is dropped and the wait goes on (at worst a timeout).
        audit({ event: "human_console_answer_rejected", toolName, id, why: checked.why });
        try {
          fs.unlinkSync(path.join(resolved, `${id}.json`));
        } catch {
          /* already gone */
        }
      }
      if (signal?.aborted || Date.now() >= deadline) {
        // Invariant: audit() is non-throwing and best-effort; finish() must remain
        // unconditional (it is deliberately outside any try block) so the broker promise
        // always settles. The ordering here is not what makes this safe.
        audit({ event: "human_console_timeout", toolName, id, aborted: signal?.aborted || undefined });
        finish({ approved: false, timedOut: true, aborted: signal?.aborted || undefined });
      }
    }, Math.min(1000, timeoutMs));
    timer.unref?.();
  });
}

// An interactive prompt (card, confirm, note) is bounded too: pi's dialog options carry a timeout and
// an abort signal, and this wrapper also enforces both when a UI implementation ignores them (an
// RPC client that never answers, a UI that was closed), so a tool call never waits on a dialog that
// nobody can answer. PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS overrides the 15-minute default.
export function promptTimeoutMs(): number {
  const n = Number(process.env.PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 900000;
}

type Prompted<T> = { kind: "answered"; value: T } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; message: string };

function boundedPrompt<T>(ctx: ExtensionContext, run: (opts: ExtensionUIDialogOptions & { timeout: number }) => Promise<T> | T): Promise<Prompted<T>> {
  const timeout = promptTimeoutMs();
  const signal: AbortSignal | undefined = ctx?.signal;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const finish = (r: Prompted<T>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish({ kind: "aborted" });
    if (signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    timer = setTimeout(() => finish({ kind: "timeout" }), timeout);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => run(signal ? { signal, timeout } : { timeout }))
      .then((value) => finish({ kind: "answered", value }), (error: unknown) => finish({ kind: "error", message: errorText(error) }));
  });
}

// What the operator, the agent and the audit log see for each way an action can end. Exactly one of
// these applies to every refusal, so the three situations are never confused:
//   HARD DENY         policy says never; no approval and no judge can override it.
//   UNCERTAIN         the automatic layers could not settle it (judge unsure, unavailable or timed out;
//                     an opaque command) or nobody could be asked. With an operator reachable it is
//                     escalated; without one it fails closed, bounded, with a message the agent can relay.
//   OPERATOR DECISION a human allowed or denied it; remembered only within the scope the card named.
// (A high-confidence block by the auto-mode judge is its own labelled case: final, with the reason.)
export type Outcome = "hard_deny" | "uncertain" | "operator_decision" | "judge_block";
const TAG: Record<Outcome, string> = { hard_deny: "HARD DENY", uncertain: "UNCERTAIN", operator_decision: "OPERATOR DECISION", judge_block: "AUTO-MODE BLOCK" };

function sessionIdOf(ctx: ExtensionContext | undefined): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id) return id;
  } catch {
    /* optional */
  }
  // Older runtimes and test harnesses put the id on the context itself.
  const legacy = field(ctx, "sessionId");
  return typeof legacy === "string" && legacy ? legacy : `pid-${process.pid}`;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (isRecord(value)) return textOf(value.text ?? value.content ?? "");
  return "";
}

// The latest user request (not the session's first message).
// goal-core's session goal, if any: the judge weighs scope against it as well as the request.
function readGoal(cwd: string, workspace: string): string | undefined {
  for (const dir of new Set([cwd, workspace])) {
    try {
      const text = fs.readFileSync(path.join(dir, ".pi", "GOAL.yaml"), "utf8").trim();
      if (text) return text.slice(0, 2000);
    } catch {
      /* no goal here */
    }
  }
  return undefined;
}

function latestRequest(ctx: ExtensionContext, fallback: string): string {
  if (fallback) return fallback;
  try {
    const entries: unknown[] = ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const m = field(entry, "message") ?? entry;
      if (field(m, "role") === "user") return textOf(field(m, "content") ?? m);
    }
  } catch {
    /* optional */
  }
  return "";
}

function judgeModelName(ctx: ExtensionContext, cfg: FirewallConfig): string | undefined {
  return process.env.PI_KIT_AUTO_MODE_MODEL?.trim() || cfg.judgeModel || (ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
}

// Default judge completer: the configured judge model, else the session model.
function modelCompleter(ctx: ExtensionContext, cfg: FirewallConfig): Completer | null {
  const registry = ctx?.modelRegistry;
  if (!registry) return null;
  let model: Model<Api> | undefined = ctx.model;
  const wanted = process.env.PI_KIT_AUTO_MODE_MODEL?.trim() || cfg.judgeModel;
  if (wanted) {
    const slash = wanted.indexOf("/");
    const found = slash > 0 ? registry.find?.(wanted.slice(0, slash), wanted.slice(slash + 1)) : undefined;
    if (found) model = found;
  }
  if (!model) return null;
  const chosen = model;
  return async (system, prompt, signal) => {
    const auth = await registry.getApiKeyAndHeaders(chosen);
    if (!auth?.ok) throw new Error(`no request auth for ${chosen.provider}`);
    const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
    const reply = await completeSimple(chosen, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}), ...(headers ? { headers } : {}), ...(signal ? { signal } : {}), maxTokens: 300 });
    return reply.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  };
}

const JUDGE_SAFE_STRICT = new Set(["read", "network_read"]);

// Protections registry (shared, in-process). Each mandatory protection (tool-firewall,
// secret-guard, protected-paths) records its name in globalThis[Symbol.for("pi-kit.protections")]
// once its factory has installed its hooks: a Set of names with `has(name)` and `list()` (sorted),
// so a trusted launcher can check that a session loaded what it must have loaded. Extensions are
// self-contained, so each carries this same small helper; whichever loads first creates the
// registry. It is a consistency check, not a boundary against code running in the same process.
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");

/** What another protection may already have stored under the key (every copy of this helper stores a Set). */
interface RegistryLike extends Iterable<unknown> {
  add(name: string): unknown;
  has(name: string): unknown;
  list?: unknown;
}

function isRegistryLike(value: unknown): value is RegistryLike {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && "add" in value && typeof value.add === "function"
    && "has" in value && typeof value.has === "function"
    && Symbol.iterator in value && typeof value[Symbol.iterator] === "function";
}

function registerProtection(name: string): void {
  try {
    const g = globalThis as Record<symbol, unknown>;
    const existing = g[PROTECTIONS_KEY];
    let reg: RegistryLike;
    if (isRegistryLike(existing)) reg = existing;
    else {
      reg = new (class ProtectionRegistry extends Set<string> {})();
      g[PROTECTIONS_KEY] = reg;
    }
    reg.add(name);
    if (typeof reg.list !== "function") Object.defineProperty(reg, "list", { value: () => [...reg].map(String).sort(), enumerable: false, configurable: true });
  } catch {
    /* the registry must never break the protection itself */
  }
}

export default function toolFirewall(pi: ExtensionAPI, deps: FirewallDeps | ((...args: never[]) => unknown) = {}) {
  const d: FirewallDeps = typeof deps === "function" ? {} : deps;
  disableCompanionInstalls();
  let session: SessionState | null = null;
  let lastRequest = "";
  let lastDetail = "";
  let queue: Promise<unknown> = Promise.resolve();
  // Unattended mode is decided once, here, from the environment the supervisor built and the read-only
  // contract it names: nothing that happens later (a config file, /auto, a tool call, a changed variable)
  // can switch it on, and a changed contract switches it off (unattended.ts).
  // The provenance facts (mount table, owner) come from the OS; tests present their own through a global
  // that only code inside this process can set (a variable in the environment could be set by an agent).
  const provenanceSlot: unknown = Reflect.get(globalThis, Symbol.for("pi-kit.test.unattended-provenance"));
  const provenanceIo = isProvenanceIo(provenanceSlot) ? provenanceSlot : undefined;
  const unattended = createUnattended({ workspace: workspaceRoot(process.cwd()), cwd: process.cwd(), agentDir: agentDir(), policy: resolvePolicy(readConfig()).policy, ...(provenanceIo !== undefined ? { io: provenanceIo } : {}) });
  {
    const st = unattended.state();
    try {
      if (st.requested && !st.active) process.stderr.write(`tool-firewall: WARNING — unattended mode was requested (PI_KIT_UNATTENDED) but is NOT active: ${st.warnings[0]}. Failing closed: the normal interactive/headless approval rules apply, so anything above the routine tier needs an operator.\n`);
      else if (st.active) process.stderr.write(`tool-firewall: UNATTENDED mode (${st.boundary} boundary, contract sha256:${st.digest?.slice(0, 12)}${st.autoApprove ? ", auto-approve" : ", no auto-approve"}): no prompts and no judge inside the zone; hard denies and anything outside the zone fail closed.\n`);
    } catch {
      /* stderr unavailable */
    }
  }

  const sessionFor = (ctx: ExtensionContext): SessionState => {
    const id = sessionIdOf(ctx);
    if (session?.id !== id) session = loadSession(id);
    return session;
  };

  // ~/.ssh/config is writable by the agent (with an approval), so hosts it names are trusted only while
  // it is unchanged since the session started; a change means the firewall trusts firewall.json's hosts
  // alone until the operator runs /firewall reload.
  let sshBaseline: number | null = null;
  let sshWarned = false;
  let lastProblemKey = "";

  // Output is never silent: an interactive UI shows a notice; a headless session (print mode, a
  // subagent) has a no-op UI, so the text goes to stderr instead.
  const say = (ctx: ExtensionContext | undefined, text: string, level: "info" | "warning" | "error" = "info"): void => {
    try {
      if (ctx?.hasUI !== false && typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(text, level);
        return;
      }
    } catch {
      /* fall through to stderr */
    }
    try {
      process.stderr.write(`${text}\n`);
    } catch {
      /* stderr unavailable */
    }
  };

  let securityCwd = process.cwd();
  const securityDefault = (ctx?: ExtensionContext, policy = resolvePolicy(readConfig()).policy) => profileDefault(ctx?.cwd || securityCwd, policy);
  const securitySnapshot = (ctx?: ExtensionContext, policy = resolvePolicy(readConfig()).policy): SecuritySnapshot => {
    if (ctx?.cwd) securityCwd = ctx.cwd;
    return resolveSecurity(securityDefault(ctx, policy), policy);
  };
  const securityRegistry = Object.freeze({ snapshot: () => securitySnapshot() });
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = securityRegistry;
  pi.on("session_shutdown", async () => {
    if ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] === securityRegistry) Reflect.deleteProperty(globalThis, REGISTRY_KEY);
  });
  let securityRevocationPending = false;
  const syncSecurity = (ctx: ExtensionContext, security: SecuritySnapshot, force = false): void => {
    const s = sessionFor(ctx);
    const binding = JSON.stringify(security);
    // Legacy sessions predate the level binding. Preserve balanced migration behaviour,
    // but never carry an unbound legacy grant into another level.
    const unboundChange = s.securityBinding === undefined && security.effective !== "balanced";
    if (force || securityRevocationPending || unboundChange || (s.securityBinding !== undefined && s.securityBinding !== binding)) {
      securityRevocationPending = true;
      const result = revokeApprovals(["session"], { root: rootSessionId(s.id), workspace: workspaceRoot(ctx.cwd || process.cwd()) });
      // If withdrawal fails, do not proceed to a stale grant. The tool-call hook fails closed,
      // and the next decision retries withdrawal before consulting approvals or the judge.
      if (result.error) throw new Error(`security level changed but session approvals could not be revoked: ${result.error}`);
      s.judgeCache = {};
      securityRevocationPending = false;
    }
    s.securityBinding = binding;
    saveSession(s);
  };
  registerSecurityCommand(pi, securitySnapshot, (ctx) => securityDefault(ctx), (ctx) => syncSecurity(ctx, securitySnapshot(ctx), true), say, promptTimeoutMs);

  // Malformed approval entries are ignored (never an allow); this makes sure someone is told: stderr
  // once per distinct set, the audit log, and a warning in an interactive session.
  const noteApprovalProblems = (view: ApprovalsView, ctx?: ExtensionContext): string[] => {
    const problems = reportProblems(view);
    const key = problems.join("|");
    if (key !== lastProblemKey) {
      lastProblemKey = key;
      if (problems.length) {
        audit({ event: "approvals_malformed", file: view.file, problems: problems.slice(0, 20) });
        try {
          if (ctx?.hasUI !== false) ctx?.ui?.notify?.(`tool-firewall: WARNING — ${problems.length} malformed item(s) in ${view.file} were ignored (never treated as an allow): ${problems.slice(0, 3).join("; ")}`, "warning");
        } catch {
          /* notification is best effort */
        }
      }
    }
    return problems;
  };

  const trustedHosts = (cfg: FirewallConfig, ctx?: ExtensionContext): Set<string> => {
    const kh = knownHostsMeta(cfg);
    sshBaseline ??= kh.sshMtime;
    if (kh.sshMtime <= sshBaseline) return kh.hosts;
    if (!sshWarned) {
      sshWarned = true;
      audit({ event: "ssh_config_changed", note: "hosts named only in ~/.ssh/config are not trusted until /firewall reload" });
      say(ctx, "tool-firewall: ~/.ssh/config changed during this session, so hosts it names are not trusted for read-only ssh until you run /firewall reload (hosts in firewall.json still are)", "warning");
    }
    return new Set([...kh.fromConfig].filter((h) => !kh.untrusted.has(h)));
  };

  // The judge's view of a stored session approval.
  const toGrant = (a: Approval): SessionGrant => ({ at: Date.parse(a.createdAt), session: a.grantedBy.session, tool: a.tool, hash: a.hash, tier: a.tier, command: a.action.command, steps: a.action.steps, reasons: a.action.reasons, chain: a.action.chain, families: a.families, scopes: a.scopes });

  pi.on("session_start", async (_event, ctx) => {
    try {
      securityCwd = ctx?.cwd || process.cwd();
      (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = securityRegistry;
      const security = securitySnapshot(ctx);
      if (security.warnings.length) say(ctx, security.warnings.join("\n"), "warning");
      reloadPolicy();
      const policy = getPolicy();
      const cfg = readConfig();
      const mode = resolveMode(ctx?.cwd || process.cwd(), cfg).mode;
      const pol = resolvePolicy(cfg).policy;
      session = null;
      lastRequest = "";
      lastDetail = "";
      sshBaseline = knownHostsMeta(cfg).sshMtime;
      sshWarned = false;
      // Export the root session before any subagent is spawned, so children share its approvals.
      rootSessionId(sessionIdOf(ctx));
      ctx.ui?.notify?.(`tool-firewall: loaded (${cachedPolicyLabel}, default unknown=${policy.defaults.unknown}, rules=${ruleCount(policy)}, mode=${mode}, policy=${pol})`, "info");
      if (lastPolicyWarnings.length > 0 || lastPolicyAdjustments.length > 0) {
        audit({ event: "policy_rule_warnings", warnings: lastPolicyWarnings, adjustments: lastPolicyAdjustments });
        if (lastPolicyWarnings.length > 0) ctx.ui?.notify?.(`tool-firewall: WARNING — ${lastPolicyWarnings.length} invalid policy item(s); fail-closed (deny all) active: ${lastPolicyWarnings.join("; ")}`, "warning");
      }
      noteApprovalProblems(readApprovals(), ctx);
      unattended.current(pol, { cwd: ctx?.cwd || process.cwd(), workspace: workspaceRoot(ctx?.cwd || process.cwd()) }); // a contract inside this workspace turns it off
      const st = unattended.state();
      if (st.requested && !st.active) ctx.ui?.notify?.(`tool-firewall: WARNING — unattended mode was requested but is NOT active (${st.warnings[0]}). Failing closed: normal approval rules apply.`, "warning");
      else if (st.active) ctx.ui?.notify?.(`tool-firewall: ${st.label} — contract sha256:${st.digest?.slice(0, 12)}; no prompts, no judge; hard denies and outside-the-zone actions fail closed`, "warning");
      unattended.publish();
      if (lastPolicyAdjustments.length > 0) ctx.ui?.notify?.(`tool-firewall: WARNING — ${lastPolicyAdjustments.length} rule(s) adjusted but still enforced: ${lastPolicyAdjustments.join("; ")}`, "warning");
    } catch (error) {
      cachedPolicy = BUILTIN_FALLBACK;
      audit({ event: "policy_load_error", error: String(error) });
      ctx.ui?.notify?.("tool-firewall: policy load failed; fail-closed (deny all) active", "warning");
    }
  });

  pi.on("before_agent_start", async (event) => {
    // Only a user prompt is the operator's request. A run that an extension starts with a custom
    // message (pi 1.2+) carries no prompt and must not stand in for what the operator asked.
    if ("prompt" in event && typeof event.prompt === "string") lastRequest = event.prompt;
    return undefined;
  });

  // Decisions are serialised so parallel tool calls see each other's effects and only one
  // approval card is open at a time.
  pi.on("tool_call", (event, ctx) => {
    const run = queue.then(() => decide(event, ctx));
    queue = run.catch(() => undefined);
    return run;
  });

  async function decide(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
    const started = Date.now();
    const toolName = toolNameFrom(event);
    const rawInput: unknown = event?.input;
    const input = rawInput || {};
    const hash = actionHash(toolName, input);
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
    const cfg = readConfig();
    const { mode } = resolveMode(cwd, cfg);
    const { policy: policyName } = resolvePolicy(cfg);
    const policy = getPolicy(ctx);
    const security = securitySnapshot(ctx, policyName);
    syncSecurity(ctx, security);
    const securityBinding = JSON.stringify(security);
    const revision = `${policyRevision()}|${securityBinding}`;
    const operatorOnly = security.effective === "strict";
    const guarded = operatorOnly || security.effective === "guarded";
    const auto = mode === "auto" && !operatorOnly;
    const s = sessionFor(ctx);
    const workspace = workspaceRoot(cwd);
    // Unattended: the state to decide by (null unless the supervisor's env + contract entered it and it still holds).
    const u: UnattendedState | null = unattended.current(policyName, { cwd, workspace });
    const contractEnv = process.env.PI_KIT_UNATTENDED_CONTRACT?.trim();
    const boundaryPaths = [...new Set([path.resolve(securityPath()), contractEnv, u?.contractPath].filter((x): x is string => !!x))];
    const env: ClassifyEnv = { cwd, workspace, home: homeDir(), tmpRoots: tmpRoots(), knownHosts: trustedHosts(cfg, ctx), policy: policyName, ...(boundaryPaths.length ? { boundaryPaths } : {}) };

    const toolRule = Object.hasOwn(policy.tools, toolName) ? policy.tools[toolName] : undefined;
    let a: Assessment;
    try {
      a = classifyToolCall(toolName, input, env, toolRule, operatorOnly ? "deny" : policy.defaults.unknown);
    } catch (error) {
      // A classifier failure cannot discard an explicit deny or a fail-closed policy.
      a = classifyToolCall(toolName, {}, env, toolRule, operatorOnly ? "deny" : policy.defaults.unknown);
      a.findings.push({ tier: "high", effect: "opaque", code: "classifier_error", detail: `could not analyse this call (${errorText(error)})`, key: `error ${toolName}` });
    }
    // A fail-closed policy says why the call is denied, instead of calling a pi tool unknown.
    if (policy === BUILTIN_FALLBACK) a.findings.unshift({ tier: "critical", effect: "security_control", code: "policy_invalid", detail: "the firewall policy is invalid; every call is denied until it is repaired (see /firewall status)", key: "policy invalid" });
    a.findings.push(...regexFindings(policy, policyName, a));
    // Tools only a root session may call: a kit child (a subagent or workflow agent) never starts a workflow run.
    if (process.env.PI_KIT_INTERNAL_CHILD === "1" && ROOT_ONLY_TOOLS.has(toolName)) a.findings.push({ tier: "critical", effect: "security_control", code: "child_denied", detail: `${toolName} is not available to child sessions`, key: `tool ${toolName} child` });
    const traj = trajectoryFindings(a, s);
    a.findings.push(...traj);
    a.effects = [...new Set(a.findings.map((f) => f.effect))];
    // The pentest policy never trusts auto-low shortcuts.
    const classifierUnsure = a.findings.some((f) => f.effect === "opaque" || f.code === "classifier_error");
    const trustAuto = auto && policyName === "coding" && !(guarded && classifierUnsure);
    const tier = effectiveTier(a, trustAuto);
    a.tier = a.findings.reduce<Tier>((t, f) => maxTier(t, f.tier), "low");
    const summary = summarize(a, trustAuto) || a.summary;
    a.summary = summary;
    const sig = signatureOf(a, trustAuto);
    const command = commandTextFrom(input);
    const uDenial = u ? unattendedDenial(a, u, workspace) : null;
    const uOutcome: "allow" | "deny" | null = !u ? null : tier === "critical" || uDenial ? "deny" : tier === "low" || u.autoApprove ? "allow" : "deny";
    const base = { securityLevel: security.effective, securityRevision: security.revision, toolName, toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined, parentToolCallId: "parentToolCallId" in event && typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined, actionHash: hash, tier, mode: u ? "unattended" : mode, ...(u ? { unattended: { boundary: u.boundary, contract: u.digest?.slice(0, 12), autoApprove: u.autoApprove } } : {}), policy: policyName, workspace, effects: a.effects, reasons: a.findings.filter((f) => f.tier !== "low").map((f) => f.code), signature: sig, command: command !== null ? redact(command).slice(0, 2000) : undefined };
    // Immediate decisions (low → allow, critical → deny) are one tool_seen record carrying the
    // decider; anything that waits on a grant, precedent, judge or human gets tool_seen (ask)
    // followed by tool_approved / tool_blocked. Routine calls stay one line.
    const immediate = tier === "low" || tier === "critical" || uOutcome !== null;
    const seen = { event: "tool_seen", ...base, decision: uOutcome ?? (tier === "low" ? "allow" : tier === "critical" ? "deny" : "ask"), risk_class: tier, reason: summary };
    if (!immediate) audit(seen);

    const finish = (outcome: "allow" | "deny", decider: string, extra: Record<string, unknown> = {}) => {
      // What was approved is what runs: pi executes this same arguments object, and handlers
      // of extensions loaded after the firewall could otherwise change it after the decision.
      if (outcome === "allow") seal(event?.input);
      recordAction(s, a, tier, outcome, decider);
      if (outcome === "deny") s.stats.denied++;
      saveSession(s);
      const tail = { decider, latencyMs: Date.now() - started, ...extra };
      if (immediate) audit({ ...seen, ...tail, reason: summary, ...(extra.reason ? { block_reason: extra.reason } : {}) });
      else audit({ event: outcome === "allow" ? "tool_approved" : "tool_blocked", ...base, ...tail });
    };
    // Every refusal is exactly one of the labelled outcomes (see TAG), in the text the agent reads and
    // in the audit record.
    const blocked = (reason: string, decider: string, outcome: Outcome, extra: Record<string, unknown> = {}) => {
      finish("deny", decider, { outcome, reason, ...extra });
      return { block: true as const, reason };
    };

    const policyChanged = (): boolean => {
      getPolicy(ctx);
      return `${policyRevision()}|${JSON.stringify(securitySnapshot(ctx))}` !== revision;
    };
    const reconsider = () => {
      blocked("tool-firewall: policy or security level changed while approval was pending; re-evaluating this call", "policy", "uncertain");
      return decide(event, ctx);
    };

    if (tier === "critical") {
      const reason = `tool-firewall: denied ${toolName} [${TAG.hard_deny}] — ${summary}. This action is never allowed automatically, whatever an approval or the auto-mode judge says; if it is truly needed, ask the user to run it themselves.`;
      if (ctx?.hasUI) say(ctx, `tool-firewall: denied ${toolName} (${summary}) — ${TAG.hard_deny}`, "warning");
      return blocked(reason, "policy", "hard_deny");
    }
    if (u) {
      // Inside the zone the container is the boundary: no prompt, no judge. Hard classes and anything that
      // needs authority outside the zone are refused, with a message the agent can relay.
      const contract = `egress: ${u.egress.join(", ") || "none"}; git remotes: ${u.remotes.join(", ") || "none"}`;
      if (uDenial?.kind === "hard") {
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: denied ${toolName} (${uDenial.what}) — ${TAG.hard_deny}, unattended run`, "warning");
        return blocked(`tool-firewall: denied ${toolName} [${TAG.hard_deny}: unattended run] — ${uDenial.what}. Destructive, security-control, credential-exfiltration and boundary actions are never allowed in an unattended run, and there is no operator to approve them. Nothing ran. Do not retry it: leave it out, carry on with work inside the container and list it in your report for the operator.`, "unattended", "hard_deny", { unattendedDenial: uDenial.code });
      }
      if (uDenial?.kind === "operator") {
        return blocked(`tool-firewall: denied ${toolName} [${TAG.uncertain}: no operator in this unattended run] — ${uDenial.what}. The policy says a person must decide this (an ask rule, or a tool the policy does not name), and an unattended run has nobody to ask. Nothing ran. Choose another approach, or say in your report that the operator must do this step.`, "unattended", "uncertain", { unattendedDenial: uDenial.code });
      }
      if (uDenial) {
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: denied ${toolName} (${uDenial.what}) — outside the unattended zone`, "warning");
        return blocked(`tool-firewall: denied ${toolName} [${TAG.hard_deny}: outside the unattended zone] — this command ${uDenial.what}. An unattended run cannot ask anyone, and its contract does not authorise it (${contract}). Nothing ran. Do not retry it: work inside the zone, and say in your report which destination or command needs the operator.`, "unattended", "hard_deny", { unattendedDenial: uDenial.code });
      }
      if (tier === "low") {
        finish("allow", "analyser");
        return undefined;
      }
      if (u.autoApprove) {
        finish("allow", "unattended", { boundary: u.boundary });
        return undefined;
      }
      return blocked(`tool-firewall: denied ${toolName} [${TAG.uncertain}: no operator in this unattended run] — ${summary}. The contract authorises unattended operation but not auto-approval, so this needs an operator, and nobody can be asked. Nothing ran. Choose a lower-impact approach, or say in your report that the operator must do this step.`, "unattended", "uncertain");
    }
    if (tier === "low") {
      finish("allow", "analyser");
      return undefined;
    }
    // Ultracode standing mode: the operator pre-authorised workflow runs for this session. It answers
    // only the policy's own "ask" for the workflow tool: any other finding (a trajectory chain, a
    // secret path), strict security, the pentest policy, a child and a session without a screen
    // are decided as before.
    if (toolName === "workflow" && !operatorOnly && policyName !== "pentest" && ctx?.hasUI && process.env.PI_KIT_INTERNAL_CHILD !== "1"
      && a.findings.every((f) => f.tier === "low" || f.code === "policy_ask") && workflowPreauthorised()) {
      finish("allow", "standing");
      return undefined;
    }
    // Pentest approvals are per action: no session approvals (the card does not offer one).
    const strict = operatorOnly || policyName === "pentest";
    const families = familiesFromSignature(sig);
    const scopes = [...new Set(a.findings.flatMap((f) => (f.tier !== "low" && f.scope ? [f.scope] : [])))];
    const root = rootSessionId(s.id);
    const steps = a.segments.filter((x) => x.tier !== "low").slice(0, 6).map((x) => redact(`${x.text.replace(/\s+/g, " ").slice(0, 140)} [${x.where}; ${x.effects.join(", ")}]`));
    const chain = traj.map((f) => redact(f.detail).slice(0, 400));
    const reasonsList = [...new Set(a.findings.filter((f) => f.tier !== "low").map((f) => redact(`[${f.tier}] ${f.detail}`).slice(0, 400)))].slice(0, 6);
    // Opaque API identity and explicit ask rules cannot acquire broader authority through
    // model similarity or learning. An operator's exact scoped session grant still applies.
    const canLearn = !guarded && trustAuto && cfg.learn && learnable(a, tier) && !needsOperator(a);
    const match = { root, workspace, cwd, policy: policyName, tool: toolName, hash };
    const actionRecord = { command: command !== null ? redact(command).slice(0, 1500) : redact(summary).slice(0, 1500), summary: redact(summary).slice(0, 1500), steps, reasons: reasonsList, chain };

    // What may run without asking again: an approval that covers exactly this action here (approvals.ts).
    // Approvals are read from the file on every call, so a revocation applies to the next call. Never
    // under the pentest policy, and never for a hard deny (handled above).
    const view: ApprovalsView | null = strict ? null : readApprovals();
    if (view) noteApprovalProblems(view, ctx);
    const learnedScope = () => scopeRecords(readFeedback(), { workspace, since: view ? floorFor(view, workspace, hash) : 0 });
    // A learned exact action: approved repeatedly (3 times, in 2 sessions, within 30 days, after the last
    // denial) in THIS workspace. It is stored as an inspectable, revocable, expiring approval.
    const learnedApproval = (existing?: Approval): Approval | undefined => {
      if (!canLearn || !view) return undefined;
      const st = exactStatus(hash, Date.now(), learnedScope());
      if (st.status !== "learned") return undefined;
      if (existing) return existing;
      try {
        return addApproval({ context: "persistent", session: null, workspace, cwd, policy: policyName, tool: toolName, hash, families, scopes, tier, grantedBy: { actor: "learned", via: "precedent", session: s.id, mode, policy: policyName, detail: `${st.approvals} approvals in ${st.sessions} sessions, within 30 days` }, action: actionRecord });
      } catch (error) {
        audit({ event: "approval_store_error", error: errorText(error) });
        return undefined; // cannot store it, so it is not silently remembered: the operator is asked
      }
    };
    let approvalHit = view ? findExact(view, match) : undefined;
    if (approvalHit?.grantedBy.actor === "learned") approvalHit = learnedApproval(approvalHit); // a later denial, or learning switched off, suspends it
    else approvalHit ??= learnedApproval();
    if (approvalHit) {
      if (approvalHit.context === "session") s.stats.grantHits++;
      else s.stats.learnedHits++;
      finish("allow", approvalHit.context === "session" ? "grant" : "precedent", { approval: approvalHit.id, approvalContext: approvalHit.context });
      return undefined;
    }

    // Everything similar to what the operator allowed goes to the judge: a session approval with a
    // shared family or scope, or families the operator has approved before in this workspace.
    const feedbackHere = scopeRecords(readFeedback(), { workspace, since: view ? floorFor(view, workspace) : 0 });
    const sessionList = view ? sessionApprovals(view, { root, workspace, policy: policyName }) : [];
    const similar = similarApprovals(sessionList, families, scopes);
    let judgeNote: string | undefined;
    let judgeView: { verdict: "allow" | "block"; reason: string } | undefined;
    let uncertainWhy: string | undefined; // set when the automatic layers could not settle it
    const highJudge = tier === "high" && canLearn && (similar.length > 0 || operatorApproved(sig, Date.now(), feedbackHere));
    const judgeAllowed = !operatorOnly && !(guarded && classifierUnsure) && (highJudge || (tier === "medium" && auto && (policyName === "coding" || a.effects.every((e) => JUDGE_SAFE_STRICT.has(e)))));
    if (tier === "high" && similar.length && !highJudge) judgeNote = trustAuto ? "similar to a session allow, but this kind always needs you" : undefined;
    if (judgeAllowed) {
      const request = latestRequest(ctx, lastRequest);
      const turn = crypto.createHash("sha1").update(`${revision}|${request}|${sessionList.map((g) => g.id).sort().join(",")}`).digest("hex").slice(0, 12);
      const cached = s.judgeCache[hash];
      let verdict: Verdict | null = cached?.turn === turn ? { verdict: cached.verdict, reason: cached.reason, ...(cached.confidence ? { confidence: cached.confidence } : {}), ...(cached.differs ? { differs: cached.differs } : {}) } : null;
      if (!verdict) {
        const complete = d.complete === undefined ? modelCompleter(ctx, cfg) : d.complete;
        audit({ event: "auto_mode_check_start", toolName, actionHash: hash, model: judgeModelName(ctx, cfg), grants: similar.length || undefined });
        s.stats.judged++;
        if (complete) {
          const goal = readGoal(cwd, env.workspace);
          const precedents = precedentsFor(sig, feedbackHere);
          const grants = similar.map(toGrant);
          const profile = strict ? undefined : profileFor(toolName, families);
          verdict = await runJudge(complete, { request, ...(goal !== undefined ? { goal } : {}), recent: s.recent, assessment: a, workspace: env.workspace, untrusted: s.untrusted, precedents, high: highJudge, grants, ...(profile !== undefined ? { profile } : {}) }, undefined, ctx?.signal);
        } else verdict = null;
        if (verdict) {
          s.judgeCache[hash] = { ...verdict, turn };
          const keys = Object.keys(s.judgeCache);
          if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) Reflect.deleteProperty(s.judgeCache, k);
          appendJudgement({ tool: toolName, sig, tier, verdict: verdict.verdict, ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}), reason: verdict.differs ? `${verdict.reason} (differs: ${verdict.differs})` : verdict.reason, ...(highJudge ? { high: true } : {}), ...(similar.length ? { grants: similar.length } : {}), session: s.id });
        }
      }
      if (verdict) judgeView = { verdict: verdict.verdict, reason: verdict.differs ?? verdict.reason };
      if (verdict?.verdict === "allow") {
        if (policyChanged()) return reconsider();
        audit({ event: "auto_mode_approved", toolName, actionHash: hash, rationale: verdict.reason, high: highJudge || undefined, grants: similar.length || undefined });
        finish("allow", highJudge ? (similar.length ? "judge+grant" : "judge+precedent") : "judge", { rationale: verdict.reason });
        return undefined;
      }
      const unsure = isUncertainBlock(verdict);
      if (verdict?.verdict === "block" && highJudge) {
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, confidence: verdict.confidence, high: true });
        judgeNote = unsure ? `not sure (${verdict.confidence} confidence) it fits what you allowed: ${verdict.differs ?? verdict.reason}` : `${similar.length ? "differs from your session allow" : "out of scope?"}: ${verdict.differs ?? verdict.reason}`;
        if (unsure) uncertainWhy = "judge_unsure";
      } else if (verdict?.verdict === "block" && !unsure) {
        // A high-confidence block is final: the agent gets the reason.
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, confidence: verdict.confidence });
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: auto-mode blocked ${toolName} — ${verdict.reason}`, "warning");
        return blocked(`tool-firewall: auto-mode blocked ${toolName} — ${verdict.reason}${verdict.differs ? ` (${verdict.differs})` : ""}. [${TAG.judge_block}: judge, high confidence] If this step is really needed, explain why to the user and ask them to approve it.`, "judge", "judge_block", { rationale: verdict.reason });
      } else if (verdict?.verdict === "block") {
        // A block the judge is only unsure about is UNCERTAIN, not final: the operator decides.
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, confidence: verdict.confidence, escalated: true });
        judgeNote = `unsure whether to block (${verdict.confidence} confidence): ${verdict.differs ?? verdict.reason}`;
        uncertainWhy = "judge_unsure";
      }
      if (!verdict) {
        judgeNote = "judge unavailable — asking you instead";
        uncertainWhy = "judge_unavailable";
        audit({ event: "auto_mode_judge_unavailable", toolName, actionHash: hash });
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: auto-mode judge unavailable for ${toolName} — falling back to manual approval`, "warning");
      }
    }
    // The classifier could not tell what this does (an unparsed or computed command): also UNCERTAIN.
    if (!uncertainWhy && a.findings.some((f) => f.tier !== "low" && (f.effect === "opaque" || f.code === "classifier_error"))) uncertainWhy = "classifier_unsure";

    // Ask a human.
    const precedent = statusFor(sig, Date.now(), feedbackHere);
    const allowSession = !strict;
    const judged = !guarded && trustAuto && cfg.learn;
    const scopeText = describeFamilies(families);
    const covers = allowSession ? (judged ? `exact repeats run; similar steps${scopeText ? ` (${scopeText})` : ""} are judged against this` : "exact repeats run") : undefined;
    const sessionScope = allowSession ? `this session + workspace, ${Math.round(SESSION_APPROVAL_TTL_MS / 3_600_000)}h` : undefined;
    const uncertain = !!uncertainWhy;
    const extras: CardExtras = { tier, trajectory: traj, ...(judgeNote !== undefined ? { judgeNote } : {}), precedent, hash, signature: sig, mode, policy: policyName, ...(covers !== undefined ? { covers } : {}), ...(sessionScope !== undefined ? { scope: sessionScope } : {}), uncertain };
    const card = buildCard(a, extras);
    lastDetail = buildDetail(a, extras);
    const choices = choicesFor(allowSession, judged);
    const grant = (via: "card" | "console", choice?: string) => {
      try {
        addApproval({ context: "session", session: root, workspace, cwd, policy: policyName, tool: toolName, hash, families, scopes, tier, grantedBy: { actor: "operator", via, session: s.id, mode, policy: policyName, ...(choice ? { choice: choice.slice(0, 280) } : {}) }, action: actionRecord });
      } catch (error) {
        audit({ event: "approval_store_error", error: errorText(error) });
        say(ctx, `tool-firewall: could not store the session allow (${errorText(error)}); you will be asked again`, "warning");
      }
    };
    const record = (decision: "allow" | "deny", source: FeedbackRecord["source"], note?: string, choice?: string) => {
      s.stats.human++;
      try {
        appendFeedback({ sig, decision, tier, tool: toolName, summary: command ?? summary, project: env.workspace, session: s.id, source, ...(note !== undefined ? { note } : {}), hash, ...(choice !== undefined ? { choice } : {}), steps, chain, ...(judgeView !== undefined ? { judge: judgeView } : {}) });
      } catch {
        /* learning is best effort */
      }
      // Every operator decision can refresh the global profile, off the hot path.
      if (cfg.learn && !strict) distillInBackground(d.complete === undefined ? modelCompleter(ctx, cfg) : d.complete);
      // The approval that just reached the learning threshold is stored now, so it is listed (and can be revoked) at once.
      if (decision === "allow") learnedApproval();
    };
    const denyReason = (note?: string) =>
      `tool-firewall: denied ${toolName} [${TAG.operator_decision}: denied] — the operator declined this action${note ? `: ${note}` : "."}${judgeView?.verdict === "block" ? ` (The auto-mode judge also flagged it: ${judgeView.reason}.)` : ""} Do not retry it; take a different approach or ask the user what they want.`;
    // Nobody answered: UNCERTAIN, refused, bounded, and worded for the agent to relay.
    const noAnswer = (why: "timeout" | "aborted" | "unavailable" | "error", via: "console" | "prompt", secs: number, detail?: string) => {
      const what =
        why === "aborted"
          ? "the request was cancelled (the turn was aborted) before anyone answered"
          : why === "unavailable"
            ? String(detail)
            : why === "error"
              ? `the approval prompt failed (${detail})`
              : via === "console"
                ? `none arrived within ${secs}s (headless: no attended session answered the human console)`
                : `none arrived within ${secs}s (the approval prompt was not answered)`;
      return blocked(`tool-firewall: denied ${toolName} [${TAG.uncertain}: no operator decision] — ${summary}. ${uncertain ? "The automatic checks could not settle this, and it" : "It"} needs operator approval, and ${what}. Nothing ran. Ask the user to approve it or to run it themselves, or choose a lower-impact approach; do not retry it unchanged.`, why === "timeout" ? (via === "console" ? "broker_timeout" : "prompt_timeout") : why, "uncertain", { why });
    };

    if (!ctx?.hasUI && policyName === "pentest" && tier === "high") return blocked(`tool-firewall: denied ${toolName} [${TAG.hard_deny}] — ${summary}. The pentest policy does not approve high-impact actions without an interactive operator.`, "policy", "hard_deny");

    if (uncertain) audit({ event: "tool_escalated", outcome: "uncertain", why: uncertainWhy, toolName, actionHash: hash, operator: ctx?.hasUI ? "interactive" : "console" });

    if (ctx?.hasUI && typeof ctx.ui?.select === "function") {
      const res = await boundedPrompt(ctx, (o) => ctx.ui.select(card, choices, o));
      if (res.kind === "aborted") return noAnswer("aborted", "prompt", 0);
      if (res.kind === "timeout") return noAnswer("timeout", "prompt", Math.round(promptTimeoutMs() / 1000));
      if (res.kind === "error") return noAnswer("error", "prompt", 0, res.message);
      const choice = res.value;
      if (choice === CHOICE_ALLOW_ONCE || isSessionChoice(choice)) {
        if (policyChanged()) return reconsider();
        if (allowSession && isSessionChoice(choice)) grant("card", choice);
        record("allow", isSessionChoice(choice) ? "grant" : "card", undefined, choice);
        finish("allow", "human", { outcome: "operator_decision", choice });
        return undefined;
      }
      let note: string | undefined;
      if (choice === CHOICE_DENY_TELL && typeof ctx.ui.input === "function") {
        const typed = await boundedPrompt(ctx, (o) => ctx.ui.input("Tell the agent why (it sees this):", "e.g. don't touch production; use the staging host", o));
        if (typed.kind === "answered" && typeof typed.value === "string") note = typed.value.trim() || undefined;
      }
      record("deny", "card", note, choice ?? "dismissed");
      return blocked(denyReason(note), "human", "operator_decision", { choice: choice ?? "dismissed" });
    }
    let approved: boolean;
    let source: FeedbackRecord["source"] = "card";
    let note: string | undefined;
    let picked: string | undefined;
    if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
      // The answer comes from a UI implementation: only a literal `true` approves.
      const res = await boundedPrompt<unknown>(ctx, (o) => ctx.ui.confirm("Approve tool call?", card, o));
      if (res.kind === "aborted") return noAnswer("aborted", "prompt", 0);
      if (res.kind === "timeout") return noAnswer("timeout", "prompt", Math.round(promptTimeoutMs() / 1000));
      if (res.kind === "error") return noAnswer("error", "prompt", 0, res.message);
      approved = res.value === true;
    } else {
      source = "broker";
      // The console adds a title line; keep the whole request within the line budget.
      const res = await brokerApproval(toolName, input, tier, summary, buildCard(a, { ...extras, maxLines: CARD_MAX_LINES - 1 }), judgeNote ?? null, ctx, ctx?.signal, choices, runActionHash(toolName, input, cwd, workspace));
      if (res.unavailable) return noAnswer("unavailable", "console", 0, `${res.unavailable}. No operator could be asked`);
      if (res.timedOut) return noAnswer(res.aborted ? "aborted" : "timeout", "console", Math.round((res.timeoutMs ?? 0) / 1000));
      approved = res.approved;
      note = res.note;
      picked = res.choice;
      if (approved && policyChanged()) return reconsider();
      if (approved && allowSession && isSessionChoice(res.choice)) {
        grant("console", res.choice);
        source = "grant";
      }
    }
    if (!approved) {
      record("deny", source === "grant" ? "broker" : source, note, picked);
      return blocked(denyReason(note), "human", "operator_decision", { choice: picked });
    }
    if (policyChanged()) return reconsider();
    record("allow", source, undefined, picked);
    finish("allow", "human", { outcome: "operator_decision", choice: picked });
    return undefined;
  }

  // ---- /firewall: inspect and revoke what the firewall remembers ---------------------------------

  const listApprovalLines = (view: ApprovalsView, root: string, workspace: string): string[] => {
    const out: string[] = [];
    for (const a of view.approvals) {
      const applies = a.workspace === workspace && (a.context === "persistent" || a.session === root);
      const grantedVia = a.grantedBy.actor === "learned" ? `learned (${a.grantedBy.detail ?? "repeated approvals"})` : `operator via ${a.grantedBy.via}${a.grantedBy.choice ? ` ("${a.grantedBy.choice.slice(0, 60)}")` : ""}`;
      out.push(
        `  ${a.context === "session" ? "SESSION   " : "PERSISTENT"} ${a.id}  ${a.tier.toUpperCase()}  ${a.tool}: ${a.action.command.replace(/\s+/g, " ").slice(0, 110)}`,
        `      scope: ${describeScope(a)}`,
        `      granted: ${grantedVia} at ${a.createdAt} · ${a.expiresAt ? `expires ${a.expiresAt}` : "no expiry"} · ${applies ? "applies here" : "not for this session/workspace"}`,
      );
    }
    return out;
  };

  const firewallList = (ctx: ExtensionContext): string => {
    const cwd = ctx?.cwd || process.cwd();
    const s = sessionFor(ctx);
    const root = rootSessionId(s.id);
    const workspace = workspaceRoot(cwd);
    const cfg = readConfig();
    const view = readApprovals();
    const problems = noteApprovalProblems(view, ctx);
    const kh = knownHostsMeta(cfg);
    const here = scopeRecords(readFeedback(), { workspace, since: floorFor(view, workspace) });
    const approvedKinds = listLearned(Date.now(), here).filter((l) => l.approvals > 0).length;
    const lines = [`tool-firewall approvals (${view.file}, schemaVersion 1) — session ${root}, workspace ${workspace}`];
    if (view.approvals.length) lines.push(...listApprovalLines(view, root, workspace));
    else lines.push("  no remembered approvals: every medium or high action asks (or goes to the judge in auto mode)");
    if (view.expired) lines.push(`  (${view.expired} expired approval(s) are ignored and dropped on the next write)`);
    if (problems.length) lines.push(`  IGNORED (malformed, never treated as an allow): ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "; …" : ""}`);
    lines.push(`  kinds you approved in this workspace that may reach the judge in auto mode: ${approvedKinds} (see /auto learned; /firewall revoke workspace clears them)`);
    const hostLines = [...new Set([...kh.fromConfig, ...kh.fromSsh])].sort().map((h) => `${h} [${kh.untrusted.has(h) ? "REVOKED" : kh.fromConfig.has(h) ? "firewall.json" : "~/.ssh/config"}]`);
    lines.push(`  known hosts (only lower READ-ONLY ssh and sudo -n reads in auto mode, coding policy): ${hostLines.join(", ") || "none"}`);
    lines.push("  revoke: /firewall revoke <id> | session | workspace | all | host:<name>  (takes effect on the next tool call)");
    return lines.join("\n");
  };

  const unattendedLine = (): string => {
    const st = unattended.state();
    if (st.active) return `  unattended: ACTIVE — ${st.boundary} boundary, contract sha256:${st.digest?.slice(0, 12)}, boundaryDigest ${st.boundaryDigest?.slice(0, 16)}, auto-approve ${st.autoApprove ? "yes" : "NO"}; egress: ${st.egress.join(", ") || "none"}; git remotes: ${st.remotes.join(", ") || "none"}; no prompts and no judge inside the zone, hard denies and outside-the-zone actions fail closed${st.warnings.length ? `; note: ${st.warnings.join("; ")}` : ""}`;
    if (st.requested) return `  unattended: NOT ACTIVE although requested — ${st.warnings.join("; ")} (fail closed: the normal interactive/headless rules apply)`;
    return "  unattended: off (only the supervisor can turn it on, with PI_KIT_UNATTENDED=1 and a read-only contract; nothing inside a session can)";
  };

  const firewallStatus = (ctx: ExtensionContext): string => {
    const policy = getPolicy();
    const cfg = readConfig();
    const cwd = ctx?.cwd || process.cwd();
    const m = resolveMode(cwd, cfg);
    const p = resolvePolicy(cfg);
    const s = sessionFor(ctx);
    const workspace = workspaceRoot(cwd);
    const view = readApprovals();
    const problems = noteApprovalProblems(view, ctx);
    const here = scopeRecords(readFeedback(), { workspace, since: floorFor(view, workspace) });
    const learned = listLearned(Date.now(), here).filter((l) => l.status === "learned").length;
    const kh = knownHostsMeta(cfg);
    const warningSuffix = `${lastPolicyWarnings.length > 0 ? ` invalid-items=${lastPolicyWarnings.length}(!)` : ""}${lastPolicyAdjustments.length > 0 ? ` adjusted-rules=${lastPolicyAdjustments.length}` : ""}`;
    const zone = unattended.state();
    const decides =
      zone.active && p.policy === "coding"
        ? `UNATTENDED zone (${zone.boundary}): ${zone.autoApprove ? "low, medium and high run with no prompt and no judge" : "only low runs; everything above fails closed (no operator, no auto-approve)"}; critical, hard-denied classes and anything outside the zone are refused (the mode above is not consulted)`
        : p.policy === "pentest"
        ? "pentest policy: medium and high ask the operator each time (denied headless); no session allows, no learning"
        : m.mode === "auto"
          ? "auto: low runs; medium is judged (a high-confidence block is final, an unsure one asks you); high runs only on an exact approval, else judge-if-similar, else asks you; critical is denied"
          : "manual: low runs; medium and high ask you; critical is denied; only an exact approval runs without asking";
    return [
      `tool-firewall: policy=${p.policy} (${p.source}) mode=${m.mode} (${m.source})`,
      `  security: ${securitySnapshot(ctx).effective} (requested ${securitySnapshot(ctx).requested}); /security status explains the active restrictions and unavailable checks`,
      `  configured strategy (security restrictions apply on top): ${decides}`,
      `  runs without asking: low-tier actions in every mode (reads of non-credential paths, git reads, network GETs, workspace writes, dev tooling, explicitly allowed external tools); unknown tool names need operator authority${m.mode === "auto" && p.policy === "coding" ? "; in auto mode also read-only ssh and sudo -n reads on known hosts" : "; read-only ssh/sudo -n on known hosts is NOT trusted in this mode and asks"}`,
      `  outcomes: HARD DENY (policy says never; no approval or judge overrides) · UNCERTAIN (judge/classifier unsure, unavailable or timed out: asks you, or fails closed when nobody can be asked) · OPERATOR DECISION (you allowed or denied; remembered only within the scope the card names)`,
      `  rules: ${cachedPolicyLabel} default-unknown=${policy.defaults.unknown} tool-rules=${Object.keys(policy.tools).length} operator-rules=${policy.command_rules.deny.length}/${policy.command_rules.ask.length} pentest-rules=${policy.pentest.deny.length}/${policy.pentest.ask.length}${warningSuffix}`,
      `  judge model: ${judgeModelName(ctx, cfg) ?? "unset"} · learning ${cfg.learn ? "on" : "off"} (${learned} learned here) · known hosts: ${[...kh.hosts].join(", ") || "none"}`,
      unattendedLine(),
      `  approvals: ${view.approvals.length} remembered (${view.approvals.filter((a) => a.context === "session").length} session, ${view.approvals.filter((a) => a.context === "persistent").length} persistent)${problems.length ? `, ${problems.length} malformed ignored (/firewall list)` : ""} — ${view.file}`,
      `  session: ${s.stats.actions} actions, ${s.stats.human} asked you, ${s.stats.judged} judged (${s.stats.judgeBlocks} blocked)${s.credentialReads.length ? `, secret reads: ${s.credentialReads.map((c) => c.what).slice(-3).join(", ")}` : ""}${s.untrusted ? ", web/untrusted content seen" : ""}`,
      `  audit=${auditPath()} config=${configPath()}`,
    ].join("\n");
  };

  const FIREWALL_USAGE = "usage: /firewall [status | list | revoke <id>… | revoke session | revoke workspace | revoke all | revoke host:<name> | reload | help]";

  const firewallCommand = async (args: string, ctx: ExtensionContext) => {
    const [subRaw = "status", ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
    const sub = subRaw.toLowerCase();
    try {
      if (sub === "status" || sub === "st") {
        say(ctx, firewallStatus(ctx), "info");
        return;
      }
      if (sub === "list" || sub === "ls" || sub === "approvals") {
        if (rest.length) {
          say(ctx, `tool-firewall: /firewall list takes no arguments. ${FIREWALL_USAGE}`, "error");
          return;
        }
        say(ctx, firewallList(ctx), "info");
        return;
      }
      if (sub === "reload") {
        reloadPolicy();
        sshBaseline = knownHostsMeta(readConfig()).sshMtime;
        sshWarned = false;
        say(ctx, `tool-firewall: reloaded policy (${cachedPolicyLabel})`, "info");
        if (lastPolicyAdjustments.length > 0) say(ctx, `tool-firewall: WARNING — ${lastPolicyAdjustments.length} rule(s) adjusted but still enforced: ${lastPolicyAdjustments.join("; ")}`, "warning");
        if (lastPolicyWarnings.length > 0) say(ctx, `tool-firewall: WARNING — ${lastPolicyWarnings.length} invalid policy item(s); fail-closed (deny all): ${lastPolicyWarnings.join("; ")}`, "warning");
        return;
      }
      if (sub === "help" || sub === "--help" || sub === "-h") {
        say(ctx, FIREWALL_USAGE, "info");
        return;
      }
      if (sub === "revoke") {
        const cwd = ctx?.cwd || process.cwd();
        const scope = { root: rootSessionId(sessionFor(ctx).id), workspace: workspaceRoot(cwd) };
        const cfg = readConfig();
        const hosts = rest.filter((t) => /^host:/i.test(t));
        const others = rest.filter((t) => !/^host:/i.test(t));
        if (!rest.length) {
          say(ctx, `tool-firewall: nothing to revoke. ${FIREWALL_USAGE}`, "error");
          return;
        }
        // Validate every target before changing anything: invalid arguments never mutate state.
        const kh = knownHostsMeta(cfg);
        const names = hosts.map((t) => t.slice(5).toLowerCase());
        const badHost = names.find((n) => !n || !(kh.fromConfig.has(n) || kh.fromSsh.has(n)) || kh.untrusted.has(n));
        if (badHost !== undefined) {
          say(ctx, `tool-firewall: "host:${badHost}" is not a trusted known host (see /firewall list). Nothing was changed.`, "error");
          return;
        }
        const lines: string[] = [];
        if (others.length) {
          const r = revokeApprovals(others, scope);
          if (r.error) {
            say(ctx, `tool-firewall: ${r.error}. Nothing was changed.`, "error");
            return;
          }
          lines.push(`revoked ${r.removed.length} approval(s)${r.removed.length ? `: ${r.removed.map((a) => `${a.id} (${a.context})`).join(", ")}` : ""}${r.resetLearning.length ? `; reset ${r.resetLearning.join(", ")}` : ""}`);
        }
        if (names.length) {
          writeConfig({ knownHosts: cfg.knownHosts.filter((h) => !names.includes(h.toLowerCase())), untrustedHosts: [...new Set([...cfg.untrustedHosts, ...names])], source: "user" });
          lines.push(`withdrew trust from ${names.map((n) => `host ${n}`).join(", ")}${names.some((n) => kh.fromSsh.has(n)) ? " (still named in ~/.ssh/config; the firewall no longer trusts it)" : ""}`);
        }
        say(ctx, `tool-firewall: ${lines.join("; ")}. Takes effect on the next tool call.`, "info");
        return;
      }
      say(ctx, `tool-firewall: unknown option "${subRaw}". ${FIREWALL_USAGE}`, "error");
      return;
    } catch (error) {
      say(ctx, `tool-firewall: /firewall ${sub} failed: ${errorText(error)}`, "error");
      return;
    }
  };

  pi.registerCommand("firewall", { description: "Tool firewall: /firewall [status | list | revoke <id>|session|workspace|all|host:<name> | reload]. Lists remembered approvals with their scope and revokes them.", handler: async (args, ctx) => {
    await firewallCommand(args, ctx);
  } });
  pi.registerCommand("firewall:reload", { description: "Reload the tool-firewall policy from disk (alias of /firewall reload)", handler: async (_args, ctx) => {
    await firewallCommand("reload", ctx);
  } });
  pi.registerCommand("firewall:status", { description: "Show tool-firewall status: policy, mode, judge, learning, approvals (alias of /firewall status)", handler: async (_args, ctx) => {
    await firewallCommand("status", ctx);
  } });

  const autoCommand = async (args: string, ctx: ExtensionContext) => {
    const [option = "status", ...rest] = (args || "status").trim().split(/\s+/);
    const cwd = ctx?.cwd || process.cwd();
    const opt = option.toLowerCase();
    if (opt === "on" || opt === "off") {
      const enabled = opt === "on";
      if (enabled && securitySnapshot(ctx).effective === "strict") {
        say(ctx, "auto-mode: /auto on refused: strict security pins the approval strategy to the operator. Use /security to change the level.", "warning");
        return;
      }
      // Manual → automatic approvals lowers oversight (a model judge decides instead of you), so it
      // is chosen at the terminal of an interactive root session, never from a linked phone or the
      // web console, like weakening /security. Turning approvals back to manual never asks. It
      // writes the saved global mode (and the legacy file in PI_KIT_AUTO_MODE_STATE_DIR), so it asks
      // unless the saved mode, the effective mode and an existing project file are all already
      // auto: an env PI_KIT_AUTO_MODE=1 run or a project auto-mode.json cannot make the global mode
      // auto unasked, and neither a saved auto mode nor PI_KIT_AUTO_MODE=1 (which masks the file in
      // the effective mode) can flip a project file pinned to manual unasked.
      if (enabled && (readConfig().mode !== "auto" || resolveMode(cwd).mode !== "auto" || legacyPinnedOff(legacyAutoModePath(cwd)))) {
        if (!atRootTerminal(ctx)) {
          say(ctx, "auto-mode: /auto on needs a choice at the terminal of an interactive root session; refused in headless, RPC and delegated/child sessions. PI_KIT_AUTO_MODE=1 sets it for a scripted run.", "warning");
          return;
        }
        if (!await chooseAtTerminal(ctx.ui, "Turn on automatic approvals? A model judge will decide tool calls that would otherwise ask you.", "keep manual approvals", "turn on automatic approvals", promptTimeoutMs())) {
          say(ctx, "auto-mode: unchanged (manual).", "info");
          return;
        }
      }
      try {
        writeConfig({ mode: enabled ? "auto" : "manual", source: "user" });
        // The legacy state file is rewritten only in an operator-set PI_KIT_AUTO_MODE_STATE_DIR (no
        // symlink followed). A project's own .pi/auto-mode.json is never written: it is repository
        // content, and following a committed link there let /auto off truncate an arbitrary file.
        // A project file that pins manual is reported below and must be removed by hand.
        const stateDir = process.env.PI_KIT_AUTO_MODE_STATE_DIR?.trim();
        if (stateDir) writeFileSafe(legacyAutoModePath(cwd), JSON.stringify({ enabled }), { root: stateDir });
        const eff = resolveMode(cwd);
        say(ctx, `auto-mode: ${enabled ? "enabled" : "disabled"}${eff.mode !== (enabled ? "auto" : "manual") ? ` (but ${eff.source} overrides it: ${eff.mode})` : ""}`, "info");
      } catch (error) {
        say(ctx, `auto-mode: could not ${enabled ? "enable" : "disable"} — failed to write ${configPath()} (${error instanceof Error ? error.message : String(error)})`, "error");
      }
      return;
    }
    if (opt === "status") {
      const cfg = readConfig();
      const m = resolveMode(cwd, cfg);
      say(ctx, `auto-mode: ${securitySnapshot(ctx).effective === "strict" ? "operator (pinned by strict security; configured " + m.mode + ")" : m.mode === "auto" ? "enabled" : "disabled"} (from ${m.source}) policy=${resolvePolicy(cfg).policy} model=${judgeModelName(ctx, cfg) ?? "unset (no session model available)"} learning=${cfg.learn ? "on" : "off"} state=${configPath()}`, "info");
      return;
    }
    if (opt === "learn") {
      const on = (rest[0] ?? "").toLowerCase();
      if (on !== "on" && on !== "off") {
        say(ctx, "auto-mode: usage /auto learn on|off", "error");
        return;
      }
      writeConfig({ learn: on === "on" });
      say(ctx, `auto-mode: learning from your decisions ${on === "on" ? "on" : "off"}`, "info");
      return;
    }
    if (opt === "learned") {
      // Learning is scoped to the workspace the decisions were made in, and to what was not revoked since.
      const workspace = workspaceRoot(cwd);
      const all = listLearned(Date.now(), scopeRecords(readFeedback(), { workspace, since: floorFor(readApprovals(), workspace) }));
      if (!all.length) {
        say(ctx, `auto-mode: no decisions recorded yet for ${workspace} (${feedbackPath()})`, "info");
        return;
      }
      say(ctx, [`auto-mode: precedents for ${workspace} (signature — approvals/sessions/denials — status)`, ...all.slice(0, 40).map((l) => `  ${l.sig} — ${l.approvals}/${l.sessions}/${l.denials} — ${l.status}`)].join("\n"), "info");
      return;
    }
    if (opt === "forget") {
      const sig = rest.join(" ");
      if (!sig) {
        say(ctx, "auto-mode: usage /auto forget <signature> (a trailing * matches a prefix)", "error");
        return;
      }
      say(ctx, `auto-mode: forgot ${forget(sig)} decision(s)`, "info");
      return;
    }
    if (opt === "stats") {
      const s = sessionFor(ctx);
      const per100 = s.stats.actions ? ((s.stats.human / s.stats.actions) * 100).toFixed(1) : "0";
      say(ctx, `auto-mode: this session ${s.stats.actions} actions · asked you ${s.stats.human} (${per100}/100) · judged ${s.stats.judged} (${s.stats.judgeBlocks} blocked) · learned hits ${s.stats.learnedHits} · session-allow repeats ${s.stats.grantHits} · denied ${s.stats.denied}`, "info");
      return;
    }
    if (opt === "profile") {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "reset") {
        say(ctx, resetProfile() ? "auto-mode: learned profile cleared (decisions are kept; it is rebuilt from them later)" : "auto-mode: no learned profile to clear", "info");
        return;
      }
      if (sub === "rebuild") {
        const complete = d.complete === undefined ? modelCompleter(ctx, readConfig()) : d.complete;
        if (!complete) {
          say(ctx, "auto-mode: no model available to rebuild the profile", "error");
          return;
        }
        const p = await distill(complete).catch(() => null);
        say(ctx, p ? `auto-mode: profile rebuilt from ${p.basedOn.decisions} decision(s) and ${p.basedOn.judgements} judgement(s)` : "auto-mode: profile rebuild failed (model gave no usable answer)", p ? "info" : "error");
        return;
      }
      const p = readProfile();
      const stats = (p?.stats?.length ? p.stats : computeStats()).slice(0, 12).map((v) => `  ${statsLine(v)}`);
      const lines = [
        p ? `auto-mode: learned profile (updated ${p.updated}, from ${p.basedOn.decisions} decisions, ${p.basedOn.judgements} judgements)` : "auto-mode: no learned profile yet (built in the background after a few decisions)",
        ...(p?.principles.length ? ["How you decide:", ...p.principles.map((x) => `  - ${x}`)] : []),
        ...(p?.cautions.length ? ["What you refuse:", ...p.cautions.map((x) => `  - ${x}`)] : []),
        ...(stats.length ? ["Most recent kinds:", ...stats] : []),
        "It informs the judge only; /auto profile rebuild | reset",
      ];
      say(ctx, lines.join("\n"), "info");
      return;
    }
    if (opt === "explain") {
      const s = sessionFor(ctx);
      const n = Math.max(1, Math.min(20, Number(rest[0]) || 5));
      const lines = s.recent.slice(-n).map((r) => `  ${r.outcome.padEnd(5)} ${r.tier.padEnd(8)} by ${r.decider.padEnd(9)} ${r.tool}: ${r.summary.slice(0, 120)}`);
      const last = lastDetail ? ["auto-mode: last approval request (full detail)", lastDetail, ""] : [];
      say(ctx, [...last, ...(lines.length ? ["auto-mode: recent decisions", ...lines] : ["auto-mode: no decisions yet this session"])].join("\n"), "info");
      return;
    }
    if (opt === "check") {
      const command = rest.join(" ");
      const cfg = readConfig();
      const security = securitySnapshot(ctx);
      const env: ClassifyEnv = { cwd, workspace: workspaceRoot(cwd), home: homeDir(), tmpRoots: tmpRoots(), knownHosts: trustedHosts(cfg, ctx), policy: resolvePolicy(cfg).policy, boundaryPaths: [path.resolve(securityPath())] };
      const a = classifyToolCall("bash", { command }, env, getPolicy().tools.bash, security.effective === "strict" ? "deny" : getPolicy().defaults.unknown);
      const unsure = a.findings.some((f) => f.effect === "opaque" || f.code === "classifier_error");
      const auto = resolveMode(cwd, cfg).mode === "auto" && security.effective !== "strict" && !(security.effective === "guarded" && unsure);
      const sigc = signatureOf(a, auto);
      const covers = env.policy === "pentest" ? undefined : describeFamilies(familiesFromSignature(sigc)) || undefined;
      say(ctx, buildDetail(a, { tier: effectiveTier(a, auto), trajectory: [], hash: actionHash("bash", { command }), signature: sigc, mode: auto ? "auto" : "manual", policy: env.policy, ...(covers !== undefined ? { covers } : {}) }), "info");
      return;
    }
    say(ctx, `auto-mode: unknown option "${option}" — use status|on|off|explain [n]|learned|forget <sig>|learn on|off|stats|profile [rebuild|reset]|check <command>`, "error");
  };

  pi.registerCommand("auto", { description: "Auto mode: /auto [status|on|off|explain [n]|learned|forget <sig>|learn on|off|stats|profile [rebuild|reset]|check <command>]", handler: autoCommand });
  pi.registerCommand("auto-mode", { description: "Alias of /auto", handler: autoCommand });
  // Only once every hook is installed: a factory that failed earlier never registers.
  registerProtection("tool-firewall");
}

