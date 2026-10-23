#!/usr/bin/env node
/**
 * Ultracode standing mode (docs/effort.md, "Ultracode"): `/effort ultracode`, `/effort uc` and
 * `/effort e5 --standing` are operator-only (refused in children and without a screen), ask one
 * No-first select, record the state with appendEntry and restore it (never the pre-authorisation;
 * `/effort reset` to a default below E5 turns it off), add the standing block inside
 * the one effort block only while the workflow tool is active, add a hidden per-turn reminder, pass
 * `--size` and `--budget` through, and `off` returns to opt-in and revokes the pre-authorisation.
 * The firewall runs `workflow` calls without asking only while they are pre-authorised, and only on
 * a screen in a root session. More than five workflow completion turns in a row ask a No-first
 * select; No stops the turn.
 *
 * Deterministic and offline: the extensions run against a fake pi API with a temp HOME and
 * PI_CODING_AGENT_DIR; the real ~/.pi is never read.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import type * as EffortModule from "../packages/extensions/src/effort/index.ts";
import type * as StandingModule from "../packages/extensions/src/effort/standing.ts";
import type * as PolicyModule from "../packages/extensions/src/effort/policy.ts";
import type * as WfTool from "../packages/extensions/third_party/subagent/wf-tool.ts";

type FakePi = ReturnType<typeof fakePi>;
type EffortView = Omit<typeof EffortModule, "default"> & { default: (api: FakePi["api"] & { appendEntry: (t: string, d?: unknown) => void }) => void };

interface FirewallDecision { block?: boolean; reason?: string }
type FwHandler = (event: object, ctx: object) => Promise<FirewallDecision | undefined>;

const restoreEnv = isolateKitEnv();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-standing-"));
const restores = [
  setEnv("HOME", path.join(root, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(root, "agent")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(root, "audit.jsonl")),
  setEnv("PI_KIT_FIREWALL_POLICY", undefined),
  setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1"),
  setEnv("PI_KIT_AUTO_MODE", "0"),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(root, "console")),
  setEnv("PI_KIT_FIREWALL_SESSIONS_DIR", path.join(root, "firewall-sessions")),
  setEnv("PI_KIT_FIREWALL_LEARNED_PROFILE", path.join(root, "firewall-profile.json")),
];
fs.mkdirSync(path.join(root, "home"), { recursive: true });
const keepAlive = setInterval(() => {}, 1000);

const mod: EffortView = await loadModule("extensions/effort/index.ts");
const standingMod: typeof StandingModule = await loadModule("extensions/effort/standing.ts");
const policyMod: typeof PolicyModule = await loadModule("extensions/effort/policy.ts");
const wfTool: typeof WfTool = await loadModule("vendor/subagent/wf-tool.ts");
const firewall = await loadExtension<(api: object) => void>("extensions/tool-firewall/index.ts");

interface Note { m: string; l: string | undefined }
interface Entry { type: "custom"; customType: string; data: unknown }

/** Boot the effort extension; `answer` picks each select's reply (undefined: Escape). */
async function boot({ hasUI = true, answer = (o: string[]): string | undefined => o[0], tools = ["read", "bash", "subagent", "workflow"], entries = [] as Entry[], reason = "startup" } = {}) {
  const pi = fakePi();
  const appended: Entry[] = [...entries];
  mod.default({ ...pi.api, getActiveTools: () => tools, appendEntry: (customType: string, data?: unknown) => { appended.push({ type: "custom", customType, data }); } });
  const notes: Note[] = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  let aborts = 0;
  const ctx = {
    hasUI,
    cwd: root,
    ui: {
      notify: (m: string, l?: string) => notes.push({ m, l }),
      select: async (title: string, options: string[]) => { selects.push({ title, options }); return answer(options); },
      setStatus() {},
    },
    sessionManager: { getSessionId: () => "standing1", getBranch: () => appended },
    abort: () => { aborts++; },
  };
  await pi.handlers.get("session_start")({ reason }, ctx);
  const registry = (): EffortModule.EffortRegistry => {
    const r: unknown = Reflect.get(globalThis, mod.REGISTRY_KEY);
    assert.ok(typeof r === "object" && r !== null);
    return r as EffortModule.EffortRegistry; // the test's own extension instance, just registered
  };
  const command = (args: string): Promise<unknown> => pi.commands.get("effort").handler(args, ctx);
  const turn = async (event: Record<string, unknown> = { messageType: "user", prompt: "go" }) => pi.handlers.get("before_agent_start")({ systemPrompt: "BASE", ...event }, ctx);
  const wake = () => turn({ messageType: "custom", message: { customType: "luna-workflow-result", content: "done", display: true } });
  return { notes, selects, command, turn, wake, registry, appended, aborts: () => aborts, last: () => notes.at(-1)?.m ?? "" };
}

const yes = (options: string[]): string | undefined => options.find((o) => o.startsWith("Yes"));
const fresh = () => fs.rmSync(path.join(root, "agent"), { recursive: true, force: true });

function promptOf(result: unknown): string {
  return typeof result === "object" && result !== null && typeof Reflect.get(result, "systemPrompt") === "string" ? String(Reflect.get(result, "systemPrompt")) : "";
}
function messageOf(result: unknown): Record<string, unknown> | null {
  const m: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "message") : undefined;
  return typeof m === "object" && m !== null ? { customType: Reflect.get(m, "customType"), content: Reflect.get(m, "content"), display: Reflect.get(m, "display") } : null;
}

const tests: Record<string, () => void | Promise<void>> = {
  "arguments: --size (1-1000, default 50) and --budget (k/m suffixes, none), off and status": () => {
    const { parseStandingArgs, parseCount, DEFAULT_SIZE, WAKE_CHAIN_CAP } = standingMod;
    assert.equal(DEFAULT_SIZE, 50);
    assert.equal(WAKE_CHAIN_CAP, 5);
    assert.deepEqual(parseStandingArgs([]), { ok: true, action: "on", size: null, budget: undefined });
    assert.deepEqual(parseStandingArgs(["--size", "80", "--budget", "200k"]), { ok: true, action: "on", size: 80, budget: 200_000 });
    assert.deepEqual(parseStandingArgs(["on", "--budget", "2m"]), { ok: true, action: "on", size: null, budget: 2_000_000 });
    assert.deepEqual(parseStandingArgs(["--budget", "none"]), { ok: true, action: "on", size: null, budget: null });
    assert.deepEqual(parseStandingArgs(["off"]), { ok: true, action: "off" });
    assert.deepEqual(parseStandingArgs(["status"]), { ok: true, action: "status" });
    for (const bad of [["--size", "0"], ["--size", "1001"], ["--size"], ["--budget", "-5"], ["--budget", "lots"], ["--colour", "red"], ["off", "now"]]) {
      assert.equal(parseStandingArgs(bad).ok, false, bad.join(" "));
    }
    assert.equal(parseCount("12k"), 12_000);
    assert.equal(parseCount("1.5k"), null);
  },

  "the completion message type is the workflow tool's": () => {
    assert.equal(standingMod.WORKFLOW_RESULT_TYPE, wfTool.RESULT_MESSAGE_TYPE);
  },

  "ultracode is refused without a screen and in children, and nothing changes": async () => {
    fresh();
    const headless = await boot({ hasUI: false });
    await headless.command("ultracode");
    assert.equal(headless.registry().standing().on, false);
    assert.equal(headless.selects.length, 0);
    const children: Array<[string, string]> = [["PI_KIT_INTERNAL_CHILD", "1"], ["PI_KIT_EFFORT_LEDGER", path.join(root, "ledger.json")]];
    for (const [name, value] of children) {
      const restore = setEnv(name, value);
      try {
        const child = await boot({ answer: yes });
        await child.command("uc");
        assert.equal(child.registry().standing().on, false, `${name}: a child cannot switch it on`);
        assert.match(child.last(), /root session/);
        assert.equal(child.selects.length, 0);
      } finally { restore(); }
    }
  },

  "one No-first select: No turns standing on but keeps asking, Yes pre-authorises, Escape changes nothing": async () => {
    fresh();
    const no = await boot();
    await no.command("ultracode");
    assert.equal(no.selects.length, 1);
    assert.deepEqual(no.selects[0]?.options, ["No, keep asking per workflow", "Yes, allow workflow runs this session"], "No is first (the default)");
    assert.deepEqual({ ...no.registry().standing() }, { on: true, preauthorised: false, size: 50, budget: null, wakeChain: 0 });
    assert.equal(no.registry().snapshot().pendingTier, "exhaustive", "ultracode chooses E5 from the next message");

    fresh();
    const esc = await boot({ answer: () => undefined });
    await esc.command("ultracode");
    assert.equal(esc.registry().standing().on, false, "Escape switches nothing on");
    assert.equal(esc.registry().snapshot().pendingTier, null);

    fresh();
    const ok = await boot({ answer: yes });
    await ok.command("uc --size 80 --budget 300k");
    assert.deepEqual({ ...ok.registry().standing() }, { on: true, preauthorised: true, size: 80, budget: 300_000, wakeChain: 0 });
    assert.equal(ok.appended.at(-1)?.customType, "luna-effort-standing");
    assert.deepEqual(ok.appended.at(-1)?.data, { version: 1, on: true, preauthorised: true, size: 80, budget: 300_000 });
  },

  "e5 --standing is the same; --standing with another tier is refused": async () => {
    fresh();
    const a = await boot({ answer: yes });
    await a.command("e5 --standing --size 20");
    assert.equal(a.registry().standing().preauthorised, true);
    assert.equal(a.registry().standing().size, 20);
    fresh();
    const b = await boot({ answer: yes });
    await b.command("thorough --standing");
    assert.equal(b.registry().standing().on, false);
    assert.match(b.last(), /--standing goes only with E5/);
    assert.equal(b.selects.length, 0);
  },

  "the standing block sits inside the one effort block, only while the workflow tool is active, with a hidden reminder": async () => {
    fresh();
    const s = await boot({ answer: yes });
    const before = await s.turn();
    assert.doesNotMatch(promptOf(before), /standing mode/, "off: no standing block");
    assert.equal(messageOf(before), null, "off: no reminder");
    await s.command("ultracode --size 30 --budget 100k");
    const result = await s.turn();
    const prompt = promptOf(result);
    const start = prompt.indexOf(policyMod.PROMPT_START);
    const end = prompt.indexOf(policyMod.PROMPT_END);
    const at = prompt.indexOf("Ultracode standing mode is on");
    assert.ok(start >= 0 && start < at && at < end, "inside the effort block");
    assert.equal(prompt.split(policyMod.PROMPT_START).length, 2, "exactly one effort block");
    assert.match(prompt, /Tier: E5 Exhaustive/);
    assert.match(prompt, /about 30 agents per workflow/);
    assert.match(prompt, /100000 output tokens/);
    assert.doesNotMatch(prompt, /\{\{/, "every placeholder is filled");
    const reminder = messageOf(result);
    assert.equal(reminder?.customType, "luna-effort-standing-reminder");
    assert.equal(reminder?.display, false);
    assert.match(String(reminder?.content), /size guideline 30 agents, budget 100000 output tokens/);

    fresh();
    const noTool = await boot({ answer: yes, tools: ["read", "bash", "subagent"] });
    await noTool.command("ultracode");
    assert.match(noTool.last(), /workflow tool is not available/);
    const r = await noTool.turn();
    assert.doesNotMatch(promptOf(r), /standing mode/, "no workflow tool: no standing block");
    assert.equal(messageOf(r), null);
  },

  "off returns to opt-in and revokes the pre-authorisation; a lower tier turns it off too": async () => {
    fresh();
    const s = await boot({ answer: yes });
    await s.command("ultracode");
    await s.command("ultracode off");
    assert.deepEqual({ ...s.registry().standing(), wakeChain: 0 }, { on: false, preauthorised: false, size: 50, budget: null, wakeChain: 0 });
    assert.deepEqual(s.appended.at(-1)?.data, { version: 1, on: false, preauthorised: false, size: 50, budget: null });
    assert.doesNotMatch(promptOf(await s.turn()), /standing mode/);
    await s.command("ultracode");
    await s.command("thorough");
    assert.equal(s.registry().standing().on, false, "choosing E4 turns standing mode off");
    assert.match(s.notes.map((n) => n.m).join("\n"), /standing mode is off \(it needs E5\)/);
  },

  "a reload or resume restores the recorded state on a screen without the pre-authorisation, never headless; a malformed last entry is off": async () => {
    fresh();
    const first = await boot({ answer: yes });
    await first.command("ultracode --budget 50k");
    await first.turn(); // E5 is now in force and saved as the default
    const entries = first.appended.filter((e) => e.customType === "luna-effort-standing");
    const resumed = await boot({ entries, reason: "resume" });
    assert.deepEqual(entries.at(-1)?.data, { version: 1, on: true, preauthorised: true, size: 50, budget: 50_000 }, "the entry recorded a Yes");
    assert.deepEqual({ ...resumed.registry().standing() }, { on: true, preauthorised: false, size: 50, budget: 50_000, wakeChain: 0 }, "a restore never brings back the pre-authorisation");
    assert.match(resumed.last(), /restored.*asked per call.*\/effort ultracode again/);
    const headless = await boot({ hasUI: false, entries });
    assert.equal(headless.registry().standing().on, false, "a headless session never restores it");
    const broken = await boot({ entries: [...entries, { type: "custom", customType: "luna-effort-standing", data: { version: 1, on: "yes" } }] });
    assert.equal(broken.registry().standing().on, false, "an unreadable last entry never brings back an earlier one");
  },

  "more than five completion turns in a row ask a No-first select; No stops the turn, Yes counts again, your message resets": async () => {
    fresh();
    let reply: string | undefined;
    const s = await boot({ answer: (o) => (o[0]?.startsWith("No, keep") ? yes(o) : reply) });
    await s.command("ultracode");
    await s.turn();
    for (let i = 0; i < 5; i++) assert.notEqual(await s.wake(), undefined, `wake ${String(i + 1)} runs`);
    assert.equal(s.selects.length, 1, "no question for five");
    reply = undefined;
    assert.equal(await s.wake(), undefined, "Escape on the sixth stops it");
    assert.equal(s.aborts(), 1);
    assert.deepEqual(s.selects.at(-1)?.options[0], "No, stop and wait for my next message");
    reply = "Yes, let the agent continue (asks again after 5 more)";
    assert.notEqual(await s.wake(), undefined, "Yes lets it continue");
    assert.equal(s.registry().standing().wakeChain, 1);
    for (let i = 0; i < 4; i++) await s.wake();
    const asked = s.selects.length;
    reply = "No, stop and wait for my next message";
    assert.equal(await s.wake(), undefined);
    assert.equal(s.selects.length, asked + 1, "asks again after five more");
    assert.equal(s.aborts(), 2);
    await s.turn();
    assert.equal(s.registry().standing().wakeChain, 0, "your message ends the chain");
  },

  "the workflow tool's run budget comes from standing mode": async () => {
    fresh();
    const s = await boot({ answer: yes });
    assert.equal(wfTool.standingBudget(), null);
    await s.command("ultracode --budget 7k");
    assert.equal(wfTool.standingBudget(), 7000);
    await s.command("ultracode off");
    assert.equal(wfTool.standingBudget(), null, "off: no budget");
  },

  "the firewall runs workflow calls unasked only while pre-authorised, on a screen, in a root session": async () => {
    fresh();
    const fw = new Map<string, FwHandler>();
    firewall({ on: (name: string, h: FwHandler) => fw.set(name, h), registerTool() {}, registerCommand() {} });
    const gate = fw.get("tool_call");
    assert.ok(gate);
    let prompts = 0;
    const screen = { hasUI: true, cwd: root, ui: { notify() {}, confirm: async () => { prompts++; return false; }, select: async (_t: string, o: string[]) => { prompts++; return o.find((x) => /^(Deny|No)/i.test(x)) ?? o.at(-1); } } };
    const headless = { hasUI: false, cwd: root };
    const call = (ctx: object) => gate({ toolName: "workflow", input: { script: "export const meta = { name: 'w', description: 'd' }; return 1" } }, ctx);

    const s = await boot({ answer: yes });
    assert.equal((await call(screen))?.block, true, "standing off: asked, and the operator said no");
    assert.equal(prompts, 1);
    await s.command("ultracode");
    prompts = 0;
    assert.equal(await call(screen), undefined, "pre-authorised: runs without asking");
    assert.equal(prompts, 0);
    assert.equal((await call(headless))?.block, true, "headless: still refused");
    const restore = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      assert.match((await call(screen))?.reason ?? "", /not available to child sessions/, "a child is still denied");
    } finally { restore(); }
    await s.command("ultracode off");
    prompts = 0;
    assert.equal((await call(screen))?.block, true, "off: asked again");
    assert.equal(prompts, 1);

    fresh();
    const reset = await boot({ answer: yes });
    await reset.command("ultracode");
    await reset.command("reset");
    assert.equal(reset.registry().standing().on, false, "/effort reset to a default below E5 turns standing mode off");
    assert.equal(reset.registry().standing().preauthorised, false);
    assert.match(reset.notes.map((n) => n.m).join("\n"), /standing mode is off \(it needs E5\)/);
    prompts = 0;
    assert.equal((await call(screen))?.block, true, "after reset: asked again");
    assert.equal(prompts, 1);

    fresh();
    const yesRun = await boot({ answer: yes });
    await yesRun.command("ultracode");
    await yesRun.turn(); // E5 in force and saved as the default
    const recorded = yesRun.appended.filter((e) => e.customType === "luna-effort-standing");
    // A session entry (not firewall-protected) claiming a Yes must not pre-authorise on restore.
    const forged: Entry[] = [...recorded, { type: "custom", customType: "luna-effort-standing", data: { version: 1, on: true, preauthorised: true, size: 50, budget: null } }];
    for (const reason of ["resume", "reload"]) {
      const resumed = await boot({ entries: forged, reason });
      assert.equal(resumed.registry().standing().on, true);
      assert.equal(resumed.registry().standing().preauthorised, false, `${reason}: not pre-authorised without a fresh Yes`);
      prompts = 0;
      assert.equal((await call(screen))?.block, true, `${reason}: a restored entry still asks`);
      assert.equal(prompts, 1);
    }

    fresh();
    const asking = await boot();
    await asking.command("ultracode");
    prompts = 0;
    assert.equal((await call(screen))?.block, true, "standing on but not pre-authorised: still asked");
    assert.equal(prompts, 1);
  },
};

let failed = 0;
try {
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  OK: ${name}`);
    } catch (error: unknown) {
      failed++;
      console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
    }
  }
} finally {
  clearInterval(keepAlive);
  restores.reverse().forEach((r) => r());
  restoreEnv();
  rmWorkspace(root);
}
if (failed) {
  console.error(`\n[effort-standing-smoke] ${String(failed)} check(s) failed`);
  process.exit(1);
}
console.log(`\n[effort-standing-smoke] all ${String(Object.keys(tests).length)} checks passed`);
