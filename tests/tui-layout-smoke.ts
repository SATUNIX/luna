#!/usr/bin/env node
/**
 * TUI layout: the pure renderers fit a terminal's columns, not its code points.
 *
 * Covers the status bar (all three densities), the todo checklist, the /workflows panel and the
 * remote pairing panel at widths 20, 32, 40, 60, 80 and 120, with ASCII, wide-character and emoji
 * input. Every line is measured with displayWidth (ANSI takes no columns, a wide character or an
 * emoji cluster takes two), so a line that only looks short because of its escape codes fails.
 * ASCII glyph mode must not emit a non-ASCII character.
 *
 * Deterministic: pure rendering, a fixed clock, no timers, no model runs, no network.
 */
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadModule } from "../packages/core/eval/harness.ts";
import type * as FooterWidgets from "../packages/extensions/third_party/custom-footer/widgets.ts";
import type * as FooterRender from "../packages/extensions/third_party/custom-footer/render.ts";
import type * as FooterWidth from "../packages/extensions/third_party/custom-footer/width.ts";
import type * as PanelModule from "../packages/extensions/third_party/subagent/wf-panel.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";

const render = await loadModule<typeof FooterRender>("vendor/custom-footer/render.ts");
const widgets = await loadModule<typeof FooterWidgets>("vendor/custom-footer/widgets.ts");
const widthMod = await loadModule<typeof FooterWidth>("vendor/custom-footer/width.ts");
const P = await loadModule<typeof PanelModule>("vendor/subagent/wf-panel.ts");
const RM = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
// A local view of the one pure export used here; a static type import of the module would pull
// its host/bridge graph into the test typecheck, where pi's loader-only syntax is not allowed.
type PairPanel = (offer: Record<string, unknown>, width: number, termRows: number, style?: { title(s: string): string; dim(s: string): string }) => string[];
const remote = await loadModule<{ pairPanel: PairPanel }>("extensions/remote-control/index.ts");

const W = widthMod.displayWidth;
const WIDTHS = [20, 32, 40, 60, 80, 120];
const MODES: FooterRender.FooterMode[] = ["light", "default", "heavy"];
const plain: FooterRender.Theme = { fg: (_c, s) => s, bold: (s) => s };
// A real theme emits ANSI; those sequences must not count as columns and must not break ASCII mode.
const ansiTheme: FooterRender.Theme = { ...plain, name: "ansi-dark" };
const wideTheme: FooterRender.Theme = {
  fg: (c, s) => `\x1b[3${c.length % 8}m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const fits = (lines: string[], width: number, label: string): void =>
  lines.forEach((line, index) => {
    const measured = W(line);
    assert.ok(measured <= width, `${label}: line ${index} is ${measured} columns, limit ${width}: ${line}`);
    const actual = visibleWidth(line);
    assert.ok(actual <= width, `${label}: line ${index} is ${actual} columns by pi-tui visibleWidth, limit ${width}: ${line}`);
    assert.ok(!line.includes("\n") && !line.includes("\r"), `${label}: line ${index} contains a newline: ${JSON.stringify(line)}`);
  });

const isAscii = (text: string): boolean => /^\p{ASCII}*$/u.test(text);

const baseState = (over: Partial<FooterRender.FooterState> = {}): FooterRender.FooterState => ({
  cwd: "/work/u/proj",
  branch: "main",
  provider: "pentest",
  model: "qwen3.8-27b",
  thinking: "medium",
  profile: "balanced",
  context: { tokens: 42000, percent: 66, contextWindow: 262144 },
  totals: { input: 446000, output: 175000, cacheRead: 14_000_000, cacheWrite: 0, total: 500000, cost: 0 },
  partial: false,
  cost: { kind: "estimated", value: 1.23 },
  pricingSource: "/work/u/.pi/agent/pi-kit/costs.json",
  effort: { code: "E3", label: "Standard", pinned: false, usage: { live: 0, total: 1, maxTotal: 3, scouts: 0, maxScouts: 1 } },
  statuses: [],
  todos: [
    { id: 1, text: "a", state: "done" },
    { id: 2, text: "b", state: "open" },
  ],
  now: 64000,
  ...over,
});

// A fixed clock so the panel's elapsed times are deterministic.
let now = 1_000_000;
const clock = (): number => now;

try {
  // 1. The status bar: every density at every width, with narrow, wide and ANSI input.
  {
    const asciiState = baseState({
      // A deep path is shortened with the glyph set's ellipsis; ASCII mode must shorten it with "...".
      cwd: "/work/u/a/b/c/d/e",
      statuses: [{ key: "trace-ledger", text: "trace-ledger: lost=0" }, { key: "verify-gate", text: "FAIL" }],
      agents: { live: 2, failed: 1 },
      compaction: { enabled: true, thresholdTokens: 100000 },
      firewall: { mode: "manual", policy: "coding" },
      unattended: { active: true, label: "unattended", boundary: "container" },
    });
    for (const width of WIDTHS) {
      for (const mode of MODES) {
        fits(render.renderFooter(asciiState, plain, width, mode), width, `footer ${mode}@${width}`);
      }
    }
    const wideState = baseState({
      // VS16/keycap clusters and a tab in the footer's own text: pi-tui measures them two (tab
      // three) columns each, so the footer's chip, path and branch fitting must use the same size.
      cwd: "/work/u/项目-日本語-🚀/a-fairly-long-directory-name/❤️-⚠️-another-long-directory-name",
      branch: "main-1️⃣",
      model: "模型-v1-🚀",
      profile: "均衡",
      thinking: "medium",
      sessionName: "会话 ✔️ 🚀",
      statuses: [
        { key: "x", text: "状态 🚀 ok" },
        { key: "trace-ledger", text: "trace-ledger: lost=0" },
        { key: "subagent", text: "[scout] step 1 running read 日本語-🚀.ts" },
        { key: "workflow", text: "bugfix · plan · running planner" },
        { key: "orchestrator", text: "❤️\t⚠️\t1️⃣ blocked: verify" },
        { key: "verify-gate", text: "FAIL" },
      ],
      todos: [
        { id: 1, text: "写测试 🚀 日本語", state: "active" },
        { id: 2, text: "x".repeat(200), state: "open" },
        { id: 3, text: "ship ❤️ the ⚠️ release ✔️ 1️⃣\tnow", state: "open" },
      ],
      cat: { text: "(=^･ω･^=)", label: "done" },
    });
    for (const width of WIDTHS) {
      for (const mode of MODES) {
        fits(render.renderFooter(wideState, plain, width, mode), width, `wide footer ${mode}@${width}`);
        fits(render.renderFooter(wideState, wideTheme, width, mode), width, `ansi wide footer ${mode}@${width}`);
      }
    }
    for (const width of WIDTHS) {
      for (const mode of MODES) {
        const lines = render.renderFooter({ ...asciiState, ascii: true }, ansiTheme, width, mode);
        fits(lines, width, `ascii footer ${mode}@${width}`);
        lines.forEach((line) => assert.ok(isAscii(line), `ascii footer ${mode}@${width}: non-ASCII character in ${line}`));
      }
    }
    ok("status bar: all densities fit every width, wide input and ASCII mode included");
  }

  // 2. The todo checklist: long lines are cut in columns, not code points.
  {
    const items: FooterRender.TodoItem[] = [
      { id: 1, text: "a finished item with a deliberately long description that must be cut on a narrow terminal", state: "done" },
      { id: 2, text: "写测试 🚀 日本語のとても長い説明文がここにあります", state: "active" },
      { id: 3, text: "open item 🚀", state: "open" },
      // A 200-character item: the cut must hold when the text is far longer than any width.
      { id: 4, text: "y".repeat(200), state: "open" },
      // Emoji that only present as emoji with VS16, a keycap cluster and a tab: each measures two
      // columns (the tab three) in pi-tui's visibleWidth, so a code-point count under-measures them.
      { id: 5, text: "ship ❤️ the ⚠️ release ✔️ 1️⃣\tnow", state: "open" },
    ];
    for (const width of WIDTHS) {
      fits(widgets.renderTodoWidget(items, plain, 8, false, width), width, `todos@${width}`);
      fits(widgets.renderTodoWidget(items, wideTheme, 8, false, width), width, `ansi todos@${width}`);
    }
    const asciiItems: FooterRender.TodoItem[] = [{ id: 1, text: "an ascii item that is long enough to be cut on a narrow terminal", state: "active" }];
    for (const width of WIDTHS) {
      const lines = widgets.renderTodoWidget(asciiItems, ansiTheme, 8, true, width);
      fits(lines, width, `ascii todos@${width}`);
      lines.forEach((line) => assert.ok(isAscii(line), `ascii todos@${width}: non-ASCII character in ${line}`));
    }
    const allDone = widgets.renderTodoWidget([{ id: 1, text: "x", state: "done" }], plain, 8, false, 20);
    fits(allDone, 20, "todos all done@20");
    // The working line's tool phrase clips a long command; ASCII mode must not add U+2026.
    const clipped = widgets.toolPhrase("bash", { command: "x".repeat(80) }, true);
    assert.ok(/^\p{ASCII}*$/u.test(clipped), `ascii tool phrase is ASCII: ${clipped}`);
    assert.ok(clipped.includes("...") && !clipped.includes("…"));
    // A grapheme that straddles the 40-column cut must never be split into a lone surrogate.
    // The 40-column budget is the command itself; the surrounding "Running `...`" is not charged.
    const commandOf = (line: string) => line.slice(line.indexOf("`") + 1, line.lastIndexOf("`"));
    const emojiClip = widgets.toolPhrase("bash", { command: "a".repeat(38) + "😀😀😀" }, false);
    const emojiCommand = commandOf(emojiClip);
    assert.ok(W(emojiCommand) <= 40, `emoji command fits 40 columns: ${W(emojiCommand)} ${emojiCommand}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiClip), `tool phrase has no lone surrogate: ${JSON.stringify(emojiClip)}`);
    assert.ok(emojiCommand.endsWith("…"), `tool phrase keeps the Unicode ellipsis: ${emojiClip}`);
    const asciiClip = widgets.toolPhrase("bash", { command: "x".repeat(80) }, true);
    assert.ok(W(commandOf(asciiClip)) <= 40, `ascii command fits 40 columns: ${W(commandOf(asciiClip))}`);
    assert.ok(commandOf(asciiClip).endsWith("...") && isAscii(asciiClip), `ascii tool phrase ends in ASCII ellipsis: ${asciiClip}`);
    ok("todo checklist: every line fits every width, wide input and ASCII mode included");
  }

  // 3. The /workflows panel: a run with a wide name, phase, agent and activity.
  {
    const registry = new RM.RunRegistry(clock);
    const narrator = new P.Narrator();
    const run = registry.start("20261112-120000-布局", "yaml", "布局 🚀 日本語", { description: "检查 🌟 宽度", file: "/kit/布局.md", source: "kit" });
    run.phase("阶段 🚀", "阶段 🚀");
    run.setPhaseStatus("阶段 🚀", "running");
    const agent = run.agentStart({ label: "代理 🚀", phase: "阶段 🚀", role: "scout", model: "模型 🚀" });
    now += 3_000;
    run.agentUpdate(agent, { activity: "reading src/日本語-🚀.ts" });
    const panel = new P.WorkflowPanel({ registry, narrator, cwd: "/work/u/项目", paint: P.plainPaint, close: () => {} }, run.id);
    for (const width of WIDTHS) {
      fits(panel.render(width), width, `workflow panel@${width}`);
    }
    const themed = new P.WorkflowPanel({
      registry,
      narrator,
      cwd: "/work/u/项目",
      paint: P.themePaint({ fg: (c, s) => `\x1b[3${c.length % 8}m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }),
      close: () => {},
    }, run.id);
    for (const width of WIDTHS) fits(themed.render(width), width, `ansi workflow panel@${width}`);
    // The list view too, including its footer and note path.
    const list = new P.WorkflowPanel({ registry, narrator, cwd: "/work/u/项目", paint: P.plainPaint, close: () => {} });
    for (const width of WIDTHS) fits(list.render(width), width, `workflow list@${width}`);
    ok("workflows panel: run and list views fit every width with wide input");
  }

  // 4. The remote pairing panel: codes, fingerprints and a QR code with wide characters.
  {
    const size = 25;
    const rows = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => ((r * size + c) % 3 === 0 ? "1" : "0")).join(""));
    const offer = {
      addresses: ["198.51.100.200", "2001:db8:5678:9abc:def0:1234:5678:9abc"],
      port: 7331,
      codeDisplay: "ABCDE-FGHIJ",
      fingerprintDisplay: "🚀 日本語日本語日本語 🚀 0123456789abcdef0123456789abcdef0123",
      expiresAt: new Date(1_700_000_000_000).toISOString(),
      qr: { size, rows },
    };
    const style = { title: (s: string) => `\x1b[1m\x1b[35m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m` };
    for (const width of WIDTHS) {
      fits(remote.pairPanel(offer, width, 40, style), width, `pair panel@${width}`);
      fits(remote.pairPanel(offer, width, 0), width, `pair panel no rows@${width}`);
    }
    // A 20-column terminal is too narrow for the QR code; the note and details still fit.
    const narrow = remote.pairPanel(offer, 20, 40, style);
    assert.match(widthMod.stripAnsi(narrow.join(" ")).replace(/\s+/g, " "), /needs a terminal of at least/, "a narrow terminal is told what the QR code needs");
    fits(narrow, 20, "pair panel narrow");
    // Absurdly narrow widths cannot fit a wide grapheme at all; the panel still emits no
    // over-wide remainder (width 2 is the smallest that can hold the one-space prefix).
    for (const width of [2, 3]) fits(remote.pairPanel(offer, width, 40), width, `pair panel tiny@${width}`);
    // A wide terminal puts the QR code beside the details; every row still fits.
    const wide = remote.pairPanel(offer, 120, 60, style);
    assert.ok(wide.some((line) => line.includes("\x1b[30;107m")), "a wide terminal gets the QR code");
    fits(wide, 120, "pair panel wide");
    ok("remote pairing panel: every line fits every width, with wide input and ANSI styling");
  }

  console.log(`tui-layout-smoke: ${checks} checks passed`);
} finally {
  now = 0;
}
