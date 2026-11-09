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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { evalCacheDir, fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { array, object, parseJsonAs, record, string, unknownValue } from "../packages/core/lib/guard.ts";
import { clampTier, loadEffortPolicy, mementoGenerations, normalizeTier, tierLimits, renderEffortPrompt, validateEffortPolicy, workflowLimits } from "../packages/core/lib/effort.ts";
import type * as EffortModule from "../packages/extensions/src/effort/index.ts";
import type * as LedgerModule from "../packages/extensions/src/effort/ledger.ts";
import type * as PolicyModule from "../packages/extensions/src/effort/policy.ts";
import type { EffortPolicy, TierLimits } from "../packages/extensions/src/effort/policy.ts";

type FakePi = ReturnType<typeof fakePi>;
/** The effort extension as these tests load it: its default export is registered on the fake pi API. */
type EffortView = Omit<typeof EffortModule, "default"> & { default: (api: FakePi["api"]) => void };
type LedgerInit = Parameters<typeof LedgerModule.createLedger>[1];
/**
 * The fixtures below create ledgers without `ceilings` and without the runtime-only `recovery.active`
 * (createLedger sets that itself), so they are typed against this narrower input.
 */
type FixtureLedgerInit = Omit<LedgerInit, "ceilings" | "recovery"> & { recovery: Omit<LedgerInit["recovery"], "active"> };
type LedgerView = Omit<typeof LedgerModule, "createLedger"> & { createLedger: (file: string, init: FixtureLedgerInit) => LedgerModule.LedgerData };
type Reservation = EffortModule.Reservation;
type Granted = Extract<Reservation, { ok: true }>;
type Denied = Extract<Reservation, { ok: false }>;

/** A reservation's denial code, or undefined when it was granted (what reading `.code` on it gives). */
function codeOf(r: { ok: true } | { ok: false; code: string }): string | undefined {
  return r.ok ? undefined : r.code;
}

/** Returns `value`, failing loudly when something the test relies on is absent. */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

/** The `default` saved in an effort.json, read back from disk (unchecked beyond being an object). */
function savedDefault(file: string): unknown {
  return parseJsonAs(object({ default: unknownValue() }), fs.readFileSync(file, "utf8"), file).default;
}

const restoreEnv = isolateKitEnv();
const mod: EffortView = await loadModule("extensions/effort/index.ts");
const policyMod: typeof PolicyModule = await loadModule("extensions/effort/policy.ts");
const ledgerMod: LedgerView = await loadModule("extensions/effort/ledger.ts");
const { default: effort, REGISTRY_KEY, readConfig, resolveEffective, saveDefault } = mod;
const corePolicy: EffortPolicy = loadEffortPolicy();
const rtPolicy = policyMod.loadPolicy();
const CACHE = evalCacheDir();

/**
 * Race `count` real processes, each making 12 reservations against one ledger file, and return what
 * every process was told. Each process reports ready, waits for one go signal, and keeps its slots (its
 * pid stays alive) until all of them have finished reserving. That guarantees they overlap and contend
 * at once however slowly each one starts. A fixed time barrier did not: on a throttled CI container the
 * children started apart, early ones exited and freed their slots, and more reservations succeeded than
 * the concurrency limit allows.
 */
async function raceReserves(file: string, limits: TierLimits, count: number): Promise<string[][]> {
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
    const closed = new Promise<void>((resolve, reject) => p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`race child exited ${code}`)))));
    closed.catch(() => {});
    return { p, lines, closed };
  });
  const next = async (k: (typeof kids)[number]): Promise<string> => {
    const r = await Promise.race([k.lines.next(), k.closed.then((): { done: true } => ({ done: true }))]);
    if (r.done) throw new Error("race child ended before reporting");
    return r.value;
  };
  try {
    for (const k of kids) assert.equal(await next(k), "ready");
    for (const k of kids) k.p.stdin.write("go\n");
    const runs = await Promise.all(kids.map(async (k) => parseJsonAs(array(string()), await next(k))));
    for (const k of kids) k.p.stdin.end();
    await Promise.all(kids.map((k) => k.closed));
    return runs;
  } finally {
    for (const k of kids) k.p.kill();
  }
}

interface Note {
  m: string;
  l: string | undefined;
}

interface EffortCtx {
  hasUI: boolean;
  cwd: string;
  ui: {
    notify: (m: string, l?: string) => number;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    setStatus: () => void;
  };
  sessionManager: { getSessionId: () => string };
}

/** The fake pi API with its active-tool control optional, as a pi without that control would have it. */
type ToolControlApi = Omit<FakePi["api"], "getActiveTools"> & {
  getActiveTools?: () => string[];
  setActiveTools?: (names: string[]) => void;
};

function world(env: Record<string, string> = {}) {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-effort-"));
  const restores = [setEnv("PI_CODING_AGENT_DIR", agent), ...Object.entries(env).map(([k, v]) => setEnv(k, v))];
  return { agent, cleanup: () => { restores.reverse().forEach((r) => r()); rmWorkspace(agent); } };
}

function boot({ hasUI = true }: { hasUI?: boolean } = {}) {
  const pi = fakePi();
  effort(pi.api);
  const notes: Note[] = [];
  const ctx: EffortCtx = { hasUI, cwd: process.cwd(), ui: { notify: (m, l) => notes.push({ m, l }), select: async (_t, opts) => opts[2], setStatus() {} }, sessionManager: { getSessionId: () => "sess1" } };
  const registry = (): EffortModule.EffortRegistry => (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as EffortModule.EffortRegistry;
  return { pi, ctx, notes, registry, start: async (reason = "startup"): Promise<unknown> => pi.handlers.get("session_start")({ reason }, ctx), turn: async (prompt = "BASE"): Promise<{ systemPrompt: string }> => (await pi.handlers.get("before_agent_start")({ systemPrompt: prompt }, ctx)) as { systemPrompt: string }, command: (args: string): Promise<unknown> => pi.commands.get("effort").handler(args, ctx) };
}

const tests: Record<string, () => void | Promise<void>> = {
  "the tier table matches the specification and validates": () => {
    assert.deepEqual(validateEffortPolicy(corePolicy), []);
    const table = corePolicy.tiers.map((t) => [t.id, t.code, t.limits.maxConcurrent, t.limits.maxTotal, t.limits.maxScouts]);
    assert.deepEqual(table, [["minimal", "E1", 0, 0, 0], ["focused", "E2", 1, 1, 1], ["standard", "E3", 2, 3, 1], ["thorough", "E4", 4, 8, 2], ["exhaustive", "E5", 6, 16, 3]]);
    assert.equal(corePolicy.default, "standard");
    const broken = structuredClone(corePolicy);
    present(broken.tiers[2], "tier 3").limits.maxTotal = 0; // below the previous tier
    present(broken.tiers[1], "tier 2").limits.maxScouts = 5; // scouts exceed the shared total
    assert.ok(validateEffortPolicy(broken).length >= 2, "a broken policy is rejected");
  },

  // PRO-11: the runtime loader types what it validated. A tier without aliases loads with none (as
  // the toolchain's schema defaults them), so normalizeTier keeps its never-throws promise, and
  // non-string aliases or a missing label are refused.
  "the runtime loader defaults missing aliases and refuses misshapen tiers": () => {
    const src = policyMod.policyDir();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-effort-shape-"));
    try {
      for (const file of fs.readdirSync(src)) fs.copyFileSync(path.join(src, file), path.join(dir, file));
      const raw = fs.readFileSync(path.join(src, "effort.json"), "utf8");
      const write = (edit: (tiers: Record<string, unknown>[]) => void): void => {
        const doc = parseJsonAs(record(unknownValue()), raw);
        const tiers = array(record(unknownValue())).parse(doc.tiers);
        edit(tiers);
        doc.tiers = tiers;
        fs.writeFileSync(path.join(dir, "effort.json"), JSON.stringify(doc));
      };
      write((tiers) => { for (const tier of tiers) delete tier.aliases; });
      const loaded = policyMod.loadPolicy(dir);
      assert.equal(policyMod.normalizeTier(loaded, "no-such-tier"), null, "an unknown name is null, not a TypeError");
      assert.equal(policyMod.normalizeTier(loaded, "E2"), "focused");
      write((tiers) => { if (tiers[0]) tiers[0].aliases = [1]; });
      assert.throws(() => policyMod.loadPolicy(dir), /tiers\[0\]\.aliases/);
      write((tiers) => { if (tiers[1]) delete tiers[1].label; });
      assert.throws(() => policyMod.loadPolicy(dir), /tiers\[1\]\.label/);
    } finally { rmWorkspace(dir); }
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

  // S5: the workflow launch kind's limits live in effort.json and both loaders read them alike.
  "the runtime and toolchain implementations agree on the workflow limits (16 / 1000 / 2000) and refuse the same bad blocks": () => {
    const expected = { workflowConcurrent: 16, workflowTotalPerRun: 1000, workflowSessionTotal: 2000 };
    assert.deepEqual(workflowLimits(corePolicy), expected);
    assert.deepEqual(policyMod.workflowLimits(rtPolicy), expected);
    const dir = policyMod.policyDir();
    const workflowProblems = (problems: string[]): string[] => problems.filter((p) => p.startsWith("workflow"));
    const bad: unknown[] = [undefined, null, [], {}, { ...expected, workflowConcurrent: 0 }, { ...expected, workflowTotalPerRun: 1.5 }, { ...expected, workflowSessionTotal: "2000" }, { ...expected, workflowConcurrent: 1001 }, { ...expected, workflowTotalPerRun: 2001 }];
    for (const block of bad) {
      const policy = { ...structuredClone(corePolicy), workflow: block };
      const core = workflowProblems(validateEffortPolicy(policy));
      assert.ok(core.length > 0, `core refuses ${JSON.stringify(block)}`);
      assert.deepEqual(workflowProblems(policyMod.validatePolicy(policy, dir)), core, `runtime agrees on ${JSON.stringify(block)}`);
    }
    assert.deepEqual(workflowProblems(policyMod.validatePolicy({ ...structuredClone(corePolicy), workflow: { workflowConcurrent: 1, workflowTotalPerRun: 1, workflowSessionTotal: 1 } }, dir)), []);
  },

  // M4: every tier carries a Memento allowance (E1-E3 none, E4 2, E5 4), and both validators refuse the same bad values.
  // The tier's plan allowance: validated and monotonic the same way in both validators.
  "the runtime and toolchain implementations agree on workflowAgents (0/1/8/16/64) and refuse the same bad values": () => {
    const expected = [0, 1, 8, 16, 64];
    assert.deepEqual(corePolicy.tiers.map((t) => t.workflowAgents), expected);
    assert.deepEqual(rtPolicy.tiers.map((t) => t.workflowAgents), expected);
    assert.deepEqual(rtPolicy.tiers.map((t) => policyMod.workflowAllowance(rtPolicy, t.id)), expected);
    assert.equal(policyMod.workflowAllowance(rtPolicy, "standard", { standard: { maxTotal: 0 } }), 0, "a tier the operator set to no delegation plans nothing");
    assert.equal(policyMod.workflowAllowance(rtPolicy, "standard", { standard: { maxTotal: 1 } }), 1, "an operator's lower limit lowers the allowance");
    assert.equal(policyMod.workflowAllowance(rtPolicy, "standard", { standard: { maxTotal: 20 } }), 8, "an operator's higher limit never raises it");
    assert.equal(policyMod.workflowAllowance(rtPolicy, "minimal", { minimal: { maxTotal: 2 } }), 0, "nor does one lift a tier that plans nothing");
    assert.equal(policyMod.workflowAllowance(rtPolicy, "standard", { thorough: { maxTotal: 1 } }), 8, "another tier's limit does not apply");
    const dir = policyMod.policyDir();
    const allowanceProblems = (problems: string[]): string[] => problems.filter((p) => p.includes("workflowAgents"));
    const withTier = (index: number, workflowAgents: unknown): unknown => {
      const policy = structuredClone(corePolicy);
      const tiers: unknown[] = policy.tiers.map((t, i) => (i === index ? { ...t, workflowAgents } : t));
      return { ...policy, tiers };
    };
    for (const policy of [withTier(2, -1), withTier(2, 1.5), withTier(2, "8"), withTier(2, 0), withTier(4, 15)]) {
      const core = allowanceProblems(validateEffortPolicy(policy));
      assert.ok(core.length > 0, `core refuses ${JSON.stringify(policy).slice(0, 80)}`);
      assert.deepEqual(allowanceProblems(policyMod.validatePolicy(policy, dir)), core, "runtime agrees");
    }
  },

  // A policy directory written before workflowAgents existed still loads. The toolchain stays strict:
  // it checks the shipped policy, which must carry the field.
  "a custom policy with no workflowAgents plans nothing at that tier, and still loads": () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-effort-policy-"));
    try {
      const src = policyMod.policyDir();
      fs.cpSync(src, dir, { recursive: true });
      const doc = structuredClone(corePolicy);
      const strip = (renamed: string | null, def = doc.default): unknown => ({
        ...doc,
        default: def,
        tiers: doc.tiers.map((t, i) => {
          const { workflowAgents: _dropped, ...rest } = t;
          return i === 2 && renamed ? { ...rest, id: renamed } : rest;
        }),
      });
      const load = (value: unknown): EffortPolicy => {
        fs.writeFileSync(path.join(dir, "effort.json"), JSON.stringify(value));
        return policyMod.loadPolicy(dir);
      };
      assert.deepEqual(load(strip(null)).tiers.map((t) => t.workflowAgents), [0, 0, 0, 0, 0], "a missing allowance is 0, so an older policy widens nothing");
      assert.deepEqual(load(strip("middling", "middling")).tiers.map((t) => t.workflowAgents), [0, 0, 0, 0, 0], "a renamed tier is no load problem either");
      const invalid = structuredClone(corePolicy);
      const bad: unknown = { ...invalid, tiers: invalid.tiers.map((t, i) => (i === 2 ? { ...t, workflowAgents: null } : t)) };
      assert.throws(() => load(bad), /tiers\[2\]\.workflowAgents must be a non-negative integer/, "a value that is present is still checked");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "the runtime and toolchain implementations agree on memento.maxGenerations (0/0/0/2/4) and refuse the same bad values": () => {
    const expected = [0, 0, 0, 2, 4];
    assert.deepEqual(corePolicy.tiers.map((t) => mementoGenerations(t.id, corePolicy)), expected);
    assert.deepEqual(rtPolicy.tiers.map((t) => policyMod.mementoGenerations(rtPolicy, t.id)), expected);
    assert.equal(corePolicy.memento.maxGenerationsCeiling, 8);
    assert.equal(rtPolicy.memento.maxGenerationsCeiling, 8);
    assert.equal(policyMod.mementoGenerations(rtPolicy, "no-such-tier"), mementoGenerations("no-such-tier", corePolicy), "an unknown tier reads the default tier's allowance");
    const dir = policyMod.policyDir();
    const mementoProblems = (problems: string[]): string[] => problems.filter((p) => p.includes("memento"));
    const withTier = (index: number, memento: unknown): unknown => {
      const policy = structuredClone(corePolicy);
      const tiers: unknown[] = policy.tiers.map((t, i) => (i === index ? { ...t, memento } : t));
      return { ...policy, tiers };
    };
    const bad: unknown[] = [
      withTier(4, undefined), withTier(4, {}), withTier(4, { maxGenerations: -1 }), withTier(4, { maxGenerations: 1.5 }), withTier(4, { maxGenerations: "4" }),
      withTier(4, { maxGenerations: 9 }), withTier(4, { maxGenerations: 1 }), withTier(0, { maxGenerations: 1 }),
      { ...structuredClone(corePolicy), memento: undefined }, { ...structuredClone(corePolicy), memento: { maxGenerationsCeiling: 0 } }, { ...structuredClone(corePolicy), memento: { maxGenerationsCeiling: 3 } },
    ];
    for (const policy of bad) {
      const core = mementoProblems(validateEffortPolicy(policy));
      assert.ok(core.length > 0, `core refuses ${JSON.stringify(policy).slice(0, 80)}`);
      assert.deepEqual(mementoProblems(policyMod.validatePolicy(policy, dir)), core, "runtime agrees");
    }
    assert.deepEqual(mementoProblems(validateEffortPolicy(withTier(4, { maxGenerations: 8 }))), [], "the ceiling itself is allowed");
    assert.deepEqual(mementoProblems(policyMod.validatePolicy(withTier(4, { maxGenerations: 8 }), dir)), []);
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
      assert.equal(savedDefault(path.join(w.agent, "pi-kit", "effort.json")), "thorough", "canonical id persisted, not the alias");
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
      assert.ok(present(b.notes.at(-1), "last notification").m.includes("Applies from your next message"));
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
    assert.match(present(bad.warnings[0], "the invalid-pin warning"), /PI_KIT_EFFORT="turbo"/);
    const badCap = resolveEffective(rtPolicy, { PI_KIT_EFFORT_CAP: "unbounded" }, cfg);
    assert.equal(badCap.tier, "minimal", "an invalid cap fails closed to the lowest tier");
    function pick(r: ReturnType<typeof resolveEffective>) { return { tier: r.tier, source: r.source, pinned: r.pinned }; }
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
      assert.equal(savedDefault(path.join(w.agent, "pi-kit", "effort.json")), "exhaustive", "the default is still saved for later sessions");
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
      assert.match(present(b.notes[0], "the first note").m, /Nothing was changed/);
      // cancelled picker
      b.ctx.ui.select = async () => undefined;
      await b.command("");
      assert.ok(!fs.existsSync(file));
      // a picker choice
      b.ctx.ui.select = async (_t, opts) => opts[3];
      await b.command("");
      assert.equal(savedDefault(file), "thorough");
      // headless: text on stderr, no exception
      const h = boot({ hasUI: false });
      const written: string[] = [];
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
      for (const text of ["{ not json", "[]", JSON.stringify({ default: "ultra", limits: { standard: { maxTotal: -3, maxScouts: "many" }, nope: { maxTotal: 1 } } }), JSON.stringify({ default: { toString: 1 } })]) {
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
        const held: Granted[] = [];
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
        const scouts: Reservation[] = [];
        for (let i = 0; i < L.maxScouts + 1; i++) scouts.push(b.registry().reserve({ kind: "discretionary", role: "scout", scout: true }));
        assert.equal(scouts.filter((s) => s.ok).length, Math.min(L.maxScouts, L.maxConcurrent), `${tier.id}: scouts limited (${scouts.map((s) => codeOf(s) ?? "ok").join(",")})`);
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
      let denied: Denied | null = null;
      for (let turn = 0; turn < 8 && !denied; turn++) {
        await b.turn();
        for (let i = 0; i < 16 && !denied; i++) {
          const r = b.registry().reserve({ kind: "discretionary", role: "worker" });
          if (r.ok) { started++; r.settle("ok"); } else denied = r;
        }
      }
      assert.equal(started, rtPolicy.ceilings.maxTotal, "the platform ceiling caps a whole session");
      assert.equal(present(denied, "a denial").code, "session-ceiling");
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
      assert.ok(fs.existsSync(present(r.env.PI_KIT_EFFORT_LEDGER, "PI_KIT_EFFORT_LEDGER")));
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
      assert.ok(file, "the session has a ledger file");
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
      assert.equal(codeOf(closed), "recovery-closed", "the model cannot open the recovery channel by asking");
      reg.setRecoveryActive(true, "progress-guard escalation");
      assert.equal(codeOf(reg.reserve({ kind: "recovery", role: "implementer", readOnly: false })), "recovery-role", "not a delegation bypass: only read-only roles");
      const one = reg.reserve({ kind: "recovery", role: "scout", readOnly: true });
      assert.equal(one.ok, true);
      assert.equal(codeOf(reg.reserve({ kind: "recovery", role: "scout", readOnly: true })), "recovery-budget", "one recovery child at a time");
      one.settle("ok");
      assert.equal(reg.reserve({ kind: "recovery", role: "scout", readOnly: true }).ok, true);
      assert.equal(codeOf(reg.reserve({ kind: "recovery", role: "scout", readOnly: true })), "recovery-budget");
      const snap = reg.snapshot();
      assert.equal(snap.usage.recoveryUsed, 2);
      assert.equal(snap.usage.total, 0, "recovery never draws on the discretionary budget");
      assert.equal(codeOf(reg.reserve({ kind: "discretionary", role: "scout", scout: true })), "tier", "E1 still cannot delegate by other means");
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
      const data = present(ledgerMod.readLedger(file), "ledger");
      assert.equal(data.total, 4);
      assert.ok(data.live.length <= 4);
      assert.ok(all.every((x) => x === "ok" || x === "concurrency" || x === "total"));
    } finally { w.cleanup(); }
  },

  // Run in a child: on a loop that never yields, this process would hang with it.
  "a stale lock that cannot be broken refuses within the lock wait, and never spins": () => {
    const w = world();
    try {
      const attempt = (file: string): { status: number | null; out: string } => {
        const script = `import(${JSON.stringify("file://" + path.join(CACHE, "packages_extensions_src_effort_ledger.mjs"))}).then((l) => { try { l.withLock(process.argv[1], () => {}); console.log("ran"); } catch (e) { console.log("threw: " + e.message); } });`;
        const r = spawnSync(process.execPath, ["-e", script, file], { encoding: "utf8", timeout: 7_000 });
        return { status: r.status, out: r.stdout };
      };
      const old = (file: string): void => { const t = new Date(Date.now() - 60_000); fs.utimesSync(file, t, t); };
      // (a) The break lock cannot be cleared (a directory stands in for a dead one on a read-only mount).
      const stuck = path.join(w.agent, "stuck.json");
      fs.writeFileSync(`${stuck}.lock`, "999999\n"); old(`${stuck}.lock`);
      fs.mkdirSync(`${stuck}.lock.break`); old(`${stuck}.lock.break`);
      const held = attempt(stuck);
      assert.equal(held.status, 0, "the wait ended by itself");
      assert.match(held.out, /threw: timed out waiting for the effort ledger lock/);
      // (b) The directory is read-only, so the break lock cannot be written (root ignores the mode).
      if (process.getuid?.() !== 0) {
        const dir = path.join(w.agent, "read-only");
        fs.mkdirSync(dir);
        const file = path.join(dir, "ledger.json");
        fs.writeFileSync(`${file}.lock`, "999999\n"); old(`${file}.lock`);
        fs.chmodSync(dir, 0o555);
        try {
          const denied = attempt(file);
          assert.equal(denied.status, 0, "the failure ended the wait");
          assert.match(denied.out, /threw: EACCES/);
        } finally { fs.chmodSync(dir, 0o755); }
      }
    } finally { w.cleanup(); }
  },

  "a stale lock left by a crashed holder is broken safely: racing waiters cannot both win, and a release never removes someone else's lock": async () => {
    const w = world();
    try {
      const old = (file: string): void => { const t = new Date(Date.now() - 60_000); fs.utimesSync(file, t, t); };
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
      assert.equal(present(ledgerMod.readLedger(file), "ledger").total, 4);
      assert.equal(fs.existsSync(`${file}.lock`) || fs.existsSync(`${file}.lock.break`), false, "no lock is left behind");
    } finally { w.cleanup(); }
  },

  "dead children release their concurrency slot (charge stays); orphaned reservations expire": () => {
    const w = world();
    try {
      const file = path.join(w.agent, "reap.json");
      const limits = { maxConcurrent: 1, maxTotal: 5, maxScouts: 1 };
      ledgerMod.createLedger(file, { scope: "reap", tier: "standard", limits, recovery: { maxInvocations: 2, maxConcurrent: 1, roles: ["scout"] }, sessionTotalBefore: 0, sessionCeiling: 64, mandatoryMax: 6 });
      const req: LedgerModule.ReserveRequest = { kind: "discretionary", role: "worker", requesterTier: "standard", requesterLimits: limits, requesterLabel: "E3 Standard" };
      const first = ledgerMod.reserve(file, req, 1_000);
      assert.equal(first.ok, true);
      assert.equal(codeOf(ledgerMod.reserve(file, req, 2_000)), "concurrency");
      ledgerMod.attach(file, first.id, 2 ** 22 - 3); // a pid that does not exist
      const after = ledgerMod.reserve(file, req, 3_000);
      assert.equal(after.ok, true, "a dead child's slot is reclaimed");
      assert.equal(present(ledgerMod.readLedger(file), "ledger").total, 2, "but its charge was kept");
      // a reservation that never got a pid expires after two minutes
      assert.equal(codeOf(ledgerMod.reserve(file, req, 4_000)), "concurrency");
      assert.equal(ledgerMod.reserve(file, req, 4_000 + 130_000).ok, true);
    } finally { w.cleanup(); }
  },

  "E1 hides the model-launchable delegation tools (prompt overhead) and restores only its own removals": async () => {
    const w = world();
    try {
      const b = boot();
      const active = ["read", "bash", "edit", "write", "subagent", "workflow_run", "workflow", "dual_review", "dispatch_specialist", "workflow_status", "workflow_control"];
      const calls: string[][] = [];
      let current = [...active];
      const api: ToolControlApi = b.pi.api;
      api.getActiveTools = () => [...current];
      api.setActiveTools = (names) => { calls.push(names); current = [...names]; };
      saveDefault("minimal");
      await b.start();
      await b.turn();
      assert.ok(!current.includes("subagent") && !current.includes("workflow_run") && !current.includes("workflow"), "delegation tools are hidden at E1");
      // Both can only be refused at E1, and a refused dispatch_specialist still spends an engagement slot.
      assert.ok(!current.includes("dual_review") && !current.includes("dispatch_specialist"), "dual_review and dispatch_specialist are hidden at E1");
      assert.ok(current.includes("workflow_status") && current.includes("workflow_control"), "the one read/stop pair stays so running children and runs can still be inspected and stopped");
      assert.equal(calls.length, 1);
      await b.turn(); // no change, no churn
      assert.equal(calls.length, 1, "setActiveTools is not called again when nothing changed");
      // a tool the operator removed on purpose is not brought back
      current = current.filter((t) => t !== "edit");
      await b.command("standard");
      await b.turn();
      assert.ok(current.includes("subagent") && current.includes("workflow_run") && current.includes("workflow") && current.includes("dual_review") && current.includes("dispatch_specialist"), "raising effort restores them at the next turn");
      assert.ok(!current.includes("edit"), "tools this extension did not remove stay removed");
      // recovery opens the delegation tools even at E1 (read-only scouts), then closes again. The
      // workflow tools stay hidden: at E1 openRunScope always refuses them, so showing them would only
      // ask the operator for approvals that end in that refusal.
      await b.command("minimal");
      await b.turn();
      assert.ok(!current.includes("subagent") && !current.includes("workflow"));
      b.registry().setRecoveryActive(true);
      assert.ok(current.includes("subagent"), "recovery makes the delegation tools available");
      assert.ok(!current.includes("workflow") && !current.includes("workflow_run"), "recovery does not bring back a tool the run scope always refuses at E1");
      b.registry().setRecoveryActive(false);
      await b.turn();
      assert.ok(!current.includes("subagent") && !current.includes("workflow"));
      // a pi without active-tool control is fine
      const bare = boot();
      const bareApi: ToolControlApi = bare.pi.api;
      delete bareApi.getActiveTools;
      await bare.start();
      await bare.turn();
    } finally { w.cleanup(); }
  },

  // S2: a script-workflow run scope is refused at E1, so E1 launches nothing even on a pi without
  // active-tool control. Recovery opens neither the tool nor the scope, and a user-typed
  // /workflow run is a "user" launch, which the tier does not bound.
  "E1 refuses a workflow run scope, and a user-directed workflow launch still works": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("minimal");
      await b.start();
      await b.turn();
      // The registry is per extension instance: keep this one, because booting another replaces the global.
      const reg = b.registry();
      const scope = reg.openRunScope("e1-run");
      assert.equal(scope.ok, false);
      assert.equal(scope.code, "tier");
      assert.match(scope.reason, /E1 Minimal does not delegate/);
      assert.match(scope.reason, /\/effort/);
      // A pi without active-tool control cannot hide the tool, so the scope refusal is the boundary.
      const bare = boot();
      const bareApi: ToolControlApi = bare.pi.api;
      delete bareApi.getActiveTools;
      delete bareApi.setActiveTools;
      saveDefault("minimal");
      await bare.start();
      await bare.turn();
      assert.equal(bare.registry().openRunScope("e1-bare").ok, false, "no active-tool control: the scope still refuses");
      // Recovery does not open a run scope at E1 either.
      reg.setRecoveryActive(true);
      assert.equal(reg.openRunScope("e1-recovery").ok, false, "recovery does not open a run scope at E1");
      reg.setRecoveryActive(false);
      // /workflow run is a user launch: it is not the agent's own initiative, so E1 allows it.
      const user = reg.reserve({ kind: "user", role: "worker" });
      assert.equal(user.ok, true, "a user-directed workflow launch is not blocked by the tier");
      // Raising effort opens a script-workflow run scope.
      await b.command("standard");
      await b.turn();
      assert.equal(reg.openRunScope("e3-run").ok, true);
    } finally { w.cleanup(); }
  },

  // N1, P3: a planned scope charges its worst case per user request, and the tier allowance caps the
  // run. A scope without `planned` (an approved script) is charged nothing and keeps totalPerRun.
  "a planned run scope charges the request and caps the run; a plain scope does neither": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("standard");
      await b.start();
      await b.turn();
      const reg = b.registry();
      const first = reg.openRunScope("plan-1", { planned: 5 });
      assert.ok(first.ok, "a plan within the allowance opens");
      assert.equal(first.maxConcurrent, 2, "the scope carries the tier's parallel limit");
      const over = reg.openRunScope("plan-2", { planned: 4 });
      assert.equal(codeOf(over), "plan-allowance", "5 + 4 is past E3's 8");
      assert.match(over.ok ? "" : over.reason, /\/effort/);
      assert.ok(reg.openRunScope("plan-2", { planned: 3 }).ok, "a refused plan charged nothing, and did not spend its run id");
      assert.equal(codeOf(reg.openRunScope("plan-3", { planned: 1 })), "plan-allowance", "the allowance is used up");
      assert.equal(codeOf(reg.openRunScope("plan-4", { planned: -1 })), "invalid", "a negative plan cannot refund the request");
      const script = reg.openRunScope("script-1");
      assert.ok(script.ok, "a scope with no plan is not charged, so the used-up allowance does not refuse it");
      const saved = present(ledgerMod.readLedger(first.ledger)?.workflow, "the workflow section");
      assert.equal(saved.runs["plan-1"]?.cap, 8);
      assert.equal(saved.runs["script-1"]?.cap, undefined, "cap applies only to planned scopes");
      assert.equal(saved.plannedUsed, 8);
      for (let i = 0; i < 8; i++) assert.equal(ledgerMod.reserve(first.ledger, { kind: "workflow", role: "worker", requesterTier: "standard", requesterLimits: { maxConcurrent: 2, maxTotal: 3, maxScouts: 1 }, requesterLabel: "E3", runId: "plan-1", runToken: first.runToken }, Date.now() + i, () => `a${String(i)}`).ok, true);
      const ninth = ledgerMod.reserve(first.ledger, { kind: "workflow", role: "worker", requesterTier: "standard", requesterLimits: { maxConcurrent: 2, maxTotal: 3, maxScouts: 1 }, requesterLabel: "E3", runId: "plan-1", runToken: first.runToken });
      assert.equal(codeOf(ninth), "total", "reserve holds a planned run to min(cap, totalPerRun)");
      assert.match(ninth.ok ? "" : ninth.reason, /limit \(8\)/);
      // A turn that is not the user's keeps the charge, a user turn renews it, and a reload changes nothing.
      const customTurn = async (customType: string): Promise<unknown> => b.pi.handlers.get("before_agent_start")({ systemPrompt: "", messageType: "custom", message: { customType, content: "done", display: true } }, b.ctx);
      await customTurn("luna-workflow-result");
      assert.equal(codeOf(reg.openRunScope("plan-5", { planned: 1 })), "plan-allowance", "a workflow's completion message does not refresh the allowance");
      await customTurn("another-extension");
      assert.equal(codeOf(reg.openRunScope("plan-5", { planned: 1 })), "plan-allowance", "nor does any other extension's custom message");
      await b.start("reload");
      await customTurn("luna-workflow-result");
      assert.equal(codeOf(reg.openRunScope("plan-6", { planned: 1 })), "plan-allowance", "nor does a reload");
      await b.pi.handlers.get("before_agent_start")({ systemPrompt: "", messageType: "user", prompt: "go" }, b.ctx);
      assert.ok(reg.openRunScope("plan-7", { planned: 8 }).ok, "a user turn renews it");
    } finally { w.cleanup(); }
  },

  // pi before 1.2.0 (the floor and a CI lane) reports no messageType, and starts this event only from a prompt.
  "a pi that reports no messageType renews the plan allowance on each prompt": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("standard");
      await b.start();
      await b.turn();
      const reg = b.registry();
      assert.ok(reg.openRunScope("floor-1", { planned: 8 }).ok, "the first request plans its allowance");
      assert.equal(codeOf(reg.openRunScope("floor-2", { planned: 1 })), "plan-allowance", "and it is used up");
      await b.turn();
      assert.ok(reg.openRunScope("floor-3", { planned: 8 }).ok, "the next prompt renews it");
    } finally { w.cleanup(); }
  },

  // An operator can raise a tier's maxTotal above a workflowAgents of 0. That tier delegates and runs an
  // approved script, which is charged nothing, and it plans nothing; a plan's refusal must say so.
  "a tier that delegates but plans nothing refuses only plans, and says why; maxTotal 0 refuses every scope": async () => {
    const w = world();
    try {
      fs.mkdirSync(path.join(w.agent, "pi-kit"), { recursive: true });
      fs.writeFileSync(path.join(w.agent, "pi-kit", "effort.json"), JSON.stringify({ default: "minimal", limits: { minimal: { maxTotal: 2 }, standard: { maxTotal: 0 } } }));
      const b = boot();
      await b.start();
      await b.turn();
      const reg = b.registry();
      const plan = reg.openRunScope("zero-plan", { planned: 1 });
      assert.equal(codeOf(plan), "plan-allowance");
      assert.doesNotMatch(plan.ok ? "" : plan.reason, /does not delegate/);
      assert.match(plan.ok ? "" : plan.reason, /E1 Minimal plans no workflow agents.*\/effort/);
      assert.ok(reg.openRunScope("zero-script").ok, "an approved script is charged nothing");
      await b.command("standard");
      await b.turn();
      for (const options of [{ planned: 1 }, undefined]) {
        const refused = reg.openRunScope("none", options);
        assert.equal(codeOf(refused), "tier");
        assert.match(refused.ok ? "" : refused.reason, /does not delegate/);
      }
    } finally { w.cleanup(); }
  },

  "an expansion's refusal says what would fit: some room, none in the request, or none left in this run": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("standard");
      await b.start();
      await b.turn();
      const run = b.registry().openRunScope("grow", { planned: 5 });
      assert.ok(run.ok, "a plan within the allowance opens");
      const charge = (planned: number) => ledgerMod.chargeRun(run.ledger, "grow", run.runToken, { planned, allowance: 8, label: "E3 Standard" });
      const room = charge(4);
      assert.equal(codeOf(room), "plan-allowance");
      assert.match(room.ok ? "" : room.reason, /up to 3 more agents would fit/);
      assert.ok(charge(3).ok, "a refused charge spent nothing, so the size it named fits");
      const spent = charge(1);
      assert.equal(codeOf(spent), "plan-allowance");
      assert.match(spent.ok ? "" : spent.reason, /no workflow of any size fits this request/);
      assert.match(spent.ok ? "" : spent.reason, /renews on the next user message/);
      for (let i = 0; i < 8; i++) assert.equal(ledgerMod.reserve(run.ledger, { kind: "workflow", role: "worker", requesterTier: "standard", requesterLimits: { maxConcurrent: 2, maxTotal: 3, maxScouts: 1 }, requesterLabel: "E3", runId: "grow", runToken: run.runToken }, Date.now() + i, () => `g${String(i)}`).ok, true);
      ledgerMod.resetPlanned(run.ledger);
      const full = charge(1);
      assert.equal(codeOf(full), "plan-allowance", "a renewed request does not lift the run's own cap");
      assert.match(full.ok ? "" : full.reason, /this run has started or planned 8 of its 8 agents, so it cannot expand; a new plan can still start up to 8/);
      assert.doesNotMatch(full.ok ? "" : full.reason, /no workflow of any size fits/, "a new workflow would fit, so this must not say none does");
    } finally { w.cleanup(); }
  },

  // Rank 57: a second process on the same session renews the allowance while this run is still going.
  "an expansion counts the run's unstarted planned agents after the allowance renews": async () => {
    const w = world();
    try {
      const b = boot();
      saveDefault("standard");
      await b.start();
      await b.turn();
      const run = b.registry().openRunScope("renewed", { planned: 6 });
      assert.ok(run.ok, "a plan within the allowance opens");
      for (let i = 0; i < 2; i++) assert.equal(ledgerMod.reserve(run.ledger, { kind: "workflow", role: "worker", requesterTier: "standard", requesterLimits: { maxConcurrent: 2, maxTotal: 3, maxScouts: 1 }, requesterLabel: "E3", runId: "renewed", runToken: run.runToken }, Date.now() + i, () => `r${String(i)}`).ok, true);
      ledgerMod.resetPlanned(run.ledger);
      const charge = (planned: number) => ledgerMod.chargeRun(run.ledger, "renewed", run.runToken, { planned, allowance: 8, label: "E3 Standard" });
      const over = charge(6);
      assert.equal(codeOf(over), "plan-allowance", "2 started, 4 still planned and 6 new is 12 against a cap of 8");
      assert.match(over.ok ? "" : over.reason, /up to 2 more agents would fit/);
      assert.ok(charge(2).ok, "the size it named fits");
    } finally { w.cleanup(); }
  },

  // E1 stays closed through the allowance key, and a tier the operator set to no delegation stays closed too.
  "an operator's maxTotal 0 refuses a run scope at any tier": async () => {
    const w = world();
    try {
      fs.mkdirSync(path.dirname(mod.configPath()), { recursive: true });
      fs.writeFileSync(mod.configPath(), JSON.stringify({ schemaVersion: 1, limits: { standard: { maxTotal: 0 } } }));
      const b = boot();
      await b.start();
      await b.turn();
      assert.equal(codeOf(b.registry().openRunScope("none")), "tier");
      assert.equal(codeOf(b.registry().openRunScope("none-plan", { planned: 1 })), "tier");
    } finally { w.cleanup(); }
  },

  "policy or ledger failures fail closed for delegation but never block mandatory verification": async () => {
    const w = world();
    try {
      const b = boot();
      await b.start();
      await b.turn();
      fs.rmSync(present(b.registry().snapshot().ledger, "ledger path"), { force: true });
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
      assert.equal((globalThis as Record<symbol, unknown>)[REGISTRY_KEY], undefined);
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
  } catch (error: unknown) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`\n[effort-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[effort-smoke] all ${Object.keys(tests).length} checks passed`);
