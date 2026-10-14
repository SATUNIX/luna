#!/usr/bin/env node
/**
 * Effort control (docs/effort.md): the five tiers, persistence, precedence, turn-boundary changes,
 * prompt de-duplication, child inheritance, the shared cross-process delegation budget,
 * exhaustion, recovery, and independence from permissions, thinking and the model.
 *
 * Deterministic and offline: the extension runs against a fake pi API in a scratch agent dir.
 * The concurrency check races real processes on one ledger file.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";
import { clampTier, loadEffortPolicy, normalizeTier, tierLimits, renderEffortPrompt, validateEffortPolicy } from "../packages/core/lib/effort.mjs";

const restoreEnv = isolateKitEnv();
const mod = await loadModule("extensions/effort/index.ts");
const policyMod = await loadModule("extensions/effort/policy.ts");
const ledgerMod = await loadModule("extensions/effort/ledger.ts");
const { default: effort, REGISTRY_KEY, readConfig, resolveEffective, saveDefault } = mod;
const corePolicy = loadEffortPolicy();
const rtPolicy = policyMod.loadPolicy();
const CACHE = path.resolve("node_modules/.cache/pi-kit-eval");

/**
 * Race `count` real processes, each making 12 reservations against one ledger file, and return what
 * every process was told. Each process reports ready, waits for one go signal, and keeps its slots (its
 * pid stays alive) until all of them have finished reserving. That guarantees they overlap and contend
 * at once however slowly each one starts. A fixed time barrier did not: on a throttled CI container the
 * children started apart, early ones exited and freed their slots, and more reservations succeeded than
 * the concurrency limit allows.
 */
async function raceReserves(file, limits, count) {
  const ledgerPath = path.join(CACHE, "packages_extensions_src_effort_ledger.mjs");
  const script = `
    import(${JSON.stringify("file://" + ledgerPath)}).then(async (m) => {
      const file = ${JSON.stringify(file)};
      const limits = ${JSON.stringify(limits)};
      const input = (await import("node:readline")).createInterface({ input: process.stdin })[Symbol.asyncIterator]();
      console.log("ready");
      await input.next(); // go
      const out = [];
      for (let i = 0; i < 12; i++) {
        const r = m.reserve(file, { kind: "discretionary", role: "worker", requesterTier: "thorough", requesterLimits: limits, requesterLabel: "E4 Thorough" });
        out.push(r.ok ? "ok" : r.code);
        if (r.ok) m.attach(file, r.id, process.pid);
      }
      console.log(JSON.stringify(out));
      await input.next(); // hold the slots until the parent closes stdin
      process.exit(0);
    });`;
  const kids = Array.from({ length: count }, () => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    const closed = new Promise((resolve, reject) => p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`race child exited ${code}`)))));
    closed.catch(() => {});
    return { p, lines, closed };
  });
  const next = async (k) => {
    const r = await Promise.race([k.lines.next(), k.closed.then(() => ({ done: true }))]);
    if (r.done) throw new Error("race child ended before reporting");
    return r.value;
  };
  try {
    for (const k of kids) assert.equal(await next(k), "ready");
    for (const k of kids) k.p.stdin.write("go\n");
    const runs = await Promise.all(kids.map(async (k) => JSON.parse(await next(k))));
    for (const k of kids) k.p.stdin.end();
    await Promise.all(kids.map((k) => k.closed));
    return runs;
  } finally {
    for (const k of kids) k.p.kill();
  }
}

function world(env = {}) {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-effort-"));
  const restores = [setEnv("PI_CODING_AGENT_DIR", agent), ...Object.entries(env).map(([k, v]) => setEnv(k, v))];
  return { agent, cleanup: () => { restores.reverse().forEach((r) => r()); rmWorkspace(agent); } };
}

function boot({ hasUI = true } = {}) {
  const pi = fakePi();
  effort(pi.api);
  const notes = [];
  const ctx = { hasUI, cwd: process.cwd(), ui: { notify: (m, l) => notes.push({ m, l }), select: async (_t, opts) => opts[2], setStatus() {} }, sessionManager: { getSessionId: () => "sess1" } };
  const registry = () => globalThis[REGISTRY_KEY];
  return { pi, ctx, notes, registry, start: (reason = "startup") => pi.handlers.get("session_start")({ reason }, ctx), turn: (prompt = "BASE") => pi.handlers.get("before_agent_start")({ systemPrompt: prompt }, ctx), command: (args) => pi.commands.get("effort").handler(args, ctx) };
}

const tests = {
  "the tier table matches the specification and validates": () => {
    assert.deepEqual(validateEffortPolicy(corePolicy), []);
    const table = corePolicy.tiers.map((t) => [t.id, t.code, t.limits.maxConcurrent, t.limits.maxTotal, t.limits.maxScouts]);
    assert.deepEqual(table, [["minimal", "E1", 0, 0, 0], ["focused", "E2", 1, 1, 1], ["standard", "E3", 2, 3, 1], ["thorough", "E4", 4, 8, 2], ["exhaustive", "E5", 6, 16, 3]]);
    assert.equal(corePolicy.default, "standard");
    const broken = structuredClone(corePolicy);
    broken.tiers[2].limits.maxTotal = 0; // below the previous tier
    broken.tiers[1].limits.maxScouts = 5; // scouts exceed the shared total
    assert.ok(validateEffortPolicy(broken).length >= 2, "a broken policy is rejected");
  },

  "the runtime and toolchain implementations agree on aliases, clamping, limits and prompts": () => {
    const inputs = ["minimal", "E1", "e1", "1", 1, "focused", "E2", "standard", "std", "default", "E3", "3", "thorough", "E4", "exhaustive", "max", "E5", "5", "E6", "0", "", "  Thorough ", "nonsense", null, undefined, {}, "e3; rm -rf /"];
    for (const input of inputs) assert.equal(policyMod.normalizeTier(rtPolicy, input), normalizeTier(input, corePolicy), `normalise ${JSON.stringify(input)}`);
    for (const a of corePolicy.tiers) for (const b of corePolicy.tiers) assert.equal(policyMod.clampTier(rtPolicy, a.id, b.id), clampTier(a.id, b.id, corePolicy), `clamp ${a.id} under ${b.id}`);
    for (const t of corePolicy.tiers) {
      assert.deepEqual(policyMod.tierLimits(rtPolicy, t.id), tierLimits(t.id, corePolicy));
      assert.equal(policyMod.renderPrompt(rtPolicy, t.id), renderEffortPrompt(t.id, corePolicy));
    }
    assert.equal(normalizeTier("E7", corePolicy), null);
  },

  "each tier injects the shared policy once plus its own contribution, and nothing about permissions or models": async () => {
    const w = world();
    try {
      const shared = fs.readFileSync(path.join(path.resolve("packages/extensions/src/effort/policy"), "shared.md"), "utf8").trim();
      assert.ok(shared.startsWith("Effort controls execution depth and breadth, not model reasoning or permissions."));
      for (const tier of corePolicy.tiers) {
        const b = boot();
        saveDefault(tier.id);
        await b.start();
        const out = (await b.turn("BASE PROMPT")).systemPrompt;
        assert.equal(out.split(shared).length - 1, 1, `${tier.id}: shared policy exactly once`);
        assert.ok(out.includes(`Tier: ${tier.code} ${tier.label}.`), `${tier.id}: tier text`);
        for (const other of corePolicy.tiers.filter((t) => t.id !== tier.id)) assert.ok(!out.includes(`Tier: ${other.code} `), `${tier.id}: no ${other.id} text`);
        assert.ok(out.startsWith("BASE PROMPT"), "the base prompt is kept");
        assert.ok(!/thinking level|switch model|grant|bypass/i.test(out.replace(shared, "")), `${tier.id}: tier text says nothing about models or permissions`);
      }
      const e1 = renderEffortPrompt("minimal", corePolicy), e5 = renderEffortPrompt("exhaustive", corePolicy);
      assert.match(e1, /mandatory security and completion checks still apply/i);
      assert.match(e5, /trivial edit is still done directly/i);
    } finally { w.cleanup(); }
  },

  "the prompt block is replaced, never duplicated, across turns and pre-existing blocks": async () => {
    const w = world();
    try {
      const b = boot();
      await b.start();
      let prompt = "BASE";
      for (let i = 0; i < 4; i++) prompt = (await b.turn(prompt)).systemPrompt; // pi could hand back our own output
      assert.equal(prompt.split("<!-- pi-kit:effort -->").length - 1, 1);
      assert.equal(prompt.split("Effort controls execution depth").length - 1, 1);
      await b.command("thorough");
      prompt = (await b.turn(prompt)).systemPrompt;
      assert.equal(prompt.split("<!-- pi-kit:effort -->").length - 1, 1, "still one block after a tier change");
      assert.ok(prompt.includes("Tier: E4 Thorough.") && !prompt.includes("Tier: E3 Standard."), "the previous contribution was replaced");
    } finally { w.cleanup(); }
  },

  "default is E3 Standard; /effort persists; a new session restores it": async () => {
    const w = world();
    try {
      let b = boot();
      await b.start();
      assert.equal(b.registry().snapshot().tier, "standard");
      assert.equal(b.registry().snapshot().code, "E3");
      assert.equal(b.registry().snapshot().source, "default");
      await b.command("E4");
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.agent, "pi-kit", "effort.json"), "utf8")).default, "thorough", "canonical id persisted, not the alias");
      b = boot();
      await b.start();
      assert.equal(b.registry().snapshot().tier, "thorough");
      assert.equal(b.registry().snapshot().source, "user");
      await b.command("reset");
      b = boot();
      await b.start();
      assert.equal(b.registry().snapshot().tier, "standard");
      assert.ok(!("default" in JSON.parse(fs.readFileSync(path.join(w.agent, "pi-kit", "effort.json"), "utf8"))));
    } finally { w.cleanup(); }
  },

  "a change applies at the next user-turn boundary, not mid-turn": async () => {
    const w = world();
    try {
      const b = boot();
      await b.start();
      await b.turn();
      const before = b.registry().snapshot();
      assert.equal(before.tier, "standard");
      await b.command("exhaustive");
      const mid = b.registry().snapshot();
      assert.equal(mid.tier, "standard", "the running turn keeps its snapshot (and its budgets)");
      assert.equal(mid.pendingTier, "exhaustive");
      assert.equal(mid.limits.maxTotal, 3);
      assert.ok(b.notes.at(-1).m.includes("Applies from your next message"));
      await b.turn();
      const after = b.registry().snapshot();
      assert.equal(after.tier, "exhaustive");
      assert.equal(after.pendingTier, null);
      assert.equal(after.limits.maxTotal, 16);
    } finally { w.cleanup(); }
  },

  "precedence: env pin > saved default > policy default; a cap only lowers; invalid values are reported": () => {
    const cfg = { tier: "thorough", limits: {}, warnings: [] };
    const none = { tier: null, limits: {}, warnings: [] };
    assert.equal(resolveEffective(rtPolicy, {}, none).tier, "standard");
    assert.deepEqual(pick(resolveEffective(rtPolicy, {}, cfg)), { tier: "thorough", source: "user", pinned: false });
    assert.deepEqual(pick(resolveEffective(rtPolicy, { PI_KIT_EFFORT: "E2" }, cfg)), { tier: "focused", source: "env", pinned: true });
    assert.deepEqual(pick(resolveEffective(rtPolicy, { PI_KIT_EFFORT: "exhaustive", PI_KIT_EFFORT_CAP: "focused" }, cfg)), { tier: "focused", source: "cap", pinned: true });
    assert.equal(resolveEffective(rtPolicy, { PI_KIT_EFFORT: "minimal", PI_KIT_EFFORT_CAP: "exhaustive" }, cfg).tier, "minimal", "a cap never raises");
    const bad = resolveEffective(rtPolicy, { PI_KIT_EFFORT: "turbo" }, cfg);
    assert.equal(bad.tier, "thorough", "an invalid pin falls back to the saved default");
    assert.match(bad.warnings[0], /PI_KIT_EFFORT="turbo"/);
    const badCap = resolveEffective(rtPolicy, { PI_KIT_EFFORT_CAP: "unbounded" }, cfg);
    assert.equal(badCap.tier, "minimal", "an invalid cap fails closed to the lowest tier");
    function pick(r) { return { tier: r.tier, source: r.source, pinned: r.pinned }; }
  },

  "a pinned session keeps its tier when /effort is used, and says so": async () => {
    const w = world({ PI_KIT_EFFORT: "focused" });
    try {
      const b = boot();
      await b.start();
      await b.command("exhaustive");
      await b.turn();
      assert.equal(b.registry().snapshot().tier, "focused");
      assert.ok(b.notes.some((n) => /pinned/.test(n.m)));
      assert.equal(JSON.parse(fs.readFileSync(path.join(w.agent, "pi-kit", "effort.json"), "utf8")).default, "exhaustive", "the default is still saved for later sessions");
    } finally { w.cleanup(); }
  },

  "invalid /effort arguments change nothing; headless sessions get text; a cancelled picker changes nothing": async () => {
    const w = world();
    try {
      const b = boot();
      await b.start();
      const file = path.join(w.agent, "pi-kit", "effort.json");
      await b.command("E9");
      await b.command("turbo; rm -rf /");
      await b.command("6");
      assert.ok(!fs.existsSync(file), "no file written for invalid input");
      assert.equal(b.notes.filter((n) => n.l === "error").length, 3);
      assert.match(b.notes[0].m, /Nothing was changed/);
      // cancelled picker
      b.ctx.ui.select = async () => undefined;
      await b.command("");
      assert.ok(!fs.existsSync(file));
      // a picker choice
      b.ctx.ui.select = async (_t, opts) => opts[3];
      await b.command("");
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).default, "thorough");
      // headless: text on stderr, no exception
      const h = boot({ hasUI: false });
      const written = [];
      const real = process.stderr.write.bind(process.stderr);
      process.stderr.write = (c) => { written.push(String(c)); return true; };
      try { await h.start(); await h.command(""); await h.command("status"); await h.command("nonsense"); } finally { process.stderr.write = real; }
      const text = written.join("");
      assert.match(text, /Effort tiers/);
      assert.match(text, /Effort: E4 Thorough/);
      assert.match(text, /not an effort level/);
    } finally { w.cleanup(); }
  },

  "malformed or hostile config is ignored with a warning, never fatal or permissive": async () => {
    const w = world();
    try {
      const file = path.join(w.agent, "pi-kit", "effort.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      for (const text of ["{ not json", "[]", JSON.stringify({ default: "ultra", limits: { standard: { maxTotal: -3, maxScouts: "many" }, nope: { maxTotal: 1 } } })]) {
        fs.writeFileSync(file, text);
        const cfg = readConfig(rtPolicy, file);
        assert.equal(cfg.tier, null);
        assert.ok(cfg.warnings.length >= 1, text);
        assert.deepEqual(cfg.limits.standard ?? {}, {}, "invalid limit values are dropped");
      }
      fs.writeFileSync(file, JSON.stringify({ default: "E5", limits: { exhaustive: { maxTotal: 9999 }, standard: { maxTotal: 2 } } }));
      const ok = readConfig(rtPolicy, file);
      assert.equal(ok.tier, "exhaustive");
      const capped = policyMod.tierLimits(rtPolicy, "exhaustive", ok.limits);
      assert.equal(capped.maxTotal, rtPolicy.ceilings.maxTotal, "user limits never exceed the platform ceiling");
      assert.equal(policyMod.tierLimits(rtPolicy, "standard", ok.limits).maxTotal, 2, "users may lower a limit");
    } finally { w.cleanup(); }
  },

  "effort is independent of permissions, thinking and the model": async () => {
    const w = world({ PI_KIT_UNATTENDED: "1", PI_KIT_AUTO_MODE: "1" });
    try {
      const b = boot();
      await b.start();
      for (const tier of ["minimal", "exhaustive"]) {
        await b.command(tier);
        await b.turn();
      }
      assert.deepEqual(b.pi.modelSelections, [], "no model change");
      assert.equal(b.pi.handlers.has("tool_call"), false, "effort registers no permission hook");
      assert.equal(b.pi.handlers.has("model_select"), false);
      assert.equal(b.pi.handlers.has("thinking_level_select"), false);
      assert.equal(b.pi.tools.size, 0, "no tools are registered or activated");
      const snap = b.registry().snapshot();
      assert.ok(!("permissions" in snap) && !("model" in snap) && !("thinking" in snap));
      // The same input under different unattended/permission env yields the same effort snapshot.
      assert.equal(snap.tier, "exhaustive");
    } finally { w.cleanup(); }
  },

  "E1 refuses discretionary delegation with an actionable reason; E5 still allows trivial direct work": async () => {
    const w = world({ PI_KIT_EFFORT: "minimal" });
    try {
      const b = boot();
      await b.start();
      await b.turn();
      const r = b.registry().reserve({ kind: "discretionary", role: "scout", scout: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, "tier");
      assert.match(r.reason, /E1 Minimal does not delegate/);
      assert.match(r.reason, /\/effort/);
      // Mandatory verification is not discretionary work and still runs at E1.
      const m = b.registry().reserve({ kind: "mandatory", role: "reviewer" });
      assert.equal(m.ok, true);
      assert.equal(m.env.PI_KIT_EFFORT, "minimal", "the reviewer child is pinned to the parent's tier");
    } finally { w.cleanup(); }
  },

  "budgets: total, concurrent and scout limits per tier; exhaustion; no refunds": async () => {
    const w = world();
    try {
      for (const tier of corePolicy.tiers.filter((t) => t.limits.maxTotal > 0)) {
        const b = boot();
        saveDefault(tier.id);
        await b.start();
        await b.turn();
        const L = tier.limits;
        const held = [];
        // concurrency: fill every slot without settling
        for (let i = 0; i < L.maxConcurrent; i++) {
          const r = b.registry().reserve({ kind: "discretionary", role: "worker" });
          assert.equal(r.ok, true, `${tier.id} slot ${i + 1}`);
          held.push(r);
        }
        const over = b.registry().reserve({ kind: "discretionary", role: "worker" });
        assert.equal(over.ok, false);
        assert.equal(over.code, L.maxConcurrent >= L.maxTotal ? "total" : "concurrency", `${tier.id}: ${over.reason}`);
        // settle as FAILED: the slot frees but the charge stays
        held.forEach((r) => r.settle("failed"));
        let granted = held.length;
        for (;;) {
          const r = b.registry().reserve({ kind: "discretionary", role: "worker" });
          if (!r.ok) { assert.equal(r.code, "total", `${tier.id}: ${r.reason}`); break; }
          r.settle("failed");
          granted++;
        }
        assert.equal(granted, L.maxTotal, `${tier.id}: exactly maxTotal executions were charged, failures included`);
        assert.equal(b.registry().snapshot().usage.total, L.maxTotal);
        assert.equal(b.registry().snapshot().usage.live, 0);
        // scouts count within the shared total
        await b.turn(); // a new user turn opens a new scope
        const scouts = [];
        for (let i = 0; i < L.maxScouts + 1; i++) scouts.push(b.registry().reserve({ kind: "discretionary", role: "scout", scout: true }));
        assert.equal(scouts.filter((s) => s.ok).length, Math.min(L.maxScouts, L.maxConcurrent), `${tier.id}: scouts limited (${scouts.map((s) => s.code ?? "ok")})`);
        scouts.forEach((s) => s.ok && s.settle("ok"));
      }
    } finally { w.cleanup(); }
  },

  "a new user turn opens a new scope, but the session ceiling still bounds the total": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("exhaustive");
      await b.start();
      let started = 0;
      let denied = null;
      for (let turn = 0; turn < 8 && !denied; turn++) {
        await b.turn();
        for (let i = 0; i < 16 && !denied; i++) {
          const r = b.registry().reserve({ kind: "discretionary", role: "worker" });
          if (r.ok) { started++; r.settle("ok"); } else denied = r;
        }
      }
      assert.equal(started, rtPolicy.ceilings.maxTotal, "the platform ceiling caps a whole session");
      assert.equal(denied.code, "session-ceiling");
    } finally { w.cleanup(); }
  },

  "children: never above the parent's tier, pinned and capped by env, sharing one ledger": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("focused");
      await b.start();
      await b.turn();
      const r = b.registry().reserve({ kind: "discretionary", role: "worker", requestedTier: "exhaustive" });
      assert.equal(r.ok, true);
      assert.equal(r.childTier, "focused", "requested exhaustive is clamped to the parent's focused");
      assert.equal(r.env.PI_KIT_EFFORT, "focused");
      assert.equal(r.env.PI_KIT_EFFORT_CAP, "focused");
      assert.ok(fs.existsSync(r.env.PI_KIT_EFFORT_LEDGER));
      const lower = b.registry().reserve({ kind: "discretionary", role: "worker", requestedTier: "minimal" });
      assert.equal(lower.ok, false, "focused allows one child in total, and it was already charged");
      // The child process: env pin + cap + ledger. It cannot raise its tier, and shares the ledger.
      const restore = [setEnv("PI_KIT_EFFORT", r.env.PI_KIT_EFFORT), setEnv("PI_KIT_EFFORT_CAP", r.env.PI_KIT_EFFORT_CAP), setEnv("PI_KIT_EFFORT_LEDGER", r.env.PI_KIT_EFFORT_LEDGER)];
      try {
        const child = boot();
        await child.start();
        await child.command("exhaustive"); // a child cannot raise itself
        await child.turn();
        const snap = child.registry().snapshot();
        assert.equal(snap.tier, "focused");
        assert.equal(snap.ledger, r.env.PI_KIT_EFFORT_LEDGER, "the child reuses the parent's ledger and opens no new scope");
        const grand = child.registry().reserve({ kind: "discretionary", role: "worker" });
        assert.equal(grand.ok, false, "descendants do not receive a fresh budget");
        assert.equal(grand.code, "total");
      } finally { restore.reverse().forEach((f) => f()); }
    } finally { w.cleanup(); }
  },

  "resume and compaction keep the budget: a fresh session on the same ledger continues the count": async () => {
    const w = world();
    try {
      const first = boot();
      saveDefault("standard");
      await first.start();
      await first.turn();
      const a = first.registry().reserve({ kind: "discretionary", role: "worker" });
      const b2 = first.registry().reserve({ kind: "discretionary", role: "worker" });
      assert.ok(a.ok && b2.ok);
      a.settle("failed");
      b2.settle("failed");
      const file = first.registry().snapshot().ledger;
      // An autonomous step resumed in a fresh session is handed the same ledger: no fresh budget.
      const restore = [setEnv("PI_KIT_EFFORT", "standard"), setEnv("PI_KIT_EFFORT_LEDGER", file)];
      try {
        const resumed = boot();
        await resumed.start("resume");
        await resumed.turn();
        assert.equal(resumed.registry().snapshot().usage.total, 2, "charges survive the restart");
        assert.equal(resumed.registry().reserve({ kind: "discretionary", role: "worker" }).ok, true, "one execution remains at standard (3 total)");
        assert.equal(resumed.registry().reserve({ kind: "discretionary", role: "worker" }).ok, false);
        // And the effort block survives a compaction-style rebuild of the prompt.
        const rebuilt = (await resumed.turn("COMPACTED SUMMARY PROMPT")).systemPrompt;
        assert.ok(rebuilt.includes("Tier: E3 Standard."));
      } finally { restore.reverse().forEach((f) => f()); }
    } finally { w.cleanup(); }
  },

  "recovery has its own small budget, opens only when the trusted extension says so, and is read-only": async () => {
    const w = world({ PI_KIT_EFFORT: "minimal" });
    try {
      const b = boot();
      await b.start();
      await b.turn();
      const reg = b.registry();
      const closed = reg.reserve({ kind: "recovery", role: "scout", readOnly: true });
      assert.equal(closed.code, "recovery-closed", "the model cannot open the recovery channel by asking");
      reg.setRecoveryActive(true, "progress-guard escalation");
      assert.equal(reg.reserve({ kind: "recovery", role: "implementer", readOnly: false }).code, "recovery-role", "not a delegation bypass: only read-only roles");
      const one = reg.reserve({ kind: "recovery", role: "scout", readOnly: true });
      assert.equal(one.ok, true);
      assert.equal(reg.reserve({ kind: "recovery", role: "scout", readOnly: true }).code, "recovery-budget", "one recovery child at a time");
      one.settle("ok");
      assert.equal(reg.reserve({ kind: "recovery", role: "scout", readOnly: true }).ok, true);
      assert.equal(reg.reserve({ kind: "recovery", role: "scout", readOnly: true }).code, "recovery-budget");
      const snap = reg.snapshot();
      assert.equal(snap.usage.recoveryUsed, 2);
      assert.equal(snap.usage.total, 0, "recovery never draws on the discretionary budget");
      assert.equal(reg.reserve({ kind: "discretionary", role: "scout", scout: true }).code, "tier", "E1 still cannot delegate by other means");
    } finally { w.cleanup(); }
  },

  "concurrent processes cannot overdraw a shared ledger (atomic reservations)": async () => {
    const w = world();
    try {
      const file = path.join(w.agent, "race.json");
      const limits = { maxConcurrent: 4, maxTotal: 8, maxScouts: 2 };
      ledgerMod.createLedger(file, { scope: "race", tier: "thorough", limits, recovery: { maxInvocations: 2, maxConcurrent: 1, roles: ["scout"] }, sessionTotalBefore: 0, sessionCeiling: 64, mandatoryMax: 6 });
      const runs = await raceReserves(file, limits, 8);
      const all = runs.flat();
      assert.equal(all.filter((x) => x === "ok").length, 4, `only maxConcurrent (4) slots can be live at once: ${all.join(",")}`);
      const data = ledgerMod.readLedger(file);
      assert.equal(data.total, 4);
      assert.ok(data.live.length <= 4);
      assert.ok(all.every((x) => x === "ok" || x === "concurrency" || x === "total"));
    } finally { w.cleanup(); }
  },

  "a stale lock left by a crashed holder is broken safely: racing waiters cannot both win, and a release never removes someone else's lock": async () => {
    const w = world();
    try {
      const old = (file) => { const t = new Date(Date.now() - 60_000); fs.utimesSync(file, t, t); };
      // (a) A stale lock is broken and the section runs; the lock is gone afterwards.
      const solo = path.join(w.agent, "stale-solo.json");
      fs.writeFileSync(`${solo}.lock`, "999999\n"); old(`${solo}.lock`);
      assert.equal(ledgerMod.withLock(solo, () => "ran"), "ran");
      assert.equal(fs.existsSync(`${solo}.lock`), false);
      // (b) A break lock left by a crash is itself stale and does not wedge the ledger.
      fs.writeFileSync(`${solo}.lock`, "999999\n"); old(`${solo}.lock`);
      fs.writeFileSync(`${solo}.lock.break`, "999999\n"); old(`${solo}.lock.break`);
      assert.equal(ledgerMod.withLock(solo, () => "ran"), "ran");
      assert.equal(fs.existsSync(`${solo}.lock.break`), false, "the dead break lock was cleared");
      // (c) A release removes only its own lock: if a stall let someone else take over, theirs stays.
      const stolen = path.join(w.agent, "stolen.json");
      ledgerMod.withLock(stolen, () => { fs.writeFileSync(`${stolen}.lock`, "another-holder\n"); });
      assert.equal(fs.readFileSync(`${stolen}.lock`, "utf8"), "another-holder\n", "a lock that is no longer ours is left alone");
      fs.rmSync(`${stolen}.lock`);
      // (d) Many processes see the same stale lock at the same instant: still exactly maxConcurrent slots are granted.
      const file = path.join(w.agent, "stale-race.json");
      const limits = { maxConcurrent: 4, maxTotal: 8, maxScouts: 2 };
      ledgerMod.createLedger(file, { scope: "stale-race", tier: "thorough", limits, recovery: { maxInvocations: 2, maxConcurrent: 1, roles: ["scout"] }, sessionTotalBefore: 0, sessionCeiling: 64, mandatoryMax: 6 });
      fs.writeFileSync(`${file}.lock`, "999999\n"); old(`${file}.lock`);
      const runs = await raceReserves(file, limits, 12);
      const all = runs.flat();
      assert.equal(all.filter((x) => x === "ok").length, 4, `a stale lock must not let two waiters both in: ${all.filter((x) => x === "ok").length} granted`);
      assert.equal(ledgerMod.readLedger(file).total, 4);
      assert.equal(fs.existsSync(`${file}.lock`) || fs.existsSync(`${file}.lock.break`), false, "no lock is left behind");
    } finally { w.cleanup(); }
  },

  "dead children release their concurrency slot (charge stays); orphaned reservations expire": () => {
    const w = world();
    try {
      const file = path.join(w.agent, "reap.json");
      const limits = { maxConcurrent: 1, maxTotal: 5, maxScouts: 1 };
      ledgerMod.createLedger(file, { scope: "reap", tier: "standard", limits, recovery: { maxInvocations: 2, maxConcurrent: 1, roles: ["scout"] }, sessionTotalBefore: 0, sessionCeiling: 64, mandatoryMax: 6 });
      const req = { kind: "discretionary", role: "worker", requesterTier: "standard", requesterLimits: limits, requesterLabel: "E3 Standard" };
      const first = ledgerMod.reserve(file, req, 1_000);
      assert.equal(first.ok, true);
      assert.equal(ledgerMod.reserve(file, req, 2_000).code, "concurrency");
      ledgerMod.attach(file, first.id, 2 ** 22 - 3); // a pid that does not exist
      const after = ledgerMod.reserve(file, req, 3_000);
      assert.equal(after.ok, true, "a dead child's slot is reclaimed");
      assert.equal(ledgerMod.readLedger(file).total, 2, "but its charge was kept");
      // a reservation that never got a pid expires after two minutes
      assert.equal(ledgerMod.reserve(file, req, 4_000).code, "concurrency");
      assert.equal(ledgerMod.reserve(file, req, 4_000 + 130_000).ok, true);
    } finally { w.cleanup(); }
  },

  "E1 hides the model-launchable delegation tools (prompt overhead) and restores only its own removals": async () => {
    const w = world();
    try {
      const b = boot();
      const active = ["read", "bash", "edit", "write", "subagent", "workflow_run", "subagent_status", "subagent_stop"];
      const calls = [];
      let current = [...active];
      b.pi.api.getActiveTools = () => [...current];
      b.pi.api.setActiveTools = (names) => { calls.push(names); current = [...names]; };
      saveDefault("minimal");
      await b.start();
      await b.turn();
      assert.ok(!current.includes("subagent") && !current.includes("workflow_run"), "delegation tools are hidden at E1");
      assert.ok(current.includes("subagent_status") && current.includes("subagent_stop"), "the read/stop tools stay so running children can still be inspected and stopped");
      assert.equal(calls.length, 1);
      await b.turn(); // no change, no churn
      assert.equal(calls.length, 1, "setActiveTools is not called again when nothing changed");
      // a tool the operator removed on purpose is not brought back
      current = current.filter((t) => t !== "edit");
      await b.command("standard");
      await b.turn();
      assert.ok(current.includes("subagent") && current.includes("workflow_run"), "raising effort restores them at the next turn");
      assert.ok(!current.includes("edit"), "tools this extension did not remove stay removed");
      // recovery opens the delegation tools even at E1 (read-only scouts), then closes again
      await b.command("minimal");
      await b.turn();
      assert.ok(!current.includes("subagent"));
      b.registry().setRecoveryActive(true);
      assert.ok(current.includes("subagent"), "recovery makes the tool available");
      b.registry().setRecoveryActive(false);
      await b.turn();
      assert.ok(!current.includes("subagent"));
      // a pi without active-tool control is fine
      const bare = boot();
      delete bare.pi.api.getActiveTools;
      await bare.start();
      await bare.turn();
    } finally { w.cleanup(); }
  },

  "policy or ledger failures fail closed for delegation but never block mandatory verification": async () => {
    const w = world();
    try {
      const b = boot();
      await b.start();
      await b.turn();
      fs.rmSync(b.registry().snapshot().ledger, { force: true });
      const denied = b.registry().reserve({ kind: "discretionary", role: "worker" });
      assert.equal(denied.ok, false);
      assert.match(denied.code, /no-ledger/);
      assert.equal(b.registry().reserve({ kind: "mandatory", role: "reviewer" }).ok, true);
      // A broken policy directory: delegation refused with an explanation; the extension still loads.
      const broken = fs.mkdtempSync(path.join(os.tmpdir(), "pi-effort-policy-"));
      const restore = setEnv("PI_KIT_EFFORT_POLICY_DIR", broken);
      try {
        fs.writeFileSync(path.join(broken, "effort.json"), "{}");
        const nb = boot();
        await nb.start();
        const r = nb.registry().reserve({ kind: "discretionary", role: "worker" });
        assert.equal(r.ok, false);
        assert.equal(r.code, "no-policy");
        assert.equal(nb.registry().snapshot().healthy, false);
        assert.ok(nb.notes.some((n) => /could not be loaded/.test(n.m)));
      } finally { restore(); rmWorkspace(broken); }
    } finally { w.cleanup(); }
  },

  "shutdown removes the registry and listeners (no leaks)": async () => {
    const w = world();
    try {
      const b = boot();
      await b.start();
      const reg = b.registry();
      let calls = 0;
      reg.onChange(() => calls++);
      await b.turn();
      assert.ok(calls > 0);
      await b.pi.handlers.get("session_shutdown")();
      assert.equal(globalThis[REGISTRY_KEY], undefined);
      const before = calls;
      await b.turn().catch(() => {});
      assert.equal(calls, before, "no notifications after shutdown");
    } finally { w.cleanup(); }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${error?.stack || error}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`\n[effort-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[effort-smoke] all ${Object.keys(tests).length} checks passed`);
