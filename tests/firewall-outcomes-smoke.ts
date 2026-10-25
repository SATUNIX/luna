#!/usr/bin/env node
// The three outcomes are never confused, and no path waits for a UI that is not there.
//   HARD DENY         policy says never (critical tier, a policy deny, a pentest rule): no approval and no
//                     judge can override it, and the operator is never asked.
//   UNCERTAIN         the automatic layers could not settle it (the judge unsure of a block, unavailable,
//                     timed out, aborted; a command the classifier cannot read) or nobody could be asked:
//                     escalated to the operator when a UI or console exists, otherwise refused, bounded,
//                     with a message the agent can relay.
//   OPERATOR DECISION a human allowed or denied it.
// A high-confidence judge block stays a block with its reason. Offline: the judge is a stub.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv, textOf, type FakeToolResult } from "../packages/core/eval/harness.ts";
import { isRecord, number, object, parseJson, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as Approvals from "../packages/extensions/src/tool-firewall/approvals.ts";
import { answerPending, startConsole } from "./console-answer.ts";

const root = tmpWorkspace("pi-kit-fw-out-");
const ws = path.join(root, "ws");
fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });
const agentDir = path.join(root, "agent");
const configFile = path.join(agentDir, "pi-kit", "firewall.json");
const consoleDir = path.join(root, "console");
const pendingDir = path.join(consoleDir, "pending");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", home),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(root, "legacy")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(root, "audit.jsonl")),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", consoleDir),
  setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "150"),
  setEnv("PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS", "150"),
  setEnv("PI_KIT_FIREWALL_JUDGE_TIMEOUT_MS", "150"),
];
startConsole(); // the console creates the answer key; requesters never do
const keepAlive = setInterval(() => {}, 1000);
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};
const config = (c: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  // Learning is off unless a test turns it on: repeated "Allow once" answers would otherwise become a learned allow.
  fs.writeFileSync(configFile, JSON.stringify({ policy: "coding", learn: false, knownHosts: [], source: "user", ...c }));
};
const audit = () => fs.readFileSync(path.join(root, "audit.jsonl"), "utf8").trim().split("\n").map((l): AuditLine => {
  const line = parseJson(l);
  assert.ok(isRecord(line), "an audit line is a JSON object");
  return line;
});
/** The `i`th element of `xs`, asserting it exists. */
const at = <T>(xs: readonly T[], i: number, what: string): T => { const x = xs[i]; assert.ok(x !== undefined, what); return x; };
/** A request filed in the human console's pending directory: the fields these checks read. */
const ConsoleRequest = object({ id: string(), timeoutMs: number(), body: string() });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Nothing in this file may wait on a person: every await is raced against a hard limit.
const limited = <T>(p: Promise<T>, ms = 4000, label = "call"): Promise<T> => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} hung for ${ms} ms`); })]);

type FakePi = ReturnType<typeof fakePi>;
// The stub judge: a fixed reply, a reply computed from the abort signal, or null for "no judge configured".
type Judge = string | null | ((signal: AbortSignal | undefined) => unknown);
// One audit log entry; the checks only compare its fields (event, why, outcome, decider...) with expected values.
type AuditLine = Record<string, unknown>;
interface UiExtra {
  session?: string;
  signal?: AbortSignal;
}
interface Note {
  m: string;
  l: string | undefined;
}
// pi's dialog options, passed through to ui.select.
interface DialogOptions {
  timeout?: number;
  signal?: AbortSignal;
}
// A tool_call handler's answer; the handler returns undefined to allow.
interface ToolCallResult {
  block?: boolean;
  reason: string;
}
interface SelectCall {
  title: string;
  options: string[];
}

async function gate(judge: Judge): Promise<{ pi: FakePi; judged: string[] }> {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  const judged: string[] = [];
  register(pi.api, {
    complete: judge === null ? null : async (system: string, prompt: string, signal?: AbortSignal) => {
      if (!/review one tool call/.test(system)) return '{"principles":["p"],"cautions":["c"]}';
      judged.push(prompt);
      return typeof judge === "function" ? judge(signal) : judge;
    },
  });
  await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
  return { pi, judged };
}
// Each context is a new session unless `session` is given: the judge's verdicts are cached per session and turn.
let sessions = 0;
const ui = (answers: string[], extra: UiExtra = {}) => {
  const seen: SelectCall[] = [];
  const notes: Note[] = [];
  const id = extra.session ?? `O1-${++sessions}`;
  delete extra.session;
  return {
    seen,
    notes,
    ctx: {
      cwd: ws,
      hasUI: true,
      sessionManager: { getSessionId: () => id },
      ui: { notify: (m: string, l?: string) => notes.push({ m, l }), select: async (title: string, options: string[]) => (seen.push({ title, options }), answers.shift()), input: async () => "use staging" },
      ...extra,
    },
  };
};
const headless = (extra: UiExtra = {}) => ({ cwd: ws, hasUI: false, ui: {}, sessionManager: { getSessionId: () => `O2-${++sessions}` }, ...extra });
const run = (pi: FakePi, tool: string, input: Record<string, unknown>, ctx: object) => limited<ToolCallResult>(Promise.resolve(pi.handlers.get("tool_call")({ toolName: tool, input }, ctx)) as Promise<ToolCallResult>, 4000, `${tool} ${JSON.stringify(input)}`);
const bash = (pi: FakePi, command: string, ctx: object) => run(pi, "bash", { command }, ctx);
const TAGS = ["HARD DENY", "UNCERTAIN", "OPERATOR DECISION", "AUTO-MODE BLOCK"];
const tagsIn = (text: string) => TAGS.filter((t) => text.includes(`[${t}`));
const hashOf = (command: string) => crypto.createHash("sha256").update(JSON.stringify({ input: { command }, toolName: "bash" })).digest("hex");
const BLOCK = (confidence: string | undefined, extra = "") => `{"verdict":"block",${confidence ? `"confidence":"${confidence}",` : ""}"reason":"goes beyond the request"${extra}}`;
const MEDIUM = "npm install left-pad";

try {
  // 1. HARD DENY: never asked, never overridable. ----------------------------------------------------
  for (const mode of ["manual", "auto"]) {
    config({ mode });
    const { pi, judged } = await gate('{"verdict":"allow","confidence":"high","reason":"fine"}');
    const v = ui(["Allow once", "Allow once"]);
    const r = await bash(pi, "rm -rf ~", v.ctx);
    assert.equal(r.block, true);
    assert.deepEqual(tagsIn(r.reason), ["HARD DENY"], "exactly one outcome label");
    assert.match(r.reason, /never allowed automatically, whatever an approval or the auto-mode judge says/);
    assert.equal(v.seen.length, 0, "a hard deny is never put to the operator");
    assert.equal(judged.length, 0, "and never reaches the judge");
    assert.equal((await bash(pi, "rm -rf ~", headless())).block, true);
    assert.ok(!fs.existsSync(pendingDir) || fs.readdirSync(pendingDir).length === 0, "nor to the console");
  }
  {
    // Not overridable by an approval either: a valid session approval for the very same action is ignored.
    config({ mode: "manual" });
    const approvals = await loadModule<typeof Approvals>("extensions/tool-firewall/approvals.ts");
    approvals.addApproval({ context: "session", session: "O1", workspace: ws, cwd: ws, policy: "coding", tool: "bash", hash: hashOf("rm -rf ~"), families: [], scopes: [], tier: "high", grantedBy: { actor: "operator", via: "card", session: "O1", mode: "manual", policy: "coding" }, action: { command: "rm -rf ~", summary: "s", steps: [], reasons: [], chain: [] } });
    const { pi } = await gate('{"verdict":"allow","confidence":"high","reason":"fine"}');
    const r = await bash(pi, "rm -rf ~", ui([]).ctx);
    assert.equal(r.block, true, "an approval cannot override a hard deny");
    assert.deepEqual(tagsIn(r.reason), ["HARD DENY"]);
    fs.rmSync(path.join(agentDir, "pi-kit", "firewall-approvals.json"), { force: true });
    // A policy deny rule and a pentest command rule are hard denies too.
    const policyFile = path.join(root, "policy.json");
    fs.writeFileSync(policyFile, JSON.stringify({ defaults: { unknown: "ask" }, tools: { never_tool: { decision: "deny" } }, command_rules: { deny: [], ask: [] } }));
    const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", policyFile);
    try {
      const g = await gate('{"verdict":"allow","confidence":"high","reason":"fine"}');
      const denied = await run(g.pi, "never_tool", {}, ui([]).ctx);
      assert.deepEqual(tagsIn(denied.reason), ["HARD DENY"]);
    } finally {
      restorePolicy();
    }
    config({ mode: "manual", policy: "pentest" });
    const p = await gate(null);
    const pv = ui(["Allow once"]);
    const rule = await bash(p.pi, "rm -r build", pv.ctx);
    assert.deepEqual(tagsIn(rule.reason), ["HARD DENY"]);
    assert.equal(pv.seen.length, 0);
    // Pentest, headless, high impact: the policy needs an interactive operator: hard deny, no console request.
    const high = await bash(p.pi, "git push --force origin main", headless());
    assert.deepEqual(tagsIn(high.reason), ["HARD DENY"]);
    assert.match(high.reason, /interactive operator/);
    assert.ok(!fs.existsSync(pendingDir) || fs.readdirSync(pendingDir).length === 0);
    const records = audit().filter((l) => l.outcome === "hard_deny");
    assert.ok(records.length >= 4 && records.every((l) => l.decision === "deny" || l.event === "tool_blocked" || l.event === "tool_seen"), "hard denies are logged as outcome=hard_deny");
    ok("HARD DENY is labelled, never asked, never judged, and not overridable by an approval or a permissive judge");
  }

  // 2. The judge's confidence: only an unsure block escalates. --------------------------------------
  config({ mode: "auto" });
  for (const conf of ["high", undefined]) {
    const { pi } = await gate(BLOCK(conf));
    const v = ui(["Allow once"]);
    const r = await bash(pi, MEDIUM, v.ctx);
    assert.equal(r.block, true, `${conf ?? "no"} confidence: the block is final`);
    assert.equal(v.seen.length, 0, "final: the operator is not interrupted");
    assert.deepEqual(tagsIn(r.reason), ["AUTO-MODE BLOCK"]);
    assert.match(r.reason, /auto-mode blocked bash — goes beyond the request/);
    assert.match(r.reason, /explain why to the user/);
    assert.ok(v.notes.some((n) => n.l === "warning" && /goes beyond the request/.test(n.m)));
  }
  for (const conf of ["medium", "low"]) {
    {
      const { pi } = await gate(BLOCK(conf, ',"differs":"installs a package the request did not name"'));
      const allow = ui(["Allow once"]);
      assert.equal(await bash(pi, MEDIUM, allow.ctx), undefined, `${conf}: the operator can allow it`);
      assert.equal(allow.seen.length, 1, `${conf} confidence: the block escalates to the operator`);
      const card = at(allow.seen, 0, "the operator was asked").title;
      assert.match(card, /^UNCERTAIN · MEDIUM · bash · /);
      assert.match(card, new RegExp(`Judge: unsure whether to block \\(${conf} confidence\\): installs a package the request did not name`));
      const deny = ui(["Deny"]);
      const r = await bash(pi, "npm install lodash", deny.ctx);
      assert.equal(r.block, true);
      assert.deepEqual(tagsIn(r.reason), ["OPERATOR DECISION"], "the operator's denial is an operator decision, not a judge block");
      assert.match(r.reason, /the operator declined this action/);
      assert.match(r.reason, /The auto-mode judge also flagged it/);
    }
  }
  {
    // The escalation and the final outcome are both in the audit log.
    const lines = audit();
    const esc = lines.filter((l) => l.event === "tool_escalated" && l.why === "judge_unsure");
    assert.ok(esc.length >= 4 && esc.every((l) => l.outcome === "uncertain"));
    assert.ok(lines.some((l) => l.event === "tool_approved" && l.decider === "human" && l.outcome === "operator_decision"));
    assert.ok(lines.some((l) => l.event === "tool_blocked" && l.decider === "human" && l.outcome === "operator_decision"));
    assert.ok(lines.some((l) => l.event === "tool_blocked" && l.decider === "judge" && l.outcome === "judge_block"));
    assert.ok(lines.some((l) => l.event === "auto_mode_blocked" && l.confidence === "medium" && l.escalated === true));
  }
  {
    // An allow verdict runs whatever its confidence; the verdict (with its confidence) is cached per turn.
    const { pi } = await gate('{"verdict":"allow","confidence":"low","reason":"probably fine"}');
    assert.equal(await bash(pi, MEDIUM, ui([]).ctx), undefined);
    const cached = await gate(BLOCK("medium"));
    const first = ui(["Deny"], { session: "cache-1" });
    await bash(cached.pi, MEDIUM, first.ctx);
    const second = ui(["Deny"], { session: "cache-1" });
    await bash(cached.pi, MEDIUM, second.ctx);
    assert.equal(cached.judged.length, 1, "the verdict is cached per action and turn");
    assert.equal(second.seen.length, 1, "...and a cached unsure block still escalates");
    assert.match(at(second.seen, 0, "the operator was asked").title, /^UNCERTAIN/);
  }
  {
    // A high-tier action keeps its existing flow: a judge block goes to the operator, whatever the confidence.
    config({ mode: "auto", learn: true }); // high actions reach the judge only through learning
    const { pi } = await gate(BLOCK("high"));
    const sudo = "sudo systemctl restart nginx";
    assert.equal(await bash(pi, sudo, ui(["Allow once"]).ctx), undefined);
    const again = ui(["Allow once"]);
    assert.equal(await bash(pi, "sudo systemctl restart apache2", again.ctx), undefined);
    assert.match(at(again.seen, 0, "the operator was asked").title, /Judge: out of scope\?: goes beyond the request/, "a sure block on a high action still asks the operator, untagged");
    assert.doesNotMatch(at(again.seen, 0, "the operator was asked").title, /^UNCERTAIN/);
    const unsure = await gate(BLOCK("medium"));
    const u = ui(["Allow once"]);
    assert.equal(await bash(unsure.pi, "sudo systemctl restart mysql", u.ctx), undefined);
    assert.equal(u.seen.length, 1);
    assert.match(at(u.seen, 0, "the operator was asked").title, /^UNCERTAIN · HIGH/);
    assert.match(at(u.seen, 0, "the operator was asked").title, /Judge: not sure \(medium confidence\) it fits what you allowed: goes beyond the request/);
    config({ mode: "auto" });
    ok("only a medium/low-confidence judge block escalates (card tagged UNCERTAIN); a high-confidence one stays a labelled block");
  }

  // 3. Judge unavailable, hanging, throwing or aborted: escalate, bounded. -----------------------------
  {
    for (const [label, judge] of [["garbage", "not json"], ["throws", () => Promise.reject(new Error("provider down"))], ["hangs", () => new Promise(() => {})]] satisfies Array<[string, Judge]>) {
      const { pi } = await gate(judge);
      const v = ui(["Allow once"]);
      const t0 = Date.now();
      assert.equal(await bash(pi, MEDIUM, v.ctx), undefined, `${label}: escalated and allowed by the operator`);
      assert.ok(Date.now() - t0 < 2000, `${label}: bounded (${Date.now() - t0} ms)`);
      assert.match(at(v.seen, 0, "the operator was asked").title, /^UNCERTAIN · MEDIUM/);
      assert.match(at(v.seen, 0, "the operator was asked").title, /Judge: judge unavailable — asking you instead/);
      assert.ok(v.notes.some((n) => /judge unavailable/.test(n.m)));
    }
    assert.ok(audit().some((l) => l.event === "tool_escalated" && l.why === "judge_unavailable" && l.outcome === "uncertain"));
    // No judge configured at all, headless, no console answer: bounded UNCERTAIN.
    const none = await gate(null);
    const t0 = Date.now();
    const r = await bash(none.pi, MEDIUM, headless());
    assert.equal(r.block, true);
    assert.deepEqual(tagsIn(r.reason), ["UNCERTAIN"]);
    assert.ok(Date.now() - t0 < 2500);
    // Aborted while the judge is still thinking: it stops at once (well before the judge timeout), then the
    // prompt is cancelled and nothing runs.
    const slow = await gate(() => new Promise(() => {}));
    const restore = setEnv("PI_KIT_FIREWALL_JUDGE_TIMEOUT_MS", "5000");
    try {
      const ac = new AbortController();
      const v = ui(["Allow once"], { signal: ac.signal });
      const pending = bash(slow.pi, MEDIUM, v.ctx);
      await sleep(30);
      const t1 = Date.now();
      ac.abort();
      const cancelled = await pending;
      assert.ok(Date.now() - t1 < 1000, "an aborted turn does not wait for the judge");
      assert.equal(cancelled.block, true);
      assert.match(cancelled.reason, /\[UNCERTAIN: no operator decision\]/);
      assert.match(cancelled.reason, /cancelled \(the turn was aborted\) before anyone answered/);
      assert.equal(v.seen.length, 0, "no card is shown for a turn that was aborted");
    } finally {
      restore();
    }
    ok("judge unavailable / hung / throwing / aborted is UNCERTAIN: escalated when someone can be asked, bounded, never hangs");
  }

  // 4. Headless: bounded, deterministic, actionable; console-capable sessions get the request. ----------
  config({ mode: "manual" });
  {
    const { pi } = await gate(null);
    const t0 = Date.now();
    const r = await bash(pi, MEDIUM, headless());
    const waited = Date.now() - t0;
    assert.equal(r.block, true);
    assert.deepEqual(tagsIn(r.reason), ["UNCERTAIN"]);
    assert.match(r.reason, /none arrived within 0s|none arrived within \d+s/);
    assert.match(r.reason, /Nothing ran\. Ask the user to approve it or to run it themselves, or choose a lower-impact approach; do not retry it unchanged\./);
    assert.ok(waited >= 100 && waited < 2500, `the wait honours PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS (150 ms), took ${waited} ms`);
    assert.ok(fs.readdirSync(pendingDir).length === 0, "the request is withdrawn when it times out");
    assert.ok(audit().some((l) => l.event === "tool_blocked" && l.decider === "broker_timeout" && l.outcome === "uncertain"));
    // A console-capable session answers the request: the human decision is an operator decision.
    const restoreT = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "3000");
    try {
      const answered = bash(pi, "npm install left-pad", headless());
      let req;
      for (let i = 0; i < 100 && !req; i++) {
        await sleep(10);
        const f = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).find((n) => n.endsWith(".json")) : undefined;
        if (f) req = parseJsonAs(ConsoleRequest, fs.readFileSync(path.join(pendingDir, f), "utf8"), f);
      }
      assert.ok(req?.timeoutMs === 3000);
      answerPending(consoleDir, req.id, { approved: false, answer: "Deny and tell the agent why…", note: "not on this host" });
      const denied = await answered;
      assert.deepEqual(tagsIn(denied.reason), ["OPERATOR DECISION"]);
      assert.match(denied.reason, /not on this host/);
    } finally {
      restoreT();
    }
    // A medium-confidence judge block reaches the console too, tagged for the operator there.
    config({ mode: "auto" });
    const j = await gate(BLOCK("medium"));
    const restoreT2 = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "3000");
    try {
      const escalated = bash(j.pi, MEDIUM, headless());
      let req;
      for (let i = 0; i < 100 && !req; i++) {
        await sleep(10);
        const f = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).find((n) => n.endsWith(".json")) : undefined;
        if (f) req = parseJsonAs(ConsoleRequest, fs.readFileSync(path.join(pendingDir, f), "utf8"), f);
      }
      assert.ok(req, "the escalation reaches the human console");
      assert.match(req.body, /^UNCERTAIN · MEDIUM/);
      assert.match(req.body, /unsure whether to block \(medium confidence\)/);
      answerPending(consoleDir, req.id, { approved: true, answer: "Allow once" });
      assert.equal(await escalated, undefined);
    } finally {
      restoreT2();
    }
    // The console cannot be used at all (a file where its directory belongs): UNCERTAIN at once, never "declined".
    const blockedDir = path.join(root, "blocked-console");
    fs.writeFileSync(blockedDir, "a file");
    const restoreDir = setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(blockedDir, "nested"));
    try {
      const k = await gate(null);
      const t1 = Date.now();
      const r2 = await bash(k.pi, MEDIUM, headless());
      assert.ok(Date.now() - t1 < 1000, "an unusable console fails immediately, not at the deadline");
      assert.deepEqual(tagsIn(r2.reason), ["UNCERTAIN"]);
      assert.match(r2.reason, /could not file the request in the human console/);
      assert.match(r2.reason, /No operator could be asked/);
      assert.doesNotMatch(r2.reason, /operator declined/);
    } finally {
      restoreDir();
    }
    // An aborted headless turn does not wait for the (long) console deadline.
    const restoreLong = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "20000");
    try {
      const ac = new AbortController();
      const h = await gate(null);
      const pending = bash(h.pi, "npm install lodash", headless({ signal: ac.signal }));
      await sleep(50);
      const t1 = Date.now();
      ac.abort();
      const r3 = await pending;
      assert.ok(Date.now() - t1 < 2500, "abort ends the wait");
      assert.match(r3.reason, /cancelled \(the turn was aborted\)/);
      assert.deepEqual(tagsIn(r3.reason), ["UNCERTAIN"]);
    } finally {
      restoreLong();
    }
    ok("headless: bounded by the console timeout and the abort signal, actionable text, console-capable sessions escalated, unusable console is UNCERTAIN");
  }

  // 5. Interactive prompts are bounded too: a UI that never answers cannot hang a tool call. -----------
  config({ mode: "manual" });
  {
    const { pi } = await gate(null);
    const never = () => new Promise(() => {});
    for (const method of ["select", "confirm"]) {
      const notes = [];
      const ctx = { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => `O3-${++sessions}` }, ui: { notify: (m: string) => notes.push(m), [method]: never } };
      const t0 = Date.now();
      const r = await bash(pi, MEDIUM, ctx);
      const waited = Date.now() - t0;
      assert.equal(r.block, true, `${method} that never answers`);
      assert.deepEqual(tagsIn(r.reason), ["UNCERTAIN"]);
      assert.match(r.reason, /none arrived within \d+s \(the approval prompt was not answered\)/);
      assert.ok(waited >= 100 && waited < 2500, `${method}: bounded by PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS (150 ms), took ${waited} ms`);
    }
    // pi's own dialog options (abort signal and timeout) are passed through.
    let opts: DialogOptions | undefined;
    const spy = { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => "O3" }, signal: new AbortController().signal, ui: { notify() {}, select: async (_t: string, _o: string[], o: DialogOptions) => ((opts = o), "Deny") } };
    await bash(pi, MEDIUM, spy);
    if (!opts) throw new Error("ui.select was never called");
    assert.equal(opts.timeout, 150);
    assert.equal(opts.signal, spy.signal);
    // A UI that throws: UNCERTAIN, not a crash.
    const boom = { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => "O3" }, ui: { notify() {}, select: async () => { throw new Error("terminal closed"); } } };
    const t = await bash(pi, MEDIUM, boom);
    assert.deepEqual(tagsIn(t.reason), ["UNCERTAIN"]);
    assert.match(t.reason, /the approval prompt failed \(terminal closed\)/);
    // Abort while the card is open: refused at once, nothing to answer afterwards.
    const ac = new AbortController();
    const open = { cwd: ws, hasUI: true, signal: ac.signal, sessionManager: { getSessionId: () => "O3" }, ui: { notify() {}, select: never } };
    const pending = bash(pi, MEDIUM, open);
    await sleep(20);
    ac.abort();
    const cancelled = await pending;
    assert.match(cancelled.reason, /cancelled \(the turn was aborted\) before anyone answered/);
    // "Deny and tell" whose note prompt hangs still denies (bounded), as an operator decision.
    const note = { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => "O3" }, ui: { notify() {}, select: async () => "Deny and tell the agent why…", input: never } };
    const t2 = Date.now();
    const denied = await bash(pi, MEDIUM, note);
    assert.ok(Date.now() - t2 < 2500);
    assert.deepEqual(tagsIn(denied.reason), ["OPERATOR DECISION"]);
    ok("interactive prompts (card, confirm, note) are bounded by a timeout and the abort signal; a broken UI is UNCERTAIN");
  }

  // 5b. The human console's own interactive question is bounded as well (ask_human on a UI that never answers).
  {
    const humanConsole = await loadExtension("extensions/human-console/index.ts");
    const hpi = fakePi();
    humanConsole(hpi.api);
    const never = () => new Promise(() => {});
    const t0 = Date.now();
    const answered = await limited<FakeToolResult>(hpi.tools.get("ask_human").execute("q1", { question: "Proceed?", options: ["yes", "no"] }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: never, input: never } }), 4000, "ask_human");
    assert.match(textOf(answered), /No human answered in time/);
    assert.ok(Date.now() - t0 >= 100 && Date.now() - t0 < 2500, "bounded by the console timeout (150 ms here)");
    ok("an interactive ask_human on a UI that never answers gives up at the console timeout");
  }

  // 6. A command the classifier cannot read is UNCERTAIN on the card; a plain ask is not. --------------
  {
    const { pi } = await gate(null);
    const plain = ui(["Deny"]);
    await bash(pi, MEDIUM, plain.ctx);
    assert.doesNotMatch(at(plain.seen, 0, "the operator was asked").title, /UNCERTAIN/, "an ordinary approval request is not labelled uncertain");
    const opaque = ui(["Deny"]);
    await bash(pi, 'x="rm"; eval "$x -rf /tmp/whatever-$RANDOM"', opaque.ctx);
    assert.match(at(opaque.seen, 0, "the operator was asked").title, /^UNCERTAIN · /);
    assert.ok(audit().some((l) => l.event === "tool_escalated" && l.why === "classifier_unsure"));
    ok("the card is tagged UNCERTAIN only when the automatic layers could not settle it");
  }

  // 7. The labels are exclusive in every refusal the agent can read. ------------------------------------
  {
    const seenTexts = [];
    for (const mode of ["manual", "auto"]) {
      config({ mode });
      for (const [judge, _answers, command, ctxFactory] of [
        [BLOCK("high"), ["Deny"], MEDIUM, () => ui(["Deny"]).ctx],
        [BLOCK("medium"), ["Deny"], MEDIUM, () => ui(["Deny"]).ctx],
        [null, [], MEDIUM, () => headless()],
        [null, [], "rm -rf ~", () => headless()],
      ] satisfies Array<[Judge, string[], string, () => object]>) {
        const { pi } = await gate(judge);
        const r = await bash(pi, command, ctxFactory());
        if (r?.block) seenTexts.push(r.reason);
      }
    }
    assert.ok(seenTexts.length >= 6);
    for (const text of seenTexts) assert.equal(tagsIn(text).length, 1, `exactly one label in: ${text.slice(0, 120)}`);
    ok("every refusal carries exactly one of HARD DENY / UNCERTAIN / OPERATOR DECISION / AUTO-MODE BLOCK");
  }

  // 8. EFF-6: the audit log is rotated to <file>.1 past 4 MiB, keeping one old copy. -------------------
  {
    config({ mode: "manual" });
    const file = path.join(root, "audit.jsonl");
    const old = JSON.stringify({ event: "old" }) + "\n";
    const oldText = old.repeat(Math.ceil((4 * 1024 * 1024 + 1) / old.length));
    fs.writeFileSync(file, oldText);
    const { pi } = await gate(null);
    await bash(pi, "rm -rf ~", headless());
    assert.equal(fs.readFileSync(file + ".1", "utf8"), oldText, "the full audit log moves to .1 unchanged");
    assert.ok(fs.statSync(file).size < 64 * 1024, "the live audit log restarts small");
    assert.ok(audit().some((l) => l.outcome === "hard_deny"), "and holds the new record");
    ok("the audit log rotates to .1 past 4 MiB");
  }

  console.log(`[firewall-outcomes-smoke] all ${checks} checks passed`);
} finally {
  clearInterval(keepAlive);
  for (const r of restores.reverse()) r();
  rmWorkspace(root);
}
