#!/usr/bin/env node
/**
 * The control centre (docs/control-center.md).
 *
 * Layers, all hermetic (temporary HOME/agent dir, no live pi):
 *   - registration: /kit and /helpers once, by control-center; session-helpers no longer owns /kit;
 *     alt+m (or the configured hubKey); nothing in an internal child session;
 *   - the controls registry: register/list/snapshot/unregister;
 *   - the view model: rows, pages, values, search, unavailability;
 *   - dispatch: a fallback row runs only a registered command; prefill rows fill the editor;
 *   - mode routing: the select chain carries a timeout, a timeout cancels, no UI prints every row;
 *   - weakening: refused outside the TUI and in a child session, otherwise run after a terminal yes;
 *     the profile rows and their weakening set match packages/kit/profiles/*.json (firewall.mode auto);
 *   - Doctor: marker/settings drift and the pi version against the kit's pin and floor;
 *   - the built-in name copy matches packages/core/lib/pi-builtins.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as ControlsModule from "../packages/extensions/src/control-center/controls.ts";
import type * as ModelModule from "../packages/extensions/src/control-center/model.ts";
import type * as ValuesModule from "../packages/extensions/src/control-center/values.ts";
import type * as DoctorModule from "../packages/extensions/src/control-center/doctor.ts";
import { headerLine, openHub, type HubDeps, type PageChoice } from "../packages/extensions/src/control-center/hub.ts";
import type { HubRow } from "../packages/extensions/src/control-center/model.ts";
import type { HubValues } from "../packages/extensions/src/control-center/values.ts";
import { PI_BUILTIN_SLASH_COMMANDS as CORE_BUILTINS } from "../packages/core/lib/pi-builtins.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { PROFILES_DIR } from "../packages/core/lib/paths.ts";
import { PI_BUILTIN_SLASH_COMMANDS as HUB_BUILTINS } from "../packages/extensions/src/control-center/builtins.ts";

const restoreEnv = isolateKitEnv();

interface FakeCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}
interface FakeShortcut {
  description?: string;
  handler: (ctx: unknown) => void;
}
interface RecordedSelect {
  title: string;
  options: string[];
  timeout: number | undefined;
}

/** A fake pi API exposing only what control-center uses. */
function makeApi(commands: string[] = []) {
  const registered = new Map<string, FakeCommand>();
  const shortcuts = new Map<string, FakeShortcut>();
  const sent: string[] = [];
  let thinking = "high";
  const api = {
    on: (): void => {
      /* the hub tests do not drive session events; command-menu-smoke covers the autocomplete hook */
    },
    registerCommand: (name: string, command: FakeCommand): void => {
      if (registered.has(name)) throw new Error(`command registered twice: ${name}`);
      registered.set(name, command);
    },
    registerShortcut: (key: string, shortcut: FakeShortcut): void => {
      if (shortcuts.has(key)) throw new Error(`shortcut registered twice: ${key}`);
      shortcuts.set(key, shortcut);
    },
    getCommands: (): Array<{ name: string; source?: string }> => commands.map((name) => ({ name, source: "extension" })),
    sendUserMessage: (text: string): void => {
      sent.push(text);
    },
    getThinkingLevel: (): string => thinking,
    setThinkingLevel: (level: string): void => {
      thinking = level;
    },
  };
  return { api, registered, shortcuts, sent, thinking: () => thinking };
}

type FakeUi = ReturnType<typeof makeUi>;

/**
 * A fake UI context that records dialogs and custom-component options. Each custom() call answers
 * with the next scripted choice (none closes the hub) and records what the component rendered.
 */
function makeUi(script: PageChoice[] = []) {
  const selects: RecordedSelect[] = [];
  const customCalls: Array<{ overlay?: boolean } | undefined> = [];
  const rendered: string[] = [];
  let editor = "";
  const fakeTheme = { fg: (_colour: string, text: string): string => text, bold: (text: string): string => text };
  const ui = {
    select: async (title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> => {
      selects.push({ title, options, timeout: opts?.timeout });
      return undefined;
    },
    confirm: async (): Promise<boolean> => false,
    input: async (): Promise<string | undefined> => undefined,
    notify: (): void => {},
    setEditorText: (text: string): void => {
      editor = text;
    },
    getEditorText: (): string => editor,
    custom: async (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: PageChoice) => void) => unknown,
      options?: { overlay?: boolean },
    ): Promise<PageChoice> => {
      customCalls.push(options);
      let finish: (result: PageChoice) => void = () => {};
      const promise = new Promise<PageChoice>((resolve) => {
        finish = resolve;
      });
      const component = factory({ requestRender: () => {} }, fakeTheme, {}, finish) as { render?: (width: number) => string[] };
      try {
        rendered.push(stripTerminalSequences((component.render?.(120) ?? []).join("\n")));
      } catch {
        rendered.push("");
      }
      finish(script.shift());
      return promise;
    },
  };
  return { ui, selects, customCalls, rendered, editor: () => editor };
}

interface FakeCtx {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  cwd: string;
  ui: FakeUi["ui"];
}

function makeCtx(mode: FakeCtx["mode"], cwd: string, hasUI = mode === "tui" || mode === "rpc"): FakeCtx {
  return { mode, hasUI, cwd, ui: makeUi().ui };
}

async function loadControl(): Promise<(api: unknown) => void> {
  const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
  return mod.default as (api: unknown) => void;
}

/** Load control-center and register it, the way pi would. */
async function registerControl(api: unknown): Promise<void> {
  const register = await loadControl();
  register(api);
}

async function loadControlsModule(): Promise<typeof ControlsModule> {
  return loadModule<typeof ControlsModule>("extensions/control-center/controls.ts");
}

async function loadModelModule(): Promise<typeof ModelModule> {
  return loadModule<typeof ModelModule>("extensions/control-center/model.ts");
}

async function loadValuesModule(): Promise<typeof ValuesModule> {
  return loadModule<typeof ValuesModule>("extensions/control-center/values.ts");
}

async function loadDoctorModule(): Promise<typeof DoctorModule> {
  return loadModule<typeof DoctorModule>("extensions/control-center/doctor.ts");
}

interface DepsOptions {
  model: ModelModule.HubModel;
  commands: string[];
  ctx?: FakeCtx;
  values?: HubValues;
  sent?: string[];
  prefill?: string[];
  confirmed?: boolean;
  isChild?: boolean;
  write?: (text: string) => void;
}

/** Build hub deps for a direct openHub/dispatchRow test. */
function makeDeps(o: DepsOptions): HubDeps {
  return {
    ctx: (o.ctx ?? makeCtx("tui", process.cwd())) as unknown as HubDeps["ctx"],
    model: o.model,
    values: o.values ?? { securityMissing: true },
    commands: o.commands,
    sendCommand: (text) => {
      o.sent?.push(text);
    },
    prefill: (text) => {
      o.prefill?.push(text);
    },
    confirm: async () => o.confirmed ?? false,
    write: (text) => {
      o.write?.(text);
    },
    notify: () => {},
    doctor: () => [],
    allCommands: () => [],
    isChild: o.isChild ?? false,
  };
}

/** Build a model over the fallback table with the given commands. */
async function modelFor(commands: string[], values: HubValues = { securityMissing: true }): Promise<ModelModule.HubModel> {
  const modelMod = await loadModelModule();
  return modelMod.buildModel({ values, commands, controls: [] });
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [];

// --- registration ------------------------------------------------------------------------------

tests.push([
  "/kit and /helpers are registered once, by control-center, with alt+m",
  async () => {
    const { api, registered, shortcuts } = makeApi();
    await registerControl(api);
    assert.ok(registered.has("kit"), "/kit must be registered");
    assert.ok(registered.has("helpers"), "/helpers must be registered");
    assert.ok(shortcuts.has("alt+m"), "alt+m must be registered by default");
    assert.equal(registered.size, 2, "control-center registers exactly /kit and /helpers");
  },
]);

tests.push([
  "session-helpers no longer registers /kit or /helpers",
  async () => {
    const pi = fakePi();
    const register = await loadExtension<(api: unknown) => void>("extensions/session-helpers/index.ts");
    register(pi.api);
    assert.ok(!pi.commands.has("kit"), "session-helpers must not register /kit");
    assert.ok(!pi.commands.has("helpers"), "session-helpers must not register /helpers");
    assert.ok(pi.commands.has("clear"), "session-helpers keeps its own commands");
  },
]);

tests.push([
  "hubKey in pi-kit/ui.json changes the shortcut and the file is not rewritten",
  async () => {
    const ws = tmpWorkspace("pi-kit-hubkey-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      const dir = path.join(ws, "pi-kit");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "ui.json");
      const original = JSON.stringify({ hubKey: "alt+x", footer: true, mode: "heavy" }, null, 2);
      fs.writeFileSync(file, original);
      const { api, shortcuts } = makeApi();
      await registerControl(api);
      assert.ok(shortcuts.has("alt+x"), "the configured hubKey must be registered");
      assert.equal(fs.readFileSync(file, "utf8"), original, "the hub must not rewrite other keys");
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "nothing registers in an internal child session",
  async () => {
    const restore = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      const { api, registered, shortcuts } = makeApi();
      await registerControl(api);
      assert.equal(registered.size, 0, "a child session gets no hub commands");
      assert.equal(shortcuts.size, 0, "a child session gets no hub shortcut");
    } finally {
      restore();
    }
  },
]);

// --- registry ----------------------------------------------------------------------------------

tests.push([
  "the controls registry registers, lists, snapshots and unregisters",
  async () => {
    const { resetControls, getOrCreateControls, getControls } = await loadControlsModule();
    resetControls();
    const registry = getOrCreateControls();
    assert.equal(getControls(), registry, "the same registry is returned");
    const off = registry.register({ id: "effort", group: "levels", label: "Effort", legacy: "/effort", value: () => "E3 standard" });
    assert.deepEqual(registry.list().map((c) => c.id), ["effort"]);
    assert.deepEqual(registry.snapshot(), { effort: "E3 standard" });
    off();
    assert.equal(registry.list().length, 0);
    resetControls();
  },
]);

// --- view model --------------------------------------------------------------------------------

tests.push([
  "the view model carries rows, values, pages and search",
  async () => {
    const modelMod = await loadModelModule();
    const model = modelMod.buildModel({
      values: { profile: "balanced", effort: "E3 standard", thinking: "high", security: "balanced", securityMissing: false, approvals: "auto/coding" },
      commands: ["auto", "effort", "console"],
      controls: [],
    });
    const main = modelMod.pageRows(model, "main");
    assert.equal(main.length, 10, "the main page has the levels, the Security level fallback and four page rows");
    assert.equal(modelMod.parentPage(model, "delegation"), "work");
    const approvals = modelMod.findRow(model, "approvals");
    assert.equal(approvals?.value, "auto/coding");
    assert.equal(approvals?.available, true);
    const improve = modelMod.findRow(model, "improve.arm");
    assert.equal(improve?.available, false);
    assert.match(improve?.unavailableReason ?? "", /self-improving/);
    assert.equal(modelMod.legacyCommandName("/auto on"), "auto");
    assert.equal(modelMod.searchRows(model, "auto").length > 0, true);
    assert.match(headerLine({ profile: "balanced", effort: "E3", securityMissing: true }), /profile balanced/);
  },
]);

tests.push([
  "no fallback row dispatches a pi built-in; a built-in is pre-filled in the editor instead",
  async () => {
    // pi.getCommands() lists only extension commands, prompt templates and skills, and
    // sendUserMessage runs only extension commands, so a typed built-in would always show as
    // unavailable (or reach the model as text).
    const modelMod = await loadModelModule();
    const builtins = new Set<string>(CORE_BUILTINS);
    const dispatched = modelMod.ROWS.filter((row) => row.legacy !== undefined && builtins.has(modelMod.legacyCommandName(row.legacy)));
    assert.deepEqual(dispatched.map((row) => row.id), [], "rows whose typed command is a pi built-in");
    const compact = modelMod.ROWS.find((row) => row.id === "compact");
    assert.equal(compact?.prefill, "/compact ");
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: [], controls: [] });
    assert.equal(modelMod.findRow(model, "compact")?.available, true, "a pre-fill row needs no registered command");
  },
]);

tests.push([
  "the control-center built-in copy matches packages/core/lib/pi-builtins.ts",
  async () => {
    assert.deepEqual([...HUB_BUILTINS], [...CORE_BUILTINS], "the hub's built-in list must match the core copy");
  },
]);

tests.push([
  "the Security row reads the firewall's registry, and says the firewall is not loaded without it",
  async () => {
    const valuesMod = await loadValuesModule();
    const securityKey = Symbol.for("pi-kit.security");
    const global = globalThis as Record<symbol, unknown>;
    try {
      Reflect.deleteProperty(globalThis, securityKey);
      const missing = valuesMod.readSecurity();
      assert.equal(missing.missing, true);
      assert.equal(missing.effective, valuesMod.NO_FIREWALL);
      global[securityKey] = { snapshot: () => { throw new Error("broken"); } };
      assert.equal(valuesMod.readSecurity().missing, true, "a registry that throws reads as missing");

      // A floor (the pentest policy) raises the operator's balanced to guarded.
      global[securityKey] = { snapshot: () => ({ requested: "balanced", effective: "guarded", source: "operator" }) };
      const fromRegistry = valuesMod.readSecurity();
      assert.equal(fromRegistry.missing, false);
      assert.equal(fromRegistry.effective, "guarded");
      assert.equal(fromRegistry.requested, "balanced");
      const ws = tmpWorkspace("pi-kit-hub-security-");
      try {
        assert.equal(valuesMod.readValues({ cwd: ws }).security, "guarded (requested balanced)");
      } finally {
        rmWorkspace(ws);
      }
    } finally {
      Reflect.deleteProperty(globalThis, securityKey);
    }
  },
]);

tests.push([
  "the Security level row is disabled while /security is not registered (no firewall loaded)",
  async () => {
    const modelMod = await loadModelModule();
    const hubMod = await loadModule<{ dispatchRow: (row: HubRow, deps: HubDeps) => Promise<{ ok: boolean; note?: string }> }>(
      "extensions/control-center/hub.ts",
    );
    const without = modelMod.buildModel({ values: { security: "not enforced (tool-firewall not loaded)", securityMissing: true }, commands: ["auto"], controls: [] });
    assert.equal(modelMod.findRow(without, "security")?.description, "the tool-firewall extension is not loaded");
    const disabled = modelMod.findRow(without, "security.level");
    assert.ok(disabled);
    assert.equal(disabled.available, false);
    assert.equal(disabled.unavailableReason, "the tool-firewall extension is not loaded");
    assert.equal(disabled.value, "not enforced (tool-firewall not loaded)");
    const refused = await hubMod.dispatchRow(disabled, makeDeps({ model: without, commands: ["auto"] }));
    assert.equal(refused.ok, false);
    assert.match(refused.note ?? "", /tool-firewall extension is not loaded/);

    const withSecurity = modelMod.buildModel({ values: { security: "guarded", securityMissing: false }, commands: ["security"], controls: [] });
    const enabled = modelMod.findRow(withSecurity, "security.level");
    assert.ok(enabled);
    assert.equal(enabled.available, true);
    const sent: string[] = [];
    const dispatched = await hubMod.dispatchRow(enabled, makeDeps({ model: withSecurity, commands: ["security"], sent }));
    assert.equal(dispatched.ok, true);
    assert.deepEqual(sent, ["/security"]);
  },
]);

// --- dispatch ----------------------------------------------------------------------------------

tests.push([
  "a fallback row runs its command only when it is registered",
  async () => {
    const modelMod = await loadModelModule();
    const hubMod = await loadModule<{ dispatchRow: (row: HubRow, deps: HubDeps, value?: string) => Promise<{ ok: boolean }> }>(
      "extensions/control-center/hub.ts",
    );
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: ["auto"], controls: [] });
    const sent: string[] = [];
    const deps = makeDeps({ model, commands: ["auto"], sent, confirmed: true });
    const approvals = modelMod.findRow(model, "approvals");
    assert.ok(approvals);
    const dispatched = await hubMod.dispatchRow(approvals, deps);
    assert.equal(dispatched.ok, true);
    assert.deepEqual(sent, ["/auto"]);

    const unavailable = modelMod.findRow(model, "improve.arm");
    assert.ok(unavailable);
    const refused = await hubMod.dispatchRow(unavailable, deps);
    assert.equal(refused.ok, false);
  },
]);

tests.push([
  "a built-in picker row pre-fills the editor",
  async () => {
    const modelMod = await loadModelModule();
    const hubMod = await loadModule<{ dispatchRow: (row: HubRow, deps: HubDeps) => Promise<{ ok: boolean }> }>("extensions/control-center/hub.ts");
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: ["new"], controls: [] });
    const prefill: string[] = [];
    const deps = makeDeps({ model, commands: ["new"], prefill });
    const row = modelMod.findRow(model, "session.new");
    assert.ok(row);
    const result = await hubMod.dispatchRow(row, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(prefill, ["/new "]);
  },
]);

// --- mode routing ------------------------------------------------------------------------------

tests.push([
  "RPC uses the select chain and every dialog carries a timeout",
  async () => {
    const model = await modelFor(["auto"]);
    const recorded = makeUi();
    const ctx = { mode: "rpc" as const, hasUI: true, cwd: process.cwd(), ui: recorded.ui };
    const sent: string[] = [];
    await openHub(makeDeps({ model, commands: ["auto"], ctx, sent }));
    assert.ok(recorded.selects.length >= 1, "the hub opened a select dialog");
    for (const select of recorded.selects) assert.equal(select.timeout, 60_000, "every dialog carries a timeout");
    assert.deepEqual(sent, [], "a timeout/cancel dispatches nothing");
  },
]);

tests.push([
  "print mode writes every row and its typed command",
  async () => {
    const model = await modelFor(["auto", "effort"]);
    const captured: string[] = [];
    const ctx = makeCtx("print", process.cwd(), false);
    await openHub(makeDeps({ model, commands: ["auto", "effort"], ctx, write: (text) => captured.push(text) }));
    const page = captured.join("");
    assert.match(page, /Control centre/);
    assert.match(page, /Effort/);
    assert.match(page, /\[\/effort\]/);
    assert.match(page, /\[\/auto\]/);
  },
]);

tests.push([
  "the TUI renderer builds a SettingsList and passes overlay only on 1.3.0+",
  async () => {
    initTheme();
    const model = await modelFor([]);
    const recorded = makeUi();
    const ctx = { mode: "tui" as const, hasUI: true, cwd: process.cwd(), ui: recorded.ui };
    await openHub(makeDeps({ model, commands: [], ctx }));
    assert.equal(recorded.customCalls.length, 1, "the TUI renderer opened one custom component");
    assert.equal(recorded.customCalls[0]?.overlay, true, "pi 1.3.0 opens the hub as an overlay");
  },
]);

tests.push([
  "in the TUI a row that runs a typed command or fills the editor closes the hub",
  async () => {
    initTheme();
    const model = await modelFor(["auto"]);
    // pi.sendUserMessage returns before /auto runs: a reopened hub would sit on top of its dialog.
    const typed = makeUi([{ id: "approvals" }]);
    const sent: string[] = [];
    await openHub(makeDeps({ model, commands: ["auto"], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: typed.ui }, sent }), "autonomy");
    assert.deepEqual(sent, ["/auto"]);
    assert.equal(typed.customCalls.length, 1, "the hub closed after handing over to /auto");

    const editor = makeUi([{ id: "session.new" }]);
    const prefill: string[] = [];
    await openHub(makeDeps({ model, commands: ["auto"], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: editor.ui }, prefill }), "session");
    assert.deepEqual(prefill, ["/new "]);
    assert.equal(editor.customCalls.length, 1, "the hub closed so the editor gets the keyboard");
  },
]);

tests.push([
  "after an in-place change the hub reopens on the same row and shows the new value",
  async () => {
    initTheme();
    const modelMod = await loadModelModule();
    const recorded = makeUi([{ id: "thinking", value: "high" }]);
    const deps = makeDeps({ model: await modelFor([]), commands: [], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: recorded.ui } });
    let thinking = "medium";
    const build = () => {
      const values = { ...deps.values, thinking };
      return { values, model: modelMod.buildModel({ values, commands: [], controls: [] }) };
    };
    Object.assign(deps, build(), {
      setThinkingLevel: (level: string) => {
        thinking = level;
      },
      refresh: build,
    });
    await openHub(deps);
    assert.equal(thinking, "high");
    assert.equal(recorded.customCalls.length, 2, "the hub reopened after the in-place change");
    assert.match(recorded.rendered[0] ?? "", /Thinking\s+medium/);
    assert.match(recorded.rendered[1] ?? "", /Thinking\s+high/, "the reopened page reads the values again");
    assert.match(recorded.rendered[1] ?? "", /→ Thinking/, "the cursor stays on the changed row");
  },
]);

tests.push([
  "Back returns the cursor to the row that opened the page",
  async () => {
    initTheme();
    const recorded = makeUi(["back"]);
    await openHub(makeDeps({ model: await modelFor([]), commands: [], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: recorded.ui } }), "autonomy");
    assert.equal(recorded.customCalls.length, 2);
    assert.match(recorded.rendered[1] ?? "", /→ Autonomy/);
  },
]);

// --- weakening ---------------------------------------------------------------------------------

/** Profile name -> firewall.mode, read from the shipped profile files. */
function shippedFirewallModes(): Map<string, string> {
  const modes = new Map<string, string>();
  for (const file of fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const profile = parseJson(fs.readFileSync(path.join(PROFILES_DIR, file), "utf8"));
    const firewall = isRecord(profile) ? profile.firewall : undefined;
    const mode = isRecord(firewall) && typeof firewall.mode === "string" ? firewall.mode : "";
    modes.set(file.replace(/\.json$/, ""), mode);
  }
  return modes;
}

tests.push([
  "the hub's profile rows and weakening set match the shipped profiles' firewall.mode",
  async () => {
    const modelMod = await loadModelModule();
    const modes = shippedFirewallModes();
    assert.ok(modes.size > 0, "packages/kit/profiles has profile files");
    const autoProfiles = [...modes].filter(([, mode]) => mode === "auto").map(([name]) => name).sort();
    assert.deepEqual([...modelMod.AUTO_DEFAULT_PROFILES].sort(), autoProfiles, "AUTO_DEFAULT_PROFILES is exactly the profiles whose firewall.mode is auto");
    const rows = modelMod.ROWS.filter((row) => row.page === "profiles");
    assert.deepEqual(rows.map((row) => row.id.replace(/^profile\./, "")).sort(), [...modes.keys()], "one hub row per shipped profile, and no other");
    for (const row of rows) {
      const auto = modes.get(row.id.replace(/^profile\./, "")) === "auto";
      assert.equal(row.risk, auto ? "weakening" : "none", `${row.id}: weakening exactly when the profile's firewall default is auto`);
      assert.equal(row.label.includes("(auto approvals)"), auto, `${row.id}: the "(auto approvals)" label matches the profile's firewall default`);
    }
  },
]);

tests.push([
  "a weakening row is refused outside the TUI and in a child session",
  async () => {
    const hubMod = await loadModule<{ dispatchRow: (row: HubRow, deps: HubDeps) => Promise<{ ok: boolean; note?: string }> }>(
      "extensions/control-center/hub.ts",
    );
    const modelMod = await loadModelModule();
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: ["auto", "improve"], controls: [] });
    const row = modelMod.findRow(model, "approvals.auto");
    assert.ok(row);
    const sent: string[] = [];
    const outside = await hubMod.dispatchRow(row, makeDeps({ model, commands: ["auto"], sent, ctx: makeCtx("rpc", process.cwd()), confirmed: true }));
    assert.equal(outside.ok, false);
    assert.match(outside.note ?? "", /terminal/);
    const child = await hubMod.dispatchRow(row, makeDeps({ model, commands: ["auto"], sent, isChild: true, confirmed: true }));
    assert.equal(child.ok, false);
    assert.deepEqual(sent, [], "a refused weakening row dispatches nothing");
  },
]);

tests.push([
  "a weakening row in the TUI runs only after the terminal confirm says yes",
  async () => {
    const hubMod = await loadModule<{
      dispatchRow: (row: HubRow, deps: HubDeps) => Promise<{ ok: boolean }>;
      terminalConfirm: (ui: object) => (title: string, detail: string) => Promise<boolean>;
    }>("extensions/control-center/hub.ts");
    // The terminal question starts on "No" (pi's confirm starts on "Yes"), and goes to the
    // terminal's own select when a phone mirror is installed.
    const offered: string[][] = [];
    const terminalSelect = async (_title: string, options: string[]) => { offered.push(options); return options[0]; };
    const mirrored = { select: async (_title: string, options: string[]) => options[1] };
    Object.defineProperty(mirrored, Symbol.for("pi-system.remote-control.mirror"), { value: { select: terminalSelect } });
    assert.equal(await hubMod.terminalConfirm(mirrored)("Start the web console", "Opens a local network listener"), false);
    assert.match(offered[0]?.[0] ?? "", /^No, /);
    const modelMod = await loadModelModule();
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: ["auto", "console"], controls: [] });
    const row = modelMod.findRow(model, "console.start");
    assert.ok(row);
    const sent: string[] = [];
    const no = await hubMod.dispatchRow(row, makeDeps({ model, commands: ["console"], sent, confirmed: false }));
    assert.equal(no.ok, false);
    assert.deepEqual(sent, []);
    const yes = await hubMod.dispatchRow(row, makeDeps({ model, commands: ["console"], sent, confirmed: true }));
    assert.equal(yes.ok, true);
    assert.deepEqual(sent, ["/console start"]);
    // "/auto on" asks at the terminal itself, so the hub hands it over without a second question,
    // and still refuses it outside the TUI.
    const auto = modelMod.findRow(model, "approvals.auto");
    assert.ok(auto);
    const handed: string[] = [];
    assert.equal((await hubMod.dispatchRow(auto, makeDeps({ model, commands: ["auto"], sent: handed, confirmed: false }))).ok, true);
    assert.deepEqual(handed, ["/auto on"]);
    const rpc = await hubMod.dispatchRow(auto, makeDeps({ model, commands: ["auto"], sent: handed, confirmed: true, ctx: makeCtx("rpc", process.cwd()) }));
    assert.equal(rpc.ok, false);
    assert.deepEqual(handed, ["/auto on"]);
  },
]);

// --- doctor ------------------------------------------------------------------------------------

tests.push([
  "the Doctor reports marker/settings drift and the pi version against the pin",
  async () => {
    const doctor = await loadDoctorModule();
    const values = await loadValuesModule();
    const ws = tmpWorkspace("pi-kit-doctor-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      fs.writeFileSync(path.join(ws, ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "global", companions: ["npm:pi-subagents@0.73.1"] }));
      const settingsFile = path.join(ws, "settings.json");
      fs.writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: "npm:pi-lens@3.8.63" }] }));
      const marker = values.readMarker(ws);
      const lines = doctor.doctorLines({
        marker,
        piVersion: "1.3.0",
        kitVersion: "0.2.4-beta.3",
        kitTestedPin: "1.3.0",
        kitFloor: ">=0.85.1",
        settingsFile,
        registries: { protections: 3, effort: "E3 standard" },
      });
      const companions = lines.find((line) => line.label === "Companions");
      assert.equal(companions?.ok, false);
      assert.match(companions?.value ?? "", /pi-subagents/);
      assert.equal(lines.find((line) => line.label === "pi")?.ok, true, "pi matches the tested pin and is above the floor");
      const drifted = doctor.doctorLines({
        marker,
        piVersion: "1.5.0",
        kitVersion: "0.2.4-beta.3",
        kitTestedPin: "1.3.0",
        kitFloor: ">=0.85.1",
        settingsFile,
        registries: { protections: 3 },
      });
      assert.equal(drifted.find((line) => line.label === "pi")?.ok, false, "a pi version off the pin is reported");
      for (const line of lines) assert.ok(line.command.startsWith("/"), "every Doctor line names a command");
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

/** Run the registered `/kit <page>` over RPC and return the first dialog's options (one per row). */
async function rpcPageOptions(page: string, cwd: string): Promise<string[]> {
  const { api, registered } = makeApi();
  await registerControl(api);
  const recorded = makeUi();
  const ctx = { mode: "rpc" as const, hasUI: true, cwd, ui: recorded.ui };
  await registered.get("kit")?.handler(page, ctx);
  return recorded.selects[0]?.options ?? [];
}

tests.push([
  "the Doctor checks a global marker against the global settings.json, not a project one",
  async () => {
    const ws = tmpWorkspace("pi-kit-doctor-scope-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      fs.writeFileSync(path.join(ws, ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "global", companions: ["npm:pi-lens@4.4.4"] }));
      fs.writeFileSync(path.join(ws, "settings.json"), JSON.stringify({ packages: ["npm:pi-lens@4.4.4"] }));
      // A project with its own settings.json (no packages) but no project marker.
      const project = path.join(ws, "project");
      fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
      const options = await rpcPageOptions("doctor", project);
      const companions = options.find((option) => option.includes("Companions"));
      assert.equal(companions, "Companions: 1 recorded and registered", "a global marker is compared with the global settings.json");
      // A project marker is compared with the project settings.json.
      fs.writeFileSync(path.join(project, ".pi", ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "project", companions: ["npm:pi-lens@4.4.4"] }));
      const projectOptions = await rpcPageOptions("doctor", project);
      assert.match(projectOptions.find((option) => option.includes("Companions")) ?? "", /^! Companions: 1 recorded, but settings\.json lists no packages$/);
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "Doctor rows keep the drift flag and show the security level the firewall publishes",
  async () => {
    const ws = tmpWorkspace("pi-kit-doctor-flag-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    const securityKey = Symbol.for("pi-kit.security");
    const global = globalThis as Record<symbol, unknown>;
    const previous = global[securityKey];
    try {
      global[securityKey] = { snapshot: () => ({ effective: "strict" }) };
      const options = await rpcPageOptions("doctor", ws);
      // No protections registry is published in this process, so the Protections line is a drift.
      assert.ok(options.includes("! Protections: 0 recorded"), `a drift line is marked: ${options.join(" | ")}`);
      assert.ok(options.some((option) => option.startsWith("Kit: ")), "a healthy line carries no marker");
      assert.ok(options.includes("Security: strict"), "the Doctor shows the firewall's security level");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, securityKey);
      else global[securityKey] = previous;
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "the Help page and the /kit description name the configured hubKey",
  async () => {
    const ws = tmpWorkspace("pi-kit-hubkey-help-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      const defaults = await rpcPageOptions("help", ws);
      assert.ok(defaults.includes("Open: /kit, /helpers, or the alt+m key"), defaults.join(" | "));
      fs.mkdirSync(path.join(ws, "pi-kit"), { recursive: true });
      fs.writeFileSync(path.join(ws, "pi-kit", "ui.json"), JSON.stringify({ hubKey: "alt+k" }));
      const options = await rpcPageOptions("help", ws);
      assert.ok(options.includes("Open: /kit, /helpers, or the alt+k key"), options.join(" | "));
      const { api, registered } = makeApi();
      await registerControl(api);
      assert.match(registered.get("kit")?.description ?? "", /\(also alt\+k\)$/);
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "the Thinking row offers off",
  async () => {
    const model = await modelFor([]);
    const modelMod = await loadModelModule();
    const thinking = modelMod.findRow(model, "thinking");
    assert.equal(thinking?.values?.[0], "off", `Thinking values: ${thinking?.values?.join(", ")}`);
  },
]);

tests.push([
  "the install marker prefers the project marker over the global one",
  async () => {
    const values = await loadValuesModule();
    const ws = tmpWorkspace("pi-kit-marker-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      fs.writeFileSync(path.join(ws, ".pi-kit.json"), JSON.stringify({ profile: "global" }));
      const project = path.join(ws, "project", ".pi");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, ".pi-kit.json"), JSON.stringify({ profile: "project" }));
      assert.equal(values.readMarker(path.join(ws, "project")).profile, "project");
      assert.equal(values.readMarker(path.join(ws, "elsewhere")).profile, "global");
    } finally {
      restore();
      rmWorkspace(ws);
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

if (failed > 0) {
  console.error(`\n[control-center-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[control-center-smoke] all ${tests.length} checks passed`);
