#!/usr/bin/env node
/**
 * Model awareness: how a model's size and location change what the kit does.
 *  - modelFit: one function from a context window to the compaction settings, so the tiers are
 *    ordered, the suggested settings leave a threshold that clears keep + pi's safety margin (and a
 *    window too small for that says so), and an unknown window is treated as normal;
 *  - "local" is one rule in three copies (model-fit, judge, subagent), pinned to one table here;
 *  - local models: children run one at a time unless models.json says otherwise, and an explicit
 *    operator setting wins;
 *  - the tool-call probe: a model that answers in prose is recorded as not calling tools, a server that
 *    cannot be asked is not recorded, and the Doctor page reports the cache.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as Fit from "../packages/extensions/src/session-helpers/model-fit.ts";
import type * as JudgeMod from "../packages/extensions/src/tool-firewall/judge.ts";
import type * as Probe from "../packages/extensions/src/session-helpers/tool-probe.ts";
import type * as Doctor from "../packages/extensions/src/control-center/doctor.ts";
import type * as SubConfig from "../packages/extensions/third_party/subagent/config.ts";

const restoreIsolation = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-model-fit-");
const restores = [restoreIsolation, setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_SUBAGENT_CONCURRENCY", undefined)];
try {
  // modelFit
  const fit = await loadModule<typeof Fit>("extensions/session-helpers/model-fit.ts");
  const tiny = fit.modelFit(4096);
  const small = fit.modelFit(32_000);
  const normal = fit.modelFit(200_000);
  assert.deepEqual([tiny.tier, small.tier, normal.tier], ["tiny", "small", "normal"]);
  assert.equal(fit.modelFit(null).tier, "normal", "an unknown window is not assumed small");
  for (const w of [6000, 8192, 16_000, 32_000]) {
    const f = fit.modelFit(w);
    assert.equal(f.compactionFits, true, `${w} fits`);
    assert.ok(w - f.compaction.reserveTokens >= f.compaction.keepRecentTokens + 4096, `the suggested settings for a ${w} window leave a threshold that clears keep + 4096`);
  }
  assert.equal(fit.modelFit(4096).compactionFits, false, "a 4k window cannot be fixed by settings");
  assert.deepEqual(normal.compaction, { reserveTokens: 16_384, keepRecentTokens: 20_000 }, "normal windows keep pi's own defaults");
  assert.ok(small.window === 32_000);

  // Local models: serial children.
  const sub = await loadModule<typeof SubConfig>("vendor/subagent/config.ts");
  const localModel = { provider: "lan", id: "qwen", baseUrl: "http://localhost:11434/v1" };
  const hostedModel = { provider: "cloud", id: "big", baseUrl: "https://api.example.com/v1" };
  assert.equal(sub.capConcurrency(4, localModel), 1, "a local model runs one child at a time");
  assert.equal(sub.capConcurrency(4, hostedModel), 4, "a hosted model is left alone");
  assert.equal(sub.capConcurrency(4, undefined), 4);
  fs.mkdirSync(path.join(ws, "agent"), { recursive: true });
  fs.writeFileSync(path.join(ws, "agent", "models.json"), JSON.stringify({ providers: { lan: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen", maxConcurrentRequests: 3 }, { id: "other" }] } } }));
  assert.equal(sub.capConcurrency(4, localModel), 3, "models.json maxConcurrentRequests wins over the local default");
  assert.equal(sub.capConcurrency(2, localModel), 2, "and never raises what was asked for");
  fs.rmSync(path.join(ws, "agent", "models.json"));
  const restoreEnv = setEnv("PI_KIT_SUBAGENT_CONCURRENCY", "6");
  assert.equal(sub.capConcurrency(6, localModel), 6, "an explicit operator setting is respected");
  restoreEnv();

  // The three copies of the local rule agree, and the operator override reaches all of them.
  const judgeMod = await loadModule<typeof JudgeMod>("extensions/tool-firewall/judge.ts");
  const urls = ["http://localhost:1/v1", "http://127.0.0.1/v1", "http://10.1.2.3/v1", "http://172.16.0.1/v1", "http://172.32.0.1/v1", "http://192.168.0.9/v1", "http://169.254.1.1/", "http://[::1]:8080/", "http://[fd00::1]/", "http://box/v1", "http://box.lan/v1", "http://gw.internal/v1", "http://m.local/v1", "https://api.example.com/v1", "https://8.8.8.8/v1", "not a url", ""];
  for (const url of urls) {
    const a = fit.isLocalBaseUrl(url);
    assert.equal(judgeMod.isLocalProvider(url), a, `judge agrees on ${url}`);
    assert.equal(sub.capConcurrency(4, { baseUrl: url }) === 1, a, `subagent agrees on ${url}`);
  }
  const forceOff = setEnv("PI_KIT_LOCAL_MODELS", "off");
  assert.equal(fit.isLocalBaseUrl("http://box/v1"), false);
  assert.equal(judgeMod.isLocalProvider("http://box/v1"), false);
  assert.equal(sub.capConcurrency(4, { baseUrl: "http://box/v1" }), 4, "PI_KIT_LOCAL_MODELS=off reaches all three");
  forceOff();

  // The probe and the doctor line.
  const probe = await loadModule<typeof Probe>("extensions/session-helpers/tool-probe.ts");
  const yes = await probe.probeToolCalls("lan/qwen", async () => [{ type: "toolCall", name: "echo" }]);
  assert.equal(yes?.ok, true);
  const no = await probe.probeToolCalls("lan/llama", async () => [{ type: "text" }]);
  assert.equal(no?.ok, false);
  assert.equal(await probe.probeToolCalls("lan/down", async () => { throw new Error("ECONNREFUSED"); }), null, "a server that cannot be asked records nothing");
  const file = probe.probeFile(path.join(ws, "agent"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(probe.withProbe(probe.withProbe([], yes ?? assert.fail("probe")), no ?? assert.fail("probe"))));
  const doctor = await loadModule<typeof Doctor>("extensions/control-center/doctor.ts");
  const lines = doctor.doctorLines({
    marker: { companions: [], extensions: [] }, piVersion: "0.0.0", settingsFile: path.join(ws, "settings.json"),
    toolProbes: doctor.readToolProbes(path.join(ws, "agent")), registries: { protections: 1 },
  }).filter((l) => l.label === "Tool calls");
  assert.deepEqual(lines.map((l) => l.ok).sort(), [false, true], "the doctor reports each probed model, and flags the one that cannot call tools");
  console.log("PASS model-fit: tiers, serial local children, tool-call probe");
} finally {
  for (const restore of restores.reverse()) restore();
  rmWorkspace(ws);
}
