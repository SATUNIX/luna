#!/usr/bin/env node
/**
 * The Luna launch screen (docs/control-center.md), behaviour only: what counts as on, off or failed,
 * that opt-outs start no timer, and the `ctx.ui.setHeader` wiring. It never pins art, wording or layout, so the screen can be redesigned.
 *
 * Hermetic: temporary agent dir, fake pi API, plain theme, and real timers only where the reveal
 * itself is under test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as LaunchModule from "../packages/extensions/src/control-center/launch-screen.ts";
import type * as BootModule from "../packages/extensions/src/control-center/boot-status.ts";

type HeaderFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

const restoreEnv = isolateKitEnv();
const restoreCi = setEnv("CI", undefined);
const restoreTerm = setEnv("TERM", "xterm-256color");

/** A plain Theme fake whose name drives the automatic ASCII choice. */
function themeNamed(name: string): Theme {
  return { name, fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
}

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
    terminal: { rows: 40 },
    requestRender: (): void => {
      requested += 1;
    },
  } as unknown as TUI;
  return { tui, count: () => requested };
}

interface StartOptions {
  /** Omit the property for a TUI; `mode: undefined` models an older pi without `ctx.mode`. */
  mode?: string | undefined;
  /** Overrides the derived flag, so `mode: undefined` can be paired with either value. */
  hasUI?: boolean;
  ui?: Record<string, unknown>;
  child?: boolean;
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
  const mode = "mode" in options ? options.mode : "tui";
  const hasUI = options.hasUI ?? (mode === "tui" || mode === "rpc");
  await handler({}, { mode, hasUI, cwd: dir, ui });
  return { headers, cleanup };
}

function headerOf(started: Started): HeaderFactory {
  assert.equal(started.headers.length, 1, "exactly one header factory is installed");
  const factory = started.headers[0];
  assert.ok(factory, "the header factory was captured");
  return factory;
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [];

tests.push([
  "extensions are on, off or failed from the marker, the manifests and what pi registered",
  async () => {
    const boot = await loadModule<typeof BootModule>("extensions/control-center/boot-status.ts");
    const shipped = [
      { name: "a", registers: true },
      { name: "b", registers: true, offSwitch: { env: "B_SWITCH", values: ["0"] } },
      { name: "c", registers: false },
      { name: "d", registers: true },
    ];
    const items = boot.classify(["a", "b", "c", "ext-only"], shipped, new Set(["a"]));
    const state = (name: string): string | undefined => items.find((item) => item.name === name)?.state;
    assert.equal(state("a"), "ok");
    assert.equal(state("b"), "fail", "enabled, promised a registration, registered none");
    assert.equal(state("c"), "ok", "an extension that registers nothing cannot fail that way");
    assert.equal(state("d"), "off");
    assert.equal(state("ext-only"), "ok", "a companion with no manifest is trusted");
    const switched = boot.classify(["b"], shipped, new Set(), { B_SWITCH: "0" });
    assert.equal(switched.find((item) => item.name === "b")?.state, "idle", "the extension's own off switch, when set, is a deliberate opt-out, not a failure");
    assert.equal(boot.classify(["b"], shipped, new Set(), { B_SWITCH: "1" }).find((item) => item.name === "b")?.state, "fail", "only the declared off value counts");
    assert.equal(boot.classify(["a"], [{ name: "a", registers: true }], new Set(), { A_ANYTHING: "0", PI_KIT_AUTO_MODE: "1" }).find((item) => item.name === "a")?.state, "fail", "an env var that is not a declared off switch never hides a failure");
    // The shipped kit: a mandatory protection that registered nothing is a failure whatever the environment says,
    // and only tool-capture (PI_KIT_CAPTURE=0) can show as idle.
    const real = boot.readShipped(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const everything = { PI_KIT_AUTO_MODE: "1", PI_KIT_UNATTENDED: "1", PI_KIT_CAPTURE: "0", PI_KIT_ORCH_DISABLE: "1", PI_KIT_UPDATE_CHECK: "0" };
    for (const name of ["tool-firewall", "secret-guard", "protected-paths"]) {
      if (real.find((entry) => entry.name === name)?.registers !== true) continue; // registers no command or tool: nothing to miss
      assert.equal(boot.classify([name], real, new Set(), everything).find((item) => item.name === name)?.state, "fail", `${name} registered nothing: a failure, never idle`);
    }
    assert.equal(boot.classify(["tool-capture"], real, new Set(), everything).find((item) => item.name === "tool-capture")?.state, "idle");
    assert.equal(boot.classify(["b"], shipped, new Set(), { B_SWITCH: "/some/dir" }).find((item) => item.name === "b")?.state, "fail", "a non-switch value does not hide a failure");
    assert.equal(boot.extensionNameOf("/x/packages/extensions/src/effort/index.ts"), "effort");
    assert.equal(boot.extensionNameOf("builtin:read"), undefined);
  },
]);

tests.push([
  "opt-outs are honoured and start no timer; animation stops itself and on dispose",
  async () => {
    const launch = await loadLaunch();
    assert.equal(launch.isReducedMotion(undefined), false, "the default is animation");
    assert.equal(launch.isReducedMotion({ reducedMotion: true }), true);
    for (const [name, value] of [["PI_KIT_REDUCED_MOTION", "1"], ["TERM", "dumb"], ["CI", "1"], ["NO_COLOR", "1"]] as const) {
      const restore = setEnv(name, value);
      try {
        assert.equal(launch.isReducedMotion(undefined), true, `${name} turns animation off`);
      } finally {
        restore();
      }
    }
    const info = () => ({ version: "pi 1", hubKey: "alt+m", menuCmd: "/menu", facts: [], items: [{ name: "x", state: "ok" as const }] });
    const still = makeTui();
    const stillHeader = launch.launchHeader({ info, ascii: false, reducedMotion: true })(still.tui, themeNamed("dark"));
    await delay(launch.REVEAL_FRAME_MS * 3);
    assert.equal(still.count(), 0, "reduced motion never requests a render");
    stillHeader.dispose?.();

    const live = makeTui();
    const liveHeader = launch.launchHeader({ info, ascii: false, reducedMotion: false })(live.tui, themeNamed("dark"));
    await delay(launch.REVEAL_FRAME_MS * (launch.REVEAL_FRAMES + 3));
    const settled = live.count();
    assert.ok(settled > 0, "the reveal renders frames");
    await delay(launch.REVEAL_FRAME_MS * 3);
    assert.equal(live.count(), settled, "the timer stopped itself");
    liveHeader.dispose?.();
  },
]);

tests.push([
  "a TUI session installs one header; rpc, print, a child and launchScreen off install none",
  async () => {
    const tui = await start();
    try {
      assert.equal(tui.headers.length, 1);
      const component = headerOf(tui)(makeTui().tui, themeNamed("dark"));
      assert.ok(component.render(100).length > 0);
      component.dispose?.();
    } finally {
      tui.cleanup();
    }
    for (const options of [{ mode: "rpc" }, { mode: "print" }, { child: true }, { ui: { launchScreen: "off" } }]) {
      const started = await start(options);
      try {
        assert.equal(started.headers.length, 0, JSON.stringify(options));
      } finally {
        started.cleanup();
      }
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
