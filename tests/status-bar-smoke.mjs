#!/usr/bin/env node
/**
 * Status bar (custom-footer): rendering at every density and width, priority-based fitting, display
 * width (wide characters, emoji, ANSI), cost provenance, warnings, staleness, ASCII fallback,
 * commands (invalid arguments never mutate; non-interactive sessions get text), and lifecycle
 * (no ticker without a UI or after a run, shutdown and reload leave nothing running, no subprocess or
 * disk read per render). Deterministic: pure rendering plus a fake pi API; no model runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModule, fakePi, isolateKitEnv, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

const restoreEnv = isolateKitEnv();
const footer = await loadModule("vendor/custom-footer/index.ts");
const widthMod = await loadModule("vendor/custom-footer/width.ts");
const dataMod = await loadModule("vendor/custom-footer/data.ts");
const renderMod = await loadModule("vendor/custom-footer/render.ts");
const todo = await loadModule("vendor/todo/index.ts");
const plain = { fg: (_c, s) => s, bold: (s) => s };
const ansiTheme = { ...plain, name: "ansi-dark" };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const W = widthMod.displayWidth;

const baseState = (over = {}) => ({
  cwd: "/home/u/proj", branch: "main", provider: "pentest", model: "qwen3.8-27b", thinking: "medium", profile: "balanced",
  context: { tokens: 42000, percent: 66, contextWindow: 262144 },
  totals: { input: 446000, output: 175000, cacheRead: 14_000_000, cacheWrite: 0, total: 500000, cost: 0 },
  partial: false, cost: { kind: "estimated", value: 1.23 }, pricingSource: "/home/u/.pi/agent/pi-kit/costs.json",
  effort: { code: "E3", label: "Standard", pinned: false, usage: { live: 0, total: 1, maxTotal: 3, scouts: 0, maxScouts: 1 } },
  statuses: [], todos: [{ id: 1, text: "a", state: "done" }, { id: 2, text: "b", state: "open" }], now: 64000, ...over,
});
const fits = (lines, width, label) => lines.forEach((l) => assert.ok(W(l) <= width, `${label}: line is ${W(l)} columns, limit ${width}: ${strip(l)}`));

const tests = {
  formatting() {
    assert.equal(footer.fmtTokens(950), "950");
    assert.equal(footer.fmtTokens(1234), "1.2k");
    assert.equal(footer.fmtTokens(52000), "52k");
    assert.equal(footer.fmtTokens(2_400_000), "2.4M");
    assert.equal(footer.fmtDuration(9000), "9s");
    assert.equal(footer.fmtDuration(64000), "1m 04s");
    assert.equal(footer.fmtDuration(3_700_000), "1h 01m");
    assert.equal(footer.fmtCost(undefined), "unknown");
    assert.equal(footer.fmtCost(0), "$0.00");
    assert.equal(footer.fmtCost(1.5), "$1.50");
    assert.equal(footer.fmtCostView({ kind: "reported", value: 1.5 }), "$1.50");
    assert.equal(footer.fmtCostView({ kind: "estimated", value: 1.5 }), "~$1.50");
    assert.equal(footer.fmtCostView({ kind: "unknown" }), "?", "unknown is not zero");
  },

  displayWidthHandlesAnsiWideCharactersAndEmoji() {
    assert.equal(W("\x1b[31mred\x1b[0m"), 3);
    assert.equal(W("\x1b]8;;https://example.test\x07link\x1b]8;;\x07"), 4, "OSC 8 hyperlinks take no columns");
    assert.equal(W("日本語"), 6, "wide characters take two columns");
    assert.equal(W("👍🏽"), 2, "an emoji with a skin-tone modifier is one two-column cluster");
    assert.equal(W("👨‍👩‍👧"), 2, "a ZWJ family is one cluster");
    assert.equal(W("e\u0301"), 1, "combining accents take no columns");
    assert.equal(W("●│█░↑↓⟲✔▸☐…·"), 12, "the footer's own glyphs are single-width");
    const cut = widthMod.truncateDisplay("日本語のテキスト", 7);
    assert.equal(cut, "日本語…");
    assert.ok(W(cut) <= 7);
    const emoji = widthMod.truncateDisplay("ab👨‍👩‍👧cd", 4);
    assert.ok(W(emoji) <= 4 && !emoji.includes("\u200d") || W(emoji) <= 4, `never splits a cluster: ${emoji}`);
    const colour = widthMod.truncateDisplay("\x1b[31mabcdefghij\x1b[0m", 5);
    assert.ok(strip(colour).length <= 5 && colour.endsWith("…") && colour.includes("\x1b[0m"), "colour is reset before the ellipsis");
    assert.equal(widthMod.truncateDisplay("short", 20), "short");
  },

  sessionTotalsSumsAssistantUsageIncrementally() {
    const entry = (id, usage) => ({ id, type: "message", message: { role: "assistant", usage } });
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
    const counted = new Proxy(entries.slice(0, 3), { get(t, k) { if (typeof k === "string" && /^\d+$/.test(k)) seen++; return t[k]; } });
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

  densitiesDifferAndFitEveryWidth() {
    const state = baseState({ statuses: [{ key: "trace-ledger", text: "trace-ledger: lost=0" }, { key: "verify-gate", text: "FAIL" }], agents: { live: 2, failed: 0 }, compaction: { enabled: true, thresholdTokens: 100000 }, firewall: { mode: "manual", policy: "coding" } });
    for (const width of [40, 80, 120, 160]) {
      const light = footer.renderFooter(state, plain, width, "light");
      const def = footer.renderFooter(state, plain, width, "default");
      const heavy = footer.renderFooter(state, plain, width, "heavy");
      assert.equal(light.length, 1, `light is one line at ${width}`);
      assert.equal(def.length, 2, `default is two lines at ${width}`);
      assert.equal(heavy.length, 4, `heavy is four lines at ${width}`);
      fits(light, width, `light@${width}`);
      fits(def, width, `default@${width}`);
      fits(heavy, width, `heavy@${width}`);
      assert.match(strip(light[0]), /proj/, "light keeps identity");
      assert.match(strip(light[0]), /E3/, `light shows the effort tier at ${width}`);
    }
    const def = footer.renderFooter(state, plain, 160, "default").map(strip).join("\n");
    assert.match(def, /proj.*on main/);
    assert.match(def, /qwen3\.8-27b.*think medium.*profile balanced.*effort E3 Standard 1\/3/, def);
    assert.match(def, /ctx .*66%/);
    assert.match(def, /agents 2/);
    assert.doesNotMatch(def, /↑446k|cost|session ↑/, "default carries no token or cost telemetry");
    const heavy = footer.renderFooter(state, plain, 160, "heavy").map(strip).join("\n");
    assert.match(heavy, /session ↑446k ↓175k ⟲14M/);
    assert.match(heavy, /cost ~\$1\.23 est/);
    assert.match(heavy, /children 1\/3.*scouts 0\/1/);
    assert.match(heavy, /firewall manual\/coding/);
    assert.match(heavy, /compaction on @100k/);
    assert.match(heavy, /trace-ledger lost=0.*verify-gate FAIL/);
    const light = footer.renderFooter(state, plain, 160, "light").map(strip).join("\n");
    assert.doesNotMatch(light, /trace-ledger/, "light hides non-critical chips");
  },

  criticalWarningsOutliveTelemetryWhenNarrow() {
    const state = baseState({ unattended: { active: true, label: "unattended", boundary: "container", autoApprove: true }, compaction: { enabled: false, reason: "disabled in settings" }, agents: { live: 0, failed: 2 }, statuses: [{ key: "orchestrator", text: "blocked: verify" }] });
    for (const width of [40, 60, 80, 120]) {
      for (const mode of ["light", "default", "heavy"]) {
        const lines = footer.renderFooter(state, plain, width, mode);
        fits(lines, width, `${mode}@${width}`);
        const text = lines.map(strip).join("\n");
        assert.match(text, /UNATTENDED/, `${mode}@${width}: the unattended boundary state is never dropped`);
        if (width >= 100) {
          assert.match(text, /compaction off|no compact/, `${mode}@${width}: compaction-off warning survives`);
          assert.match(text, /2 agents failed|2 failed/, `${mode}@${width}: failed children survive`);
          assert.match(text, /blocked: verify/, `${mode}@${width}: a blocked chip survives`);
        } else {
          // Too narrow for every warning: the first is named, the rest are counted, and the detail view has them all.
          assert.ok(/UNATTENDED[^\n]*\+\d/.test(text) || (/compaction off|no compact/.test(text) && /failed/.test(text)), `${mode}@${width}: every critical warning is shown, or the rest are counted (never silently lost):\n${text}`);
        }
      }
    }
    const detail = footer.renderDetail(state, "default").join("\n");
    assert.match(detail, /unattended\s+ACTIVE \(container, approvals automatic\)/);
    assert.match(detail, /compaction\s+OFF: disabled in settings/);
    assert.match(detail, /2 failed this request/);
    assert.match(detail, /orchestrator: blocked: verify/);
    const narrow = footer.renderFooter(baseState({ statuses: [] }), plain, 40, "default").map(strip).join("\n");
    assert.match(narrow, /proj/);
    assert.match(narrow, /E3/, "the effort tier outlives secondary telemetry");
    assert.doesNotMatch(narrow, /pentest|\/home\/u/, "provider and path are the first to go");
    const misconfigured = footer.renderFooter(baseState({ unattended: { active: false, label: "unattended requested, not enforced", misconfigured: true } }), plain, 100, "default").map(strip).join("\n");
    assert.match(misconfigured, /unattended NOT enforced/, "an unattended request that nothing enforces is a loud warning, not a reassurance");
  },

  unknownAndMissingValuesAreNotZero() {
    const unknownCtx = footer.renderFooter(baseState({ context: { contextWindow: 200000, percent: null, tokens: null } }), plain, 100, "default").map(strip).join("\n");
    assert.match(unknownCtx, /ctx \?\/200k/);
    assert.doesNotMatch(unknownCtx, /ctx .*0%/);
    const noWindow = footer.renderFooter(baseState({ context: {} }), plain, 100, "default").map(strip).join("\n");
    assert.match(noWindow, /ctx \?/);
    const heavy = footer.renderFooter(baseState({ cost: { kind: "unknown" }, partial: true, pricingSource: undefined }), plain, 120, "heavy").map(strip).join("\n");
    assert.match(heavy, /cost \? partial/, "unknown cost is shown as unknown, flagged partial");
    const reported = footer.renderFooter(baseState({ cost: { kind: "reported", value: 0.42 } }), plain, 120, "heavy").map(strip).join("\n");
    assert.match(reported, /cost \$0\.42/);
    assert.doesNotMatch(reported, /\best\b/);
    const bare = footer.renderFooter({ cwd: "/x", totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, partial: false, cost: { kind: "unknown" }, statuses: [], todos: [], now: 0 }, plain, 60, "default");
    fits(bare, 60, "minimal state");
    assert.match(strip(bare.join("\n")), /no model/);
  },

  longPathsModelNamesAndWideText() {
    const longState = baseState({ cwd: "/home/u/a/very/deeply/nested/project-with-a-really-long-directory-name", model: "anthropic/claude-with-a-very-long-model-identifier-2026-09-01-preview", sessionName: "a long session name with extra words", provider: "some-provider-with-a-long-name" });
    for (const width of [40, 80, 120, 160]) for (const mode of ["light", "default", "heavy"]) fits(footer.renderFooter(longState, plain, width, mode), width, `long@${width}/${mode}`);
    const wide = baseState({ cwd: "/home/u/项目-日本語-🚀", model: "模型-v1", sessionName: "会话" });
    for (const width of [40, 80, 120]) for (const mode of ["light", "default", "heavy"]) fits(footer.renderFooter(wide, plain, width, mode), width, `wide@${width}/${mode}`);
    fits(footer.renderFooter(baseState(), plain, 12, "heavy"), 12, "absurdly narrow");
    fits(footer.renderFooter(baseState(), plain, 1, "default"), 1, "one column");
    // ANSI colour does not count against the width
    const coloured = { fg: (c, s) => `\x1b[3${c.length % 8}m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
    for (const width of [40, 80, 120]) fits(footer.renderFooter(baseState({ agents: { live: 1, failed: 1 } }), coloured, width, "heavy"), width, `coloured@${width}`);
  },

  effortAndPendingChange() {
    const pinned = footer.renderFooter(baseState({ effort: { code: "E2", label: "Focused", pinned: true } }), plain, 120, "default").map(strip).join("\n");
    assert.match(pinned, /effort E2 Focused\*/);
    const pending = footer.renderFooter(baseState({ effort: { code: "E3", label: "Standard", pinned: false, pendingCode: "E4" } }), plain, 120, "default").map(strip).join("\n");
    assert.match(pending, /E3 Standard→E4/, "a change chosen mid-request is visible before it applies");
    const light = footer.renderFooter(baseState(), plain, 100, "light").map(strip).join("\n");
    assert.match(light, /E3 1\/3/);
    assert.equal(footer.renderFooter(baseState({ effort: undefined }), plain, 100, "default").map(strip).join("\n").includes("effort"), false, "no effort extension, no chip");
  },

  staleTransientChipsAreHiddenButFailuresStay() {
    const old = 5 * 60_000;
    const statuses = [
      { key: "subagent", text: "[scout] step 1 running read x · 12s", ageMs: old },
      { key: "workflow", text: "bugfix · plan · running planner", ageMs: old },
      { key: "orchestrator", text: "blocked: verify", ageMs: old },
      { key: "trace-ledger", text: "trace-ledger: lost=0", ageMs: old },
    ];
    const idle = footer.renderFooter(baseState({ statuses, running: false }), plain, 200, "heavy").map(strip).join("\n");
    assert.doesNotMatch(idle, /\[scout\]|bugfix/, "stale in-flight chips are cleared from the bar once nothing runs");
    assert.match(idle, /blocked: verify/, "a failure is never hidden for being old");
    assert.match(idle, /trace-ledger lost=0/, "non-transient chips are not aged out");
    const running = footer.renderFooter(baseState({ statuses, running: true }), plain, 200, "heavy").map(strip).join("\n");
    assert.match(running, /\[scout\]|bugfix/, "while a request runs nothing is hidden");
    const detail = footer.renderDetail(baseState({ statuses, running: false }), "default").join("\n");
    assert.match(detail, /subagent: .*hidden from the bar/, "the detail view still lists what the bar hid");
    const withAgents = footer.renderFooter(baseState({ statuses: [{ key: "subagent", text: "[scout] running", ageMs: 0 }], agents: { live: 1, failed: 0 } }), plain, 200, "default").map(strip).join("\n");
    assert.doesNotMatch(withAgents, /\[scout\]/, "the subagent chip is redundant with the agents count");
  },

  asciiFallback() {
    const state = baseState({ unattended: { active: true, label: "u", boundary: "container" }, agents: { live: 1, failed: 0 }, statuses: [{ key: "x", text: "ok" }] });
    for (const mode of ["light", "default", "heavy"]) {
      const out = [...footer.renderFooter(state, ansiTheme, 100, mode), ...footer.renderTodoWidget(state.todos, ansiTheme)].join("\n");
      assert.ok(/^[\x00-\x7F]*$/.test(out), `${mode}: ASCII theme output is ASCII only: ${out}`);
    }
    const forced = footer.renderFooter({ ...state, ascii: true }, plain, 100, "heavy").join("\n");
    assert.ok(/^[\x00-\x7F]*$/.test(forced), "the ascii setting forces ASCII on any theme");
    const restore = setEnv("PI_KIT_ASCII", "1");
    try { assert.equal(footer.footerGlyphs(plain).ascii, true); } finally { restore(); }
    const output = footer.renderFooter(state, ansiTheme, 120, "default").join("\n");
    assert.match(output, /in:|E3/);
  },

  todoWidget() {
    const items = [
      { id: 1, text: "done thing", state: "done" },
      { id: 2, text: "current thing", state: "active" },
      { id: 3, text: "later thing", state: "open" },
    ];
    const lines = footer.renderTodoWidget(items, plain).map(strip);
    assert.match(lines[0], /Todos 1\/3/);
    assert.ok(lines.some((l) => /▸ #2 current thing/.test(l)), lines.join("|"));
    assert.ok(lines.some((l) => /✔ #1 done thing/.test(l)));
    assert.ok(lines.some((l) => /☐ #3 later thing/.test(l)));
    assert.deepEqual(footer.renderTodoWidget([], plain), []);
    const allDone = footer.renderTodoWidget([{ id: 1, text: "x", state: "done" }], plain).map(strip);
    assert.match(allDone[0], /all done/);
  },

  phrasesAndActivity() {
    assert.ok(footer.PHRASES.length > 5);
    assert.equal(footer.toolPhrase("read", { path: "/a/b/server.ts" }), "Reading server.ts");
    assert.equal(footer.toolPhrase("bash", { command: "npm test" }), "Running `npm test`");
    assert.equal(footer.toolPhrase("subagent", {}), "Delegating to a subagent");
    assert.equal(footer.toolPhrase("memory_search", {}), "Consulting memory");
    assert.equal(footer.toolPhrase("weird_tool", {}), "Using weird_tool");
  },

  tipsAreFilteredToLoadedCommands() {
    assert.ok(footer.TIPS.length > 5);
    assert.ok(footer.TIPS.filter((t) => !t.requires).length >= 3, "some tips always apply");
    assert.ok(footer.TIPS.some((t) => t.requires === "compress"));
    assert.ok(footer.TIPS.some((t) => /\/effort/.test(t.text)), "the effort command is discoverable");
  },

  async commandsRejectInvalidArgumentsWithoutMutation() {
    const agent = tmpWorkspace("pi-kit-footer-settings-");
    const workspace = tmpWorkspace("pi-kit-footer-workspace-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const pi = fakePi();
      footer.default(pi.api);
      const notes = [];
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m", provider: "p", contextWindow: 100 },
        getContextUsage: () => ({ percent: 0, tokens: 0, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify: (m, l) => notes.push({ m, l }), select: async () => "heavy" },
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
        assert.equal(notes.at(-1).l, "error", `"${bad}" reports an error`);
        assert.match(notes.at(-1).m, /Nothing was changed/);
        assert.match(notes.at(-1).m, /Usage: \/footer/);
      }
      // valid changes persist
      await h("light", ctx);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mode, "light");
      await h("off", ctx);
      const off = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(off.footer, false);
      assert.equal(off.mode, "light", "off preserves the selected preset for the next toggle");
      await h("", ctx);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).footer, true, "no argument toggles");
      await h("ascii on", ctx);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ascii, true);
      await h("ascii off", ctx);
      assert.ok(!("ascii" in JSON.parse(fs.readFileSync(file, "utf8"))));
      await h("todos off", ctx);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).todos, false);
      // /tips
      const t = pi.commands.get("tips").handler;
      const tipsBefore = fs.readFileSync(file, "utf8");
      notes.length = 0;
      await t("sometimes", ctx);
      assert.equal(fs.readFileSync(file, "utf8"), tipsBefore);
      assert.equal(notes.at(-1).l, "error");
      await t("off", ctx);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).tips, false);
      // status is an accessible detail view
      notes.length = 0;
      await h("status", ctx);
      assert.match(notes[0].m, /Status bar: /);
      assert.match(notes[0].m, /cost\s+\?/);
      assert.match(notes[0].m, /compaction\s+not reported/);
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
    const written = [];
    try {
      const pi = fakePi();
      footer.default(pi.api);
      let footerInstalls = 0;
      const ctx = { cwd: workspace, hasUI: false, model: { id: "m" }, sessionManager: { getEntries: () => [] }, ui: { setFooter() { footerInstalls++; } } };
      process.stderr.write = (c) => { written.push(String(c)); return true; };
      await pi.handlers.get("session_start")({}, ctx);
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(pi.api.__footerDebug.tickerActive(), false, "no ticker without a UI");
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
      assert.equal(JSON.parse(fs.readFileSync(path.join(agent, "pi-kit", "ui.json"), "utf8")).mode, "heavy", "a valid change still applies headlessly");
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
    globalThis.clearInterval = (id) => { live.delete(id); return realClear(id); };
    try {
      const pi = fakePi();
      footer.default(pi.api);
      const widgets = new Map();
      const working = [];
      let footerFactory;
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m" }, getContextUsage: () => ({ percent: 5, tokens: 5, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter: (f) => { footerFactory = f; }, setWidget: (k, v) => (v === undefined ? widgets.delete(k) : widgets.set(k, v)), setWorkingMessage: (m) => working.push(m), notify() {} },
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
      const state = pi.api.__footerDebug.state;
      let reads = 0;
      fs.readFileSync = (...a) => { reads++; return realRead(...a); };
      try {
        for (let i = 0; i < 200; i++) footer.renderFooter(state(), plain, 100, "heavy");
      } finally { fs.readFileSync = realRead; }
      assert.equal(reads, 0, "rendering reads no files");
      let stats = 0;
      fs.statSync = (...a) => { stats++; return realStat(...a); };
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
    const keys = ["pi-kit.effort", "pi-kit.unattended", "pi-kit.compaction", "pi-kit.subagents"].map((k) => Symbol.for(k));
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
      globalThis[keys[0]] = { snapshot: () => ({ code: "E4", label: "Thorough", pinned: false, pendingTier: null, ledger: "x", usage: { live: 1, total: 2, scouts: 1 }, limits: { maxTotal: 8, maxScouts: 2 } }), onChange: () => () => {} };
      await pi.handlers.get("session_start")({}, ctx);
      const dbg = pi.api.__footerDebug;
      let s = dbg.state();
      assert.equal(s.profile, "long-horizon");
      assert.deepEqual(s.firewall, { mode: "auto", policy: "coding" });
      assert.equal(s.effort.code, "E4");
      assert.equal(s.effort.usage.maxTotal, 8);
      assert.equal(s.unattended.misconfigured, true, "the env alone is a misconfiguration warning, never proof");
      globalThis[keys[1]] = { active: true, boundary: "container", autoApprove: true, label: "unattended (container)" };
      globalThis[keys[2]] = { enabled: false, reason: "compaction disabled in settings" };
      globalThis[keys[3]] = { snapshot: () => ({ live: 2, finished: 3, failures: 1 }) };
      s = dbg.state();
      assert.equal(s.unattended.active, true);
      assert.equal(s.compaction.enabled, false);
      assert.deepEqual(s.agents, { live: 2, failed: 1 });
      const text = footer.renderFooter(s, plain, 120, "default").map(strip).join("\n");
      assert.match(text, /UNATTENDED . container/);
      assert.match(text, /compaction off/);
      assert.match(text, /agents 2/);
      // a new request starts counting failures from zero again
      await pi.handlers.get("agent_start")({}, ctx);
      assert.equal(dbg.state().agents.failed, 0);
      await pi.handlers.get("agent_end")({}, ctx);
    } finally {
      for (const k of keys) delete globalThis[k];
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
    return loadModule("vendor/subagent/live.ts").then((live) => {
      const reg = globalThis[Symbol.for("pi-kit.subagents")];
      assert.ok(reg && typeof reg.snapshot === "function");
      const before = reg.snapshot();
      live.registerLive({ id: "t1", agent: "scout", startedAt: 1, cwd: "/", logPath: "x", terminate() {} });
      assert.equal(globalThis[Symbol.for("pi-kit.subagents")].snapshot().live, 1);
      live.noteFinished(true);
      live.unregisterLive("t1");
      const after = globalThis[Symbol.for("pi-kit.subagents")].snapshot();
      assert.equal(after.live, 0);
      assert.equal(after.failures, 1);
      assert.ok(after.finished >= 1 && before.live === 0);
    });
  },

  async workingLineShowsTimeAndTokens() {
    const restore = setEnv("PI_CODING_AGENT_DIR", tmpWorkspace("pi-kit-ui-agent-"));
    try {
      const pi = fakePi();
      pi.api.getThinkingLevel = () => "off";
      footer.default(pi.api);
      const dbg = pi.api.__footerDebug;
      const ws2 = tmpWorkspace("pi-kit-ui-ws-");
      const before = dbg.workingText(Date.now());
      assert.match(before, /…/, "no run yet: plain phrase with an ellipsis");
      const items = footer.readTodoItems(ws2);
      assert.deepEqual(items, [], "no TODO.md yields no items");
      fs.writeFileSync(path.join(ws2, "TODO.md"), "# TODO\n\n- [x] #1: done\n- [~] #2: doing\n- [ ] #3: todo\n");
      const parsed = footer.readTodoItems(ws2);
      assert.deepEqual(parsed.map((t) => t.state), ["done", "active", "open"]);
      rmWorkspace(ws2);
    } finally {
      rmWorkspace(process.env.PI_CODING_AGENT_DIR);
      restore();
    }
  },

  async todoToolStatesAndListOutput() {
    const ws = tmpWorkspace("pi-kit-todo-tool-");
    const restore = setEnv("PI_KIT_TODO_FILE", path.join(ws, "TODO.md"));
    try {
      const pi = fakePi();
      todo.default(pi.api);
      const tool = pi.tools.get("todo");
      const call = async (params) => (await tool.execute("id", params, undefined, undefined, { cwd: ws })).content[0].text;

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
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`status-bar-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
restoreEnv();
console.log(`status-bar-smoke: ${total}/${total} passed`);
