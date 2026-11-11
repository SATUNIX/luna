#!/usr/bin/env node
/**
 * The curated `/` menu (docs/control-center.md; internal/docs/proposals/control-center.md §5.2 D).
 *
 * Hermetic (temporary agent dir, no live pi). Layers:
 *   - classification: pinned kit commands stay, every other extension command hides, and pi's
 *     built-ins, prompt templates and skill commands are untouched unless hiddenCommands names them;
 *   - the reveal rule: a hidden command returns at four typed characters, and dispatch/completion
 *     are never touched;
 *   - the location: a hidden suggestion's description says where the command moved;
 *   - settings: commandMenu / pinnedCommands / hiddenCommands from pi-kit/ui.json, invalid values
 *     warned about once and replaced by the defaults;
 *   - registration: a provider only in the TUI, nothing over RPC, print or json, and nothing in a
 *     child session.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as CommandMenuModule from "../packages/extensions/src/control-center/command-menu.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as ModelModule from "../packages/extensions/src/control-center/model.ts";

const restoreEnv = isolateKitEnv();
const signal = new AbortController().signal;

async function loadMenu(): Promise<typeof CommandMenuModule> {
  return loadModule<typeof CommandMenuModule>("extensions/control-center/command-menu.ts");
}

async function loadModel(): Promise<typeof ModelModule> {
  return loadModule<typeof ModelModule>("extensions/control-center/model.ts");
}

async function loadControl(): Promise<(api: unknown) => void> {
  const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
  return mod.default as (api: unknown) => void;
}

async function modelFor(commands: string[]): Promise<ModelModule.HubModel> {
  const model = await loadModel();
  return model.buildModel({ values: { securityMissing: true }, commands, controls: [] });
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
  { name: "auto", source: "extension" },
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
  ui: { addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void };
}

function makeApi(commands: CommandMenuModule.CommandMenuCommand[]): FakeRegistration {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const providers: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
  return {
    handlers,
    providers,
    ui: {
      addAutocompleteProvider: (factory): void => {
        providers.push(factory);
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
  "hidden commands are filtered from the bare `/` menu while pinned kit commands stay",
  async () => {
    const menu = await loadMenu();
    const hidden = menu.hiddenCommandNames({ commands: COMMANDS, builtins: BUILTINS });
    assert.ok(hidden.has("auto"), "a non-pinned kit command is hidden");
    assert.ok(hidden.has("todos"), "another non-pinned kit command is hidden");
    assert.ok(hidden.has("totally-companion"), "a companion-package command is hidden");
    assert.ok(!hidden.has("effort"), "a pinned kit command stays");

    const provider = menu.commandMenuProvider(fakeBase(ITEMS), { hidden, locationOf: () => menu.ALL_COMMANDS_LOCATION });
    const result = await suggest(provider, ["/"], 1);
    assert.deepEqual(values(result), ["effort", "code-plan", "skill:foo"], "only the pinned and non-extension commands remain");
  },
]);

tests.push([
  "pi built-ins, prompt templates and skill commands are never hidden by default",
  async () => {
    const menu = await loadMenu();
    const hidden = menu.hiddenCommandNames({ commands: COMMANDS, builtins: BUILTINS });
    for (const name of ["compact", "model", "new", "code-plan", "skill:foo"]) {
      assert.ok(!hidden.has(name), `${name} must stay visible by default`);
    }

    // The operator can still opt them out through hiddenCommands.
    const optedOut = menu.hiddenCommandNames({ commands: COMMANDS, builtins: BUILTINS, hiddenCommands: ["compact", "code-plan", "skill:foo"] });
    for (const name of ["compact", "code-plan", "skill:foo"]) {
      assert.ok(optedOut.has(name), `${name} must hide when hiddenCommands names it`);
    }
    assert.ok(!optedOut.has("model"), "an unnamed built-in is still untouched");
  },
]);

tests.push([
  "pinnedCommands and hiddenCommands extend the defaults, and a pin wins over a hide",
  async () => {
    const menu = await loadMenu();
    const custom = menu.hiddenCommandNames({
      commands: COMMANDS,
      builtins: BUILTINS,
      pinnedCommands: ["todos", "totally-companion"],
      hiddenCommands: ["effort"],
    });
    assert.ok(!custom.has("todos"), "an extra pinned command stays visible");
    assert.ok(!custom.has("totally-companion"), "an extra pinned companion command stays visible");
    assert.ok(custom.has("effort"), "an extra hidden command is removed even when it is pinned by default");

    const both = menu.hiddenCommandNames({ commands: [], builtins: ["compact"], pinnedCommands: ["compact"], hiddenCommands: ["compact"] });
    assert.ok(!both.has("compact"), "an explicit pin beats an explicit hide");
  },
]);

tests.push([
  "a profile pins the commands that define it",
  async () => {
    const menu = await loadMenu();
    const selfImproving = menu.hiddenCommandNames({
      commands: [
        { name: "improve", source: "extension" },
        { name: "review", source: "extension" },
        { name: "engagement", source: "extension" },
        { name: "autonomy", source: "extension" },
      ],
      builtins: BUILTINS,
      profile: "self-improving",
    });
    for (const name of ["improve", "review", "engagement"]) assert.ok(!selfImproving.has(name), `${name} pins in self-improving`);
    assert.ok(selfImproving.has("autonomy"), "autonomy is not pinned outside the autonomous profile");

    const autonomous = menu.hiddenCommandNames({ commands: [{ name: "autonomy", source: "extension" }], builtins: BUILTINS, profile: "autonomous" });
    assert.ok(!autonomous.has("autonomy"), "autonomy pins in the autonomous profile");

    const pentest = menu.hiddenCommandNames({
      commands: [
        { name: "engagement", source: "extension" },
        { name: "improve", source: "extension" },
      ],
      builtins: BUILTINS,
      profile: "pentest",
    });
    assert.ok(!pentest.has("engagement"), "engagement pins in pentest");
    assert.ok(pentest.has("improve"), "improve is not pinned in pentest");
  },
]);

// --- the reveal rule ---------------------------------------------------------------------------

tests.push([
  "a hidden command reappears at four typed characters and dispatch is never touched",
  async () => {
    const menu = await loadMenu();
    const hidden = menu.hiddenCommandNames({ commands: COMMANDS, builtins: BUILTINS });
    const provider = menu.commandMenuProvider(fakeBase(ITEMS), { hidden, locationOf: () => menu.ALL_COMMANDS_LOCATION });

    const atThree = await suggest(provider, ["/aut"], 4);
    assert.deepEqual(values(atThree), ["effort", "code-plan", "skill:foo"], "three characters is below the reveal length");

    const atFour = await suggest(provider, ["/auto"], 5);
    assert.ok(values(atFour).includes("auto"), "four characters reveals the hidden command");

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

// --- the location ------------------------------------------------------------------------------

tests.push([
  "a hidden suggestion's description says where the command moved",
  async () => {
    const menu = await loadMenu();
    const model = await modelFor(["auto", "todos", "orchestrate", "lens-health"]);
    assert.equal(menu.hubLocationFor("auto", model), "moved → /kit ▸ Autonomy ▸ Approvals");
    assert.equal(menu.hubLocationFor("todos", model), "moved → /kit ▸ Work ▸ Todos");
    assert.equal(menu.hubLocationFor("orchestrate", model), "moved → /kit ▸ Work ▸ Delegation ▸ Orchestration");
    assert.equal(menu.hubLocationFor("lens-health", model), "moved → /kit ▸ System ▸ Companions ▸ pi-lens health");
    assert.equal(menu.hubLocationFor("not-in-the-hub", model), menu.ALL_COMMANDS_LOCATION, "a command with no row points at All commands");

    const provider = menu.commandMenuProvider(fakeBase(ITEMS), { hidden: new Set(["auto", "todos"]), locationOf: menu.locationFor(model) });
    const result = await suggest(provider, ["/auto"], 5);
    const auto = result?.items.find((item) => item.value === "auto");
    assert.equal(auto?.description, "moved → /kit ▸ Autonomy ▸ Approvals — Autonomy / approvals", "the location prefixes the old description");

    const all = await suggest(provider, ["/todo"], 5);
    const todos = all?.items.find((item) => item.value === "todos");
    assert.equal(todos?.description, "moved → /kit ▸ Work ▸ Todos", "a row without a description shows only the location");
  },
]);

// --- settings ----------------------------------------------------------------------------------

tests.push([
  "ui.json selects the menu, and invalid values warn once and fall back to the defaults",
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
      assert.equal(captured.filter((line) => line.includes("control-center:")).length, 3, "each invalid key warns exactly once");
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
  "in the TUI the registered provider curates the live command list",
  async () => {
    const fixture = agentDirFixture("pi-kit-menu-tui-");
    try {
      fs.writeFileSync(path.join(fixture.dir, ".pi-kit.json"), JSON.stringify({ profile: "balanced" }));
      const fake = await startWith("tui", true, fixture.dir, COMMANDS);
      assert.equal(fake.providers.length, 1, "the TUI gets exactly one provider");
      const provider = fake.providers[0];
      assert.ok(provider);
      const wrapped = provider(fakeBase(ITEMS));

      assert.deepEqual(values(await suggest(wrapped, ["/"], 1)), ["effort", "code-plan", "skill:foo"]);
      const revealed = await suggest(wrapped, ["/tota"], 5);
      assert.ok(values(revealed).includes("totally-companion"));
      assert.match(String(revealed?.items.find((item) => item.value === "totally-companion")?.description), /^moved → /);
    } finally {
      fixture.done();
    }
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
