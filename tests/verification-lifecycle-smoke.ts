import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { boolean, number, object, parseJsonAs, record } from "../packages/core/lib/guard.ts";
import type * as VerifyGate from "../packages/extensions/src/verify-gate/index.ts";

/** A custom message the extensions send with sendMessage (text content). */
interface CustomSteer { customType: string; content: string }

/** .pi/verdicts.json, as far as this test reads it. */
const VerdictBoard = object({ generation: number(), verdicts: record(object({ pass: boolean() })) });

const restoreIsolation = isolateKitEnv();
const ws = tmpWorkspace("pi-verification-lifecycle-");
const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
const restore = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
const restoreOrch = setEnv("PI_KIT_ORCH_DISABLE", undefined);
const final = { message: { role: "assistant", stopReason: "stop" } };
try {
  const pi = fakePi();
  (await loadExtension("extensions/orchestrator/index.ts"))(pi.api);
  await pi.handlers.get("session_start")({}, ctx);
  for (const source of ["interactive", "rpc"]) {
    for (const text of ["hello", "I am just saying hello, all good.", "What does a verifier do?"]) {
      await pi.handlers.get("input")({ source, text }, ctx);
      await pi.handlers.get("turn_end")(final, ctx);
      assert.equal(pi.steers.length, 0, `${source} conversation must not activate verification`);
    }
  }
  await pi.handlers.get("tool_result")({ toolName: "edit", isError: true }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(pi.steers.length, 0, "failed edits do not activate verification");
  await pi.handlers.get("tool_result")({ toolName: "write", isError: false }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(pi.steers.length, 0, "a report without a project verify script does not require an npm board");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
  const disableAuto = setEnv("PI_KIT_VERIFY_ON_TURN", undefined);
  await pi.handlers.get("tool_result")({ toolName: "edit", isError: false }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(pi.steers.length, 0, "ordinary edits do not implicitly opt into disabled automatic verification");
  disableAuto();
  await pi.handlers.get("tool_result")({ toolName: "edit", isError: false }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(pi.steers.length, 1, "successful edits require real verification");
  const [gate] = pi.steers;
  assert.ok(gate, "a verification diagnostic was sent");
  assert.equal((gate.message as CustomSteer).customType, "orchestrator-verification");
  assert.match((gate.message as CustomSteer).content, /Never fabricate a PASS/);
  await pi.handlers.get("input")({ source: "extension", text: "diagnostic" }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(pi.steers.length, 1, "automatic continuation cannot loop");
  await pi.handlers.get("input")({ source: "interactive", text: "I am just saying hello, all good." }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(pi.steers.length, 1, "user clarification stops the previous gate");
  // The manual commands now deliver their directive as a user message (it used to be a
  // contribution file the next input clobbered), so count only verification diagnostics here.
  const gates = () => pi.steers.filter((s) => (s.message as Partial<CustomSteer> | undefined)?.customType === "orchestrator-verification").length;
  await pi.commands.get("orchestrate-plan").handler("Investigate the feature", ctx);
  assert.match(pi.steers.at(-1)?.message as string, /plan only/i, "the plan directive is sent as a message");
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(gates(), 1, "planning does not require a code verification board");
  await pi.commands.get("orchestrate-implement-review").handler("Fix the feature", ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(gates(), 2, "explicit implementation workflow remains gated");
  pi.api.getActiveTools = () => ["read", "bash", "write", "edit"];
  await pi.handlers.get("input")({ source: "rpc", text: "Implement a robust feature across a.ts and b.ts then test and review the entire system." }, ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(gates(), 2, "complex requests cannot activate unavailable delegation tools");
  assert.ok(!fs.existsSync(path.join(ws, ".pi/ctx-contributions/orchestrator.json")));
  await pi.commands.get("orchestrate-implement-review").handler("Fix feature", ctx);
  await pi.handlers.get("turn_end")(final, ctx);
  assert.equal(gates(), 2, "manual delegation rejects unavailable tools without arming a gate");

  const vg = fakePi();
  (await loadExtension("extensions/verify-gate/index.ts"))(vg.api);
  await vg.handlers.get("session_start")({}, ctx);
  await vg.handlers.get("turn_end")(final, ctx);
  assert.ok(!fs.existsSync(path.join(ws, ".pi/verdicts.json")), "greeting creates no false failing board");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
  await vg.handlers.get("tool_result")({ toolName: "write", isError: false }, ctx);
  await vg.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
  assert.ok(!fs.existsSync(path.join(ws, ".pi/verdicts.json")), "no checks midway through tool work");
  await vg.handlers.get("turn_end")(final, ctx);
  const board = () => parseJsonAs(VerdictBoard, fs.readFileSync(path.join(ws, ".pi/verdicts.json"), "utf8"));
  assert.equal(board().verdicts.verify?.pass, true, "final turn awaits actual verification");
  assert.ok(!fs.existsSync(path.join(ws, ".pi/verify-pending.json")));
  await vg.handlers.get("turn_end")(final, ctx);
  assert.equal(board().generation, 1, "unchanged work is not reverified");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: 'node -e "process.exit(1)"' } }));
  for (let i = 0; i < 2; i++) {
    await vg.handlers.get("tool_result")({ toolName: "edit", isError: false }, ctx);
    await vg.handlers.get("turn_end")(final, ctx);
  }
  assert.equal(board().verdicts.verify?.pass, false);
  assert.equal(vg.steers.length, 1, "standalone verify failure correction is bounded");

  // verify-pending must self-expire: a crash/SIGKILL leaves the marker behind, and a
  // marker older than the TTL must not be treated as an in-flight run forever.
  const vgMod = await loadModule<typeof VerifyGate>("extensions/verify-gate/index.ts");
  const marker = path.join(ws, ".pi", "verify-pending.json");
  fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  assert.equal(vgMod.isVerifyPendingActive(ws), false, "a marker older than the TTL must not count as active");
  await vg.handlers.get("session_start")({}, ctx);
  assert.ok(!fs.existsSync(marker), "session_start must clear a stale verify-pending marker");
  fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString() }));
  assert.equal(vgMod.isVerifyPendingActive(ws), true, "a fresh marker must count as active");
  fs.rmSync(marker, { force: true });
  console.log("PASS verification lifecycle: greetings, RPC, edits, clarification, explicit workflows, auto-verify ordering and bounded correction");
} finally {
  restore(); restoreOrch(); restoreIsolation(); rmWorkspace(ws);
}
