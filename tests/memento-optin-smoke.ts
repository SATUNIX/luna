#!/usr/bin/env node
/**
 * Memento opt-in (docs/effort.md, "Memento mode"): the per-model allow-list in
 * <agent dir>/pi-kit/autonomy.json is off by default, read with type guards only, clamped to the
 * tier's memento.maxGenerations, limited to the long-horizon and autonomous profiles, and switched
 * on only through `/effort memento on` and a No-first select (never headless, never in a child).
 *
 * Deterministic and offline: the effort extension runs against a fake pi API with a temp HOME and
 * PI_CODING_AGENT_DIR; the real ~/.pi is never read.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import type * as EffortModule from "../packages/extensions/src/effort/index.ts";
import type * as MementoModule from "../packages/extensions/src/effort/memento.ts";

type FakePi = ReturnType<typeof fakePi>;
type EffortView = Omit<typeof EffortModule, "default"> & { default: (api: FakePi["api"]) => void };

const restoreEnv = isolateKitEnv();
const mod: EffortView = await loadModule("extensions/effort/index.ts");
const memento: typeof MementoModule = await loadModule("extensions/effort/memento.ts");
const { readOptIn, writeOptIn, mementoAllowance, modelKey, installedProfile } = memento;

const MODEL = "openrouter/qwen/qwen3-coder";

function world(profile: string | null = "long-horizon") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memento-"));
  const agent = path.join(root, "agent");
  const cwd = path.join(root, "work");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  if (profile) fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile }));
  const restores = [setEnv("HOME", root), setEnv("PI_CODING_AGENT_DIR", agent)];
  const file = path.join(agent, "pi-kit", "autonomy.json");
  return { agent, cwd, file, cleanup: () => { restores.reverse().forEach((r) => r()); rmWorkspace(root); } };
}

interface Note { m: string; l: string | undefined }

/** Boot the extension; `answer` picks the select's reply from its options (undefined: Escape). */
async function boot(cwd: string, { hasUI = true, answer = (o: string[]): string | undefined => o[0], model = { provider: "openrouter", id: "qwen/qwen3-coder" } }: { hasUI?: boolean; answer?: (options: string[]) => string | undefined; model?: { provider: string; id: string } | null } = {}) {
  const pi = fakePi();
  mod.default(pi.api);
  const notes: Note[] = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const ctx = {
    hasUI,
    cwd,
    model: model ?? undefined,
    ui: {
      notify: (m: string, l?: string) => notes.push({ m, l }),
      select: async (title: string, options: string[]) => { selects.push({ title, options }); return answer(options); },
      setStatus() {},
    },
    sessionManager: { getSessionId: () => "memento1" },
  };
  await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
  const command = (args: string): Promise<unknown> => pi.commands.get("effort").handler(args, ctx);
  const last = (): string => notes.at(-1)?.m ?? "";
  return { notes, selects, command, last };
}

/** The models block of the file, read back without trusting its shape. */
function modelsOf(file: string): Record<string, unknown> {
  const raw = parseJson(fs.readFileSync(file, "utf8"));
  const block = isRecord(raw) && isRecord(raw.memento) ? raw.memento.models : undefined;
  return isRecord(block) ? block : {};
}

const yes = (options: string[]): string | undefined => options.find((o) => o.startsWith("Yes"));

const tests: Record<string, () => void | Promise<void>> = {
  "the opt-in file is off by default and read with type guards only": () => {
    const w = world();
    try {
      assert.deepEqual([...readOptIn(w.file).models], [], "a missing file opts nothing in");
      assert.deepEqual(readOptIn(w.file).warnings, [], "and is not a warning");
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      fs.writeFileSync(w.file, "{not json");
      assert.match(readOptIn(w.file).warnings.join(), /not valid JSON/);
      fs.writeFileSync(w.file, "[]");
      assert.match(readOptIn(w.file).warnings.join(), /not an object/);
      fs.writeFileSync(w.file, JSON.stringify({ memento: { models: [] } }));
      assert.match(readOptIn(w.file).warnings.join(), /memento\.models is not an object/);
      fs.writeFileSync(w.file, JSON.stringify({ memento: { models: {
        "a/one": { enabled: true },
        "a/two": { enabled: "true" },
        "a/three": { enabled: 1 },
        "a/four": {},
        "a/five": { enabled: false },
        "a/six": { enabled: true, maxGenerations: -1 },
        "a/seven": { enabled: true, maxGenerations: 3 },
        "no-slash": { enabled: true },
        "../x/y": { enabled: true },
        "a/../b": { enabled: true },
        ["__proto__"]: { enabled: true },
      } } }));
      const read = readOptIn(w.file);
      assert.deepEqual([...read.models].sort(), [["a/one", { maxGenerations: null }], ["a/seven", { maxGenerations: 3 }], ["a/six", { maxGenerations: null }]], "only an explicit enabled:true opts in");
      assert.match(read.warnings.join("\n"), /a\/six.*not a non-negative integer/);
      assert.match(read.warnings.join("\n"), /"no-slash"/);
      assert.equal(modelKey("openrouter", "qwen/qwen3-coder"), MODEL);
      assert.equal(modelKey(undefined, "x"), null);
      assert.equal(modelKey("bad provider", "x"), null);
    } finally { w.cleanup(); }
  },

  "the allowance is the tier's, lowered (never raised) by the model's own limit, and 0 outside the allowed profiles": () => {
    const on = { models: new Map([[MODEL, { maxGenerations: null }], ["a/low", { maxGenerations: 1 }], ["a/high", { maxGenerations: 7 }]]), warnings: [] };
    const off = { models: new Map(), warnings: [] };
    const allow = (tierMax: number, profile: string | null, model: string | null, optIn: MementoModule.OptIn = on): number => mementoAllowance({ tierMax, profile, model, optIn }).maxGenerations;
    assert.equal(allow(4, "long-horizon", MODEL), 4);
    assert.equal(allow(2, "autonomous", MODEL), 2);
    assert.equal(allow(4, "balanced", MODEL), 0, "a profile outside long-horizon and autonomous allows none");
    assert.equal(allow(4, null, MODEL), 0, "an unknown profile allows none");
    assert.equal(allow(4, "long-horizon", MODEL, off), 0, "a model not opted in gets none");
    assert.equal(allow(4, "long-horizon", null), 0, "no model gets none");
    assert.equal(allow(0, "long-horizon", MODEL), 0, "E1-E3 allow none");
    assert.equal(allow(4, "long-horizon", "a/low"), 1, "the model's own limit lowers the tier's");
    assert.equal(allow(4, "long-horizon", "a/high"), 4, "and never raises it");
    assert.match(mementoAllowance({ tierMax: 4, profile: "balanced", model: MODEL, optIn: on }).reason, /"balanced" profile does not allow/);
  },

  "the installed profile comes from the install marker, a project marker first": () => {
    const w = world("autonomous");
    try {
      assert.equal(installedProfile(w.cwd), "autonomous");
      fs.mkdirSync(path.join(w.cwd, ".pi"));
      fs.writeFileSync(path.join(w.cwd, ".pi", ".pi-kit.json"), JSON.stringify({ profile: "balanced" }));
      assert.equal(installedProfile(w.cwd), "balanced");
      fs.writeFileSync(path.join(w.cwd, ".pi", ".pi-kit.json"), JSON.stringify({ profile: 3 }));
      assert.equal(installedProfile(w.cwd), null, "a profile that is not a string reads as unknown");
    } finally { w.cleanup(); }
  },

  "/effort memento on asks a No-first select; No and Escape change nothing": async () => {
    const w = world();
    try {
      for (const answer of [(o: string[]) => o[0], () => undefined]) {
        const b = await boot(w.cwd, { answer });
        await b.command("memento on");
        const asked = b.selects.at(-1);
        assert.ok(asked, "a select was shown");
        assert.match(asked.options[0] ?? "", /^No, keep Memento mode off/, "the first (default) answer is No");
        assert.match(asked.options[1] ?? "", /^Yes, allow Memento mode for openrouter\/qwen\/qwen3-coder$/);
        assert.match(asked.title, /E4 2, E5 4/, "the select names what each tier would allow");
        assert.equal(fs.existsSync(w.file), false, "nothing was written");
        assert.match(b.last(), /stays off/);
      }
    } finally { w.cleanup(); }
  },

  "Yes opts the current model in (0600), keeps other keys, and status reports the allowance": async () => {
    const w = world();
    try {
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      fs.writeFileSync(w.file, JSON.stringify({ schemaVersion: 1, other: { keep: true }, memento: { models: { "a/b": { enabled: true } } } }));
      const b = await boot(w.cwd, { answer: yes });
      await b.command("memento status");
      assert.match(b.last(), /Memento mode \(generations\): 0 for the current model at E3 Standard \(openrouter\/qwen\/qwen3-coder is not opted in\)/);
      await b.command("memento on");
      assert.deepEqual(modelsOf(w.file), { "a/b": { enabled: true }, [MODEL]: { enabled: true } });
      const raw = parseJson(fs.readFileSync(w.file, "utf8"));
      assert.ok(isRecord(raw) && isRecord(raw.other) && raw.other.keep === true, "unrelated keys are kept");
      if (process.platform !== "win32") assert.equal(fs.statSync(w.file).mode & 0o777, 0o600);
      await b.command("thorough");
      await b.command("memento status");
      assert.match(b.last(), /0 for the current model at E3 Standard \(this effort tier allows no generations\)/, "a tier change applies from the next message");
      assert.match(b.last(), /tiers: E1 0, E2 0, E3 0, E4 2, E5 4/);
      assert.match(b.last(), /pi-autonomy reads the same allowance/);
      await b.command("memento on a/c --max 1");
      assert.deepEqual(modelsOf(w.file)["a/c"], { enabled: true, maxGenerations: 1 }, "a named model with its own limit");
    } finally { w.cleanup(); }
  },

  "status reads the tier in force: E4 allows 2 for an opted-in model": async () => {
    const w = world();
    try {
      writeOptIn(MODEL, { maxGenerations: null }, w.file);
      const b = await boot(w.cwd);
      await b.command("thorough");
      // The fake has no user turn: a second boot reads the saved default as the tier in force.
      const c = await boot(w.cwd);
      await c.command("memento");
      assert.match(c.last(), /2 for the current model at E4 Thorough \(openrouter\/qwen\/qwen3-coder is opted in; the tier allows 2\)/);
      assert.equal(b.selects.length + c.selects.length, 0, "status never asks");
    } finally { w.cleanup(); }
  },

  "switching on is refused headless, in a child, outside the allowed profiles, and for bad arguments": async () => {
    const w = world("balanced");
    try {
      let b = await boot(w.cwd, { answer: yes });
      await b.command("memento on");
      assert.match(b.last(), /only available in the long-horizon and autonomous profiles \(installed: balanced\)/);
      assert.equal(b.selects.length, 0, "no select outside the allowed profiles");
      fs.writeFileSync(path.join(w.agent, ".pi-kit.json"), JSON.stringify({ profile: "autonomous" }));
      const stderr = process.stderr.write.bind(process.stderr);
      const lines: string[] = [];
      process.stderr.write = (chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
      try {
        b = await boot(w.cwd, { hasUI: false, answer: yes });
        await b.command("memento on");
      } finally { process.stderr.write = stderr; }
      assert.match(lines.join(""), /needs a screen to confirm on/);
      b = await boot(w.cwd, { answer: yes });
      const restore = setEnv("PI_KIT_EFFORT_LEDGER", path.join(w.agent, "child-ledger.json"));
      try { await b.command("memento on"); } finally { restore(); }
      assert.match(b.last(), /only be switched on in the root session/);
      for (const args of ["memento on --max 9", "memento on --max x", "memento on not-a-model", "memento on a/b c/d", "memento off --max 1", "memento maybe"]) {
        await b.command(args);
        assert.equal(b.notes.at(-1)?.l, "error", `${args} is refused`);
      }
      b = await boot(w.cwd, { answer: yes, model: null });
      await b.command("memento on");
      assert.match(b.last(), /no model is selected/);
      assert.equal(fs.existsSync(w.file), false, "nothing was ever written");
      assert.equal(b.selects.length, 0);
    } finally { w.cleanup(); }
  },

  "an unreadable file is never overwritten; off opts out without asking, headless too": async () => {
    const w = world();
    try {
      fs.mkdirSync(path.dirname(w.file), { recursive: true });
      fs.writeFileSync(w.file, "{broken");
      let b = await boot(w.cwd, { answer: yes });
      await b.command("memento on");
      assert.match(b.last(), /not valid JSON; fix or remove it first/);
      assert.equal(fs.readFileSync(w.file, "utf8"), "{broken");
      fs.writeFileSync(w.file, JSON.stringify({ memento: { models: { [MODEL]: { enabled: true }, "a/b": { enabled: true } } } }));
      const stderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = (): boolean => true;
      try {
        b = await boot(w.cwd, { hasUI: false });
        await b.command("memento off");
      } finally { process.stderr.write = stderr; }
      assert.deepEqual(modelsOf(w.file), { "a/b": { enabled: true } });
      assert.equal(b.selects.length, 0, "opting out never asks");
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
  console.error(`\n[memento-optin-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[memento-optin-smoke] all ${Object.keys(tests).length} checks passed`);
