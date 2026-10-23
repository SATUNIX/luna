/**
 * The control centre: one navigable hub for the kit's settings and actions.
 *
 * `/kit` (and its `/helpers` alias, and the `alt+m` shortcut) opens a searchable tree. Every row
 * carries its typed command; the hub never renames anything, and the TUI's `/` menu only filters
 * autocomplete suggestions (see `command-menu.ts`) while every command keeps running when typed.
 *
 * The registry (`globalThis[Symbol.for("pi-kit.controls")]`) is published at load so an owning
 * extension can register a real control that the hub and the old command share (phase 2). Until
 * then the hub uses its built-in fallback table.
 *
 * Nothing registers in an internal child session (`PI_KIT_INTERNAL_CHILD=1`), the rule `/workflow`
 * follows.
 *
 * Self-containment rule: import only node:* builtins, pi peers and sibling modules.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { getOrCreateControls } from "./controls.ts";
import { buildModel, PAGES } from "./model.ts";
import { openHub, terminalConfirm, type CommandInfo, type HubDeps } from "./hub.ts";
import { readMarker, readCompaction, readDelegation, readEffort, readProtections, readSecurity, readSubagents, readUnattended, readValues, settingsFileFor } from "./values.ts";
import { doctorLines, kitRootFromModuleUrl, readKitManifest } from "./doctor.ts";
import { builtinCommandNames } from "./builtins.ts";
import { commandMenuProvider, hiddenCommandNames, locationFor, readCommandMenuSettings, readUiFile } from "./command-menu.ts";

const DEFAULT_HUB_KEY = "alt+m";

/** The shortcut key: `hubKey` in `<agent dir>/pi-kit/ui.json`, else alt+m. Never rewrites the file. */
export function readHubKey(): string {
  const key = readUiFile()?.hubKey;
  if (typeof key === "string" && key.trim() !== "") return key.trim();
  return DEFAULT_HUB_KEY;
}

/**
 * Register the curated `/` menu in the TUI. Only a terminal gets a provider: over RPC and in print
 * or json mode the base menu is left alone, and older pi without `ctx.mode` falls back to `hasUI`.
 * The provider hides the kit commands that moved into the hub while leaving every built-in, prompt
 * and skill command visible (`commandMenu: "all"` turns the filter off entirely).
 */
function registerCommandMenu(pi: ExtensionAPI): void {
  let curated = false;
  pi.on("session_start", (_event, ctx) => {
    if (curated) return;
    const mode: string | undefined = ctx.mode;
    const isTui = mode === undefined ? ctx.hasUI : mode === "tui";
    if (!isTui) return;
    curated = true;
    const settings = readCommandMenuSettings();
    if (settings.commandMenu === "all") return;
    const commands = pi.getCommands().map((command) => ({ name: command.name, source: command.source }));
    const hidden = hiddenCommandNames({
      commands,
      builtins: builtinCommandNames(),
      profile: readMarker(ctx.cwd || process.cwd()).profile,
      pinnedCommands: settings.pinnedCommands,
      hiddenCommands: settings.hiddenCommands,
    });
    const model = buildModel({ values: { securityMissing: true }, commands: commands.map((command) => command.name), controls: getOrCreateControls().list() });
    ctx.ui.addAutocompleteProvider((current) => commandMenuProvider(current, { hidden, locationOf: locationFor(model) }));
  });
}

/** The first word of the command's argument, when it names a page. */
function pageArg(args: string | string[] | undefined): string {
  const text = Array.isArray(args) ? args.join(" ") : (args ?? "");
  return text.trim().split(/\s+/)[0] ?? "";
}

function thinkingLevelOf(pi: ExtensionAPI): string | undefined {
  try {
    return pi.getThinkingLevel();
  } catch {
    return undefined;
  }
}

/** Every command: pi's own built-ins plus what `pi.getCommands()` reports, tagged by source. */
function allCommands(pi: ExtensionAPI): CommandInfo[] {
  const out: CommandInfo[] = [];
  for (const name of builtinCommandNames()) out.push({ name, source: "built-in" });
  for (const command of pi.getCommands()) out.push({ name: command.name, source: command.source ?? "extension" });
  return out;
}

function buildDoctor(ctx: ExtensionContext) {
  const cwd = ctx.cwd || process.cwd();
  const security = readSecurity();
  const manifest = readKitManifest(kitRootFromModuleUrl(import.meta.url));
  return doctorLines({
    marker: readMarker(cwd),
    piVersion: VERSION,
    kitVersion: manifest.version,
    kitTestedPin: manifest.testedPin,
    kitFloor: manifest.floor,
    settingsFile: settingsFileFor(cwd),
    registries: {
      effort: readEffort(),
      protections: readProtections().length,
      delegation: readDelegation(),
      compaction: readCompaction(),
      unattended: readUnattended(),
      subagents: readSubagents(),
      security: security.missing ? undefined : security.effective,
    },
  });
}

export default function controlCenter(pi: ExtensionAPI): void {
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;

  // Publish the registry at load so an owning extension can register before the hub ever opens.
  getOrCreateControls();
  const hubKey = readHubKey();

  const open = async (args: string | string[], ctx: ExtensionCommandContext): Promise<void> => {
    const cwd = ctx.cwd || process.cwd();
    const commands = pi.getCommands().map((command) => command.name);
    const build = () => {
      const values = readValues({ cwd, thinkingLevel: thinkingLevelOf(pi) });
      return { values, model: buildModel({ values, commands, controls: getOrCreateControls().list() }) };
    };
    const { values, model } = build();
    const requested = pageArg(args);
    const startPage = PAGES.some((page) => page.id === requested) ? requested : "main";
    const deps: HubDeps = {
      ctx,
      model,
      values,
      commands,
      sendCommand: (text) => {
        pi.sendUserMessage(text, { expandPromptTemplates: true });
      },
      prefill: (text) => {
        ctx.ui.setEditorText(text);
      },
      confirm: (title, detail) => terminalConfirm(ctx.ui)(title, detail),
      write: (text) => {
        try {
          process.stderr.write(text);
        } catch {
          /* no stderr */
        }
      },
      notify: (message, level) => {
        try {
          ctx.ui.notify(message, level);
        } catch {
          /* stale ctx after a reload */
        }
      },
      doctor: () => buildDoctor(ctx),
      allCommands: () => allCommands(pi),
      getThinkingLevel: () => thinkingLevelOf(pi),
      setThinkingLevel: (level) => {
        pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
      },
      refresh: build,
      hubKey,
      isChild: process.env.PI_KIT_INTERNAL_CHILD === "1",
    };
    await openHub(deps, startPage);
  };

  pi.registerCommand("kit", {
    description: `Open the control centre: profile, effort, thinking, security and every page (also ${hubKey})`,
    getArgumentCompletions: (prefix: string) =>
      PAGES.filter((page) => page.id.startsWith(prefix.trim())).map((page) => ({ value: page.id, label: page.id, description: page.title })),
    handler: open,
  });

  pi.registerCommand("helpers", {
    description: "Alias of /kit - open the control centre",
    handler: open,
  });

  pi.registerShortcut(hubKey as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Open the control centre",
    handler: () => {
      pi.sendUserMessage("/kit", { expandPromptTemplates: true });
    },
  });

  registerCommandMenu(pi);
}
