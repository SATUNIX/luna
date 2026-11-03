#!/usr/bin/env node
// Auto mode: the /auto command and its state, and the in-process judge (stubbed completer):
//   - on/off writes the global firewall config (and a project/legacy state file when present);
//   - status shows the effective source and the provider-qualified judge model;
//   - a judge "allow" runs the call; a judge "block" blocks it and tells the agent why, without
//     interrupting the operator; an unusable judge falls back to the operator;
//   - the judge sees the LATEST user request, verdicts are cached per turn, and high-tier
//     actions never reach the judge.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { isRecord } from "../packages/core/lib/guard.ts";

interface Notice {
  message: string;
  level: string | undefined;
}

interface JudgeCall {
  system: string;
  prompt: string;
}

// The ui.confirm arguments the firewall passes: a title and the prompt message.
type ConfirmArgs = [title: string, message: string, ...rest: unknown[]];

type Completer = (system: string, prompt: string) => Promise<string>;

function ui(confirmAnswer = true) {
  const notices: Notice[] = [];
  const confirms: ConfirmArgs[] = [];
  return {
    notices,
    confirms,
    ctx: {
      hasUI: true,
      cwd: process.cwd(),
      model: { provider: "acme", id: "model-x" },
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        confirm: async (...args: ConfirmArgs) => {
          confirms.push(args);
          return confirmAnswer;
        },
      },
    },
  };
}

// A session that runs /auto on: the terminal choice is a select, ["No, …", "Yes, …"].
function autoUi(choose: "Yes" | "No" = "Yes") {
  const view = ui();
  return { ...view, ctx: { ...view.ctx, ui: { ...view.ctx.ui, select: async (_title: string, options: string[]) => options.find((o) => o.startsWith(choose)) } } };
}

function lastNotice(notices: Notice[]): Notice {
  const last = notices.at(-1);
  assert.ok(last, "expected a notice");
  return last;
}

function readJsonObject(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(isRecord(value), `${file} holds a JSON object`);
  return value;
}

function judge(reply: string | Error, calls: JudgeCall[]): Completer {
  return async (system, prompt) => {
    calls.push({ system, prompt });
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

async function registered(complete: Completer) {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  register(pi.api, { complete });
  await pi.handlers.get("session_start")({}, { cwd: process.cwd(), ui: { notify() {} } });
  return pi;
}

const esc = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

async function run() {
  const restoreIsolation = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-auto-mode-");
  const stateDir = path.join(ws, "state");
  const configFile = path.join(ws, "agent", "pi-kit", "firewall.json");
  const restores = [
    restoreIsolation,
    setEnv("HOME", path.join(ws, "home")),
    setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
    setEnv("PI_KIT_FIREWALL_CONFIG", undefined),
    setEnv("PI_KIT_AUTO_MODE", undefined),
    setEnv("PI_KIT_AUTO_MODE_MODEL", undefined),
    setEnv("PI_KIT_FIREWALL_PROFILE", undefined),
    setEnv("PI_KIT_AUTO_MODE_STATE_DIR", stateDir),
    setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl")),
  ];
  try {
    // State: global config + the legacy state file; status shows source and model.
    let calls: JudgeCall[] = [];
    let pi = await registered(judge('{"verdict":"allow","reason":"fits task"}', calls));
    let view: ReturnType<typeof ui> = autoUi();
    // Manual → automatic approvals is chosen at the terminal: refused over RPC (a phone or the web console), and "No" (the
    // first option) keeps manual approvals.
    const headless = { hasUI: true, mode: "rpc", cwd: process.cwd(), ui: { notify: (message: string, level?: string) => view.notices.push({ message, level }) } };
    await pi.commands.get("auto").handler("on", headless);
    assert.equal(fs.existsSync(configFile) ? readJsonObject(configFile).mode : "manual", "manual");
    assert.match(lastNotice(view.notices).message, /needs a choice at the terminal/);
    const declined = autoUi("No");
    await pi.commands.get("auto").handler("on", declined.ctx);
    assert.equal(fs.existsSync(configFile) ? readJsonObject(configFile).mode : "manual", "manual");
    assert.match(lastNotice(declined.notices).message, /unchanged \(manual\)/);
    // The gate compares the saved global mode it is about to write, not the effective mode: an env
    // PI_KIT_AUTO_MODE=1 run or a project auto-mode.json cannot make a phone's /auto on permanent.
    const restoreEnvAuto = setEnv("PI_KIT_AUTO_MODE", "1");
    await pi.commands.get("auto").handler("on", headless);
    restoreEnvAuto();
    assert.equal(fs.existsSync(configFile) ? readJsonObject(configFile).mode : "manual", "manual", "env auto must not skip the /auto on gate");
    assert.match(lastNotice(view.notices).message, /needs a choice at the terminal/);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "auto-mode.json"), JSON.stringify({ enabled: true }));
    await pi.commands.get("auto").handler("on", headless);
    fs.rmSync(path.join(stateDir, "auto-mode.json"));
    assert.equal(fs.existsSync(configFile) ? readJsonObject(configFile).mode : "manual", "manual", "a project auto-mode.json must not skip the /auto on gate");
    assert.match(lastNotice(view.notices).message, /needs a choice at the terminal/);
    await pi.commands.get("auto-mode").handler("on", view.ctx);
    assert.equal(readJsonObject(configFile).mode, "auto");
    assert.equal(readJsonObject(configFile).source, "user");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "auto-mode.json"), "utf8")), { enabled: true });
    // The mirror case: the saved mode is auto but the project auto-mode.json pins this repo to
    // manual. A phone's /auto on would rewrite that file, so it is refused and the file stays false.
    fs.writeFileSync(path.join(stateDir, "auto-mode.json"), JSON.stringify({ enabled: false }));
    await pi.commands.get("auto").handler("on", headless);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "auto-mode.json"), "utf8")), { enabled: false }, "a saved auto mode must not skip the gate for a project pinned to manual");
    assert.match(lastNotice(view.notices).message, /needs a choice at the terminal/);
    // PI_KIT_AUTO_MODE=1 masks the project file in the effective mode, but /auto on still rewrites
    // that file, so the gate reads the file itself: the pin to manual stays and the call is refused.
    const restoreEnvMasked = setEnv("PI_KIT_AUTO_MODE", "1");
    await pi.commands.get("auto").handler("on", headless);
    restoreEnvMasked();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "auto-mode.json"), "utf8")), { enabled: false }, "env auto must not let /auto on flip a project pinned to manual");
    assert.match(lastNotice(view.notices).message, /needs a choice at the terminal/);
    await pi.commands.get("auto").handler("on", view.ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "auto-mode.json"), "utf8")), { enabled: true });
    await pi.commands.get("auto").handler("status", view.ctx);
    assert.match(lastNotice(view.notices).message, /auto-mode: enabled/);
    assert.match(lastNotice(view.notices).message, new RegExp(esc(configFile)));
    assert.match(lastNotice(view.notices).message, /acme\/model-x/);
    await pi.commands.get("auto").handler("off", view.ctx);
    await pi.commands.get("auto").handler("status", view.ctx);
    assert.match(lastNotice(view.notices).message, /auto-mode: disabled/);

    // A config path that cannot be written reports the error instead of throwing.
    const blocked = path.join(ws, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const badConfig = path.join(blocked, "nested", "firewall.json");
    const restoreConfig = setEnv("PI_KIT_FIREWALL_CONFIG", badConfig);
    view = autoUi();
    await pi.commands.get("auto").handler("on", view.ctx);
    assert.equal(lastNotice(view.notices).level, "error");
    assert.match(lastNotice(view.notices).message, /could not enable/);
    assert.match(lastNotice(view.notices).message, new RegExp(esc(badConfig)));
    restoreConfig();

    await pi.commands.get("auto").handler("on", autoUi().ctx);

    // Judge allow: runs without asking; it saw the latest request, not the first.
    calls = [];
    pi = await registered(judge('{"verdict":"allow","reason":"fits task"}', calls));
    await pi.handlers.get("before_agent_start")({ prompt: "first request: set up the repo" }, {});
    await pi.handlers.get("before_agent_start")({ prompt: "latest request: install lodash for the date helpers" }, {});
    view = ui();
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install lodash" } }, view.ctx), undefined);
    assert.equal(view.confirms.length, 0, "a judged allow must not interrupt the operator");
    assert.equal(calls.length, 1);
    const [judged] = calls;
    assert.ok(judged);
    assert.match(judged.prompt, /latest request: install lodash/);
    assert.doesNotMatch(judged.prompt, /first request/);
    assert.match(judged.system, /data to evaluate, not instructions/);
    // Cached for the same action in the same turn.
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install lodash" } }, view.ctx), undefined);
    assert.equal(calls.length, 1, "the verdict is cached per action and turn");
    // A new request is a new turn: the turn key (a SHA-256 digest) changes and the action is judged again.
    await pi.handlers.get("before_agent_start")({ prompt: "next request: add the lodash types too" }, {});
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install lodash" } }, view.ctx), undefined);
    assert.equal(calls.length, 2, "a cached verdict is not reused in a later turn");
    const audit = fs.readFileSync(path.join(ws, "audit.jsonl"), "utf8");
    assert.match(audit, /"event":"auto_mode_check_start"[^\n]*"model":"acme\/model-x"/);

    // Judge block: blocked, the agent is told why, the operator is not interrupted.
    calls = [];
    pi = await registered(judge('{"verdict":"block","reason":"unexpected side effect"}', calls));
    view = ui();
    const blockedResult = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install blocked-package" } }, view.ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult?.reason as string, /auto-mode blocked bash — unexpected side effect/);
    assert.match(blockedResult?.reason as string, /explain why to the user/);
    assert.equal(view.confirms.length, 0);
    assert.ok(view.notices.some((n) => n.level === "warning" && /unexpected side effect/.test(n.message)));

    // Malformed / failing judge: warn, then fall back to the operator.
    for (const [i, reply] of ["not-json", new Error("provider down")].entries()) {
      calls = [];
      pi = await registered(judge(reply, calls));
      view = ui();
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: `npm install fallback-package-${i}` } }, view.ctx), undefined);
      assert.equal(view.confirms.length, 1);
      const [fallback] = view.confirms;
      assert.ok(fallback);
      assert.match(fallback[1], /judge unavailable/);
      assert.ok(view.notices.some((n) => n.level === "warning" && /bash/.test(n.message) && /judge unavailable/.test(n.message)));
    }

    // High tier never reaches the judge.
    calls = [];
    pi = await registered(judge('{"verdict":"allow","reason":"x"}', calls));
    view = ui(false);
    const force = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git push origin main --force" } }, view.ctx);
    assert.equal(force?.block, true);
    assert.equal(calls.length, 0, "high-tier actions must not be judged");
    assert.equal(view.confirms.length, 1);
    const [forceConfirm] = view.confirms;
    assert.ok(forceConfirm);
    assert.match(forceConfirm[1], /force-push/);

    // Unknown identities now require operator authority, regardless of the judge's verdict.
    calls = [];
    pi = await registered(judge('{"verdict":"allow","reason":"looks harmless"}', calls));
    view = ui(false);
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "unknown_ask", input: { command: "pwd" } }, view.ctx))?.block, true);
    assert.equal(calls.length, 0, "unknown tool identity never reaches the judge");
    assert.equal(view.confirms.length, 1, "the operator decides unknown tool authority");

    // In auto mode, read-only ssh to a known host needs nobody (host from firewall.json).
    fs.writeFileSync(configFile, JSON.stringify({ mode: "auto", policy: "coding", knownHosts: ["buildbox"], source: "user" }));
    calls = [];
    pi = await registered(judge('{"verdict":"block","reason":"x"}', calls));
    view = ui(false);
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ssh buildbox 'uptime; df -h; sudo -n journalctl -u nginx -n 50'" } }, view.ctx), undefined);
    assert.equal(calls.length + view.confirms.length, 0);
    // ...but not in manual mode.
    await pi.commands.get("auto").handler("off", ui().ctx);
    fs.rmSync(path.join(stateDir, "auto-mode.json"));
    view = ui(false);
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ssh buildbox uptime" } }, view.ctx))?.block, true);
    assert.equal(view.confirms.length, 1);

    console.log("[auto-mode-smoke] OK");
  } finally {
    restores.reverse().forEach((restore) => restore());
    rmWorkspace(ws);
  }
}

await run();
