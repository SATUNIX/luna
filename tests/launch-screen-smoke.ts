#!/usr/bin/env node
/**
 * The Luna launch screen (docs/control-center.md): the pure rendering rules, reduced motion, the
 * reveal timer, ASCII output, and the `ctx.ui.setHeader` wiring in the one `session_start` handler.
 *
 * Hermetic: temporary agent dir, fake pi API, plain theme, and real timers only where the reveal
 * itself is under test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as LaunchModule from "../packages/extensions/src/control-center/launch-screen.ts";

type HeaderFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

const restoreEnv = isolateKitEnv();
const restoreCi = setEnv("CI", undefined);
const restoreTerm = setEnv("TERM", "xterm-256color");
const plain: LaunchModule.LaunchTheme = { fg: (_color, text) => text, bold: (text) => text };

async function loadLaunch(): Promise<typeof LaunchModule> {
  return loadModule<typeof LaunchModule>("extensions/control-center/launch-screen.ts");
}

async function loadControl(): Promise<(api: unknown) => void> {
  const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
  return mod.default as (api: unknown) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTui(): { tui: TUI; count: () => number } {
  let requested = 0;
  const tui = {
    requestRender: (): void => {
      requested += 1;
    },
  } as unknown as TUI;
  return { tui, count: () => requested };
}

interface StartOptions {
  mode?: string;
  ui?: Record<string, unknown>;
  child?: boolean;
  noMenu?: boolean;
  env?: Record<string, string | undefined>;
}

interface Started {
  headers: HeaderFactory[];
  cleanup: () => void;
}

/** Load control-center, register it, and run its one session_start handler with a fake context. */
async function start(options: StartOptions = {}): Promise<Started> {
  const dir = tmpWorkspace("pi-kit-launch-agent-");
  const restores: Array<() => void> = [];
  restores.push(setEnv("PI_CODING_AGENT_DIR", dir));
  restores.push(setEnv("PI_KIT_INTERNAL_CHILD", options.child ? "1" : undefined));
  for (const [name, value] of Object.entries(options.env ?? {})) restores.push(setEnv(name, value));
  const kit = path.join(dir, "pi-kit");
  fs.mkdirSync(kit, { recursive: true });
  if (options.ui) fs.writeFileSync(path.join(kit, "ui.json"), JSON.stringify(options.ui, null, 2));

  const cleanup = (): void => {
    for (const restore of restores.reverse()) restore();
    rmWorkspace(dir);
  };

  const register = await loadControl();
  const pi = fakePi();
  register(pi.api);
  if (options.noMenu) pi.commands.delete("menu");
  const headers: HeaderFactory[] = [];
  const ui = {
    addAutocompleteProvider: (): void => {},
    setHeader: (factory: HeaderFactory): void => {
      headers.push(factory);
    },
  };
  const handler = pi.handlers.find("session_start");
  if (!handler) {
    // A child session registers nothing at all, so there is no handler to run and no header.
    assert.equal(options.child, true, "only a child session may register no session_start handler");
    return { headers, cleanup };
  }
  const mode = options.mode ?? "tui";
  await handler({}, { mode, hasUI: mode === "tui" || mode === "rpc", cwd: dir, ui });
  return { headers, cleanup };
}

function headerOf(started: Started): HeaderFactory {
  assert.equal(started.headers.length, 1, "exactly one header factory is installed");
  const factory = started.headers[0];
  assert.ok(factory, "the header factory was captured");
  return factory;
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [];

// --- rendering ---------------------------------------------------------------------------------

tests.push([
  "every width fits, and narrow widths keep Luna and the menu command",
  async () => {
    const launch = await loadLaunch();
    for (const width of [20, 40, 60, 80, 120]) {
      let lines: string[] = [];
      assert.doesNotThrow(() => {
        lines = launch.launchLines({
          width,
          frame: launch.REVEAL_FRAMES - 1,
          reducedMotion: false,
          ascii: false,
          version: "1.2.3",
          hubKey: "alt+m",
          menuCmd: "/menu",
          theme: plain,
        });
      }, `width ${width} must not throw`);
      assert.ok(lines.length > 0, `width ${width} renders something`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
      const joined = lines.join("\n");
      assert.ok(joined.includes("Luna"), `width ${width} shows Luna`);
      assert.ok(joined.includes("/menu"), `width ${width} shows the menu command`);
    }
    for (const width of [20, 40]) {
      const narrow = launch.launchLines({
        width, frame: launch.REVEAL_FRAMES - 1, reducedMotion: false, ascii: false,
        version: "1.2.3", hubKey: "alt+m", menuCmd: "/menu", theme: plain,
      });
      assert.equal(narrow.length, 1, `a ${width}-column terminal gets one compact line`);
      assert.match(narrow[0] ?? "", /^Luna \/menu/, `at width ${width} the menu command follows Luna so truncation cannot drop it`);
      for (const line of narrow) assert.ok(visibleWidth(line) <= width, `narrow width ${width}: ${JSON.stringify(line)}`);
    }
  },
]);

tests.push([
  "ASCII mode keeps every rendered character printable",
  async () => {
    const launch = await loadLaunch();
    for (const width of [20, 80, 120]) {
      const lines = launch.launchLines({
        width, frame: launch.REVEAL_FRAMES - 1, reducedMotion: false, ascii: true,
        version: "1.2.3", hubKey: "alt+m", menuCmd: "/menu", theme: plain,
      });
      for (const line of lines) assert.doesNotMatch(line, /[^\x20-\x7e]/, `ASCII width ${width} is printable US-ASCII: ${JSON.stringify(line)}`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `ASCII width ${width}: ${JSON.stringify(line)}`);
    }
  },
]);

tests.push([
  "the reveal is progressive and reduced motion is the final frame",
  async () => {
    const launch = await loadLaunch();
    const base = { width: 80, ascii: false, version: "1.2.3", hubKey: "alt+m", menuCmd: "/menu", theme: plain };
    const first = launch.launchLines({ ...base, frame: 0, reducedMotion: false });
    const last = launch.launchLines({ ...base, frame: launch.REVEAL_FRAMES - 1, reducedMotion: false });
    const beyond = launch.launchLines({ ...base, frame: launch.REVEAL_FRAMES + 4, reducedMotion: false });
    const still = launch.launchLines({ ...base, frame: 0, reducedMotion: true });
    assert.ok(first.length < last.length, "frame 0 shows less than the final frame");
    assert.deepEqual(beyond, last, "frames beyond the reveal show the final content");
    assert.deepEqual(still, last, "reduced motion renders the final content at once");
  },
]);

tests.push([
  "reduced motion comes from the environment or ui.json",
  async () => {
    const launch = await loadLaunch();
    assert.equal(launch.isReducedMotion(undefined), false, "the default is animation");
    assert.equal(launch.isReducedMotion({ reducedMotion: true }), true, "ui.json can turn it on");
    assert.equal(launch.isReducedMotion({ reducedMotion: false }), false, "ui.json can leave it off");
    const restoreMotion = setEnv("PI_KIT_REDUCED_MOTION", "1");
    try {
      assert.equal(launch.isReducedMotion(undefined), true, "PI_KIT_REDUCED_MOTION=1 turns it on");
    } finally {
      restoreMotion();
    }
    const restoreDumb = setEnv("TERM", "dumb");
    try {
      assert.equal(launch.isReducedMotion(undefined), true, "TERM=dumb turns it on");
    } finally {
      restoreDumb();
    }
    const restoreCiValue = setEnv("CI", "1");
    try {
      assert.equal(launch.isReducedMotion(undefined), true, "CI turns it on");
    } finally {
      restoreCiValue();
    }
  },
]);

// --- registration ------------------------------------------------------------------------------

tests.push([
  "a TUI session installs exactly one header, even when commandMenu is all",
  async () => {
    const tui = await start();
    try {
      assert.equal(tui.headers.length, 1, "the TUI gets one header");
    } finally {
      tui.cleanup();
    }
    const all = await start({ ui: { commandMenu: "all" } });
    try {
      assert.equal(all.headers.length, 1, "the early commandMenu return must not skip the header");
    } finally {
      all.cleanup();
    }
  },
]);

tests.push([
  "no header outside the TUI, in a child session, or when launchScreen is off",
  async () => {
    for (const mode of ["rpc", "print"]) {
      const started = await start({ mode });
      try {
        assert.equal(started.headers.length, 0, `${mode} must not install a header`);
      } finally {
        started.cleanup();
      }
    }
    const child = await start({ child: true });
    try {
      assert.equal(child.headers.length, 0, "a child session must not install a header");
    } finally {
      child.cleanup();
    }
    const off = await start({ ui: { launchScreen: "off" } });
    try {
      assert.equal(off.headers.length, 0, "launchScreen: off disables the header");
    } finally {
      off.cleanup();
    }
  },
]);

tests.push([
  "the menu command follows getCommands: /menu when present, /kit otherwise",
  async () => {
    const reduced = { PI_KIT_REDUCED_MOTION: "1" };
    for (const [noMenu, expected] of [[false, "/menu"], [true, "/kit"]] as const) {
      const started = await start({ noMenu, env: reduced });
      try {
        const factory = headerOf(started);
        const { tui } = makeTui();
        const component = factory(tui, plain as unknown as Theme);
        const lines = component.render(100).join("\n");
        assert.ok(lines.includes(expected), `expected ${expected} in the launch screen`);
        assert.ok(lines.includes("Luna"), "the launch screen still shows Luna");
        component.dispose?.();
      } finally {
        started.cleanup();
      }
    }
  },
]);

// --- timers ------------------------------------------------------------------------------------

tests.push([
  "reduced motion starts no timer, from the environment and from ui.json",
  async () => {
    for (const options of [
      { env: { PI_KIT_REDUCED_MOTION: "1" } },
      { ui: { reducedMotion: true } },
    ] as StartOptions[]) {
      const started = await start(options);
      try {
        const factory = headerOf(started);
        const { tui, count } = makeTui();
        const component = factory(tui, plain as unknown as Theme);
        const first = component.render(80);
        await delay(250);
        assert.equal(count(), 0, "reduced motion never calls requestRender");
        assert.deepEqual(component.render(80), first, "successive renders are identical");
        component.dispose?.();
      } finally {
        started.cleanup();
      }
    }
  },
]);

tests.push([
  "the reveal requests renders, stops itself, and dispose stops it immediately",
  async () => {
    const started = await start();
    try {
      const factory = headerOf(started);
      const { tui, count } = makeTui();
      const component = factory(tui, plain as unknown as Theme);
      await delay(250);
      assert.ok(count() > 0, "the reveal called requestRender");
      await delay(1200);
      const settled = count();
      await delay(300);
      assert.equal(count(), settled, "the timer stops growing after the final frame");
      assert.ok(settled >= 2, "the reveal ran for more than one frame");
      const final = component.render(80).join("\n");
      assert.ok(final.includes("Luna") && final.includes("/menu"), "the final frame is the full launch screen");
      component.dispose?.();
    } finally {
      started.cleanup();
    }

    const disposable = await start();
    try {
      const factory = headerOf(disposable);
      const { tui, count } = makeTui();
      const component = factory(tui, plain as unknown as Theme);
      await delay(250);
      const before = count();
      assert.ok(before > 0, "the reveal is running before dispose");
      component.dispose?.();
      await delay(250);
      assert.equal(count(), before, "dispose stops the reveal immediately");
    } finally {
      disposable.cleanup();
    }
  },
]);

// --- runner ------------------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

restoreEnv();
restoreCi();
restoreTerm();

if (failed > 0) {
  console.error(`\n[launch-screen-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[launch-screen-smoke] all ${tests.length} checks passed`);
