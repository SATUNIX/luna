#!/usr/bin/env node
/**
 * Status bar (custom-footer), behaviour only: cost provenance, session totals, commands (invalid
 * arguments never mutate; non-interactive sessions get text), and lifecycle (no ticker without a UI
 * or after a run, shutdown and reload leave nothing running, no subprocess or
 * disk read per render). Deterministic: pure rendering plus a fake pi API; no model runs.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { loadModule, loadExtension, fakePi, isolateKitEnv, setEnv, tmpWorkspace, rmWorkspace, textOf } from "../packages/core/eval/harness.ts";
import type { ExtensionFactory } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import type * as FooterIndex from "../packages/extensions/third_party/custom-footer/index.ts";
import type * as FooterData from "../packages/extensions/third_party/custom-footer/data.ts";
import type * as FooterRender from "../packages/extensions/third_party/custom-footer/render.ts";
import type * as SubagentLive from "../packages/extensions/third_party/subagent/live.ts";
import type { FooterState, Theme } from "../packages/extensions/third_party/custom-footer/render.ts";

// The footer's named exports as written; its default export is registered on the harness's fake pi API.
type FooterModule = Omit<typeof FooterIndex, "default"> & { default: ExtensionFactory };

interface FooterComponent {
  dispose(): void;
  render(width: number): string[];
}

type FooterFactory = (
  tui: { requestRender(): void },
  theme: Theme,
  data: { getExtensionStatuses(): Map<string, string>; onBranchChange(cb: () => void): () => void; getGitBranch(): string },
) => FooterComponent;

interface Note {
  m: string;
  l: string;
}

// Test hooks custom-footer attaches to the pi API it is registered on.
interface FooterDebug {
  tickerActive(): boolean;
  state: () => FooterState;
  workingText(now: number): string;
}

interface SubagentSnapshot {
  live: number;
  finished: number;
  failures: number;
}

interface SubagentRegistry {
  snapshot(): SubagentSnapshot;
}

const footerDebug = (api: object): FooterDebug => (api as { __footerDebug: FooterDebug }).__footerDebug;
// Extensions publish cross-extension registries on globalThis under Symbol.for keys.
const globalRegistry = globalThis as Record<symbol, unknown>;

const restoreEnv = isolateKitEnv();
const footer = await loadModule<FooterModule>("vendor/custom-footer/index.ts");
const dataMod = await loadModule<typeof FooterData>("vendor/custom-footer/data.ts");
const renderMod = await loadModule<typeof FooterRender>("vendor/custom-footer/render.ts");
const registerTodo = await loadExtension("vendor/todo/index.ts");
const plain: Theme = { fg: (_c, s) => s, bold: (s) => s };
const strip = (s: string): string => stripVTControlCharacters(s);

// The settings file read back: a JSON object, or the test fails.
const readSettings = (file: string): Record<string, unknown> => {
  const value = parseJson(fs.readFileSync(file, "utf8"));
  assert.ok(isRecord(value), `${file} holds a JSON object`);
  return value;
};

const tests = {
  sessionTotalsSumsAssistantUsageIncrementally() {
    const entry = (id: string, usage: object) => ({ id, type: "message", message: { role: "assistant", usage } });
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: "hi" } },
      entry("a1", { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 150, cost: { total: 0.2 } }),
      entry("a2", { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { total: 0.1 } }),
      { id: "a3", type: "message", message: { role: "assistant" } },
    ];
    const { totals, partial } = footer.sessionTotals(entries);
    assert.equal(totals.input, 150);
    assert.equal(totals.output, 60);
    assert.equal(totals.total, 220);
    assert.equal(Number(totals.cost.toFixed(2)), 0.3);
    assert.equal(partial, true, "a usage-less assistant message marks totals partial");
    // The cache only looks at new entries, and recomputes when the list is rewritten.
    const cache = footer.createTotalsCache();
    let seen = 0;
    const counted = new Proxy(entries.slice(0, 3), { get(t, k) { if (typeof k === "string" && /^\d+$/.test(k)) seen++; const value: unknown = Reflect.get(t, k); return value; } });
    cache.update(counted);
    const first = seen;
    const grown = [...entries.slice(0, 3), entry("a4", { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } })];
    const again = cache.update(grown);
    assert.equal(again.totals.input, 151);
    assert.ok(seen === first, "only the new entry was read on the second update");
    const rewritten = [entry("z1", { input: 7, output: 0, totalTokens: 7, cost: { total: 0 } })];
    assert.equal(cache.update(rewritten).totals.input, 7, "a fork/tree switch is recomputed from scratch");
    assert.equal(cache.update([]).totals.input, 0, "a shorter list resets");
  },

  costProvenance() {
    const totals = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, total: 1_500_000, cost: 0 };
    assert.deepEqual(dataMod.costOf(totals, { source: "unconfigured" }), { kind: "unknown" }, "no prices and nothing reported is unknown, not zero");
    assert.equal(dataMod.costOf({ ...totals, cost: 0.75 }, { source: "unconfigured" }).kind, "reported");
    const priced = dataMod.costOf(totals, { inputPerMTok: 2, outputPerMTok: 8, source: "costs.json" });
    assert.equal(priced.kind, "estimated");
    assert.equal(priced.value, 6);
    const incomplete = dataMod.costOf({ ...totals, cacheRead: 5 }, { inputPerMTok: 2, outputPerMTok: 8, source: "costs.json" });
    assert.notEqual(incomplete.kind, "estimated", "a missing rate for a used token class is not a complete estimate");
    assert.equal(footer.estimateCost(totals, { inputPerMTok: 2, outputPerMTok: 8, source: "x" }), 6, "the previous contract still holds");
  },

  async commandsRejectInvalidArgumentsWithoutMutation() {
    const agent = tmpWorkspace("pi-kit-footer-settings-");
    const workspace = tmpWorkspace("pi-kit-footer-workspace-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const pi = fakePi();
      footer.default(pi.api);
      const notes: Note[] = [];
      const noteAt = (index: number): Note => {
        const note = notes.at(index);
        assert.ok(note, `expected a notification at ${index} of ${notes.length}`);
        return note;
      };
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m", provider: "p", contextWindow: 100 },
        getContextUsage: () => ({ percent: 0, tokens: 0, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify: (m: string, l: string) => notes.push({ m, l }), select: async () => "heavy" },
      };
      await pi.handlers.get("session_start")({}, ctx);
      const file = path.join(agent, "pi-kit", "ui.json");
      const h = pi.commands.get("footer").handler;
      // valid: mode config persists exactly the previous contract
      await h(["config"], ctx);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { footer: true, mode: "heavy", tips: true, todos: true, cat: true });
      const before = fs.readFileSync(file, "utf8");
      // invalid: nothing changes, an error explains, and it says so
      for (const bad of ["nonsense", "lite", "todos maybe", "ascii perhaps", "heavy extra", "on now", "--mode heavy"]) {
        notes.length = 0;
        await h(bad, ctx);
        assert.equal(fs.readFileSync(file, "utf8"), before, `"${bad}" must not change settings`);
        assert.equal(noteAt(-1).l, "error", `"${bad}" reports an error`);
        assert.match(noteAt(-1).m, /Nothing was changed/);
        assert.match(noteAt(-1).m, /Usage: \/footer/);
      }
      // valid changes persist
      await h("light", ctx);
      assert.equal(readSettings(file).mode, "light");
      await h("off", ctx);
      const off = readSettings(file);
      assert.equal(off.footer, false);
      assert.equal(off.mode, "light", "off preserves the selected preset for the next toggle");
      await h("", ctx);
      assert.equal(readSettings(file).footer, true, "no argument toggles");
      await h("ascii on", ctx);
      assert.equal(readSettings(file).ascii, true);
      await h("ascii off", ctx);
      assert.ok(!("ascii" in readSettings(file)));
      await h("todos off", ctx);
      assert.equal(readSettings(file).todos, false);
      // /tips
      const t = pi.commands.get("tips").handler;
      const tipsBefore = fs.readFileSync(file, "utf8");
      notes.length = 0;
      await t("sometimes", ctx);
      assert.equal(fs.readFileSync(file, "utf8"), tipsBefore);
      assert.equal(noteAt(-1).l, "error");
      await t("off", ctx);
      assert.equal(readSettings(file).tips, false);
      // status is an accessible detail view
      notes.length = 0;
      await h("status", ctx);
      assert.match(noteAt(0).m, /Status bar: /);
      assert.match(noteAt(0).m, /cost\s+\?/);
      assert.match(noteAt(0).m, /compaction\s+not reported/);
    } finally {
      restore();
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  async uiSettingsMergePreservesForeignKeys() {
    // ui.json is shared with the hub, command menu and launch screen. Every valid /footer and /tips
    // change must merge its own keys instead of rewriting the file with a six-field projection.
    const agent = tmpWorkspace("pi-kit-footer-merge-");
    const workspace = tmpWorkspace("pi-kit-footer-merge-ws-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const file = path.join(agent, "pi-kit", "ui.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const foreign = {
        hubKey: "alt+k",
        commandMenu: "all",
        pinnedCommands: ["/help"],
        hiddenCommands: ["/model"],
        launchScreen: "off",
        reducedMotion: true,
      };
      fs.writeFileSync(file, JSON.stringify({ ...foreign, footer: true }, null, 2));
      const pi = fakePi();
      footer.default(pi.api);
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m", provider: "p", contextWindow: 100 },
        getContextUsage: () => ({ percent: 0, tokens: 0, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify: () => {}, select: async () => "heavy" },
      };
      await pi.handlers.get("session_start")({}, ctx);
      const h = pi.commands.get("footer").handler;
      const t = pi.commands.get("tips").handler;
      const assertForeign = (step: string): void => {
        const saved = readSettings(file);
        for (const [key, value] of Object.entries(foreign)) assert.deepEqual(saved[key], value, `${step}: ${key} is unchanged`);
      };
      await h("light", ctx);
      assert.equal(readSettings(file).mode, "light");
      assert.equal(readSettings(file).footer, true);
      assertForeign("/footer light");
      await h("ascii on", ctx);
      assert.equal(readSettings(file).ascii, true);
      assertForeign("/footer ascii on");
      await h("ascii off", ctx);
      assert.ok(!("ascii" in readSettings(file)), "ascii off removes the key");
      assertForeign("/footer ascii off");
      await t("off", ctx);
      assert.equal(readSettings(file).tips, false);
      assertForeign("/tips off");
    } finally {
      restore();
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  async nonInteractiveSessionsGetTextNotSilence() {
    const agent = tmpWorkspace("pi-kit-footer-headless-");
    const workspace = tmpWorkspace("pi-kit-footer-headless-ws-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    const realWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    try {
      const pi = fakePi();
      footer.default(pi.api);
      let footerInstalls = 0;
      const ctx = { cwd: workspace, hasUI: false, model: { id: "m" }, sessionManager: { getEntries: () => [] }, ui: { setFooter() { footerInstalls++; } } };
      process.stderr.write = (c) => { written.push(String(c)); return true; };
      await pi.handlers.get("session_start")({}, ctx);
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(footerDebug(pi.api).tickerActive(), false, "no ticker without a UI");
      const h = pi.commands.get("footer").handler;
      await h("status", ctx);
      await h("nonsense", ctx);
      await h("heavy", ctx);
      await h("config", ctx);
      await pi.handlers.get("agent_end")({}, ctx);
      process.stderr.write = realWrite;
      assert.equal(footerInstalls, 0, "no footer is installed without a UI");
      const text = written.join("");
      assert.match(text, /\[footer\] Status bar: /);
      assert.match(text, /unknown option "nonsense"/);
      assert.match(text, /needs an interactive session/);
      assert.equal(readSettings(path.join(agent, "pi-kit", "ui.json")).mode, "heavy", "a valid change still applies headlessly");
    } finally {
      process.stderr.write = realWrite;
      restore();
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  async lifecycleLeavesNothingRunning() {
    const agent = tmpWorkspace("pi-kit-footer-life-");
    const workspace = tmpWorkspace("pi-kit-footer-life-ws-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const live = new Set();
    globalThis.setInterval = (fn, ms, ...a) => { const id = realSet(fn, ms, ...a); live.add(id); return id; };
    globalThis.clearInterval = (id) => { live.delete(id); realClear(id); };
    try {
      const pi = fakePi();
      footer.default(pi.api);
      const widgets = new Map<string, unknown>();
      const working: Array<string | undefined> = [];
      let footerFactory: FooterFactory | undefined;
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m" }, getContextUsage: () => ({ percent: 5, tokens: 5, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter: (f: FooterFactory) => { footerFactory = f; }, setWidget: (k: string, v: unknown) => (v === undefined ? widgets.delete(k) : widgets.set(k, v)), setWorkingMessage: (m?: string) => working.push(m), notify() {} },
      };
      await pi.handlers.get("session_start")({}, ctx);
      assert.equal(live.size, 0, "session start starts no timer");
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(live.size, 1, "one ticker while a request runs");
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(live.size, 1, "a second agent_start replaces the ticker, never adds one");
      await pi.handlers.get("agent_end")({}, ctx);
      assert.equal(live.size, 0, "agent end clears the ticker");
      assert.ok(working.at(-1) === undefined, "the working message is reset");
      // a reload in the middle of a run
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(live.size, 1);
      await pi.handlers.get("session_start")({ reason: "reload" }, ctx);
      assert.equal(live.size, 0, "a reload clears a ticker left by the previous session");
      await pi.handlers.get("agent_start")({}, ctx);
      await pi.handlers.get("session_shutdown")({}, ctx);
      assert.equal(live.size, 0, "shutdown clears the ticker");
      assert.equal(widgets.size, 0, "shutdown removes the tip and todo widgets");
      // the footer component disposes its subscriptions
      let unsubscribed = 0;
      assert.ok(footerFactory);
      const component = footerFactory({ requestRender() {} }, plain, { getExtensionStatuses: () => new Map(), onBranchChange: () => () => { unsubscribed++; }, getGitBranch: () => "main" });
      component.dispose();
      assert.equal(unsubscribed, 1);
      assert.doesNotThrow(() => component.render(80));
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      restore();
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  async renderAndRefreshDoNoSubprocessOrDiskReads() {
    const agent = tmpWorkspace("pi-kit-footer-perf-");
    const workspace = tmpWorkspace("pi-kit-footer-perf-ws-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    const src = ["index.ts", "render.ts", "data.ts", "widgets.ts", "width.ts"].map((f) => fs.readFileSync(path.resolve("packages/extensions/third_party/custom-footer", f), "utf8")).join("\n");
    assert.doesNotMatch(src, /child_process|execFileSync|execSync|spawnSync/, "the status bar never starts a subprocess");
    const realRead = fs.readFileSync;
    const realStat = fs.statSync;
    try {
      const pi = fakePi();
      footer.default(pi.api);
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m" }, getContextUsage: () => ({ percent: 5, tokens: 5, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify() {} },
      };
      await pi.handlers.get("session_start")({}, ctx);
      const state = footerDebug(pi.api).state;
      let reads = 0;
      // Counting wrappers: the cast restores the overloaded signature the wrapper forwards to verbatim.
      fs.readFileSync = ((...a: Parameters<typeof realRead>) => { reads++; return realRead(...a); }) as typeof fs.readFileSync;
      try {
        for (let i = 0; i < 200; i++) footer.renderFooter(state(), plain, 100, "heavy");
      } finally { fs.readFileSync = realRead; }
      assert.equal(reads, 0, "rendering reads no files");
      let stats = 0;
      fs.statSync = ((...a: Parameters<typeof realStat>) => { stats++; return realStat(...a); }) as typeof fs.statSync;
      try {
        for (let i = 0; i < 100; i++) footer.renderFooter(state(), plain, 100, "default");
      } finally { fs.statSync = realStat; }
      assert.equal(stats, 0, "rendering stats no files");
    } finally {
      fs.readFileSync = realRead;
      fs.statSync = realStat;
      restore();
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  async publishedRegistriesFeedTheBar() {
    const agent = tmpWorkspace("pi-kit-footer-reg-");
    const workspace = tmpWorkspace("pi-kit-footer-reg-ws-");
    const restore = [setEnv("PI_CODING_AGENT_DIR", agent), setEnv("PI_KIT_UNATTENDED", "1")];
    const effortKey = Symbol.for("pi-kit.effort");
    const unattendedKey = Symbol.for("pi-kit.unattended");
    const compactionKey = Symbol.for("pi-kit.compaction");
    const subagentsKey = Symbol.for("pi-kit.subagents");
    const keys = [effortKey, unattendedKey, compactionKey, subagentsKey];
    try {
      fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
      fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: "long-horizon" }));
      fs.writeFileSync(path.join(agent, "pi-kit", "firewall.json"), JSON.stringify({ mode: "auto", policy: "coding" }));
      const pi = fakePi();
      footer.default(pi.api);
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m", provider: "p" }, getContextUsage: () => ({ percent: 5, tokens: 5, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify() {} },
      };
      globalRegistry[effortKey] = { snapshot: () => ({ code: "E4", label: "Thorough", pinned: false, pendingTier: null, ledger: "x", usage: { live: 1, total: 2, scouts: 1 }, limits: { maxTotal: 8, maxScouts: 2 } }), onChange: () => () => {} };
      await pi.handlers.get("session_start")({}, ctx);
      const dbg = footerDebug(pi.api);
      let s = dbg.state();
      assert.equal(s.profile, "long-horizon");
      assert.deepEqual(s.firewall, { mode: "auto", policy: "coding" });
      assert.equal(s.effort?.code, "E4");
      assert.equal(s.effort?.usage?.maxTotal, 8);
      assert.equal(s.unattended?.misconfigured, true, "the env alone is a misconfiguration warning, never proof");
      globalRegistry[unattendedKey] = { active: true, boundary: "container", autoApprove: true, label: "unattended (container)" };
      globalRegistry[compactionKey] = { enabled: false, reason: "compaction disabled in settings" };
      globalRegistry[subagentsKey] = { snapshot: () => ({ live: 2, finished: 3, failures: 1 }) };
      s = dbg.state();
      assert.equal(s.unattended?.active, true);
      assert.equal(s.compaction?.enabled, false);
      assert.deepEqual(s.agents, { live: 2, failed: 1 });
      const text = footer.renderFooter(s, plain, 120, "default").map(strip).join("\n");
      assert.match(text, /UNATTENDED . container/);
      assert.match(text, /compaction off/);
      assert.match(text, /agents 2/);
      // a new request starts counting failures from zero again
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(dbg.state().agents?.failed, 0);
      await pi.handlers.get("agent_end")({}, ctx);
    } finally {
      for (const k of keys) Reflect.deleteProperty(globalRegistry, k);
      restore.reverse().forEach((r) => r());
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  branchProfileAndPathHelpersAvoidSubprocesses() {
    const ws = tmpWorkspace("pi-kit-footer-git-");
    try {
      assert.equal(dataMod.readBranch(ws), undefined, "outside a repository there is no branch");
      fs.mkdirSync(path.join(ws, ".git"));
      fs.writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
      assert.equal(dataMod.readBranch(ws), "feature/x");
      const sub = path.join(ws, "a", "b");
      fs.mkdirSync(sub, { recursive: true });
      assert.equal(dataMod.readBranch(sub), "feature/x", "found from a subdirectory");
      fs.writeFileSync(path.join(ws, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
      assert.equal(dataMod.readBranch(ws), "0123456", "detached HEAD shows a short commit");
      assert.equal(renderMod.shortCwd("/home/u/a/b/c/d/e", "/home/u"), `~${path.sep}…${path.sep}d${path.sep}e`);
    } finally { rmWorkspace(ws); }
  },

  subagentsPublishALiveCount() {
    // The subagent extension publishes a read-only counter registry for this bar.
    return loadModule<typeof SubagentLive>("vendor/subagent/live.ts").then((live) => {
      const reg = globalRegistry[Symbol.for("pi-kit.subagents")] as SubagentRegistry | undefined;
      assert.ok(reg && typeof reg.snapshot === "function");
      const before = reg.snapshot();
      live.registerLive({ id: "t1", agent: "scout", startedAt: 1, cwd: "/", logPath: "x", terminate() {} });
      assert.equal((globalRegistry[Symbol.for("pi-kit.subagents")] as SubagentRegistry).snapshot().live, 1);
      live.noteFinished(true);
      live.unregisterLive("t1");
      const after = (globalRegistry[Symbol.for("pi-kit.subagents")] as SubagentRegistry).snapshot();
      assert.equal(after.live, 0);
      assert.equal(after.failures, 1);
      assert.ok(after.finished >= 1 && before.live === 0);
    });
  },

  async todoToolStatesAndListOutput() {
    const ws = tmpWorkspace("pi-kit-todo-tool-");
    const restore = setEnv("PI_KIT_TODO_FILE", path.join(ws, "TODO.md"));
    try {
      const pi = fakePi();
      registerTodo(pi.api);
      const tool = pi.tools.get("todo");
      const call = async (params: Record<string, unknown>): Promise<string> => textOf(await tool.execute("id", params, undefined, undefined, { cwd: ws }));

      let out = await call({ action: "add", items: ["design it", "build it", "test it"] });
      assert.match(out, /Added #1-#3/);
      assert.match(out, /Todos: 0\/3 done/);
      out = await call({ action: "start", id: 2 });
      assert.match(out, /in progress: #2/);
      assert.match(out, /\[~\] #2: build it {2}\(in progress\)/);
      // Starting another item clears the first active one.
      out = await call({ action: "start", id: 3 });
      assert.match(out, /in progress: #3/);
      assert.doesNotMatch(out, /\[~\] #2/);
      out = await call({ action: "done", id: 1 });
      assert.match(out, /Todos: 1\/3 done/);
      assert.match(out, /\[x\] #1: design it/);
      out = await call({ action: "remove", id: 3 });
      assert.match(out, /Removed #3/);
      assert.doesNotMatch(out, /test it/);
      out = await call({ action: "list" });
      assert.match(out, /Todos: 1\/2 done/);
      // The file on disk carries the states for the footer widget to read.
      const disk = fs.readFileSync(path.join(ws, "TODO.md"), "utf8");
      assert.match(disk, /- \[x\] #1: design it/);
      assert.match(disk, /- \[ \] #2: build it/);
      out = await call({ action: "done", id: 99 });
      assert.match(out, /#99 not found/);
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`status-bar-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
restoreEnv();
console.log(`status-bar-smoke: ${total}/${total} passed`);
