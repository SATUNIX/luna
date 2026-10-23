// Host-owned scoring helpers. Evidence is untrusted; malformed required records fail closed.
import fs from "node:fs";
import path from "node:path";
import { boolean, isRecord, matches, number, object, parseJson, parseJsonAs, string, type Infer } from "../../lib/guard.ts";

/** One problem with a piece of evidence (`line` is 1-based, for JSONL records). */
export interface ScoringIssue {
  readonly artifact: string;
  readonly code: string;
  readonly line?: number;
}

export interface JsonLines<T> {
  rows: T[];
  errors: ScoringIssue[];
}

/** A pi JSON-mode event as written to events.jsonl. Everything but `type` is unchecked evidence. */
export interface EventRecord {
  readonly type: string;
  readonly message?: unknown;
  readonly [key: string]: unknown;
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
export type UsageField = (typeof USAGE_FIELDS)[number];
export type UsageTotals = Record<UsageField, number | null>;

export interface FieldCoverage {
  observed: number | null;
  messagesWithValue: number;
}

export interface UsageSummary {
  complete: boolean;
  reasons: string[];
  startedAgentRuns: number;
  completedAgentRuns: number;
  startedMessages: number;
  completedMessages: number;
  messagesWithUsage: number;
  observed: UsageTotals;
  totals: UsageTotals | null;
  tokenCoverage: Record<UsageField, FieldCoverage>;
  observedValuesAreLowerBounds: boolean;
  cost: { observedTotal: number | null; complete: boolean; total: number | null };
}

export interface SummarizeOptions {
  readonly timedOut?: boolean;
  readonly exitCode?: number | null;
  readonly evidenceErrors?: readonly ScoringIssue[];
}

export type CaseOutcome = "error" | "failed" | "pending_review" | "passed";

export interface ReportReview {
  status: "pending";
  reason?: string;
}

/** What every case result records, including a case whose execution threw. */
export interface CaseResult {
  name: string;
  passed: boolean | null;
  behavioralPassed: boolean;
  outcome: CaseOutcome;
  reportReview: ReportReview | null;
  timedOut: boolean | null;
  exitCode: number | null;
  agentDurationMs: number | null;
  scoringDurationMs: number | null;
  usage: unknown[];
  usageSummary: UsageSummary;
  errors: ScoringIssue[];
}

/** A case that ran to scoring. */
export interface ScoredCase extends CaseResult {
  toolCalls: number;
  diagnostics: number;
  queuedSteering: number;
  pending: boolean | null;
  stopReason: unknown;
  response: string;
}

/** A result as persisted by runCases (scored or not), with its wall-clock duration. */
export type RecordedCase = (CaseResult | ScoredCase) & { durationMs: number };

/** The coding case's independent validation: only its exit status is scored. */
export interface CodingValidation {
  readonly status: number | null;
}

export interface ScoreCaseOptions {
  readonly name: string;
  readonly dir: string;
  readonly workspace: string;
  readonly logs: string;
  readonly hostLogs: string;
  readonly targetLogFile: string;
  readonly priorTargetRequests?: number;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly agentDurationMs: number;
  /** Required for the "coding" case; a missing validator is an execution error there. */
  readonly validateCoding?: (() => CodingValidation) | undefined;
  readonly now?: () => number;
}

export interface RunCasesOptions {
  readonly selected: readonly string[];
  readonly runCase: (name: string) => Promise<CaseResult>;
  readonly persist: (result: RecordedCase, results: RecordedCase[]) => void | Promise<void>;
  readonly now?: () => number;
}

/** The fields resultExitCode reads. */
export interface ExitCodeInput {
  readonly behavioralPassed: boolean;
  readonly passed: boolean | null;
  readonly outcome: string;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const issue = (artifact: string, code: string): ScoringIssue => ({ artifact, code });
const prop = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const errorCode = (error: unknown): unknown => prop(error, "code");
/** Truthy `.length`, as a string or an array (or anything else with one) has. */
const hasLength = (value: unknown): boolean =>
  Boolean(typeof value === "string" || Array.isArray(value) ? value.length : prop(value, "length"));

const LifecycleSchema = object({ pendingMessages: boolean() });
const TargetRequestSchema = object({ method: string(), path: string(), user: string(), status: number({ integer: true }) });
type TargetRequest = Infer<typeof TargetRequestSchema>;
type LifecycleRecord = Infer<typeof LifecycleSchema>;
const BoardSchema = object({ verdicts: object({ verify: object({ pass: boolean() }) }) });

/** An event row: a typed event, whose message events carry a message with a role, and whose
 * assistant message_end carries a content array. */
function isEventRecord(event: unknown): event is EventRecord {
  if (!isRecord(event) || typeof event.type !== "string") return false;
  if (!["message_start", "message_end"].includes(event.type)) return true;
  const message = event.message;
  return isRecord(message) && typeof message.role === "string"
    && (event.type !== "message_end" || message.role !== "assistant" || Array.isArray(message.content));
}

export function readJsonLines(file: string, artifact: string): JsonLines<Record<string, unknown>>;
export function readJsonLines<T>(file: string, artifact: string, validate: (row: unknown) => row is T): JsonLines<T>;
export function readJsonLines(file: string, artifact: string, validate: (row: unknown) => boolean = isRecord): JsonLines<unknown> {
  let content: string;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (error) { return { rows: [], errors: [issue(artifact, errorCode(error) === "ENOENT" ? "missing" : "unreadable")] }; }
  const rows: unknown[] = [], errors: ScoringIssue[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const row = parseJson(line);
      if (!validate(row)) throw new Error("invalid record");
      rows.push(row);
    } catch { errors.push({ ...issue(artifact, "invalid_record"), line: index + 1 }); }
  }
  if (!rows.length && !errors.length) errors.push(issue(artifact, "empty"));
  return { rows, errors };
}

/** Lifts one function over the usage fields, keeping their order. */
const perField = <T>(fn: (field: UsageField) => T): Record<UsageField, T> =>
  ({ input: fn("input"), output: fn("output"), cacheRead: fn("cacheRead"), cacheWrite: fn("cacheWrite"), totalTokens: fn("totalTokens") });

export function summarizeUsage(events: readonly EventRecord[], { timedOut = false, exitCode = 0, evidenceErrors = [] }: SummarizeOptions = {}): UsageSummary {
  const isAssistant = (event: EventRecord): boolean => prop(event.message, "role") === "assistant";
  const starts = events.filter((event) => event.type === "message_start" && isAssistant(event)).length;
  const ends = events.filter((event) => event.type === "message_end" && isAssistant(event));
  const usages = ends.map((event) => prop(event.message, "usage"));
  const reasons: string[] = [];
  const agentStarts = events.filter((event) => event.type === "agent_start").length;
  const agentEnds = events.filter((event) => event.type === "agent_end").length;
  if (timedOut) reasons.push("timed_out");
  if (exitCode !== 0) reasons.push("process_failed");
  if (evidenceErrors.length) reasons.push("invalid_event_evidence");
  if (!agentStarts) reasons.push("missing_agent_start");
  if (!agentEnds) reasons.push("missing_agent_end");
  if (agentStarts !== agentEnds) reasons.push("unmatched_agent_runs");
  if (!ends.length) reasons.push("no_completed_assistant_messages");
  if (starts !== ends.length) reasons.push("unmatched_assistant_messages");
  if (ends.some((event) => { const stopReason = prop(event.message, "stopReason"); return stopReason !== "stop" && stopReason !== "toolUse"; })) {
    reasons.push("interrupted_or_failed_message");
  }
  const sumField = (values: readonly unknown[]): FieldCoverage => {
    const observed = values.filter(finite);
    return { observed: observed.length ? observed.reduce((sum, value) => sum + value, 0) : null, messagesWithValue: observed.length };
  };
  const tokenCoverage = perField((field) => sumField(usages.map((usage) => prop(usage, field))));
  if (usages.some((usage) => !USAGE_FIELDS.every((field) => finite(prop(usage, field))))) reasons.push("missing_or_invalid_token_usage");
  const complete = reasons.length === 0;
  const observed = perField((field) => tokenCoverage[field].observed);
  const cost = sumField(usages.map((usage) => prop(prop(usage, "cost"), "total")));
  return { complete, reasons, startedAgentRuns: agentStarts, completedAgentRuns: agentEnds, startedMessages: starts, completedMessages: ends.length,
    messagesWithUsage: usages.filter(isRecord).length,
    observed, totals: complete ? observed : null,
    tokenCoverage, observedValuesAreLowerBounds: !complete,
    cost: { observedTotal: cost.observed, complete: complete && cost.messagesWithValue === ends.length,
      total: complete && cost.messagesWithValue === ends.length ? cost.observed : null } };
}

/** The verify verdict's pass flag, or null (with an error recorded) when the board is unusable. */
function readBoard(file: string, errors: ScoringIssue[]): boolean | null {
  try {
    return parseJsonAs(BoardSchema, fs.readFileSync(file, "utf8")).verdicts.verify.pass;
  } catch (error) {
    errors.push(issue("verdicts.json", errorCode(error) === "ENOENT" ? "missing" : "invalid_or_unreadable"));
    return null;
  }
}

export function scoreCase({ name, dir, workspace, logs, hostLogs, targetLogFile, priorTargetRequests = 0,
  timedOut, exitCode, agentDurationMs, validateCoding, now = Date.now }: ScoreCaseOptions): ScoredCase {
  const scoringStarted = now();
  const eventEvidence = readJsonLines(path.join(hostLogs, "events.jsonl"), "events.jsonl", isEventRecord);
  const messages = eventEvidence.rows;
  const errors = [...eventEvidence.errors];
  const ends = messages.filter((event) => event.type === "message_end" && prop(event.message, "role") === "assistant");
  const response = ends.at(-1)?.message;
  const content = prop(response, "content");
  const text = Array.isArray(content) ? content.flatMap((item: unknown) => {
    const itemText = prop(item, "text");
    return prop(item, "type") === "text" && typeof itemText === "string" ? [itemText] : [];
  }).join("\n") : "";
  fs.writeFileSync(path.join(dir, "response.md"), text);
  const usageSummary = summarizeUsage(messages, { timedOut, exitCode, evidenceErrors: eventEvidence.errors });
  for (const reason of ["missing_agent_start", "missing_agent_end", "unmatched_agent_runs", "unmatched_assistant_messages"]) {
    if (usageSummary.reasons.includes(reason)) errors.push(issue("events.jsonl", reason));
  }
  const toolCalls = messages.filter((event) => event.type === "tool_execution_start").length;
  const diagnostics = messages.filter((event) => event.type === "message_end" && prop(event.message, "role") === "custom").length;
  const queuedSteering = messages.filter((event) => event.type === "queue_update" && (hasLength(event.steering) || hasLength(event.followUp))).length;
  const lifecycle = readJsonLines(path.join(logs, "lifecycle.jsonl"), "lifecycle.jsonl", (row): row is LifecycleRecord => matches(LifecycleSchema, row));
  errors.push(...lifecycle.errors);
  const pending = lifecycle.errors.length ? null : lifecycle.rows.some((row) => row.pendingMessages);
  const stopReason = prop(response, "stopReason");
  let behavioralPassed = !timedOut && exitCode === 0 && stopReason === "stop" && text.trim().length > 0;
  if (["hello", "clarification"].includes(name)) behavioralPassed &&= toolCalls === 0 && diagnostics === 0 && queuedSteering === 0 && pending === false
    && !fs.existsSync(path.join(workspace, ".pi/verdicts.json"));
  if (name === "coding") {
    try {
      if (!validateCoding) throw new Error("no coding validator");
      const validation = validateCoding(); behavioralPassed &&= validation.status === 0;
    }
    catch { errors.push(issue("coding_validation", "execution_error")); }
  }
  let reportReview: ReportReview | null = null;
  if (name.startsWith("cyber")) {
    reportReview = { status: "pending", reason: "Report evidence, claims, impact and remediation require independent evidence review." };
    const target = readJsonLines(targetLogFile, "target/requests.jsonl", (row): row is TargetRequest => matches(TargetRequestSchema, row));
    errors.push(...target.errors);
    const requests = target.rows.slice(priorTargetRequests);
    const matrix = ["anonymous:101:401", "anonymous:202:401", "alice:101:200", "bob:202:200", "alice:202:200", "bob:101:200"];
    const observed = new Set(requests.filter((row) => row.method === "GET" && /^\/invoices\/(101|202)$/.test(row.path))
      .map((row) => `${row.user}:${row.path.split("/").pop() ?? ""}:${row.status}`));
    const missing = matrix.filter((entry) => !observed.has(entry));
    let reportNonempty = false;
    try { reportNonempty = fs.readFileSync(path.join(workspace, "finding.md"), "utf8").trim().length > 0; }
    catch (error) { errors.push(issue("finding.md", errorCode(error) === "ENOENT" ? "missing" : "unreadable")); }
    behavioralPassed &&= missing.length === 0 && reportNonempty;
    fs.writeFileSync(path.join(dir, "target-evidence.json"), JSON.stringify({ requests, matrixComplete: missing.length === 0,
      missing, reportNonempty, reportReview, errors: target.errors }, null, 2));
  }
  if (name === "verify-failure") {
    const verifyPass = readBoard(path.join(workspace, ".pi/verdicts.json"), errors);
    behavioralPassed &&= verifyPass === false && diagnostics === 1 && pending === false && /fail|block|not pass/i.test(text);
  }
  behavioralPassed = behavioralPassed && errors.length === 0;
  const outcome: CaseOutcome = errors.length ? "error" : !behavioralPassed ? "failed" : reportReview ? "pending_review" : "passed";
  return { name, passed: outcome === "pending_review" ? null : behavioralPassed, behavioralPassed, outcome, reportReview,
    timedOut, exitCode, agentDurationMs, scoringDurationMs: now() - scoringStarted,
    toolCalls, diagnostics, queuedSteering, pending, stopReason: stopReason ?? null,
    usage: ends.map((event) => prop(event.message, "usage") ?? null), usageSummary, response: text, errors };
}

// Persist after every case. Infrastructure/scoring exceptions must not discard later cases.
export async function runCases({ selected, runCase, persist, now = Date.now }: RunCasesOptions): Promise<RecordedCase[]> {
  const summary: RecordedCase[] = [];
  for (const name of selected) {
    const started = now();
    let result: CaseResult;
    try { result = await runCase(name); }
    catch (error) {
      // Only a conventional error code is recorded: the message may carry secrets.
      const code = errorCode(error);
      result = { name, passed: false, behavioralPassed: false, outcome: "error", reportReview: name.startsWith("cyber") ? { status: "pending" } : null,
        timedOut: null, exitCode: null, agentDurationMs: null, scoringDurationMs: null,
        usage: [], usageSummary: summarizeUsage([], { exitCode: null }),
        errors: [{ artifact: "case_execution", code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "exception" }] };
    }
    const recorded = Object.assign(result, { durationMs: now() - started });
    summary.push(recorded);
    await persist(recorded, summary);
  }
  return summary;
}

export function resultExitCode(summary: readonly ExitCodeInput[]): 0 | 1 | 2 {
  if (!summary.length || summary.some((result) => !result.behavioralPassed)) return 1;
  return summary.some((result) => result.outcome === "pending_review" || result.passed !== true) ? 2 : 0;
}
