import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readJsonLines, runCases, scoreCase, summarizeUsage, resultExitCode } from "../packages/core/eval/live/scoring.ts";
import { runBoundedProcess } from "../packages/core/eval/live/process.ts";
import { resolveProvider } from "../packages/core/eval/live/provider.ts";

type MatrixCell = [user: string, id: string, status: number];

// The per-case options scoreCase reads. `validateCoding` is only called for the "coding" case;
// the other fixtures leave it undefined (scoring.ts infers it as a required key).
interface CaseFixture {
  name: string;
  dir: string;
  workspace: string;
  logs: string;
  hostLogs: string;
  targetLogFile: string;
  timedOut: boolean;
  exitCode: number;
  agentDurationMs: number;
  validateCoding: (() => { status: number }) | undefined;
}

const usage = { input: 10, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 22, cost: { total: 0.05 } };
const assistant = (overrides: Record<string, unknown> = {}) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done; verification failed as expected." }], usage, ...overrides });
const stream = (messages: object[] = [assistant()]) => [
  { type: "agent_start" },
  ...messages.flatMap((message) => [{ type: "message_start", message: { role: "assistant" } }, { type: "message_end", message }]),
  { type: "agent_end" },
];
const matrixCells: MatrixCell[] = [["anonymous", "101", 401], ["anonymous", "202", 401], ["alice", "101", 200], ["bob", "202", 200], ["alice", "202", 200], ["bob", "101", 200]];
const matrix = matrixCells
  .map(([user, id, status]) => ({ method: "GET", path: `/invoices/${id}`, user, status }));
const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function fixture(t: TestContext, name = "cyber"): CaseFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-score-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("pi-score-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const options: CaseFixture = { name, dir, workspace: path.join(dir, "workspace"), logs: path.join(dir, "logs"), hostLogs: path.join(dir, "host"),
    targetLogFile: path.join(dir, "requests.jsonl"), timedOut: false, exitCode: 0, agentDurationMs: 23, validateCoding: undefined };
  for (const sub of [options.workspace, options.logs, options.hostLogs]) fs.mkdirSync(sub);
  fs.writeFileSync(path.join(options.hostLogs, "events.jsonl"), jsonl(stream()));
  fs.writeFileSync(path.join(options.logs, "lifecycle.jsonl"), jsonl([{ pendingMessages: false }]));
  fs.writeFileSync(options.targetLogFile, jsonl(matrix));
  fs.writeFileSync(path.join(options.workspace, "finding.md"), "Observed cross-account invoice reads. Evidence awaits human review.");
  return options;
}

for (const content of ["", " \n\t"]) await test(`empty cyber deliverable fails (${JSON.stringify(content)})`, (t) => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.workspace, "finding.md"), content);
  const result = scoreCase(options);
  assert.equal(result.behavioralPassed, false);
  assert.equal(result.passed, false);
  assert.equal(result.outcome, "failed");
  assert.equal(result.reportReview?.status, "pending");
});
await test("complete matrix and nonempty prose passes behavior while full review stays pending", (t) => {
  const result = scoreCase(fixture(t));
  assert.equal(result.behavioralPassed, true);
  assert.equal(result.passed, null);
  assert.equal(result.outcome, "pending_review");
  assert.equal(result.reportReview?.status, "pending");
});
await test("incomplete matrix fails and records the missing control", (t) => {
  const options = fixture(t);
  fs.writeFileSync(options.targetLogFile, jsonl(matrix.slice(1)));
  assert.equal(scoreCase(options).behavioralPassed, false);
  const evidence = JSON.parse(fs.readFileSync(path.join(options.dir, "target-evidence.json"), "utf8")) as { missing: string[] };
  assert.deepEqual(evidence.missing, ["anonymous:101:401"]);
});
await test("holdout: non-invoice paths and prior case requests cannot satisfy controls", (t) => {
  const options = fixture(t);
  fs.writeFileSync(options.targetLogFile, jsonl([...matrix, ...matrix.map((row) => ({ ...row, path: row.path.replace("invoices", "other") }))]));
  assert.equal(scoreCase({ ...options, priorTargetRequests: 6 }).behavioralPassed, false);
});
for (const kind of ["missing", "malformed", "empty", "wrong_shape"]) await test(`${kind} target evidence gives structured error and preserves usage`, (t) => {
  const options = fixture(t);
  if (kind === "missing") fs.unlinkSync(options.targetLogFile);
  else fs.writeFileSync(options.targetLogFile, kind === "malformed" ? jsonl(matrix) + "{truncated" : kind === "empty" ? "" : jsonl([{}]));
  const result = scoreCase(options);
  assert.equal(result.outcome, "error");
  assert.equal(result.behavioralPassed, false);
  assert.equal(result.usageSummary.totals?.totalTokens, 22);
  assert.ok(result.errors.some((error) => error.artifact === "target/requests.jsonl"));
});
for (const kind of ["missing", "malformed", "wrong_shape"]) await test(`${kind} verdict board fails closed`, (t) => {
  const options = fixture(t, "verify-failure");
  if (kind !== "missing") {
    fs.mkdirSync(path.join(options.workspace, ".pi"));
    fs.writeFileSync(path.join(options.workspace, ".pi/verdicts.json"), kind === "malformed" ? "{" : '{"verdicts":{"verify":{"pass":"false"}}}');
  }
  const result = scoreCase(options);
  assert.equal(result.outcome, "error");
  assert.ok(result.errors.some((error) => error.artifact === "verdicts.json"));
});
await test("valid failed verdict is a successful verify-failure control", (t) => {
  const options = fixture(t, "verify-failure");
  fs.mkdirSync(path.join(options.workspace, ".pi"));
  fs.writeFileSync(path.join(options.workspace, ".pi/verdicts.json"), '{"verdicts":{"verify":{"pass":false}}}');
  fs.appendFileSync(path.join(options.hostLogs, "events.jsonl"), jsonl([{ type: "message_end", message: { role: "custom" } }]));
  const result = scoreCase(options);
  assert.equal(result.passed, true);
});
for (const artifact of ["events.jsonl", "lifecycle.jsonl"]) await test(`malformed ${artifact} cannot silently pass`, (t) => {
  const options = fixture(t, "hello");
  fs.appendFileSync(path.join(artifact === "events.jsonl" ? options.hostLogs : options.logs, artifact), '{"truncated":');
  const result = scoreCase(options);
  assert.equal(result.outcome, "error");
  assert.ok(result.errors.some((error) => error.artifact === artifact));
  if (artifact === "events.jsonl") {
    assert.equal(result.usageSummary.complete, false);
    assert.equal(result.usageSummary.observed.totalTokens, 22);
    assert.equal(result.usageSummary.totals, null);
  }
});
await test("coding validation duration is separate from captured agent duration", (t) => {
  let clock = 1000;
  const result = scoreCase({ ...fixture(t, "coding"), now: () => clock, validateCoding: () => { clock += 350; return { status: 0 }; } });
  assert.equal(result.passed, true);
  assert.equal(result.agentDurationMs, 23);
  assert.equal(result.scoringDurationMs, 350);
});
await test("coding validator execution failure preserves known token use", (t) => {
  const result = scoreCase({ ...fixture(t, "coding"), validateCoding: () => { throw new Error("unavailable"); } });
  assert.equal(result.outcome, "error");
  assert.equal(result.usageSummary.totals?.totalTokens, 22);
});
await test("case exception and missing evidence persist, then later cases still run", async (t) => {
  const missing = fixture(t, "cyber"), healthy = fixture(t, "hello");
  fs.unlinkSync(missing.targetLogFile);
  const file = path.join(healthy.dir, "summary.json");
  const snapshots: unknown[][] = [];
  const results = await runCases({ selected: ["setup-failure", "cyber", "hello"], runCase: async (name: string) => {
    if (name === "setup-failure") throw Object.assign(new Error("must not leak secret payload"), { code: "ENOENT" });
    return scoreCase(name === "cyber" ? missing : healthy);
  }, persist: (result: unknown, summary: unknown[]) => { fs.writeFileSync(file, JSON.stringify(summary)); snapshots.push(JSON.parse(fs.readFileSync(file, "utf8")) as unknown[]); } });
  assert.deepEqual(results.map((result) => result.outcome), ["error", "error", "passed"]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.length), [1, 2, 3]);
  const [failure] = results;
  assert.ok(failure, "the setup failure has a result");
  assert.equal(failure.errors[0]?.code, "ENOENT");
  assert.equal(JSON.stringify(results).includes("secret payload"), false);
  assert.equal(failure.usageSummary.observed.totalTokens, null);
  assert.ok(results.every((result) => result.durationMs >= 0));
});
await test("complete multi-message usage sums tokens, caches and cost once", () => {
  const result = summarizeUsage(stream([assistant({ stopReason: "toolUse" }), assistant()]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.totals, { input: 20, output: 8, cacheRead: 12, cacheWrite: 4, totalTokens: 44 });
  assert.equal(result.cost.total, 0.1);
});
await test("absent usage remains unknown, not zero", () => {
  const result = summarizeUsage(stream([assistant({ usage: undefined })]));
  assert.equal(result.complete, false);
  assert.equal(result.totals, null);
  assert.equal(result.observed.totalTokens, null);
});
await test("partial and invalid usage retain valid observed fields with explicit coverage", () => {
  const result = summarizeUsage(stream([assistant(), assistant({ usage: { input: 3, output: -1, totalTokens: "4" } })]));
  assert.equal(result.complete, false);
  assert.equal(result.observed.input, 13);
  assert.equal(result.observed.output, 4);
  assert.equal(result.tokenCoverage.output.messagesWithValue, 1);
  assert.equal(result.cost.complete, false);
});
await test("interrupted generation retains completed tokens as an incomplete observation", () => {
  const events = stream().slice(0, -1);
  events.push({ type: "message_start", message: { role: "assistant" } });
  const result = summarizeUsage(events, { timedOut: true, exitCode: 137 });
  assert.equal(result.complete, false);
  assert.equal(result.observed.totalTokens, 22);
  assert.equal(result.totals, null);
  assert.equal(result.observedValuesAreLowerBounds, true);
  assert.ok(result.reasons.includes("unmatched_assistant_messages"));
  assert.ok(result.reasons.includes("timed_out"));
});
await test("failed generation with zero-valued SDK usage is never complete consumption", () => {
  const result = summarizeUsage(stream([assistant({ stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } })]));
  assert.equal(result.complete, false);
  assert.equal(result.totals, null);
});
await test("absent optional cost stays unknown without invalidating complete token coverage", () => {
  const result = summarizeUsage(stream([assistant({ usage: { ...usage, cost: undefined } })]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.cost, { observedTotal: null, complete: false, total: null });
});
await test("missing JSONL artifact returns a structured record without throwing", (t) => {
  const options = fixture(t);
  assert.deepEqual(readJsonLines(path.join(options.dir, "absent"), "absent"), { rows: [], errors: [{ artifact: "absent", code: "missing" }] });
});

await test("holdout: a truncated stream without agent_end cannot pass", (t) => {
  const options = fixture(t, "hello");
  fs.writeFileSync(path.join(options.hostLogs, "events.jsonl"), jsonl(stream().slice(0, -1)));
  const result = scoreCase(options);
  assert.equal(result.outcome, "error");
  assert.ok(result.errors.some((error) => error.code === "missing_agent_end"));
  assert.equal(result.usageSummary.complete, false);
});

await test("holdout: an unfinished follow-up cannot borrow the first agent_end", (t) => {
  const options = fixture(t, "clarification");
  fs.appendFileSync(path.join(options.hostLogs, "events.jsonl"), jsonl([{ type: "agent_start" }]));
  const result = scoreCase(options);
  assert.equal(result.outcome, "error");
  assert.equal(result.usageSummary.complete, false);
  assert.ok(result.errors.some((error) => error.code === "unmatched_agent_runs"));
});
await test("holdout: structurally corrupt message cannot be silently ignored after valid evidence", (t) => {
  const options = fixture(t, "hello");
  fs.appendFileSync(path.join(options.hostLogs, "events.jsonl"), jsonl([{ type: "message_end", message: {} }]));
  const result = scoreCase(options);
  assert.equal(result.outcome, "error");
  assert.equal(result.usageSummary.complete, false);
  assert.equal(result.usageSummary.observed.totalTokens, 22);
});

await test("pending report review cannot give CI a successful exit code", () => {
  const passed = { behavioralPassed: true, passed: true, outcome: "passed" };
  const pending = { behavioralPassed: true, passed: null, outcome: "pending_review" };
  const failed = { behavioralPassed: false, passed: false, outcome: "error" };
  assert.equal(resultExitCode([passed]), 0);
  assert.equal(resultExitCode([passed, pending]), 2);
  assert.equal(resultExitCode([pending, failed]), 1);
  assert.equal(resultExitCode([]), 1);
});
await test("hung host process terminates even when container stop throws", { timeout: 5000 }, async () => {
  let stopCalls = 0;
  const result = await runBoundedProcess({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    stdio: "ignore", timeoutMs: 100, stop: () => { stopCalls++; throw new Error("unavailable stop"); } });
  assert.equal(result.timedOut, true);
  assert.equal(stopCalls, 1);
  assert.notEqual(result.exitCode, 0);
});
await test("completed host process clears timeout without stopping unrelated work", async () => {
  let stopCalls = 0;
  const result = await runBoundedProcess({ command: process.execPath, args: ["-e", "process.exit(0)"],
    stdio: "ignore", timeoutMs: 5000, stop: () => { stopCalls++; } });
  assert.deepEqual(result, { exitCode: 0, timedOut: false });
  assert.equal(stopCalls, 0);
});

function modelsFixture(t: TestContext, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("pi-provider-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, content);
  return file;
}
for (const [label, content] of [
  ["empty object", "{}"],
  ["null providers map", '{"providers":null}'],
  ["null provider", '{"providers":{"x":null}}'],
  ["empty models", '{"providers":{"x":{"models":[]}}}'],
  ["model without id", '{"providers":{"x":{"models":[{}]}}}'],
  ["null document", "null"],
  ["array document", "[]"],
  ["non-array models map", '{"providers":{"x":{"models":{"0":{"id":"m"}}}}}'],
] satisfies Array<[string, string]>) await test(`malformed models file (${label}) throws a descriptive Error, not a TypeError`, (t) => {
  const file = modelsFixture(t, content);
  let error: unknown;
  try {
    resolveProvider(file, "x");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.equal(error instanceof TypeError, false);
  assert.ok(error.message.length > 0);
});
await test("valid models file returns the requested provider object", (t) => {
  const file = modelsFixture(t, '{"providers":{"x":{"models":[{"id":"m"}]}}}');
  assert.deepEqual(resolveProvider(file, "x"), { models: [{ id: "m" }] });
});
