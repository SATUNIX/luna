#!/usr/bin/env node
// dual_review and skill-forge's three tools are registered inactive and wake when the command that
// needs them runs (/review, /improve), so a self-improving session that never uses either does not
// carry their text in every request. The same pattern as workflow_status (tests/lazy-run-tools-smoke.ts).
import assert from "node:assert/strict";
import { fakePi, loadExtension, rmWorkspace, tmpWorkspace, type FakePiApi } from "../packages/core/eval/harness.ts";

type ToolControlApi = FakePiApi & { setActiveTools(names: string[]): void; getAllTools(): { name: string }[] };
type Factory = (pi: ToolControlApi) => void;

const FORGE = ["skill_synthesise", "skill_score", "skill_archive"];
const factories = {
  review: await loadExtension<Factory>("extensions/dual-review/index.ts"),
  forge: await loadExtension<Factory>("extensions/skill-forge/index.ts"),
  improve: await loadExtension<Factory>("extensions/self-improvement/index.ts"),
};

// A pi whose active tool set the test can read, as pi 1.x exposes it: every registered tool except
// the ones that asked for `defaultActive: false`.
function session(...load: (keyof typeof factories)[]) {
  const pi = fakePi();
  let active: string[] = ["read", "bash"];
  const api: ToolControlApi = { ...pi.api, getActiveTools: () => [...active], setActiveTools: (names) => (active = names), getAllTools: () => [...pi.tools.keys()].map((name) => ({ name })) };
  for (const key of load) factories[key](api);
  for (const name of pi.tools.keys()) if (pi.tools.get(name).defaultActive !== false) active.push(name);
  return { pi, active: () => active };
}
const ws = tmpWorkspace("lazy-improve-tools-");
const ctx = { cwd: ws, hasUI: true, ui: { notify() {}, setStatus() {} } };

try {
  {
    const { pi, active } = session("review");
    assert.equal(pi.tools.get("dual_review").defaultActive, false, "dual_review registers inactive");
    assert.ok(!active().includes("dual_review"), "nothing is woken before /review");
    await pi.commands.get("review").handler("", ctx);
    assert.ok(active().includes("dual_review"), "/review wakes dual_review");
    assert.equal(active().filter((n) => n === "dual_review").length, 1, "waking is idempotent");
    await pi.commands.get("review").handler("", ctx);
    assert.equal(active().filter((n) => n === "dual_review").length, 1, "a second /review adds nothing");
  }
  {
    const { pi, active } = session("forge", "improve");
    for (const name of FORGE) assert.equal(pi.tools.get(name).defaultActive, false, `${name} registers inactive`);
    assert.ok(FORGE.every((n) => !active().includes(n)), "nothing is woken before /improve");
    await pi.commands.get("improve").handler("", ctx);
    assert.ok(FORGE.every((n) => active().includes(n)), "/improve wakes the skill-forge tools");
    assert.ok(active().includes("read") && active().includes("bash"), "the rest of the active set is kept");
  }
  {
    // /improve without skill-forge loaded names tools nobody registered: nothing is invented.
    const { pi, active } = session("improve");
    await pi.commands.get("improve").handler("", ctx);
    assert.ok(FORGE.every((n) => !active().includes(n)), "an unregistered tool is never added to the active set");
  }
  {
    // A pi without tool control (older pi) leaves the tools as registered and never throws.
    const pi = fakePi();
    factories.review(pi.api as ToolControlApi);
    factories.improve(pi.api as ToolControlApi);
    await pi.commands.get("review").handler("", ctx);
    await pi.commands.get("improve").handler("", ctx);
  }
} finally {
  rmWorkspace(ws);
}
console.log("[lazy-improve-tools-smoke] dual_review and the skill-forge tools are inactive until /review or /improve");
