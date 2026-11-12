/**
 * The control centre: one navigable hub for the kit's settings and actions.
 *
 * `/menu` (and its `/kit` and `/helpers` aliases, and the `alt+m` shortcut) opens a searchable tree. Every row
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
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { getOrCreateControls } from "./controls.ts";
import { buildModel, PAGES } from "./model.ts";
import { openHub, terminalConfirm, type CommandInfo, type HubDeps } from "./hub.ts";
import { agentDir, readMarker, readCompaction, readDelegation, readEffort, readProtections, readSecurity, readSubagents, readUnattended, readValues, settingsFileFor } from "./values.ts";
import { doctorLines, kitRootFromModuleUrl, readKitManifest } from "./doctor.ts";
import { builtinCommandNames } from "./builtins.ts";
import { releaseInputHolds } from "./shared/input-owner.ts";
import { commandMenuProvider, hiddenCommandNames, locationFor, readCommandMenuSettings, readUiFile, warnOnce } from "./command-menu.ts";
import { isReducedMotion, launchHeader } from "./launch-screen.ts";

const DEFAULT_HUB_KEY: KeyId = "alt+m";

// Whitespace, C0, DEL and C1 controls: rejected before any shape check because a trimmed value
// could otherwise carry one (a trailing newline is removed by `trim`, an inner one is not).
function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || char.trim() === "") return true;
  }
  return false;
}
const HUB_KEY_MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const HUB_KEY_SYMBOLS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"]);
const HUB_KEY_NAMES = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/**
 * True when `value` is one key pi-tui can parse, mirroring `parseKeyId` in its `keys.js`: any
 * number (including zero) of distinct modifiers, then one base key. A duplicate modifier is not a
 * key pi-tui can match, and `+` is the one base key that itself contains `+`.
 */
function isHubKey(value: string): value is KeyId {
  if (hasControlOrSpace(value)) return false;
  let rest = value.toLowerCase();
  const seen = new Set<string>();
  for (;;) {
    const modifier = HUB_KEY_MODIFIERS.find((name) => rest.startsWith(`${name}+`));
    if (modifier === undefined) break;
    if (seen.has(modifier)) return false;
    seen.add(modifier);
    rest = rest.slice(modifier.length + 1);
  }
  if (rest === "") return false;
  if (rest.includes("+")) return rest === "+";
  return /^[a-z0-9]$/.test(rest) || HUB_KEY_SYMBOLS.has(rest) || HUB_KEY_NAMES.has(rest);
}

/**
 * The shortcut key: `hubKey` in `<agent dir>/pi-kit/ui.json`, else alt+m. Never rewrites the file.
 * Surrounding whitespace is trimmed, then the value is accepted only when it is one key pi-tui can
 * parse; anything else is ignored with one warning naming the default, never echoing the value.
 */
export function readHubKey(): KeyId {
  const key = readUiFile()?.hubKey;
  if (key === undefined) return DEFAULT_HUB_KEY;
  if (typeof key !== "string") {
    warnInvalidHubKey();
    return DEFAULT_HUB_KEY;
  }
  const trimmed = key.trim();
  if (!isHubKey(trimmed)) {
    warnInvalidHubKey();
    return DEFAULT_HUB_KEY;
  }
  return trimmed;
}

function warnInvalidHubKey(): void {
  warnOnce(
    `${path.join(agentDir(), "pi-kit", "ui.json")}:hubKey`,
    `pi-kit/ui.json: hubKey must be one key such as "alt+k" or "ctrl+shift+k"; using "${DEFAULT_HUB_KEY}"`,
  );
}

/**
 * Install the launch screen on the existing `session_start` handler. Only a real TUI gets it:
 * RPC and print have no header, a child session stays quiet, and `launchScreen: "off"` in
 * `pi-kit/ui.json` disables it. The caller passes the same `isTui` predicate it uses for the menu,
 * so older pi without `ctx.mode` gets the header too when `hasUI` is true. The menu command is
 * `/menu`, or `/kit` when `/menu` is absent.
 */
function installLaunchHeader(pi: ExtensionAPI, ctx: ExtensionContext, isTui: boolean, hubKey: KeyId): void {
  if (!isTui) return;
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;
  if (typeof ctx.ui.setHeader !== "function") return;
  const ui = readUiFile();
  if (ui?.launchScreen === "off") return;
  const menuCmd = pi.getCommands().some((command) => command.name === "menu") ? "/menu" : "/kit";
  ctx.ui.setHeader(launchHeader({
    version: VERSION,
    hubKey,
    menuCmd,
    ascii: process.env.PI_KIT_ASCII === "1",
    reducedMotion: isReducedMotion(ui),
  }));
}

/**
 * Register the curated `/` menu in the TUI. Only a terminal gets a provider: over RPC and in print
 * or json mode the base menu is left alone, and older pi without `ctx.mode` falls back to `hasUI`.
 * The provider hides the kit commands that moved into the hub while leaving every built-in, prompt
 * and skill command visible (`commandMenu: "all"` turns the filter off entirely).
 */
function registerCommandMenu(pi: ExtensionAPI, hubKey: KeyId): void {
  // Re-run for every session: pi clears the autocomplete wrappers and the extension header when a
  // session is replaced (/new, /resume, /fork), so a one-shot guard would silently drop both.
  pi.on("session_start", (_event, ctx) => {
    const mode: string | undefined = ctx.mode;
    const isTui = mode === undefined ? ctx.hasUI : mode === "tui";
    if (!isTui) return;
    installLaunchHeader(pi, ctx, isTui, hubKey);
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
    const ascii = process.env.PI_KIT_ASCII === "1";
    const model = buildModel({ values: { securityMissing: true }, commands: commands.map((command) => command.name), controls: getOrCreateControls().list() });
    ctx.ui.addAutocompleteProvider((current) => commandMenuProvider(current, { hidden, locationOf: locationFor(model, ascii), ascii }));
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

/**
 * Every command: pi's own built-ins plus what `pi.getCommands()` reports, tagged by source.
 * Built-ins come first; a `pi.getCommands()` entry whose name is already present is skipped, because
 * pi's always-loaded extensions report the built-in extension commands (`mcp`, `llama`) too.
 */
function allCommands(pi: ExtensionAPI): CommandInfo[] {
  const out: CommandInfo[] = [];
  const seen = new Set<string>();
  for (const name of builtinCommandNames()) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "built-in" });
  }
  for (const command of pi.getCommands()) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push({ name: command.name, source: command.source ?? "extension" });
  }
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
  // pi's reload removes an open hub without settling it, so its hold ends here or never.
  pi.on("session_shutdown", () => {
    releaseInputHolds();
  });
  const hubKey = readHubKey();

  const open = async (args: string | string[], ctx: ExtensionCommandContext): Promise<void> => {
    const cwd = ctx.cwd || process.cwd();
    const commands = pi.getCommands().map((command) => command.name);
    const build = () => {
      const values = readValues({ cwd, thinkingLevel: thinkingLevelOf(pi), commandMenu: readCommandMenuSettings(), hubKey });
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

  pi.registerCommand("menu", {
    description: `Open the control centre: profile, effort, thinking, security and every page (also ${hubKey})`,
    getArgumentCompletions: (prefix: string) =>
      PAGES.filter((page) => page.id.startsWith(prefix.trim())).map((page) => ({ value: page.id, label: page.id, description: page.title })),
    handler: open,
  });

  pi.registerCommand("kit", {
    description: "Alias of /menu",
    handler: open,
  });

  pi.registerCommand("helpers", {
    description: "Alias of /menu",
    handler: open,
  });

  pi.registerShortcut(hubKey, {
    description: "Open the control centre",
    handler: () => {
      pi.sendUserMessage("/menu", { expandPromptTemplates: true });
    },
  });

  registerCommandMenu(pi, hubKey);
}
