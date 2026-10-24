#!/usr/bin/env node
/**
 * Effective auto-compaction state (session-helpers): computed from the REAL settings files with
 * pi's own semantics, published for the footer, and surfaced once per session when degraded.
 *
 * Ground truth for every expectation below is pi 0.85.1's source, not the kit's comments:
 *   - settings-manager.js: global < project deep merge; an untrusted project file is never read;
 *     compaction.enabled is `?? true` and tested for truthiness; reserve 16384, keepRecent 20000.
 *   - compaction.js shouldCompact: `enabled && tokens > window - reserveTokens`.
 *   - agent-session.js _checkCompaction: returns immediately when `!enabled`, so disabling
 *     auto-compaction ALSO disables overflow recovery (the kit's older docs claimed otherwise).
 *   - agent-session.js getContextUsage: undefined for an unknown window, tokens:null after a
 *     compaction until the next response - unknown must stay unknown.
 *
 * The last section installs each of the seven profiles with the REAL installer (fake `pi` on PATH,
 * throwaway agent dir) and computes the effective state from the settings the installer left
 * behind: the per-profile compaction table in the release report is what this prints.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import type { PublishedCompaction } from "../packages/extensions/src/session-helpers/index.ts";
import type * as SessionHelpers from "../packages/extensions/src/session-helpers/index.ts";
import type * as DelegationGuard from "../packages/extensions/src/delegation-guard/index.ts";
import { array, object, optional, parseJsonAs, string, union, unknownValue } from "../packages/core/lib/guard.ts";

type FakePi = ReturnType<typeof fakePi>;
// The extension factory is typed for pi's ExtensionAPI; this smoke drives it with the fake pi.
type SessionHelpersView = Omit<typeof SessionHelpers, "default"> & { default: (api: FakePi["api"]) => void };

interface Note {
  m: string;
  l: string;
}

interface ProfileRow {
  profile: string;
  trigger: boolean;
  custom: boolean;
  sieve: boolean;
  compress: boolean;
  threshold: number | null;
  native: number | null;
}

/** The installed settings fields this smoke reads back. */
const InstalledSettings = object({
  compaction: optional(unknownValue()),
  packages: array(union(string(), object({ source: string(), extensions: optional(array(string())) }))),
});

const restoreEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await loadModule<SessionHelpersView>("extensions/session-helpers/index.ts");
const { computeCompactionState, describeCompaction, COMPACTION_GLOBAL_KEY } = mod;
const published = (): PublishedCompaction => Reflect.get(globalThis, COMPACTION_GLOBAL_KEY) as PublishedCompaction;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A throwaway agent dir + project dir; settings are written by the caller.
function scene({ global, project }: { global?: unknown; project?: unknown } = {}) {
  const agent = tmp("pi-kit-cstate-agent-");
  const cwd = tmp("pi-kit-cstate-cwd-");
  if (global !== undefined) fs.writeFileSync(path.join(agent, "settings.json"), typeof global === "string" ? global : JSON.stringify(global));
  if (project !== undefined) {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), typeof project === "string" ? project : JSON.stringify(project));
  }
  const restore = setEnv("PI_CODING_AGENT_DIR", agent);
  return { agent, cwd, done: () => { restore(); rmWorkspace(agent); rmWorkspace(cwd); } };
}

function capture(stream: NodeJS.WriteStream) {
  const original = stream.write.bind(stream);
  const chunks: string[] = [];
  stream.write = (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { stream.write = original; } };
}

const tests: Record<string, () => void | Promise<void>> = {
  "defaults: enabled, pi's own reserve/keepRecent, threshold = window - reserve": () => {
    const s = scene();
    try {
      const st = computeCompactionState({ cwd: s.cwd, contextWindow: 200_000 });
      assert.equal(st.enabled, true);
      assert.equal(st.source, "default");
      assert.equal(st.reserveTokens, 16384);
      assert.equal(st.keepRecentTokens, 20000);
      assert.equal(st.nativeThresholdTokens, 200_000 - 16384);
      assert.equal(st.thresholdTokens, 183_616);
      assert.equal(st.reason, null);
    } finally { s.done(); }
  },

  "project settings override global field by field (pi's deep merge), and only when trusted": () => {
    const s = scene({ global: { compaction: { enabled: false, reserveTokens: 9000 } }, project: { compaction: { enabled: true } } });
    try {
      const st = computeCompactionState({ cwd: s.cwd, contextWindow: 100_000 });
      assert.equal(st.enabled, true, "the project's enabled:true wins");
      assert.equal(st.source, "project");
      assert.equal(st.reserveTokens, 9000, "reserveTokens is not set by the project, so the global value survives the merge");
      const untrusted = computeCompactionState({ cwd: s.cwd, contextWindow: 100_000, projectTrusted: false });
      assert.equal(untrusted.enabled, false, "an untrusted project's settings are ignored by pi, so global false applies");
      assert.equal(untrusted.source, "global");
      assert.ok(untrusted.notes.some((n: string) => /not trusted/.test(n)));
    } finally { s.done(); }
  },

  "a null project value overrides like pi's merge does ('?? true' then makes it enabled)": () => {
    const s = scene({ global: { compaction: { enabled: false } }, project: { compaction: { enabled: null } } });
    try {
      const st = computeCompactionState({ cwd: s.cwd, contextWindow: 100_000 });
      assert.equal(st.enabled, true);
    } finally { s.done(); }
  },

  "a settings file that does not parse is reported and pi's defaults apply": () => {
    const s = scene({ global: "{ broken" });
    try {
      const st = computeCompactionState({ cwd: s.cwd, contextWindow: 100_000 });
      assert.equal(st.enabled, true);
      assert.ok(st.notes.some((n: string) => /not valid JSON/.test(n)));
    } finally { s.done(); }
  },

  "disabled: reports WHY, no threshold, and that overflow recovery is off too": () => {
    const s = scene({ global: { compaction: { enabled: false } } });
    try {
      const st = computeCompactionState({ cwd: s.cwd, contextWindow: 200_000 });
      assert.equal(st.enabled, false);
      assert.equal(st.thresholdTokens, null);
      assert.equal(st.code, "disabled");
      assert.match(st.reason ?? "", /will not recover from a context overflow/);
      assert.match(st.reason ?? "", /settings\.json/);
      assert.match(describeCompaction(st), /overflow recovery: OFF/);
    } finally { s.done(); }
  },

  "an unknown context window is unknown, never 0": () => {
    const s = scene();
    try {
      const st = computeCompactionState({ cwd: s.cwd, contextWindow: 0 });
      assert.equal(st.contextWindow, null);
      assert.equal(st.nativeThresholdTokens, null);
      assert.equal(st.thresholdTokens, null);
      assert.equal(st.code, "window-unknown");
      assert.match(describeCompaction(st), /context window: unknown/);
      const noModel = computeCompactionState({ cwd: s.cwd });
      assert.equal(noModel.code, null, "no model yet is not a degraded state");
      assert.equal(noModel.thresholdTokens, null);
    } finally { s.done(); }
  },

  "a reserve that swallows a small window is flagged (pi would compact every turn)": () => {
    const s = scene();
    try {
      const small = computeCompactionState({ cwd: s.cwd, contextWindow: 16_384 });
      assert.equal(small.code, "reserve-exceeds-window");
      assert.match(small.reason ?? "", /almost every turn/);
      const tuned = scene({ global: { compaction: { reserveTokens: 2000, keepRecentTokens: 4000 } } });
      try {
        assert.equal(computeCompactionState({ cwd: tuned.cwd, contextWindow: 16_384 }).code, null, "a reserve sized for the window is healthy");
      } finally { tuned.done(); }
    } finally { s.done(); }
  },

  "the kit trigger lowers the earliest threshold only when it is below pi's own": () => {
    const s = scene();
    try {
      const big = computeCompactionState({ cwd: s.cwd, contextWindow: 1_300_000, kitTriggerLoaded: true });
      assert.equal(big.kitTrigger.effective, true);
      assert.equal(big.thresholdTokens, 100_000, "the 100k kit trigger fires long before pi's 1.28M");
      const small = computeCompactionState({ cwd: s.cwd, contextWindow: 110_000, kitTriggerLoaded: true });
      assert.equal(small.kitTrigger.effective, false, "pi's 93.6k trigger fires first, so the 100k kit trigger never does");
      assert.equal(small.thresholdTokens, 110_000 - 16384);
      const off = computeCompactionState({ cwd: s.cwd, contextWindow: 1_300_000, kitTriggerLoaded: false });
      assert.equal(off.thresholdTokens, 1_300_000 - 16384);
    } finally { s.done(); }
  },

  "session_start publishes {enabled, thresholdTokens, reason} and warns once per session": async () => {
    const s = scene({ global: { compaction: { enabled: false } } });
    const warned: Note[] = [];
    const err = capture(process.stderr);
    try {
      const pi = fakePi();
      mod.default(pi.api);
      const ctx = {
        cwd: s.cwd,
        hasUI: true,
        model: { provider: "p", id: "m", contextWindow: 200_000 },
        sessionManager: { getSessionId: () => "sess-once-1" },
        ui: { notify: (m: string, l: string) => warned.push({ m, l }) },
        isProjectTrusted: () => true,
      };
      await pi.handlers.get("session_start")({}, ctx);
      assert.deepEqual(Object.keys(published()).sort(), ["enabled", "reason", "thresholdTokens"], "the published shape is exactly these three keys");
      assert.equal(published().enabled, false);
      assert.equal(published().thresholdTokens, null);
      assert.match(published().reason ?? "", /OFF/);
      assert.equal(warned.length, 1, "one warning at session start");
      assert.ok(warned[0], "the session start warning was raised");
      assert.equal(warned[0].l, "warning");
      // Per-turn hooks and reloads of the same session do not repeat it.
      for (let i = 0; i < 5; i++) await pi.handlers.get("before_agent_start")({}, ctx);
      await pi.handlers.get("model_select")({}, ctx);
      await pi.handlers.get("session_start")({}, ctx);
      assert.equal(warned.length, 1, "still exactly one warning after 5 turns, a model change and a reload");
      // A different session warns again.
      await pi.handlers.get("session_start")({}, { ...ctx, sessionManager: { getSessionId: () => "sess-once-2" } });
      assert.equal(warned.length, 2);
      await pi.handlers.get("session_shutdown")({}, ctx);
      assert.deepEqual(published(), { enabled: null, thresholdTokens: null, reason: null }, "shutdown resets to unknown");
      assert.equal(err.chunks.join(""), "", "with a UI nothing goes to stderr");
    } finally { err.restore(); s.done(); }
  },

  "without a UI the degraded warning goes to stderr, once": async () => {
    const s = scene({ global: { compaction: { enabled: false } } });
    const err = capture(process.stderr);
    try {
      const pi = fakePi();
      mod.default(pi.api);
      const ctx = { cwd: s.cwd, hasUI: false, model: { contextWindow: 200_000 }, sessionManager: { getSessionId: () => "sess-stderr-1" }, ui: { notify() {} } };
      await pi.handlers.get("session_start")({}, ctx);
      await pi.handlers.get("before_agent_start")({}, ctx);
      await pi.handlers.get("before_agent_start")({}, ctx);
      const lines = err.chunks.join("").split("\n").filter(Boolean);
      assert.equal(lines.length, 1);
      assert.ok(lines[0], "the warning line was written");
      assert.match(lines[0], /^\[pi-kit\] compaction: pi auto-compaction is OFF/);
    } finally { err.restore(); s.done(); }
  },

  "a healthy session publishes reason null and stays silent": async () => {
    const s = scene();
    const notes: string[] = [];
    try {
      const pi = fakePi();
      mod.default(pi.api);
      const ctx = { cwd: s.cwd, hasUI: true, model: { contextWindow: 200_000 }, sessionManager: { getSessionId: () => "sess-healthy" }, ui: { notify: (m: string) => notes.push(m) } };
      await pi.handlers.get("session_start")({}, ctx);
      assert.deepEqual(published(), { enabled: true, thresholdTokens: 183_616, reason: null });
      assert.equal(notes.length, 0);
    } finally { s.done(); }
  },

  "a mid-session change to settings.json is picked up by the next turn": async () => {
    const s = scene();
    const notes: string[] = [];
    try {
      const pi = fakePi();
      mod.default(pi.api);
      const ctx = { cwd: s.cwd, hasUI: true, model: { contextWindow: 200_000 }, sessionManager: { getSessionId: () => "sess-mid" }, ui: { notify: (m: string) => notes.push(m) } };
      await pi.handlers.get("session_start")({}, ctx);
      assert.equal(published().enabled, true);
      fs.writeFileSync(path.join(s.agent, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
      await pi.handlers.get("before_agent_start")({}, ctx);
      assert.equal(published().enabled, false);
      assert.equal(notes.length, 1, "the change is announced once");
    } finally { s.done(); }
  },

  "/compaction status prints state, threshold and reason (stderr when there is no UI)": async () => {
    const s = scene({ global: { compaction: { enabled: false } } });
    const err = capture(process.stderr);
    try {
      const pi = fakePi();
      mod.default(pi.api);
      const handler = pi.commands.get("compaction").handler;
      await handler("status", { cwd: s.cwd, hasUI: false, model: { contextWindow: 200_000 }, ui: { notify() {} } });
      const text = err.chunks.join("");
      assert.match(text, /Auto-compaction \(pi\): OFF/);
      assert.match(text, /WARNING: pi auto-compaction is OFF/);
      assert.match(text, /Earliest automatic trigger: none/);
    } finally { err.restore(); s.done(); }
  },

  "/compaction off warns about overflow recovery, persists, and the reload does not warn again": async () => {
    const s = scene({ global: { theme: "t", compaction: { enabled: true, reserveTokens: 9000 } } });
    const notes: Note[] = [];
    try {
      const pi = fakePi();
      mod.default(pi.api);
      let reloads = 0;
      const ctx = {
        cwd: s.cwd, hasUI: true, model: { contextWindow: 200_000 }, sessionManager: { getSessionId: () => "sess-off" },
        ui: { notify: (m: string, l: string) => notes.push({ m, l }), select: async () => undefined },
        reload: async () => { reloads++; },
      };
      await pi.commands.get("compaction").handler("off", ctx);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.agent, "settings.json"), "utf8")), { theme: "t", compaction: { enabled: false, reserveTokens: 9000 } });
      assert.equal(reloads, 1);
      assert.ok(notes[0], "/compaction off raised a notice");
      assert.match(notes[0].m, /stops recovering from a context overflow/);
      assert.equal(notes[0].l, "warning");
      // What the new instance does after the reload:
      const pi2 = fakePi();
      mod.default(pi2.api);
      await pi2.handlers.get("session_start")({}, ctx);
      assert.equal(notes.length, 1, "the session_start after /compaction off must not repeat the warning");
      assert.equal(published().enabled, false);
    } finally { s.done(); }
  },

  "/compaction rejects unknown options without touching settings": async () => {
    const s = scene({ global: { compaction: { enabled: true } } });
    const notes: Note[] = [];
    try {
      const pi = fakePi();
      mod.default(pi.api);
      const before = fs.readFileSync(path.join(s.agent, "settings.json"));
      await pi.commands.get("compaction").handler("nonsense", { cwd: s.cwd, hasUI: true, ui: { notify: (m: string, l: string) => notes.push({ m, l }) }, reload: async () => { throw new Error("must not reload"); } });
      assert.ok(notes[0], "an unknown option raised a notice");
      assert.equal(notes[0].l, "error");
      assert.deepEqual(fs.readFileSync(path.join(s.agent, "settings.json")), before);
    } finally { s.done(); }
  },
};

// --- child sessions ---------------------------------------------------------------------------------
// A subagent child is `pi --mode json -p --no-session --no-extensions -e <allowlist>` (delegation-guard's). It reads the same
// global settings (PI_CODING_AGENT_DIR is inherited) and its own cwd's project settings, so pi's native
// compaction is exactly as effective there as in the parent - including being OFF when the parent is off.
// The kit's fixed trigger is NOT in the allowlist (and would abort a one-shot run if it were), so children
// rely on pi's own in-run compaction; finish-reason-retry IS in it, which is what explains an exhausted window.
tests["subagent children: compaction is pi's native one, and finish-reason-retry (not trigger-compact) is loaded"] = async () => {
  // The child allowlist is the guard's: governance first, then these companions.
  const guard = await loadModule<typeof DelegationGuard>("extensions/delegation-guard/index.ts");
  const mandatory: readonly string[] = guard.MANDATORY_PROTECTIONS;
  assert.ok(guard.DEFAULT_COMPANIONS.includes("finish-reason-retry"));
  for (const name of ["trigger-compact", "custom-compaction", "context-sieve", "compress", "session-helpers"]) {
    assert.ok(!guard.DEFAULT_COMPANIONS.includes(name), `${name} is not loaded in a child`);
    assert.ok(!mandatory.includes(name), `${name} is not a governance extension`);
  }
  const s = scene({ global: { compaction: { enabled: false } } });
  try {
    // The child computes its state from the same files: off in the parent means off in the child.
    const st = computeCompactionState({ cwd: s.cwd, contextWindow: 128_000 });
    assert.equal(st.enabled, false);
    assert.match(st.reason ?? "", /Subagents and other child sessions inherit this/);
  } finally { s.done(); }
};

// --- per-profile: install with the real installer, then compute the effective state -----------------
function installProfile(profile: string) {
  const dir = tmp("pi-kit-cstate-install-");
  const agent = path.join(dir, "agent");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [ROOT] }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_LEAN_CTX_BIN: path.join(dir, "no-lean-ctx"), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  const run = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "install.ts"), "--profile", profile, "--yes", "--settings-only", "--mode", "local", "--no-externals"], { cwd: dir, env, encoding: "utf8" });
  return { dir, agent, run };
}

const PROFILES = ["quick", "balanced", "long-horizon", "autonomous", "self-improving", "pentest", "lite"];
const rows: ProfileRow[] = [];
for (const profile of PROFILES) {
  tests[`profile ${profile}: after install.ts --profile ${profile}, pi's auto-compaction is ON and healthy`] = () => {
    const { dir, agent, run } = installProfile(profile);
    try {
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const settings = parseJsonAs(InstalledSettings, fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
      assert.equal(settings.compaction, undefined, "the installer never writes compaction settings: pi's defaults are in force");
      const entry = settings.packages.find((p) => (typeof p === "string" ? p : p.source) === ROOT);
      assert.ok(entry !== undefined, "the kit package entry must be in the installed settings");
      const extensions = typeof entry === "string" ? undefined : entry.extensions;
      const loaded = (extensions ?? []).map((e) => e.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1]);
      const restore = setEnv("PI_CODING_AGENT_DIR", agent);
      try {
        const st = computeCompactionState({ cwd: dir, contextWindow: 200_000, kitTriggerLoaded: loaded.includes("trigger-compact") });
        assert.equal(st.enabled, true);
        assert.equal(st.source, "default");
        assert.equal(st.reason, null);
        assert.equal(st.reserveTokens, 16384);
        assert.equal(st.kitTrigger.loaded, loaded.includes("trigger-compact"));
        rows.push({ profile, trigger: loaded.includes("trigger-compact"), custom: loaded.includes("custom-compaction"), sieve: loaded.includes("context-sieve"), compress: loaded.includes("compress"), threshold: st.thresholdTokens, native: st.nativeThresholdTokens });
      } finally { restore(); }
    } finally { rmWorkspace(dir); }
  };
}

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
  }
}
restoreEnv();
if (rows.length) {
  console.log("\nprofile          native  kit-trigger  earliest@200k  custom-compaction  context-sieve  compress");
  for (const r of rows) console.log(`${r.profile.padEnd(16)} ${String(r.native).padEnd(7)} ${String(r.trigger).padEnd(12)} ${String(r.threshold).padEnd(14)} ${String(r.custom).padEnd(18)} ${String(r.sieve).padEnd(14)} ${r.compress}`);
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`compaction-state-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`compaction-state-smoke: ${total}/${total} passed`);
