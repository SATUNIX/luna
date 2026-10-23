#!/usr/bin/env node
// Run-scoped approval broker for workflow agents (E5 slice S7), offline.
//
// tool-firewall in a workflow child (PI_KIT_INTERNAL_CHILD=1 + PI_KIT_WORKFLOW_RUN_ID) tags its
// console request with the run and the exact action hash; the human console then, per run: opens
// at most 2 prompts, groups requests by action hash, keeps denials, gives high-risk actions no run
// grant, and pauses the run (No-first resume question) once more than 10 distinct actions were
// approved. A temp HOME, PI_CODING_AGENT_DIR and console directory are used; no model or network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { boolean, nullable, object, optional, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as Broker from "../packages/extensions/src/human-console/run-broker.ts";
import type * as Control from "../packages/extensions/third_party/subagent/control.ts";

const Resolved = object({ id: string(), approved: boolean(), answer: nullable(string()), note: optional(nullable(string())) });
const PendingFile = object({ id: string(), kind: string(), riskClass: optional(string()), workflowRun: optional(string()), actionHash: optional(string()) });

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, test: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await wait(20);
  }
}
const ok = (msg: string): void => console.log(`ok - ${msg}`);
const hashOf = (label: string): string => crypto.createHash("sha256").update(label).digest("hex");

const restores: Array<() => void> = [isolateKitEnv()];
const ws = tmpWorkspace("pi-kit-wf-approvals-");
const consoleDir = path.join(ws, "console");
restores.push(setEnv("HOME", path.join(ws, "home")), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_HUMAN_CONSOLE_DIR", consoleDir), setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl")), setEnv("PI_KIT_AUTO_MODE", "0"));
const pendingDir = path.join(consoleDir, "pending");
const resolvedDir = path.join(consoleDir, "resolved");
fs.mkdirSync(pendingDir, { recursive: true });
fs.mkdirSync(resolvedDir, { recursive: true });
const keepAlive = setInterval(() => {}, 1000);

// ---- 1. the state machine -----------------------------------------------------------------------
const B = await loadModule<typeof Broker>("extensions/human-console/run-broker.ts");
{
  const b = new B.RunApprovalBroker();
  const req = (id: string, label: string, high = false, runId = "wf-unit") => ({ id, runId, hash: hashOf(label), high });
  assert.deepEqual(b.offer(req("1", "a")), { kind: "prompt" });
  assert.deepEqual(b.offer(req("2", "a")), { kind: "wait", reason: "grouped" }, "same hash joins the open prompt");
  assert.deepEqual(b.offer(req("3", "b")), { kind: "prompt" });
  assert.deepEqual(b.offer(req("4", "c")), { kind: "wait", reason: "outstanding" }, "a third distinct prompt waits");
  assert.equal(B.RUN_OUTSTANDING_MAX, 2);
  assert.deepEqual(b.offer(req("5", "c", false, "wf-other")), { kind: "prompt" }, "the cap is per run");
  const denied = b.settle(req("1", "a"), { approved: false, runGrant: false });
  assert.deepEqual(denied.members, ["2"], "a denial settles the whole group");
  assert.deepEqual(b.offer(req("6", "a")), { kind: "resolve", approved: false, reason: "sticky_deny" }, "a denial sticks for the run");
  assert.deepEqual(b.offer(req("7", "a", false, "wf-other")), { kind: "prompt" }, "and only for that run");
  assert.deepEqual(b.offer(req("4", "c")), { kind: "prompt" }, "the freed slot goes to the waiting request");
  b.settle(req("4", "c"), { approved: true, runGrant: true });
  assert.deepEqual(b.offer(req("8", "c")), { kind: "resolve", approved: true, reason: "run_grant" }, "a medium run grant answers exact repeats");
  // High risk: no run grant, and "Allow once" approves only the request shown.
  b.settle(req("3", "b"), { approved: true, runGrant: false });
  assert.deepEqual(b.offer(req("9", "h", true)), { kind: "prompt" });
  assert.deepEqual(b.offer(req("10", "h", true)), { kind: "wait", reason: "grouped" });
  const high = b.settle(req("9", "h", true), { approved: true, runGrant: true });
  assert.deepEqual(high.members, [], "a high-risk allow does not answer its group");
  assert.deepEqual(b.offer(req("10", "h", true)), { kind: "prompt" }, "a high-risk repeat asks again, even after a run grant was asked for");
  assert.deepEqual(B.runChoices(true), [B.RUN_CHOICE_DENY, B.RUN_CHOICE_DENY_TELL, B.RUN_CHOICE_ALLOW_ONCE], "high: No first, no run grant");
  assert.equal(B.runChoices(false)[0], B.RUN_CHOICE_DENY, "medium: No first");
  assert.ok(B.runChoices(false).includes(B.RUN_CHOICE_ALLOW_RUN));
  assert.equal(B.runRequestOf({ id: "x", workflowRun: "wf-a", actionHash: hashOf("x") })?.high, true, "a request with no tier is treated as high");
  assert.equal(B.runRequestOf({ id: "x", workflowRun: "../x", actionHash: hashOf("x"), riskClass: "medium" }), null, "a malformed run id is not a run request");
  assert.equal(B.runRequestOf({ id: "x", workflowRun: "wf-a", actionHash: "abc", riskClass: "medium" }), null, "a malformed hash is not a run request");
  // Distinct approvals: the 11th distinct approval asks for a pause; while that is open, nothing new prompts.
  const p = new B.RunApprovalBroker();
  let last: Broker.Settled | undefined;
  for (let i = 1; i <= 11; i++) {
    assert.deepEqual(p.offer(req(`p${i}`, `p${i}`, false, "wf-p")), { kind: "prompt" });
    last = p.settle(req(`p${i}`, `p${i}`, false, "wf-p"), { approved: true, runGrant: false });
    assert.equal(last.pause, i === 11, `pause only after more than 10 distinct approvals (at ${i})`);
  }
  assert.equal(last?.distinct, 11);
  assert.deepEqual(p.offer(req("p12", "p12", false, "wf-p")), { kind: "wait", reason: "pause_question" });
  p.pauseAnswered("wf-p");
  assert.deepEqual(p.offer(req("p12", "p12", false, "wf-p")), { kind: "prompt" });
  ok("broker: 2 outstanding per run, groups by hash, sticky denials, no high grants, pause after 10 distinct");
}

// ---- 2. the console, driven through its watcher -------------------------------------------------
const C = await loadModule<typeof Control>("vendor/subagent/control.ts");
const runE = C.runControls.open("wf-e");
const runF = C.runControls.open("wf-f");

interface Prompt { header: string; options: string[]; answer: (value: string | undefined) => void; done: boolean }
const prompts: Prompt[] = [];
const notes: string[] = [];
const ui = {
  select: (header: string, options: string[]): Promise<string | undefined> => new Promise((resolve) => {
    const p: Prompt = { header, options, done: false, answer: (v) => { p.done = true; resolve(v); } };
    prompts.push(p);
  }),
  input: async (): Promise<string> => "not that path",
  confirm: async (): Promise<boolean> => { throw new Error("run requests must use the menu"); },
  notify: (message: string): void => { notes.push(message); },
};
const human = await loadExtension("extensions/human-console/index.ts");
const hpi = fakePi();
human(hpi.api);
await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui });

let seq = 0;
function file(runId: string, label: string, riskClass: string | undefined = "medium"): string {
  const id = `req-${++seq}`;
  fs.writeFileSync(path.join(pendingDir, `${id}.json`), JSON.stringify({ id, kind: "approval", createdAt: new Date().toISOString(), timeoutMs: 60000, title: "Approve tool call? (subagent)", body: `action ${label}`, toolName: "bash", ...(riskClass ? { riskClass } : {}), choices: ["Allow once", "Deny"], workflowRun: runId, actionHash: hashOf(label) }));
  return id;
}
const answerOf = (id: string) => {
  const f = path.join(resolvedDir, `${id}.json`);
  return fs.existsSync(f) ? parseJsonAs(Resolved, fs.readFileSync(f, "utf8")) : null;
};
const openFor = (runId: string): Prompt[] => prompts.filter((p) => !p.done && p.header.includes(`workflow run ${runId}`));

// 2a. At most two prompts per run; a grouped duplicate is answered by its group's prompt.
{
  const ids = [file("wf-a", "a1"), file("wf-a", "a1"), file("wf-a", "a2"), file("wf-a", "a3")];
  let shown = 0;
  let maxOpen = 0;
  while (!ids.every((id) => answerOf(id))) {
    await until("a wf-a prompt or answers", () => openFor("wf-a").length > 0 || ids.every((id) => answerOf(id)));
    await wait(1200); // one more watcher tick: a third prompt would appear now
    const open = openFor("wf-a");
    maxOpen = Math.max(maxOpen, open.length);
    for (const p of open) { shown++; p.answer(B.RUN_CHOICE_ALLOW_ONCE); }
    await wait(50);
  }
  assert.equal(maxOpen, 2, "two prompts at most are open for one run");
  assert.equal(shown, 3, "the two requests for the same action shared one prompt");
  for (const id of ids) assert.equal(answerOf(id)?.approved, true);
  ok("console: at most 2 open prompts per run, identical actions grouped under one prompt");
}

// 2b. A denial sticks for the run (with a note for the agent), not for other runs.
{
  const first = file("wf-b", "b1");
  await until("the wf-b prompt", () => openFor("wf-b").length === 1);
  const shown = openFor("wf-b")[0];
  assert.ok(shown);
  assert.equal(shown.options[0], B.RUN_CHOICE_DENY, "the run menu is No first");
  assert.ok(shown.options.includes(B.RUN_CHOICE_ALLOW_RUN), "medium actions can be allowed for the run");
  shown.answer(B.RUN_CHOICE_DENY);
  await until("the wf-b answer", () => answerOf(first) !== null);
  assert.equal(answerOf(first)?.approved, false);
  assert.match(answerOf(first)?.note ?? "", /denied for the rest of workflow run wf-b/);
  const before = prompts.length;
  const again = file("wf-b", "b1");
  await until("the sticky denial", () => answerOf(again) !== null);
  assert.equal(answerOf(again)?.approved, false);
  assert.equal(prompts.length, before, "a repeat of a denied action is denied without asking");
  const elsewhere = file("wf-c", "b1");
  await until("the wf-c prompt", () => openFor("wf-c").length === 1);
  openFor("wf-c")[0]?.answer(B.RUN_CHOICE_ALLOW_ONCE);
  await until("the wf-c answer", () => answerOf(elsewhere) !== null);
  assert.equal(answerOf(elsewhere)?.approved, true, "the denial belongs to its run only");
  ok("console: a denial sticks for the rest of the run and tells the agent so");
}

// 2c. A medium run grant answers exact repeats; high-risk actions get no run grant.
{
  const g = file("wf-d", "d1");
  await until("the wf-d prompt", () => openFor("wf-d").length === 1);
  openFor("wf-d")[0]?.answer(B.RUN_CHOICE_ALLOW_RUN);
  await until("the wf-d answer", () => answerOf(g) !== null);
  const before = prompts.length;
  const repeat = file("wf-d", "d1");
  await until("the run grant", () => answerOf(repeat) !== null);
  assert.equal(answerOf(repeat)?.approved, true);
  assert.equal(prompts.length, before, "an exact repeat ran on the run grant without asking");
  const h1 = file("wf-d", "h1", "high");
  const h2 = file("wf-d", "h1", undefined);
  await until("the high prompt", () => openFor("wf-d").length === 1);
  await wait(1200);
  const highPrompt = openFor("wf-d");
  assert.equal(highPrompt.length, 1, "identical high-risk requests share one prompt");
  assert.ok(highPrompt[0] && !highPrompt[0].options.includes(B.RUN_CHOICE_ALLOW_RUN), "a high-risk action is not offered a run grant");
  highPrompt[0]?.answer(B.RUN_CHOICE_ALLOW_ONCE);
  await until("one high answer", () => answerOf(h1) !== null || answerOf(h2) !== null);
  await until("the second high prompt", () => openFor("wf-d").length === 1);
  assert.ok(answerOf(h1) === null || answerOf(h2) === null, "Allow once on a high-risk action approves only the request shown");
  openFor("wf-d")[0]?.answer(B.RUN_CHOICE_DENY_TELL);
  await until("both high answers", () => answerOf(h1) !== null && answerOf(h2) !== null);
  const deniedHigh = answerOf(h1)?.approved === false ? answerOf(h1) : answerOf(h2);
  assert.match(deniedHigh?.note ?? "", /wf-d: not that path/, "Deny and tell passes the operator's note");
  ok("console: medium run grants answer exact repeats; high-risk actions get none");
}

// 2d. More than 10 distinct approvals pause the run and ask, No first, whether to resume.
{
  const drive = async (runId: string, reply: string): Promise<Prompt> => {
    const ids: string[] = [];
    for (let i = 1; i <= 11; i++) ids.push(file(runId, `${runId}-${i}`));
    while (!ids.every((id) => answerOf(id))) {
      await until(`a ${runId} prompt`, () => openFor(runId).length > 0 || ids.every((id) => answerOf(id)));
      for (const p of openFor(runId)) p.answer(B.RUN_CHOICE_ALLOW_ONCE);
      await wait(30);
    }
    await until(`the ${runId} resume question`, () => prompts.some((p) => !p.done && p.header.startsWith(`Workflow run ${runId} has had 11`)));
    const question = prompts.find((p) => !p.done && p.header.startsWith(`Workflow run ${runId} has had 11`));
    assert.ok(question);
    assert.deepEqual(question.options, [B.PAUSE_CHOICE_NO, B.PAUSE_CHOICE_YES], "the resume question is No first");
    const held = file(runId, `${runId}-12`);
    await wait(1200);
    assert.equal(openFor(runId).length, 0, "no new approval prompt opens while the resume question is open");
    assert.equal(answerOf(held), null);
    question.answer(reply);
    await until(`${runId}-12 prompt after the question`, () => openFor(runId).length === 1);
    openFor(runId)[0]?.answer(B.RUN_CHOICE_ALLOW_ONCE);
    await until(`${runId}-12 answer`, () => answerOf(held) !== null);
    return question;
  };
  const [e, f] = await Promise.all([drive("wf-e", B.PAUSE_CHOICE_NO), drive("wf-f", B.PAUSE_CHOICE_YES)]);
  assert.ok(e.header.includes("it is paused") && f.header.includes("it is paused"));
  const audited = fs.readFileSync(path.join(ws, ".pi", "human-console-audit.jsonl"), "utf8");
  assert.match(audited, /"event":"workflow_approvals_pause","runId":"wf-f","distinct":11,"ok":true/, "the Yes run was paused before it was resumed");
  assert.equal(runE.control.paused, true, "No keeps the run paused");
  assert.equal(runE.control.held, true, "the safety stop's pause is held for the operator");
  const agentResume = C.controlRun("wf-e", "resume", C.runControls, "agent");
  assert.equal(agentResume.ok, false, "the governed agent's workflow_control resume is refused");
  assert.match(agentResume.message, /only the operator can resume it/);
  assert.equal(runE.control.paused, true, "and the run stays paused");
  assert.equal(runF.control.paused, false, "Yes resumes it");
  ok("console: an 11th distinct approval pauses the run; No keeps it paused (the agent cannot resume it), Yes resumes it");
}

// ---- 3. tool-firewall in a workflow child tags its request; the console's denial sticks --------
{
  const restoreChild = [setEnv("PI_KIT_INTERNAL_CHILD", "1"), setEnv("PI_KIT_WORKFLOW_RUN_ID", "wf-g-1"), setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "20000")];
  try {
    const register = await loadExtension("extensions/tool-firewall/index.ts");
    const pi = fakePi();
    register(pi.api, { complete: null });
    const call = () => pi.handlers.get("tool_call")({ toolName: "unknown_wf_tool", input: { x: 1 } }, { hasUI: false, ui: {}, cwd: ws });
    const first = call();
    await until("the child's run prompt", () => openFor("wf-g-1").length === 1);
    const pendingNames = fs.readdirSync(pendingDir).filter((n) => n.endsWith(".json"));
    const tagged = pendingNames.map((n) => parseJsonAs(PendingFile, fs.readFileSync(path.join(pendingDir, n), "utf8"))).find((r) => r.workflowRun === "wf-g-1");
    assert.ok(tagged, "the child's request names its workflow run");
    assert.match(tagged.actionHash ?? "", /^[a-f0-9]{64}$/, "and the exact action hash");
    openFor("wf-g-1")[0]?.answer(B.RUN_CHOICE_DENY);
    const blocked = await first;
    assert.equal(blocked?.block, true);
    assert.match(String(blocked?.reason), /denied for the rest of workflow run wf-g-1/);
    const before = prompts.length;
    const second = await call();
    assert.equal(second?.block, true, "the same call is denied again");
    assert.equal(prompts.length, before, "without asking the operator");
    // The run hash binds the checkout: the same input from another worktree is a different action,
    // so the denial (or a run grant) for this checkout does not answer it.
    const otherCheckout = tmpWorkspace("pi-kit-wf-other-checkout-");
    try {
      const elsewhere = pi.handlers.get("tool_call")({ toolName: "unknown_wf_tool", input: { x: 1 } }, { hasUI: false, ui: {}, cwd: otherCheckout });
      await until("a prompt for the other checkout", () => openFor("wf-g-1").length === 1);
      const otherTag = fs.readdirSync(pendingDir).filter((n) => n.endsWith(".json")).map((n) => parseJsonAs(PendingFile, fs.readFileSync(path.join(pendingDir, n), "utf8"))).find((r) => r.workflowRun === "wf-g-1");
      assert.ok(otherTag?.actionHash && otherTag.actionHash !== tagged.actionHash, "the same input in another checkout carries a different action hash");
      openFor("wf-g-1")[0]?.answer(B.RUN_CHOICE_DENY);
      assert.equal((await elsewhere)?.block, true);
    } finally {
      rmWorkspace(otherCheckout);
    }
    const consoleAudit = fs.readFileSync(path.join(ws, ".pi", "human-console-audit.jsonl"), "utf8");
    assert.match(consoleAudit, /"event":"workflow_approval_sticky_deny","runId":"wf-g-1"/, "the console's sticky denial answered it");
    // Outside a workflow run (or with a malformed id) the request carries no run tag.
    for (const value of [undefined, "not-a-run"]) {
      const r = setEnv("PI_KIT_WORKFLOW_RUN_ID", value);
      const p2 = fakePi();
      register(p2.api, { complete: null });
      const plain = p2.handlers.get("tool_call")({ toolName: "unknown_wf_tool", input: { x: `plain-${String(value)}` } }, { hasUI: false, ui: {}, cwd: ws });
      await until("a plain console prompt", () => prompts.some((p) => !p.done && !p.header.includes("workflow run")));
      const plainPrompt = prompts.find((p) => !p.done && !p.header.includes("workflow run"));
      assert.ok(plainPrompt && !plainPrompt.options.includes(B.RUN_CHOICE_DENY), "an untagged request keeps the firewall's own menu");
      plainPrompt.answer("Deny");
      assert.equal((await plain)?.block, true);
      r();
    }
  } finally {
    for (const r of restoreChild.reverse()) r();
  }
  ok("firewall: a workflow child's request names its run and action hash; a console denial sticks across calls, in that checkout only");
}

await hpi.handlers.get("session_shutdown")({}, { cwd: ws, hasUI: true, ui });
runE.close();
runF.close();
clearInterval(keepAlive);
for (const r of restores.reverse()) r();
rmWorkspace(ws);
console.log("firewall-workflow-approvals smoke passed");
