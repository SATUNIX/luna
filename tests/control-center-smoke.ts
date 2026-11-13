#!/usr/bin/env node
/**
 * The control centre (docs/control-center.md).
 *
 * Layers, all hermetic (temporary HOME/agent dir, no live pi):
 *   - registration: /menu once, by control-center;
 *     alt+m (or the configured hubKey); nothing in an internal child session;
 *   - the controls registry: register/list/snapshot/unregister;
 *   - the view model: rows, pages, values, search, unavailability;
 *   - dispatch: a fallback row runs only a registered command; prefill rows fill the editor;
 *   - mode routing: the select chain carries a timeout, a timeout cancels, no UI prints every row;
 *   - weakening: refused outside the TUI and in a child session, otherwise run after a terminal yes;
 *     the profile rows and their weakening set match packages/kit/profiles/*.json (firewall.mode auto);
 *   - Doctor: marker/settings drift and the pi version against the kit's pin and floor;
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initTheme, type Theme, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type { OverlayTheme } from "../packages/extensions/src/control-center/overlay-frame.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as ControlsModule from "../packages/extensions/src/control-center/controls.ts";
import type * as ModelModule from "../packages/extensions/src/control-center/model.ts";
import type * as ValuesModule from "../packages/extensions/src/control-center/values.ts";
import type * as DoctorModule from "../packages/extensions/src/control-center/doctor.ts";
import { headerLine, openHub, rowsForPage, supportsOverlay, type HubDeps, type PageChoice } from "../packages/extensions/src/control-center/hub.ts";
import type { HubRow } from "../packages/extensions/src/control-center/model.ts";
import type { HubValues } from "../packages/extensions/src/control-center/values.ts";
import { PI_BUILTIN_SLASH_COMMANDS as CORE_BUILTINS } from "../packages/core/lib/pi-builtins.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { PROFILES_DIR } from "../packages/core/lib/paths.ts";
import { HIDDEN_CHARS, isHiddenChar, oneVisibleLine, stripHiddenChars } from "../packages/core/shared/visible-text.ts";

const restoreEnv = isolateKitEnv();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
function makeUi(script: PageChoice[] = [], selectScript: Array<string | undefined> = [], terminalRows?: number, renderWidth = 120) {
  const selects: RecordedSelect[] = [];
  const customCalls: Array<{ overlay?: boolean } | undefined> = [];
  const rendered: string[] = [];
  let editor = "";
  const fakeTheme = { fg: (_colour: string, text: string): string => text, bold: (text: string): string => text };
  // Only a test that names terminal rows gets one; the rest keep the original terminal-less fake.
  const fakeTui = terminalRows === undefined ? { requestRender: () => {} } : { requestRender: () => {}, terminal: { rows: terminalRows } };
  const ui = {
    select: async (title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> => {
      selects.push({ title, options, timeout: opts?.timeout });
      return selectScript.length > 0 ? selectScript.shift() : undefined;
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
      const component = factory(fakeTui, fakeTheme, {}, finish) as { render?: (width: number) => string[] };
      try {
        rendered.push(stripTerminalSequences((component.render?.(renderWidth) ?? []).join("\n")));
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
  allCommands?: Array<{ name: string; source: string }>;
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
    allCommands: () => o.allCommands ?? [],
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
  "/menu is registered once, by control-center, with alt+m sending /menu",
  async () => {
    const { api, registered, shortcuts, sent } = makeApi();
    await registerControl(api);
    assert.ok(registered.has("menu"), "/menu must be registered as the primary command");
    assert.ok(shortcuts.has("alt+m"), "alt+m must be registered by default");
    assert.deepEqual([...registered.keys()].sort(), ["menu", "status"], "control-center registers /menu and /status");
    shortcuts.get("alt+m")?.handler(undefined);
    assert.deepEqual(sent, ["/menu"], "the alt+m shortcut sends /menu");
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
  "an invalid hubKey falls back to alt+m with one warning",
  async () => {
    const ws = tmpWorkspace("pi-kit-hubkey-invalid-space-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    const captured: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    Object.defineProperty(process.stderr, "write", { value: capture, configurable: true, writable: true });
    try {
      const dir = path.join(ws, "pi-kit");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "ui.json"), JSON.stringify({ hubKey: "alt m\n" }));
      const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
      assert.equal(mod.readHubKey(), "alt+m", "a value with internal whitespace falls back to alt+m");
      const { api, shortcuts } = makeApi();
      await registerControl(api);
      assert.ok(shortcuts.has("alt+m"), "the default shortcut is registered");
      assert.equal(shortcuts.size, 1, "the invalid raw key is not registered");
      assert.equal(captured.filter((line) => line.includes("control-center:")).length, 1, "the invalid key warns exactly once");
    } finally {
      Reflect.deleteProperty(process.stderr, "write");
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "an invalid hubKey containing terminal controls never reaches stderr",
  async () => {
    const ws = tmpWorkspace("pi-kit-hubkey-invalid-control-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    const captured: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    const raw = "alt+m\u001b[2J";
    Object.defineProperty(process.stderr, "write", { value: capture, configurable: true, writable: true });
    try {
      const dir = path.join(ws, "pi-kit");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "ui.json"), JSON.stringify({ hubKey: raw }));
      const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
      assert.equal(mod.readHubKey(), "alt+m", "a value with a control sequence falls back to alt+m");
      const text = captured.join("");
      assert.ok(text.includes("control-center:"), "the invalid key warns");
      assert.ok(!text.includes("\u001b"), "the warning contains no escape character");
      assert.ok(!text.includes(raw), "the warning does not echo the invalid value");
    } finally {
      Reflect.deleteProperty(process.stderr, "write");
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "valid hubKeys still register unchanged, including a single base key",
  async () => {
    // `f2`/`escape`/`k` have no modifier; pi-tui accepts them (KeyId = BaseKey | ModifiedKeyId).
    for (const key of ["ctrl++", "ctrl+shift+k", "f2", "escape", "k"]) {
      const ws = tmpWorkspace("pi-kit-hubkey-valid-");
      const restore = setEnv("PI_CODING_AGENT_DIR", ws);
      try {
        const dir = path.join(ws, "pi-kit");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "ui.json"), JSON.stringify({ hubKey: key }));
        const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
        assert.equal(mod.readHubKey(), key, `${key} is a valid key`);
        const { api, shortcuts } = makeApi();
        await registerControl(api);
        assert.ok(shortcuts.has(key), `${key} is registered unchanged`);
      } finally {
        restore();
        rmWorkspace(ws);
      }
    }
  },
]);

tests.push([
  "a duplicate-modifier hubKey falls back because pi-tui cannot match it",
  async () => {
    for (const key of ["alt+alt+m", "ctrl+shift+shift+k"]) {
      const ws = tmpWorkspace("pi-kit-hubkey-duplicate-");
      const restore = setEnv("PI_CODING_AGENT_DIR", ws);
      try {
        const dir = path.join(ws, "pi-kit");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "ui.json"), JSON.stringify({ hubKey: key }));
        const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
        assert.equal(mod.readHubKey(), "alt+m", `${key} repeats a modifier, so it is not a key pi-tui matches`);
        const { api, shortcuts } = makeApi();
        await registerControl(api);
        assert.ok(shortcuts.has("alt+m"), `${key} registers the default instead`);
        assert.ok(!shortcuts.has(key), `${key} is not registered`);
      } finally {
        restore();
        rmWorkspace(ws);
      }
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
    assert.equal(modelMod.pageRows(model, "security").some((row) => row.id === "approvals"), true, "the approval mode lives on the Security page");
    assert.equal(modelMod.findRow(model, "security.level")?.page, "security");
    assert.equal(modelMod.parentPage(model, "delegation"), "work");
    const approvals = modelMod.findRow(model, "approvals");
    assert.equal(approvals?.value, "auto/coding");
    assert.equal(approvals?.available, true);
    const improve = modelMod.findRow(model, "improve.arm");
    assert.equal(improve?.available, false);
    assert.match(improve?.unavailableReason ?? "", /self-improving/);
    assert.equal(modelMod.legacyCommandName("/auto on"), "auto");
    assert.equal(modelMod.searchRows(model, "auto").length > 0, true);
  },
]);

tests.push([
  "the hub header and informational rows strip terminal control sequences",
  async () => {
    const hidden = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
    const header = headerLine({ profile: "x\u001b[2Jowned", securityMissing: true });
    assert.ok(!header.includes("\u001b"), "the header must not contain ESC");
    assert.equal(header, "profile xowned", "the header keeps the visible text");

    // A reset is stripped by pi-tui; an alternate-screen sequence is not `m/G/K/H/J` CSI, so its
    // ESC is left behind, and the whole-class filter removes it.
    const screened = headerLine({ profile: "x\u001b[0mown\u001b[?1049hend", securityMissing: true });
    assert.ok(!screened.includes("\u001b"), "the header must not contain ESC from an alternate screen or reset");
    assert.ok(!hidden.test(screened), "the header keeps no control or format code point");
    assert.ok(screened.includes("own"), "the header keeps its visible text");

    const model = await modelFor([]);
    const deps = makeDeps({ model, commands: [] });
    deps.doctor = () => [
      { ok: true, label: "Bad\u001b[2JLabel", value: "val\u001b[2Jue", command: "/x\u001b[2Jy" },
      { ok: true, label: "C1", value: "val\u009b2Jue", command: "" },
      { ok: true, label: "Long", value: "v".repeat(600), command: "" },
    ];
    const rows = rowsForPage("doctor", deps);
    assert.equal(rows[0]?.label, "BadLabel", "the label loses its control sequence");
    assert.equal(rows[0]?.value, "value", "the value loses its control sequence");
    assert.equal(rows[0]?.description, "more: /xy", "the command loses its control sequence");
    assert.ok(!rows[1]?.value?.includes("\u009b"), "the value loses its C1 CSI");
    assert.ok(!hidden.test(rows[1]?.value ?? ""), "the value keeps no control or format code point");
    assert.ok(rows[1]?.value?.includes("val"), "the value keeps its visible text");
    assert.equal(rows[2]?.value?.length, 500, "a long value is capped at 500 characters");
    assert.equal(rows[2]?.value, "v".repeat(500), "the cap keeps the leading visible text");

    const titled = { ...model, pages: model.pages.map((page, index) => index === 0 ? { ...page, title: "Bad\u001b[2J\u202ePage", parent: "P\u0007\u202earent" } : page) };
    assert.ok(titled.pages[0], "the fallback model defines a first page");
    const captured: string[] = [];
    await openHub(makeDeps({ model: titled, commands: [], ctx: makeCtx("print", process.cwd(), false), write: (text) => captured.push(text) }), titled.pages[0]?.id);
    const pageText = captured.join("");
    assert.ok(pageText.includes("BadPage"), "the visible page title survives");
    assert.ok(!pageText.includes("\u001b"), "the page title must not contain ESC");
    assert.ok(!pageText.includes("\u202e"), "the page title must not contain a bidi override");
    assert.ok(pageText.includes("(Parent)"), "the page parent keeps its visible text and loses control and bidi characters");
  },
]);

tests.push([
  "the one shared visible-text filter removes a bidi override and is written once",
  async () => {
    const bidi = "safe\u202eoverride";
    assert.equal(stripHiddenChars(bidi), "safeoverride", "the shared filter removes a bidi override");
    assert.ok(!oneVisibleLine(bidi).includes("\u202e"), "the one-line rule removes a bidi override");
    assert.equal(oneVisibleLine("a\n\tb  c"), "a b c", "tab, newline and whitespace runs become one space");
    assert.equal(oneVisibleLine("v".repeat(600)).length, 600, "the one-line rule itself does not cap");
    assert.ok(isHiddenChar("\u202e") && !isHiddenChar("\n") && !isHiddenChar("\t") && !isHiddenChar("a"), "the predicate keeps tab, newline and ordinary text");

    // One class literal in the repository: the source holds it once, the generated copies carry it,
    // and no hand-written copy is left in the autonomy or extension trees.
    const literal = "[\\p{Cf}\\p{Cc}\\p{Default_Ignorable_Code_Point}]";
    const source = fs.readFileSync(path.join(ROOT, "packages/core/shared/visible-text.ts"), "utf8");
    assert.equal(source.split(literal).length - 1, 1, "the source holds the class literal once");
    assert.ok(HIDDEN_CHARS.test("\u202e"), "the exported class matches the bidi override");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(path.join(ROOT, "packages/autonomy"));
    walk(path.join(ROOT, "packages/extensions"));
    const handwritten = files.filter((file) => !file.endsWith(path.join("shared", "visible-text.ts")) && fs.readFileSync(file, "utf8").includes(literal));
    assert.deepEqual(handwritten, [], "no hand-written copy of the class remains outside the generated shared copies");
  },
]);

tests.push([
  "readValues exposes the command-menu settings, the hub key and the joined command lists",
  async () => {
    const valuesMod = await loadValuesModule();
    const ws = tmpWorkspace("pi-kit-settings-values-");
    try {
      const values = valuesMod.readValues({
        cwd: ws,
        hubKey: "alt+k",
        commandMenu: { commandMenu: "curated", pinnedCommands: ["goal", "verify"], hiddenCommands: ["foo"] },
      });
      assert.equal(values.commandMenu, "curated");
      assert.equal(values.hubKey, "alt+k");
      assert.equal(values.pinnedCommands, "goal, verify");
      assert.equal(values.hiddenCommands, "foo");
      const empty = valuesMod.readValues({ cwd: ws, commandMenu: { commandMenu: "all", pinnedCommands: [], hiddenCommands: [] } });
      assert.equal(empty.commandMenu, "all");
      assert.equal(empty.pinnedCommands, undefined, "an empty pin list reads as undefined");
      assert.equal(empty.hiddenCommands, undefined, "an empty hide list reads as undefined");
      assert.equal(empty.hubKey, undefined);
    } finally {
      rmWorkspace(ws);
    }
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
    // Bare /boost spends a recovery attempt and at the cap stops the loop: a hub row only looks.
    assert.equal(modelMod.ROWS.find((row) => row.id === "boost")?.legacy, "/boost status", "the Auto-boost row spends no recovery attempt");
    const compact = modelMod.ROWS.find((row) => row.id === "compact");
    assert.equal(compact?.prefill, "/compact ");
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: [], controls: [] });
    assert.equal(modelMod.findRow(model, "compact")?.available, true, "a pre-fill row needs no registered command");
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

      // A floor (the engagement policy) raises the operator's balanced to guarded.
      global[securityKey] = { snapshot: () => ({ requested: "balanced", effective: "guarded", source: "operator" }) };
      const fromRegistry = valuesMod.readSecurity();
      assert.equal(fromRegistry.missing, false);
      assert.equal(fromRegistry.effective, "guarded");
      assert.equal(fromRegistry.requested, "balanced");
      const ws = tmpWorkspace("pi-kit-hub-security-");
      try {
        assert.equal(valuesMod.readValues({ cwd: ws }).security, "guarded (requested balanced)");
        const modelMod = await loadModelModule();
        const values = valuesMod.readValues({ cwd: ws });
        const model = modelMod.buildModel({ values, commands: [], controls: [] });
        const level = modelMod.findRow(model, "security.level");
        assert.equal(level?.value, "guarded (requested balanced)", "the Security page shows the effective and requested level on one row");

        Reflect.deleteProperty(globalThis, securityKey);
        const missingValues = valuesMod.readValues({ cwd: ws });
        const missingModel = modelMod.buildModel({ values: missingValues, commands: [], controls: [] });
        assert.equal(modelMod.findRow(missingModel, "security.level")?.value, valuesMod.NO_FIREWALL, "without a firewall the Security page shows no level");
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
    const row = modelMod.findRow(model, "session.fork");
    assert.ok(row);
    const result = await hubMod.dispatchRow(row, deps);
    assert.equal(result.ok, true);
    assert.deepEqual(prefill, ["/fork "]);
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
  "All commands lists a built-in extension command once, not again from getCommands()",
  async () => {
    // pi's always-loaded extensions report mcp and llama through getCommands() as well as being built-ins.
    const { api, registered } = makeApi(["mcp", "llama", "auto"]);
    await registerControl(api);
    const recorded = makeUi();
    const ctx = { mode: "rpc" as const, hasUI: true, cwd: process.cwd(), ui: recorded.ui };
    await registered.get("menu")?.handler("all-commands", ctx);
    const options = recorded.selects[0]?.options ?? [];
    for (const name of ["mcp", "llama", "auto"]) {
      const label = `/${name}`;
      assert.equal(options.filter((option) => option === label).length, 1, `${label} must be listed exactly once`);
    }
    // A built-in that getCommands() does not report is still there: dedupe must not drop built-ins.
    assert.equal(options.filter((option) => option === "/settings").length, 1, "a built-in absent from getCommands() is listed once");
  },
]);

tests.push([
  "a cancelled RPC value dialog closes the hub instead of reopening the parent page",
  async () => {
    const model: ModelModule.HubModel = {
      pages: [
        { id: "main", title: "Control centre", parent: null },
        { id: "system", title: "System", parent: "main" },
        { id: "display", title: "Display", parent: "system" },
      ],
      rows: [
        {
          id: "display.mode",
          page: "display",
          label: "Display mode",
          kind: "value",
          value: "compact",
          values: ["compact", "full"],
          available: true,
        },
      ],
    };
    // First answer opens the value dialog; the second cancels (undefined), which must close the hub.
    const recorded = makeUi([], ["Display mode: compact", undefined]);
    const ctx = { mode: "rpc" as const, hasUI: true, cwd: process.cwd(), ui: recorded.ui };
    const sent: string[] = [];
    await openHub(makeDeps({ model, commands: [], ctx, sent }), "display");
    assert.deepEqual(sent, [], "a cancel dispatches nothing");
    assert.equal(recorded.selects.length, 2, "a cancelled value dialog closes the hub; it must not open the parent page");
    assert.match(recorded.selects[1]?.title ?? "", /^Display mode \(now compact\)/, "the second dialog is the value picker");
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
    // The installed pi decides: the compat lanes run this file on pi below 1.3.0 too.
    assert.equal(
      recorded.customCalls[0]?.overlay === true,
      supportsOverlay(PI_VERSION),
      `pi ${PI_VERSION} opens the hub as an overlay only if it is 1.3.0 or newer`,
    );
    // Both branches of the gate, whatever pi is installed.
    for (const v of ["1.3.0", "1.3.1-beta.1", "1.4.0", "2.0.0", "v1.3.0"]) assert.equal(supportsOverlay(v), true, `supportsOverlay(${v})`);
    for (const v of ["1.2.9", "1.2.0", "0.99.2", "0.85.1"]) assert.equal(supportsOverlay(v), false, `supportsOverlay(${v})`);
  },
]);

tests.push([
  "a mouse press on the first data row selects it when the title is shown",
  async () => {
    initTheme();
    const model = await modelFor([]);
    const allCommands = Array.from({ length: 20 }, (_, index) => ({ name: `cmd${index}`, source: "extension" }));
    const theme: OverlayTheme & { bold(text: string): string } = { fg: (_colour, text) => text, bold: (text) => text };
    const tui = { requestRender: (): void => {}, terminal: { rows: 24 } };
    let component: { render(width: number): string[]; handleInput?(data: string): void; handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined } | undefined;
    const ui = {
      notify: (): void => {},
      custom: (
        factory: (tuiArg: unknown, themeArg: unknown, keybindings: unknown, done: (result: PageChoice) => void) => typeof component,
      ): Promise<PageChoice> => {
        component = factory(tui, theme, {}, () => {});
        return new Promise<PageChoice>(() => {});
      },
    };
    const ctx = { mode: "tui" as const, hasUI: true, cwd: process.cwd(), ui };
    void openHub(makeDeps({ model, commands: [], ctx: ctx as unknown as FakeCtx, allCommands }), "all-commands");
    assert.ok(component, "the hub opened a custom component");
    // Move the selection off the first row, so only a correctly translated press brings it back.
    component.handleInput?.("\x1b[B");
    component.handleInput?.("\x1b[B");
    const lines = component.render(80);
    const firstRow = lines.findIndex((line) => line.includes("/cmd0"));
    assert.ok(firstRow > 0, "the first data row is visible below the title");
    const press: TuiMouseEvent = { type: "press", button: "left", x: 5, y: firstRow, width: 80, height: lines.length, screenX: 5, screenY: firstRow, shift: false, alt: false, ctrl: false };
    assert.equal(component.handleMouse?.(press)?.handled, true, "the press reaches the list");
    assert.match(stripTerminalSequences(component.render(80).join("\n")), /→ \/cmd0\b/, "the press focused the row under the pointer, not a lower one");
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
    await openHub(makeDeps({ model, commands: ["auto"], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: typed.ui }, sent }), "security");
    assert.deepEqual(sent, ["/auto"]);
    assert.equal(typed.customCalls.length, 1, "the hub closed after handing over to /auto");

    const editor = makeUi([{ id: "session.fork" }]);
    const prefill: string[] = [];
    await openHub(makeDeps({ model, commands: ["auto"], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: editor.ui }, prefill }), "session");
    assert.deepEqual(prefill, ["/fork "]);
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

tests.push([
  "Back follows the path the operator took, not the page's static parent",
  async () => {
    initTheme();
    // Settings -> Display: Display's declared parent is System, so a static parent would land there.
    const recorded = makeUi([{ id: "settings.display" }, "back"]);
    await openHub(makeDeps({ model: await modelFor([]), commands: [], ctx: { mode: "tui", hasUI: true, cwd: process.cwd(), ui: recorded.ui } }), "settings");
    assert.equal(recorded.customCalls.length, 3);
    assert.match(recorded.rendered[1] ?? "", /│ Display/, "the Display page opened from Settings");
    assert.match(recorded.rendered[2] ?? "", /│ Settings/, "Back returns to the page that opened Display");
    assert.match(recorded.rendered[2] ?? "", /→ Display/, "the cursor is on the row that opened Display");
    assert.doesNotMatch(recorded.rendered[2] ?? "", /│ System/, "Back does not fall back to the static parent");
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

tests.push([
  "the Doctor lists extensions switched off in overrides.json and flags one the marker still loads",
  async () => {
    const doctor = await loadDoctorModule();
    const values = await loadValuesModule();
    const ws = tmpWorkspace("pi-kit-doctor-disabled-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      fs.mkdirSync(path.join(ws, "pi-kit"), { recursive: true });
      fs.writeFileSync(path.join(ws, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["branch-lab", "herdr"] } }));
      fs.writeFileSync(path.join(ws, ".pi-kit.json"), JSON.stringify({ profile: "balanced", extensions: ["herdr", "effort"] }));
      const disabled = values.readDisabledExtensions();
      assert.deepEqual(disabled, ["branch-lab", "herdr"]);
      const line = doctor.doctorLines({
        marker: values.readMarker(ws),
        piVersion: "1.3.0",
        settingsFile: path.join(ws, "settings.json"),
        disabled,
        registries: { protections: 1 },
      }).find((l) => l.label === "Disabled");
      assert.equal(line?.ok, false, "herdr is in overrides but the marker still loads it");
      assert.match(line?.value ?? "", /still loaded: herdr/);
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

/** Run the registered `/menu <page>` over RPC and return the first dialog's options (one per row). */
async function rpcPageOptions(page: string, cwd: string): Promise<string[]> {
  const { api, registered } = makeApi();
  await registerControl(api);
  const recorded = makeUi();
  const ctx = { mode: "rpc" as const, hasUI: true, cwd, ui: recorded.ui };
  await registered.get("menu")?.handler(page, ctx);
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
      assert.match(companions ?? "", /^Companions: 1 recorded and registered {2}\[\/update status\]$/, "a global marker is compared with the global settings.json");
      // A project marker is compared with the project settings.json.
      fs.writeFileSync(path.join(project, ".pi", ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "project", companions: ["npm:pi-lens@4.4.4"] }));
      const projectOptions = await rpcPageOptions("doctor", project);
      assert.match(projectOptions.find((option) => option.includes("Companions")) ?? "", /^! Companions: 1 recorded, but settings\.json lists no packages {2}\[\/update status\]$/);
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
      assert.ok(options.some((option) => option.startsWith("! Protections: 0 recorded")), `a drift line is marked: ${options.join(" | ")}`);
      assert.ok(options.some((option) => option.startsWith("Kit: ")), "a healthy line carries no marker");
      assert.ok(options.some((option) => option.startsWith("Security: strict")), "the Doctor shows the firewall's security level");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, securityKey);
      else global[securityKey] = previous;
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "the launch header and the registered shortcut name the load-time hubKey after a session restart",
  async () => {
    const ws = tmpWorkspace("pi-kit-hubkey-reread-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      const kit = path.join(ws, "pi-kit");
      fs.mkdirSync(kit, { recursive: true });
      fs.writeFileSync(path.join(kit, "ui.json"), JSON.stringify({ hubKey: "alt+k", reducedMotion: true }));

      const pi = fakePi();
      await registerControl(pi.api);
      assert.deepEqual([...pi.shortcuts.keys()], ["alt+k"], "the shortcut is registered from the load-time key");

      // Change ui.json after load, as a reload would: /new, /resume, /fork and /tree re-emit session_start.
      fs.writeFileSync(path.join(kit, "ui.json"), JSON.stringify({ hubKey: "alt+x", reducedMotion: true }));
      type HeaderFactory = (tui: TUI, theme: Theme) => { render: (width: number) => string[]; dispose?(): void };
      const headers: HeaderFactory[] = [];
      const ui = {
        addAutocompleteProvider: (): void => {},
        setHeader: (factory: HeaderFactory): void => {
          headers.push(factory);
        },
      };
      const handler = pi.handlers.get("session_start");
      const ctx = { mode: "tui", hasUI: true, cwd: ws, ui };
      await handler({}, ctx);
      await handler({}, ctx);
      assert.equal(headers.length, 2, "each session_start installs the header");
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
      for (const factory of headers) {
        const component = factory({ requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI, theme);
        const rendered = component.render(120).join("\n");
        assert.ok(rendered.includes("alt+k"), `the header names the bound key: ${rendered}`);
        assert.ok(!rendered.includes("alt+x"), "the header does not read a later ui.json value");
        component.dispose?.();
      }
      assert.deepEqual([...pi.shortcuts.keys()], ["alt+k"], "the shortcut still names the bound key");
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "the launch screen shows a first-run card until the first prompt, then never again",
  async () => {
    const ws = tmpWorkspace("pi-kit-first-run-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      fs.mkdirSync(path.join(ws, "pi-kit"), { recursive: true });
      fs.writeFileSync(path.join(ws, "pi-kit", "ui.json"), JSON.stringify({ reducedMotion: true }));
      const pi = fakePi();
      await registerControl(pi.api);
      type HeaderFactory = (tui: TUI, theme: Theme) => { render: (width: number) => string[]; dispose?(): void };
      const headers: HeaderFactory[] = [];
      const ui = { addAutocompleteProvider: (): void => {}, setHeader: (factory: HeaderFactory): void => { headers.push(factory); } };
      // pi's placeholder model (nothing configured): the card says how to get one.
      const ctx = { mode: "tui", hasUI: true, cwd: ws, ui, model: { id: "unknown", provider: "unknown", contextWindow: 0 } };
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
      const render = (factory: HeaderFactory | undefined): string => {
        assert.ok(factory, "a header was installed");
        const component = factory({ requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI, theme);
        const text = component.render(120).join("\n");
        component.dispose?.();
        return text;
      };
      const start = pi.handlers.get("session_start");
      await start({}, ctx);
      assert.match(render(headers.at(-1)), /\/login/, "no model yet: the card names the way to get one");
      await start({}, ctx);
      assert.match(render(headers.at(-1)), /\/login/, "still shown until a prompt is sent");

      await pi.handlers.get("agent_start")({}, ctx);
      await start({}, ctx);
      assert.doesNotMatch(render(headers.at(-1)), /First run/, "once the first prompt was sent the card is gone for good");
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
