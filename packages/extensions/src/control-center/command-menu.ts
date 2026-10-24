/**
 * The curated `/` menu: in the TUI, autocomplete hides the kit commands that moved into the hub.
 *
 * The filter never changes what runs. A hidden command appears again once at least four characters
 * are typed, and a fully typed hidden command still runs unchanged; only the suggestion list is
 * touched. pi's built-ins, prompt templates and skill commands are never hidden unless the operator
 * asks for it, and every other extension command - including companion-package commands - is
 * hidden unless it is pinned.
 *
 * Settings come from the same `<agent dir>/pi-kit/ui.json` the hub key uses: `commandMenu` is
 * "curated" (the default) or "all", and `pinnedCommands` / `hiddenCommands` add names to either
 * side. A hidden command's description says where it now lives, read from the hub model.
 *
 * Self-containment rule: import only node:* builtins, pi peer types and sibling modules.
 */
import fs from "node:fs";
import path from "node:path";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { legacyCommandName, type HubModel } from "./model.ts";
import { agentDir } from "./values.ts";

/** A hidden command is offered again from this many typed characters after the slash. */
export const HIDDEN_VISIBLE_PREFIX_LENGTH = 4;

/** The location shown when no hub row runs the command. */
export const ALL_COMMANDS_LOCATION = "moved → /kit ▸ All commands";

/** The kit commands that stay in the `/` menu in every profile. */
export const PINNED_KIT_COMMANDS: readonly string[] = [
  "kit",
  "goal",
  "verify",
  "save",
  "remember",
  "effort",
  "profile",
  "update",
  "security",
];

/** Commands a profile adds to the pinned set because the profile is defined by them. */
export const PROFILE_PINNED_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  autonomous: ["autonomy"],
  pentest: ["engagement"],
  "self-improving": ["engagement", "improve", "review"],
};

export type CommandMenuMode = "curated" | "all";

export interface CommandMenuSettings {
  commandMenu: CommandMenuMode;
  /** Extra names to show even when they would be hidden. */
  pinnedCommands: string[];
  /** Extra names to hide even when they would be shown (built-ins, prompts and skills opt in here). */
  hiddenCommands: string[];
}

export const DEFAULT_COMMAND_MENU: CommandMenuMode = "curated";

const UI_FILE = "ui.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const warned = new Set<string>();

/** Write one line to stderr, once per key for the life of the process. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    process.stderr.write(`control-center: ${message}\n`);
  } catch {
    /* no stderr */
  }
}

/** `<agent dir>/pi-kit/ui.json`, parsed as an object, or undefined when absent or malformed. */
export function readUiFile(): Record<string, unknown> | undefined {
  const file = path.join(agentDir(), "pi-kit", UI_FILE);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(raw) ? raw : undefined;
  } catch {
    /* a missing or malformed file falls back to the defaults */
    return undefined;
  }
}

function commandList(value: unknown, key: string, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    warnOnce(key, `pi-kit/${UI_FILE}: ${label} must be an array of command names; ignoring it`);
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().replace(/^\/+/, ""))
    .filter((entry) => entry !== "");
}

/** The curated-menu settings, with invalid values warned about once and replaced by the defaults. */
export function readCommandMenuSettings(): CommandMenuSettings {
  const raw = readUiFile() ?? {};
  const file = path.join(agentDir(), "pi-kit", UI_FILE);
  let commandMenu: CommandMenuMode = DEFAULT_COMMAND_MENU;
  const requested = raw.commandMenu;
  if (requested === "curated" || requested === "all") {
    commandMenu = requested;
  } else if (requested !== undefined) {
    warnOnce(`${file}:commandMenu`, `pi-kit/${UI_FILE}: commandMenu must be "curated" or "all"; using "${DEFAULT_COMMAND_MENU}"`);
  }
  return {
    commandMenu,
    pinnedCommands: commandList(raw.pinnedCommands, `${file}:pinnedCommands`, "pinnedCommands"),
    hiddenCommands: commandList(raw.hiddenCommands, `${file}:hiddenCommands`, "hiddenCommands"),
  };
}

/** The pinned kit commands: the base set plus whatever the profile is defined by. */
export function pinnedCommandsFor(profile?: string): string[] {
  const extra = profile !== undefined ? PROFILE_PINNED_COMMANDS[profile] : undefined;
  return [...PINNED_KIT_COMMANDS, ...(extra ?? [])];
}

export interface CommandMenuCommand {
  name: string;
  source: string;
}

export interface HiddenCommandInput {
  /** `pi.getCommands()`: extension, prompt and skill commands with their source. */
  commands: readonly CommandMenuCommand[];
  /** pi's built-in names, which `getCommands()` does not report. */
  builtins?: readonly string[];
  /** The install marker's profile; adds that profile's pinned commands. */
  profile?: string | undefined;
  /** Extra visible names from `ui.json`. */
  pinnedCommands?: readonly string[];
  /** Extra hidden names from `ui.json`; may name a built-in, prompt or skill. */
  hiddenCommands?: readonly string[];
}

/**
 * The names the `/` menu hides. Built-ins, prompt templates, skill commands and the pinned kit
 * commands are visible; every other extension command is hidden. The `ui.json` overrides sit
 * between them: an explicit `hiddenCommands` entry beats a default pin, and an explicit
 * `pinnedCommands` entry beats everything.
 */
export function hiddenCommandNames(input: HiddenCommandInput): Set<string> {
  const explicitPinned = new Set(input.pinnedCommands ?? []);
  const explicitHidden = new Set(input.hiddenCommands ?? []);
  const defaultPinned = new Set(pinnedCommandsFor(input.profile));
  const builtins = new Set(input.builtins ?? []);
  const hidden = new Set<string>();

  const decide = (name: string, isExtension: boolean): void => {
    if (explicitPinned.has(name)) return;
    if (explicitHidden.has(name)) {
      hidden.add(name);
      return;
    }
    if (defaultPinned.has(name)) return;
    if (isExtension) hidden.add(name);
  };

  for (const command of input.commands) {
    decide(command.name, command.source === "extension" && !builtins.has(command.name));
  }
  for (const name of builtins) decide(name, false);
  // An explicit hide also covers a name that is not registered in this session yet.
  for (const name of explicitHidden) if (!explicitPinned.has(name)) hidden.add(name);
  return hidden;
}

/** The pages between the main page and `page`, outermost first. Empty for the main page. */
export function pageTrail(model: HubModel, page: string): string[] {
  const byId = new Map(model.pages.map((p) => [p.id, p]));
  const trail: string[] = [];
  let current = page;
  for (let guard = 0; guard <= model.pages.length; guard += 1) {
    const found = byId.get(current);
    if (found === undefined) break;
    if (found.parent === null) break;
    trail.unshift(found.title);
    current = found.parent;
  }
  return trail;
}

function locationOfRow(model: HubModel, page: string, label: string): string {
  return `moved → ${["/kit", ...pageTrail(model, page), label].join(" ▸ ")}`;
}

/** Where a command lives in the hub, for a hidden suggestion's description. */
export function hubLocationFor(name: string, model: HubModel): string {
  const row = model.rows.find((candidate) => legacyCommandName(candidate.legacy ?? "") === name);
  return row ? locationOfRow(model, row.page, row.label) : ALL_COMMANDS_LOCATION;
}

/** A lookup from command name to its hub location, built once from the model. */
export function locationFor(model: HubModel): (name: string) => string {
  const locations = new Map<string, string>();
  for (const row of model.rows) {
    if (row.legacy === undefined) continue;
    const name = legacyCommandName(row.legacy);
    if (name !== "" && !locations.has(name)) locations.set(name, locationOfRow(model, row.page, row.label));
  }
  return (name) => locations.get(name) ?? ALL_COMMANDS_LOCATION;
}

export interface CurationOptions {
  hidden: ReadonlySet<string>;
  locationOf: (name: string) => string;
}

/**
 * Filter a command-token suggestion list. A hidden item is dropped below the reveal length and
 * otherwise kept with its hub location prefixed to the description. `prefix` is the editor's
 * command token including the leading slash.
 */
export function curateSuggestions(items: readonly AutocompleteItem[], prefix: string, options: CurationOptions): AutocompleteItem[] {
  const typed = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  const kept: AutocompleteItem[] = [];
  for (const item of items) {
    const name = item.value.replace(/^\/+/, "");
    if (!options.hidden.has(name)) {
      kept.push(item);
      continue;
    }
    if (typed.length < HIDDEN_VISIBLE_PREFIX_LENGTH) continue;
    const location = options.locationOf(name);
    kept.push(item.description ? { ...item, description: `${location} — ${item.description}` } : { ...item, description: location });
  }
  return kept;
}

/** `/` plus the command name, with no space yet: the only input the filter touches. */
const COMMAND_TOKEN = /^\/\S*$/;

/**
 * Wrap the built-in autocomplete provider. Only the bare command token is filtered, so argument
 * completion, file completion and a forced path completion are passed through untouched.
 */
export function commandMenuProvider(current: AutocompleteProvider, config: CurationOptions): AutocompleteProvider {
  return {
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    async getSuggestions(lines, cursorLine, cursorCol, request): Promise<AutocompleteSuggestions | null> {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, request);
      if (!suggestions || request.force) return suggestions;
      const commandText = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
      if (!COMMAND_TOKEN.test(commandText)) return suggestions;
      const items = curateSuggestions(suggestions.items, commandText, config);
      if (items.length === 0) return null;
      return { items, prefix: suggestions.prefix };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
