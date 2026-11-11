#!/usr/bin/env node
/**
 * The `/menu` command and its Settings page (docs/control-center.md).
 *
 * Hermetic (temporary agent dir, no live pi). Layers:
 *   - routing: `/menu settings` opens the Settings page directly, and the page carries the five
 *     settings rows plus the Display page row;
 *   - prefill: the pi-settings row pre-fills the editor with `/settings `;
 *   - values: the command-menu rows show the settings read from pi-kit/ui.json;
 *   - locations: a hidden suggestion says `moved → /menu ▸ ...`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as ControlModule from "../packages/extensions/src/control-center/index.ts";
import type * as ModelModule from "../packages/extensions/src/control-center/model.ts";
import type * as ValuesModule from "../packages/extensions/src/control-center/values.ts";
import type * as CommandMenuModule from "../packages/extensions/src/control-center/command-menu.ts";

const restoreEnv = isolateKitEnv();

interface FakeCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/** A fake pi API exposing only what control-center uses. */
function makeApi(commands: string[] = []) {
  const registered = new Map<string, FakeCommand>();
  const sent: string[] = [];
  const api = {
    on: (): void => {
      /* the settings-page tests do not drive session events */
    },
    registerCommand: (name: string, command: FakeCommand): void => {
      registered.set(name, command);
    },
    registerShortcut: (): void => {
      /* no shortcut is exercised here */
    },
    getCommands: (): Array<{ name: string; source?: string }> => commands.map((name) => ({ name, source: "extension" })),
    sendUserMessage: (text: string): void => {
      sent.push(text);
    },
    getThinkingLevel: (): string => "high",
    setThinkingLevel: (): void => {
      /* nothing to set in this test */
    },
  };
  return { api, registered, sent };
}

interface RecordedSelect {
  title: string;
  options: string[];
  timeout: number | undefined;
}

/** A fake UI that records the RPC select dialogs and answers nothing. */
function makeUi() {
  const selects: RecordedSelect[] = [];
  const ui = {
    select: async (title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> => {
      selects.push({ title, options, timeout: opts?.timeout });
      return undefined;
    },
    confirm: async (): Promise<boolean> => false,
    input: async (): Promise<string | undefined> => undefined,
    notify: (): void => {},
    setEditorText: (): void => {},
    custom: (): Promise<never> => new Promise<never>(() => {}),
  };
  return { ui, selects };
}

async function loadControl(): Promise<(api: unknown) => void> {
  const mod = await loadModule<typeof ControlModule>("extensions/control-center/index.ts");
  return mod.default as (api: unknown) => void;
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [];

tests.push([
  "/menu settings resolves the Settings page and its rows show the joined settings",
  async () => {
    const ws = tmpWorkspace("pi-kit-menu-settings-");
    const restore = setEnv("PI_CODING_AGENT_DIR", ws);
    try {
      const kit = path.join(ws, "pi-kit");
      fs.mkdirSync(kit, { recursive: true });
      fs.writeFileSync(
        path.join(kit, "ui.json"),
        JSON.stringify({ commandMenu: "curated", pinnedCommands: ["goal", "verify"], hiddenCommands: ["foo"], hubKey: "alt+k" }),
      );
      const { api, registered } = makeApi();
      const register = await loadControl();
      register(api);
      const recorded = makeUi();
      const ctx = { mode: "rpc" as const, hasUI: true, cwd: ws, ui: recorded.ui };
      await registered.get("menu")?.handler("settings", ctx);

      const first = recorded.selects[0];
      assert.ok(first, "the Settings page opened a select dialog");
      assert.equal(first.title, "Settings");
      assert.equal(first.timeout, 60_000, "the dialog carries a timeout");
      for (const label of [
        "pi settings",
        "Command menu: curated",
        "Hub key: alt+k",
        "Pinned commands: goal, verify",
        "Hidden commands: foo",
      ]) {
        assert.ok(first.options.includes(label), `the Settings page shows "${label}": ${first.options.join(" | ")}`);
      }
      assert.ok(first.options.includes("Display"), "the Display page row is present");
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "the pi-settings row pre-fills the editor and the Settings page is under main",
  async () => {
    const modelMod = await loadModule<typeof ModelModule>("extensions/control-center/model.ts");
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: [], controls: [] });
    assert.ok(modelMod.PAGES.some((page) => page.id === "settings" && page.parent === "main"), "Settings has parent main");
    const pi = modelMod.findRow(model, "settings.pi");
    assert.ok(pi, "the pi-settings row exists");
    assert.equal(pi.prefill, "/settings ");
    assert.equal(modelMod.parentPage(model, "settings"), "main");
    const settings = modelMod.pageRows(model, "settings").filter((row) => row.id.startsWith("settings."));
    assert.equal(settings.length, 5, "five settings rows on the page");
  },
]);

tests.push([
  "readValues joins the command lists and carries the hub key",
  async () => {
    const valuesMod = await loadModule<typeof ValuesModule>("extensions/control-center/values.ts");
    const ws = tmpWorkspace("pi-kit-menu-values-");
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
      assert.equal(empty.pinnedCommands, undefined);
      assert.equal(empty.hiddenCommands, undefined);
    } finally {
      rmWorkspace(ws);
    }
  },
]);

tests.push([
  "a hidden suggestion is located under /menu",
  async () => {
    const menu = await loadModule<typeof CommandMenuModule>("extensions/control-center/command-menu.ts");
    const modelMod = await loadModule<typeof ModelModule>("extensions/control-center/model.ts");
    const model = modelMod.buildModel({ values: { securityMissing: true }, commands: ["auto", "todos"], controls: [] });
    assert.equal(menu.hubLocationFor("auto", model), "moved → /menu ▸ Autonomy ▸ Approvals");
    assert.equal(menu.hubLocationFor("todos", model), "moved → /menu ▸ Work ▸ Todos");
    assert.equal(menu.ALL_COMMANDS_LOCATION, "moved → /menu ▸ All commands");
    assert.equal(menu.hubLocationFor("not-in-the-hub", model), menu.ALL_COMMANDS_LOCATION);
    const hidden = menu.hiddenCommandNames({ commands: [{ name: "todos", source: "extension" }], builtins: [] });
    const located = menu.locationFor(model);
    assert.match(located("todos"), /^moved → \/menu /);
    assert.ok(hidden.has("todos"));
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
  console.error(`\n[menu-settings-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[menu-settings-smoke] all ${tests.length} checks passed`);
