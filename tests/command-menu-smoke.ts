#!/usr/bin/env node
/**
 * The curated `/` menu (docs/control-center.md; internal/docs/proposals/control-center.md §5.2 D).
 *
 * Hermetic (temporary agent dir, no live pi). Pins behaviour, not the menu's contents: hiding never
 * touches dispatch or completion, invalid ui.json settings fall back to the defaults, and a
 * provider registers only in the TUI (nothing over RPC, print or json, nothing in a child session).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as CommandMenuModule from "../packages/extensions/src/control-center/command-menu.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";

const restoreEnv = isolateKitEnv();
const signal = new AbortController().signal;

async function loadMenu(): Promise<typeof CommandMenuModule> {
  return loadModule<typeof CommandMenuModule>("extensions/control-center/command-menu.ts");
}

async function loadControl(): Promise<(api: unknown) => void> {
  const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
  return mod.default as (api: unknown) => void;
}

/** A base provider that always offers the same items; the wrapper never calls applyCompletion. */
function fakeBase(items: AutocompleteItem[]): AutocompleteProvider {
  return {
    async getSuggestions(): Promise<AutocompleteSuggestions> {
      return { items, prefix: "" };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  };
}

async function suggest(provider: AutocompleteProvider, lines: string[], cursorCol: number): Promise<AutocompleteSuggestions | null> {
  return provider.getSuggestions(lines, 0, cursorCol, { signal });
}

const values = (suggestions: AutocompleteSuggestions | null): string[] => (suggestions?.items ?? []).map((item) => item.value);

// --- fixtures ----------------------------------------------------------------------------------

const COMMANDS: CommandMenuModule.CommandMenuCommand[] = [
  { name: "menu", source: "extension" },
  { name: "auto", source: "extension" },
  { name: "kit", source: "extension" },
  { name: "effort", source: "extension" },
  { name: "todos", source: "extension" },
  { name: "totally-companion", source: "extension" },
  { name: "code-plan", source: "prompt" },
  { name: "skill:foo", source: "skill" },
];

const BUILTINS = ["compact", "model", "new"];

const ITEMS: AutocompleteItem[] = [
  { value: "auto", label: "auto", description: "Autonomy / approvals" },
  { value: "effort", label: "effort", description: "Set effort" },
  { value: "todos", label: "todos" },
  { value: "totally-companion", label: "totally-companion" },
  { value: "code-plan", label: "code-plan" },
  { value: "skill:foo", label: "skill:foo" },
];

// --- registration helpers ----------------------------------------------------------------------

interface FakeApi {
  on: (name: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
  registerCommand: () => void;
  registerShortcut: () => void;
  getCommands: () => CommandMenuModule.CommandMenuCommand[];
  getThinkingLevel: () => string;
  setThinkingLevel: () => void;
  sendUserMessage: () => void;
}

interface FakeRegistration {
  api: FakeApi;
  handlers: Map<string, (event?: unknown, ctx?: unknown) => unknown>;
  providers: Array<(current: AutocompleteProvider) => AutocompleteProvider>;
  headers: unknown[];
  ui: {
    addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
    setHeader: (factory: unknown) => void;
  };
}

function makeApi(commands: CommandMenuModule.CommandMenuCommand[]): FakeRegistration {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const providers: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
  const headers: unknown[] = [];
  return {
    handlers,
    providers,
    headers,
    ui: {
      addAutocompleteProvider: (factory): void => {
        providers.push(factory);
      },
      setHeader: (factory): void => {
        headers.push(factory);
      },
    },
    api: {
      on: (name, handler): void => {
        handlers.set(name, handler);
      },
      registerCommand: (): void => {},
      registerShortcut: (): void => {},
      getCommands: (): CommandMenuModule.CommandMenuCommand[] => commands,
      getThinkingLevel: (): string => "high",
      setThinkingLevel: (): void => {},
      sendUserMessage: (): void => {},
    },
  };
}

/** Load control-center, register it, and run its session_start handler with a chosen mode. */
async function startWith(mode: string | undefined, hasUI: boolean, cwd: string, commands: CommandMenuModule.CommandMenuCommand[]): Promise<FakeRegistration> {
  const register = await loadControl();
  const fake = makeApi(commands);
  register(fake.api);
  const handler = fake.handlers.get("session_start");
  assert.ok(handler, "control-center must register a session_start handler");
  await handler({}, { mode, hasUI, cwd, ui: fake.ui });
  return fake;
}

/** A temporary agent dir with an optional pi-kit/ui.json, restored on the returned closure. */
function agentDirFixture(prefix: string, ui?: Record<string, unknown>): { dir: string; done: () => void } {
  const dir = tmpWorkspace(prefix);
  const restore = setEnv("PI_CODING_AGENT_DIR", dir);
  const kit = path.join(dir, "pi-kit");
  fs.mkdirSync(kit, { recursive: true });
  if (ui) fs.writeFileSync(path.join(kit, "ui.json"), JSON.stringify(ui, null, 2));
  return {
    dir,
    done: (): void => {
      restore();
      rmWorkspace(dir);
    },
  };
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [];

// --- classification ----------------------------------------------------------------------------

tests.push([
  "hiding never touches argument completion, forced completion or accepting a suggestion",
  async () => {
    const menu = await loadMenu();
    const hidden = menu.hiddenCommandNames({ commands: COMMANDS, builtins: BUILTINS });
    const provider = menu.commandMenuProvider(fakeBase(ITEMS), { hidden, locationOf: () => menu.ALL_COMMANDS_LOCATION });

    const fullyTyped = await suggest(provider, ["/totally-companion"], 19);
    assert.ok(values(fullyTyped).includes("totally-companion"), "a fully typed hidden command is offered");

    // A space means argument completion: the wrapper must not filter it.
    const argument = await suggest(provider, ["/auto on"], 8);
    assert.ok(values(argument).includes("auto"), "argument completion is passed through untouched");

    // A forced (Tab) file completion is passed through even on a bare command token.
    const forced = await provider.getSuggestions(["/a"], 0, 2, { signal, force: true });
    assert.ok(values(forced).includes("auto"), "a forced completion is passed through untouched");

    // Accepting a suggestion still goes through the base provider's applyCompletion.
    const applied = provider.applyCompletion(["/auto"], 0, 5, { value: "auto", label: "auto" }, "/auto");
    assert.deepEqual(applied, { lines: ["/auto"], cursorLine: 0, cursorCol: 5 }, "completion is delegated to the base provider");
  },
]);

tests.push([
  "ui.json selects the menu, and invalid values fall back to the defaults",
  async () => {
    const menu = await loadMenu();
    const valid = agentDirFixture("pi-kit-menu-valid-", { commandMenu: "all", pinnedCommands: ["/foo", "bar"], hiddenCommands: ["compact"] });
    try {
      const settings = menu.readCommandMenuSettings();
      assert.equal(settings.commandMenu, "all");
      assert.deepEqual(settings.pinnedCommands, ["foo", "bar"], "a leading slash is normalised away");
      assert.deepEqual(settings.hiddenCommands, ["compact"]);
    } finally {
      valid.done();
    }

    const invalid = agentDirFixture("pi-kit-menu-invalid-", { commandMenu: "sometimes", pinnedCommands: "nope", hiddenCommands: [1, 2] });
    const captured: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    Object.defineProperty(process.stderr, "write", { value: capture, configurable: true, writable: true });
    try {
      const first = menu.readCommandMenuSettings();
      const second = menu.readCommandMenuSettings();
      for (const settings of [first, second]) {
        assert.equal(settings.commandMenu, "curated", "an invalid commandMenu falls back to curated");
        assert.deepEqual(settings.pinnedCommands, [], "an invalid pinnedCommands is ignored");
        assert.deepEqual(settings.hiddenCommands, [], "an invalid hiddenCommands is ignored");
      }
    } finally {
      Reflect.deleteProperty(process.stderr, "write");
      invalid.done();
    }
  },
]);

// --- registration ------------------------------------------------------------------------------

tests.push([
  "nothing is filtered outside the TUI, and pi without ctx.mode falls back to hasUI",
  async () => {
    for (const [mode, hasUI] of [["rpc", true], ["json", false], ["print", false]] as const) {
      const fake = await startWith(mode, hasUI, process.cwd(), COMMANDS);
      assert.equal(fake.providers.length, 0, `${mode} must not register an autocomplete provider`);
    }
    const older = await startWith(undefined, true, process.cwd(), COMMANDS);
    assert.equal(older.providers.length, 1, "older pi without ctx.mode uses hasUI");
    const noUi = await startWith(undefined, false, process.cwd(), COMMANDS);
    assert.equal(noUi.providers.length, 0, "older pi without a UI registers nothing");
  },
]);

tests.push([
  "commandMenu: all registers no provider, so the whole menu is shown",
  async () => {
    const fixture = agentDirFixture("pi-kit-menu-all-", { commandMenu: "all" });
    try {
      const fake = await startWith("tui", true, fixture.dir, COMMANDS);
      assert.equal(fake.providers.length, 0, "nothing is filtered under commandMenu: all");
    } finally {
      fixture.done();
    }
  },
]);

tests.push([
  "an internal child session registers neither the hub nor the autocomplete provider",
  async () => {
    const restoreChild = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    try {
      const fake = await loadControl();
      const registered = makeApi(COMMANDS);
      fake(registered.api);
      assert.equal(registered.handlers.size, 0, "a child session gets no event handlers");
      assert.equal(registered.providers.length, 0, "a child session gets no autocomplete provider");
    } finally {
      restoreChild();
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
  console.error(`\n[command-menu-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[command-menu-smoke] all ${tests.length} checks passed`);
