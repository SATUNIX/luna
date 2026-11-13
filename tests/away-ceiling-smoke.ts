#!/usr/bin/env node
/**
 * The unattended ceiling and /away. One ceiling object (turns, money, wall time) parks a run at the
 * first limit; /away is automatic approvals plus that ceiling, and refuses what would need a card;
 * a bell rings only when someone is likely away. Offline: fake pi, stub judge, temporary state.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ceilingBreach, ceilingEnvProblems, ceilingFromEnv, normaliseCeiling, parseDuration } from "../packages/core/shared/ceiling.ts";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";

interface GuardModule {
  guardCeiling(pi: unknown, options: { env?: NodeJS.ProcessEnv; now?: () => number; ring?: (m: string) => void; notifyAfterMs?: number }): void;
  ring(message: string, out: { isTTY?: boolean; write(text: string): unknown }): void;
  PARKED_EXIT_CODE: number;
}

const restoreIsolation = isolateKitEnv();

// ---- the object -------------------------------------------------------------------------------
assert.equal(ceilingBreach({ turns: 3, costUsd: 5, seconds: 60 }, { turns: 2, costUsd: 4.99, seconds: 59 }), null);
assert.equal(ceilingBreach({ turns: 3 }, { turns: 3, costUsd: 99, seconds: 99999 }), "turns", "a missing limit is no limit");
assert.equal(ceilingBreach({ turns: 3, costUsd: 1 }, { turns: 3, costUsd: 1, seconds: 0 }), "cost", "money is checked first");
assert.deepEqual(normaliseCeiling({ turns: 0, costUsd: -1, seconds: "x" }), {}, "a typo is no limit, never a zero limit");
assert.deepEqual(ceilingFromEnv({ PI_KIT_CEILING_TURNS: "40", PI_KIT_CEILING_USD: "2.5", PI_KIT_CEILING_SECONDS: "abc" }), { turns: 40, costUsd: 2.5 });
assert.deepEqual(ceilingFromEnv({ PI_KIT_CEILING_SECONDS: "90m", PI_KIT_CEILING_USD: "5" }), { costUsd: 5, seconds: 5400 }, "the environment accepts the same durations as the command line");
assert.deepEqual(ceilingEnvProblems({ PI_KIT_CEILING_USD: "5usd", PI_KIT_CEILING_SECONDS: "90x", PI_KIT_CEILING_TURNS: "0" }), ["PI_KIT_CEILING_TURNS=0", "PI_KIT_CEILING_USD=5usd", "PI_KIT_CEILING_SECONDS=90x"], "set but unusable values are named");
assert.deepEqual(ceilingEnvProblems({}), []);
assert.deepEqual([parseDuration("1h30m"), parseDuration("90"), parseDuration("2x"), parseDuration("")], [5400, 90, undefined, undefined]);

// ---- the guard (goal-core) --------------------------------------------------------------------
const guard = await loadModule<GuardModule>("extensions/goal-core/ceiling-guard.ts");
function session(env: NodeJS.ProcessEnv, hasUI = true) {
  const pi = fakePi();
  const rings: string[] = [];
  const parked: unknown[] = [];
  pi.api.events.on("luna:parked", (d) => parked.push(d));
  let clock = 0;
  guard.guardCeiling(pi.api, { env, now: () => clock, ring: (m) => rings.push(m), notifyAfterMs: 1000 });
  let aborted = 0;
  const notes: string[] = [];
  const ctx = { cwd: "/tmp", hasUI, abort: () => { aborted++; }, ui: { notify: (m: string) => notes.push(m) } };
  return { pi, rings, parked, ctx, notes, aborted: () => aborted, tick: (ms: number) => { clock += ms; } };
}
async function turn(s: ReturnType<typeof session>, cost = 0): Promise<void> {
  await s.pi.handlers.get("message_end")({ message: { role: "assistant", usage: { cost: { total: cost } } } }, s.ctx);
  await s.pi.handlers.get("turn_end")({}, s.ctx);
}

{
  const s = session({ PI_KIT_CEILING_TURNS: "2" });
  await s.pi.handlers.get("session_start")({}, s.ctx);
  await turn(s);
  assert.equal(s.aborted(), 0, "under the ceiling nothing happens");
  await turn(s);
  assert.equal(s.aborted(), 1, "the turn limit aborts the run");
  assert.equal(s.parked.length, 1, "and announces that it parked");
  assert.match(s.rings[0] ?? "", /parked/, "a park rings");
  const refused = await s.pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ls" } }, s.ctx);
  assert.equal(refused?.block, true, "a parked run refuses further tool calls");
  await turn(s);
  assert.equal(s.parked.length, 1, "it parks once");
}
{
  // A run that finishes with a final answer on exactly its last allowed turn is a success, not a park.
  const s = session({ PI_KIT_CEILING_TURNS: "2" }, false);
  await s.pi.handlers.get("session_start")({}, s.ctx);
  const final = { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };
  const tools = { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] } };
  const before = process.exitCode;
  await s.pi.handlers.get("turn_end")(tools, s.ctx);
  await s.pi.handlers.get("turn_end")(final, s.ctx);
  assert.equal(s.aborted(), 0, "the final answer on the last turn is not parked");
  assert.equal(s.parked.length, 0);
  assert.equal(process.exitCode, before, "and the exit code stays as it was");
  await s.pi.handlers.get("agent_start")({}, s.ctx);
  assert.equal(s.parked.length, 1, "but a further run past the limit is parked before it starts");
  process.exitCode = before;
}
{
  // A malformed environment ceiling is never silently unbounded.
  const quiet = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const before = process.exitCode;
  try {
    const headless = session({ PI_KIT_CEILING_USD: "5usd" }, false);
    await headless.pi.handlers.get("session_start")({}, headless.ctx);
    assert.equal(headless.parked.length, 1, "a headless run with an unusable ceiling parks at once");
    assert.match(String(Reflect.get(headless.parked[0] ?? {}, "reason")), /PI_KIT_CEILING_USD=5usd is not a valid ceiling/);
    const person = session({ PI_KIT_CEILING_SECONDS: "90x" }, true);
    await person.pi.handlers.get("session_start")({}, person.ctx);
    assert.equal(person.parked.length, 0);
    assert.match(person.notes.join("\n"), /PI_KIT_CEILING_SECONDS=90x is not a valid ceiling/, "a person is told");
  } finally {
    process.stderr.write = quiet;
    process.exitCode = before;
  }
}
{
  const s = session({ PI_KIT_CEILING_USD: "1" });
  await s.pi.handlers.get("session_start")({}, s.ctx);
  await turn(s, 0.4);
  await turn(s, 0.7);
  assert.equal(s.aborted(), 1, "spend over the ceiling parks the run");
  assert.match(String(Reflect.get(s.parked[0] ?? {}, "reason")), /\$1\.10 of the \$1\.00/);
}
{
  const before = process.exitCode;
  const s = session({ PI_KIT_CEILING_TURNS: "1" }, false);
  await s.pi.handlers.get("session_start")({}, s.ctx);
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try { await turn(s); } finally { process.stderr.write = realWrite; }
  assert.equal(process.exitCode, guard.PARKED_EXIT_CODE, "a headless run exits with the parked code");
  process.exitCode = before;
}
{
  const s = session({});
  await s.pi.handlers.get("session_start")({}, s.ctx);
  for (let i = 0; i < 10; i++) await turn(s, 5);
  assert.equal(s.aborted(), 0, "no ceiling, no limit");
  s.pi.api.events.emit("luna:ceiling", { turns: 1 });
  await turn(s);
  assert.equal(s.aborted(), 1, "a ceiling sent over the bus arms the guard");
  s.pi.api.events.emit("luna:ceiling", { clear: true });
  await turn(s);
  assert.equal(s.aborted(), 1, "and clearing it disarms it");
  // Run end: only a run long enough to have been left alone rings.
  await s.pi.handlers.get("agent_start")({}, s.ctx);
  s.tick(500);
  await s.pi.handlers.get("agent_end")({}, s.ctx);
  const quiet = s.rings.length;
  await s.pi.handlers.get("agent_start")({}, s.ctx);
  s.tick(5000);
  await s.pi.handlers.get("agent_end")({}, s.ctx);
  assert.equal(s.rings.length, quiet + 1, "a short run is quiet, a long one rings at its end");
  // A card left open rings once; answering it first cancels the ring.
  s.pi.api.events.emit("luna:attention", { kind: "approval", active: true, label: "approve bash" });
  s.pi.api.events.emit("luna:attention", { kind: "approval", active: false, label: "" });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(s.rings.length, quiet + 1, "an answered card never rings");
  s.pi.api.events.emit("luna:attention", { kind: "approval", active: true, label: "approve bash" });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(s.rings.length, quiet + 2, "a card left open rings");
  await s.pi.handlers.get("session_shutdown")({}, s.ctx);
}
{
  // The environment ceiling is a floor: the bus can tighten it, never loosen or clear it.
  const s = session({ PI_KIT_CEILING_TURNS: "3" });
  await s.pi.handlers.get("session_start")({}, s.ctx);
  s.pi.api.events.emit("luna:ceiling", { seconds: 7200 });
  s.pi.api.events.emit("luna:ceiling", { clear: true });
  await turn(s);
  await turn(s);
  assert.equal(s.aborted(), 0);
  await turn(s);
  assert.equal(s.aborted(), 1, "clearing the bus ceiling leaves the environment turn limit in force");
  s.pi.api.events.emit("luna:ceiling", { clear: true });
  const still = await s.pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ls" } }, s.ctx);
  assert.equal(still?.block, true, "a park by the environment ceiling is not undone by /away");
  assert.match(s.notes[0] ?? "", /restart the session/);
}
{
  const s = session({});
  await s.pi.handlers.get("session_start")({}, s.ctx);
  s.pi.api.events.emit("luna:ceiling", { turns: 1 });
  await turn(s);
  assert.match(s.notes[0] ?? "", /\/away off/, "the park notice says how to resume");
  s.pi.api.events.emit("luna:ceiling", { clear: true });
  const ok = await s.pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ls" } }, s.ctx);
  assert.equal(ok, undefined, "clearing a bus-set ceiling resumes a session it parked");
}
{
  const written: string[] = [];
  guard.ring("done \u001b[31m", { isTTY: false, write: (t) => written.push(t) });
  assert.equal(written.length, 0, "nothing is written to a pipe or file");
  guard.ring("done \u001b[31m", { isTTY: true, write: (t) => written.push(t) });
  assert.ok(written[0]?.includes("\u0007") && !written[0].includes("\u001b[31m"), "a terminal gets the bell and OSC 9, with control characters removed");
}

// ---- /away (tool-firewall) --------------------------------------------------------------------
const root = tmpWorkspace("pi-kit-away-");
const ws = path.join(root, "ws");
fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
const restores = [
  setEnv("HOME", path.join(root, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(root, "agent")),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(root, "legacy")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(root, "audit.jsonl")),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(root, "console")),
];
try {
  fs.mkdirSync(path.join(root, "agent", "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(root, "agent", "pi-kit", "firewall.json"), JSON.stringify({ policy: "coding", learn: false, knownHosts: [], source: "user", mode: "manual" }));
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  let verdict = '{"verdict":"allow","confidence":"high","reason":"fine"}';
  register(pi.api, { complete: async (system: string) => (/review one tool call/.test(system) ? verdict : '{"principles":["p"],"cautions":["c"]}') });
  const ceilings: unknown[] = [];
  pi.api.events.on("luna:ceiling", (d) => ceilings.push(d));
  // goal-core answers the enforcement probe; this is switched off and on below.
  let enforcing = false;
  pi.api.events.on("luna:ceiling-probe", (d) => { if (enforcing && typeof Reflect.get(d as object, "ack") === "function") (Reflect.get(d as object, "ack") as () => void)(); });
  const asked: string[] = [];
  const notes: string[] = [];
  let answer: string | undefined = "Yes, go away";
  const ctx = { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => "s1" }, ui: { notify: (m: string) => notes.push(m), select: async (t: string) => { asked.push(t); return answer; }, input: async () => "" } };
  await pi.handlers.get("session_start")({}, ctx);
  const away = (args: string) => pi.commands.get("away").handler(args, ctx);
  const PUSH = "git push origin feature/a";
  const run = (command = PUSH) => pi.handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx);

  answer = "Yes, go away";
  await away("--for 1h --budget 5");
  assert.equal(ceilings.length, 0, "with goal-core off, nothing enforces the ceiling and /away refuses");
  assert.match(notes.at(-1) ?? "", /goal-core is switched off/);
  enforcing = true;
  await away("--for banana");
  assert.equal(ceilings.length, 0, "an unreadable request changes nothing");
  answer = "No, stay and keep asking";
  await away("--for 1h --budget 5");
  assert.equal(ceilings.length, 0, "declining the confirmation changes nothing");
  answer = "Yes, go away";
  await away("--for 1h --budget 5");
  assert.deepEqual(ceilings, [{ seconds: 3600, costUsd: 5 }], "the ceiling is sent to the guard");

  const cards = asked.length;
  assert.equal(await run(), undefined, "away approves automatically when the judge allows");
  verdict = '{"verdict":"block","confidence":"low","reason":"not sure"}';
  const refused = await run("git push origin feature/b");
  assert.equal(refused?.block, true, "a call that would need a card is refused");
  assert.match(String(refused?.reason), /operator is away/, "with the reason the agent sees");
  assert.equal(asked.length, cards, "no card was shown to nobody");

  pi.api.events.emit("luna:parked", { reason: "ceiling" });
  const back = await run("git push origin feature/c");
  assert.equal(back?.block, true);
  assert.doesNotMatch(String(back?.reason), /operator is away/, "a parked run ends away mode");

  answer = "Yes, go away";
  await away("--for 1h");
  await away("off");
  assert.deepEqual(ceilings.at(-1), { clear: true }, "off clears the ceiling");

  const sent = ceilings.length;
  await pi.commands.get("away").handler("--for 1h", { ...ctx, hasUI: false });
  assert.equal(ceilings.length, sent, "a headless session cannot go away from a prompt");
  console.log("away-ceiling-smoke: OK");
} finally {
  restores.reverse().forEach((r) => r());
  restoreIsolation();
  rmWorkspace(root);
}
