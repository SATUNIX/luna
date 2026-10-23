/**
 * The hub's view model, built from plain data so it can be tested without a terminal.
 *
 * The tree here is the built-in fallback table: one row per setting or action, each carrying the
 * typed command that still does the work. A control registered by an owning extension (phase 2)
 * with the same id replaces the fallback row; a control with a new id is appended to its group's
 * page. Rows whose typed command is not registered in this session are marked unavailable with a
 * reason instead of silently running nothing.
 *
 * Self-containment rule: imports of `./controls.ts` and `./values.ts` stay inside the extension.
 */
import type { ControlGroup, ControlRisk, KitControl } from "./controls.ts";
import type { HubValues } from "./values.ts";

export type RowKind = "value" | "action" | "page";

/** Rows the hub renders itself rather than dispatching a typed command. */
export type RowSpecial = "thinking" | "security" | "doctor" | "all-commands" | "help";

export interface HubPage {
  id: string;
  title: string;
  parent: string | null;
}

/** A row in the built-in fallback table. */
export interface RowDef {
  id: string;
  label: string;
  page: string;
  kind?: RowKind;
  /** The typed equivalent, e.g. "/auto on". Also what a fallback row dispatches. */
  legacy?: string;
  /** Which entry of the value table to show on the right. */
  valueKey?: keyof HubValues;
  /** For a value row the hub can cycle (thinking), the values to offer. */
  values?: string[];
  /** For a page row, the page it opens. */
  targetPage?: string;
  special?: RowSpecial;
  /** For a built-in picker pi cannot open from code: text to pre-fill in the editor. */
  prefill?: string;
  description?: string;
  risk?: ControlRisk;
  /** The typed command asks at the terminal itself (/auto on), so the hub does not ask again. */
  asksItself?: boolean;
  changesSession?: boolean;
  /** Overrides the generic "not loaded in this profile" reason. */
  unavailableReason?: string;
}

/** A row as the hub renders and dispatches it. */
export interface HubRow {
  id: string;
  page: string;
  label: string;
  description?: string | undefined;
  legacy?: string | undefined;
  value?: string | undefined;
  values?: string[] | undefined;
  kind: RowKind;
  targetPage?: string | undefined;
  special?: RowSpecial | undefined;
  prefill?: string | undefined;
  risk?: ControlRisk | undefined;
  asksItself?: boolean | undefined;
  changesSession?: boolean | undefined;
  available: boolean;
  unavailableReason?: string | undefined;
}

export interface HubModel {
  pages: HubPage[];
  rows: HubRow[];
}

// --- the tree ----------------------------------------------------------------------------------

export const PAGES: HubPage[] = [
  { id: "main", title: "Control centre", parent: null },
  { id: "profiles", title: "Profile", parent: "main" },
  { id: "security", title: "Security", parent: "main" },
  { id: "autonomy", title: "Autonomy", parent: "main" },
  { id: "work", title: "Work", parent: "main" },
  { id: "session", title: "Session", parent: "main" },
  { id: "connect", title: "Connect", parent: "main" },
  { id: "system", title: "System", parent: "main" },
  { id: "delegation", title: "Delegation", parent: "work" },
  { id: "recovery", title: "Recovery", parent: "work" },
  { id: "memory", title: "Memory", parent: "work" },
  { id: "lab", title: "Lab", parent: "work" },
  { id: "display", title: "Display", parent: "system" },
  { id: "updates", title: "Updates & health", parent: "system" },
  { id: "diagnostics", title: "Diagnostics", parent: "system" },
  { id: "companions", title: "Companions", parent: "system" },
  { id: "doctor", title: "Doctor", parent: "updates" },
  { id: "all-commands", title: "All commands", parent: "system" },
  { id: "help", title: "Help & keys", parent: "system" },
];

/** The manual profiles whose firewall default is auto (report E, §5.4): switching to them weakens. */
export const AUTO_DEFAULT_PROFILES = ["long-horizon", "autonomous", "self-improving"];

const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function profileRow(name: string, title: string): RowDef {
  return {
    id: `profile.${name}`,
    label: title,
    page: "profiles",
    kind: "action",
    legacy: `/profile ${name}`,
    risk: AUTO_DEFAULT_PROFILES.includes(name) ? "weakening" : "none",
    changesSession: true,
  };
}

export const ROWS: RowDef[] = [
  // --- main: the levels, then the five pages ---
  { id: "profile", label: "Profile", page: "main", kind: "page", targetPage: "profiles", valueKey: "profile", legacy: "/profile" },
  { id: "effort", label: "Effort", page: "main", kind: "action", valueKey: "effort", legacy: "/effort" },
  { id: "thinking", label: "Thinking", page: "main", kind: "value", special: "thinking", values: THINKING_VALUES, valueKey: "thinking", description: "This session only" },
  { id: "security", label: "Security", page: "main", kind: "page", targetPage: "security", valueKey: "security" },
  { id: "security.level", label: "Security level", page: "main", kind: "action", legacy: "/security", valueKey: "security", unavailableReason: "the tool-firewall extension is not loaded" },
  { id: "page.autonomy", label: "Autonomy", page: "main", kind: "page", targetPage: "autonomy" },
  { id: "page.work", label: "Work", page: "main", kind: "page", targetPage: "work" },
  { id: "page.session", label: "Session", page: "main", kind: "page", targetPage: "session" },
  { id: "page.connect", label: "Connect", page: "main", kind: "page", targetPage: "connect" },
  { id: "page.system", label: "System", page: "main", kind: "page", targetPage: "system" },

  // --- profiles ---
  profileRow("quick", "quick"),
  profileRow("balanced", "balanced"),
  profileRow("lite", "lite"),
  profileRow("long-horizon", "long-horizon (auto approvals)"),
  profileRow("autonomous", "autonomous (auto approvals)"),
  profileRow("self-improving", "self-improving (auto approvals)"),
  profileRow("pentest", "pentest"),

  // --- autonomy ---
  { id: "approvals", label: "Approvals", page: "autonomy", kind: "action", valueKey: "approvals", legacy: "/auto" },
  { id: "approvals.auto", label: "Approvals → auto", page: "autonomy", kind: "action", legacy: "/auto on", risk: "weakening", asksItself: true, description: "Switches approvals to automatic (a model judge decides)" },
  { id: "firewall", label: "Remembered approvals", page: "autonomy", kind: "action", legacy: "/firewall" },
  { id: "loop", label: "Loop", page: "autonomy", kind: "action", legacy: "/loop", unavailableReason: "loaded only in the long-horizon and autonomous profiles" },
  { id: "boost", label: "Auto-boost", page: "autonomy", kind: "action", legacy: "/boost" },
  { id: "autonomy", label: "Container runs", page: "autonomy", kind: "action", legacy: "/autonomy", unavailableReason: "loaded only in the autonomous profile" },

  // --- work ---
  { id: "goal", label: "Goal", page: "work", kind: "action", legacy: "/goal" },
  { id: "todos", label: "Todos", page: "work", kind: "action", legacy: "/todos" },
  { id: "verify", label: "Verify", page: "work", kind: "action", legacy: "/verify" },
  { id: "page.delegation", label: "Delegation", page: "work", kind: "page", targetPage: "delegation" },
  { id: "page.recovery", label: "Recovery", page: "work", kind: "page", targetPage: "recovery" },
  { id: "page.memory", label: "Memory", page: "work", kind: "page", targetPage: "memory" },
  { id: "engagement", label: "Engagement", page: "work", kind: "action", legacy: "/engagement", unavailableReason: "loaded only in the pentest and self-improving profiles" },
  { id: "page.lab", label: "Lab", page: "work", kind: "page", targetPage: "lab" },

  // --- delegation ---
  { id: "orchestrate", label: "Orchestration", page: "delegation", kind: "action", legacy: "/orchestrate" },
  { id: "orchestrate.plan", label: "Plan only", page: "delegation", kind: "action", legacy: "/orchestrate-plan" },
  { id: "orchestrate.implement-review", label: "Plan → implement → review", page: "delegation", kind: "action", legacy: "/orchestrate-implement-review" },
  { id: "subagents", label: "Subagents", page: "delegation", kind: "action", valueKey: "subagents", legacy: "/subagents" },
  { id: "workflow", label: "Workflows", page: "delegation", kind: "action", legacy: "/workflow" },
  { id: "plan", label: "Plan mode", page: "delegation", kind: "action", legacy: "/plan", unavailableReason: "loaded only in the self-improving profile" },

  // --- recovery ---
  { id: "reflect", label: "Reflect now", page: "recovery", kind: "action", legacy: "/reflect" },
  { id: "recover", label: "Recover now", page: "recovery", kind: "action", legacy: "/recover", unavailableReason: "loaded only in the long-horizon and autonomous profiles" },

  // --- memory ---
  { id: "remember", label: "Remember", page: "memory", kind: "action", legacy: "/remember" },
  { id: "memory", label: "Memory vault", page: "memory", kind: "action", legacy: "/memory" },

  // --- lab ---
  { id: "improve", label: "Self-improvement", page: "lab", kind: "action", legacy: "/improve", unavailableReason: "loaded only in the self-improving profile" },
  { id: "improve.arm", label: "Self-improvement: arm", page: "lab", kind: "action", legacy: "/improve arm", risk: "weakening", unavailableReason: "loaded only in the self-improving profile" },
  { id: "review", label: "Dual review", page: "lab", kind: "action", legacy: "/review", unavailableReason: "loaded only in the self-improving profile" },

  // --- session ---
  { id: "save", label: "Save check-in", page: "session", kind: "action", legacy: "/save" },
  { id: "handoff", label: "Handoff note", page: "session", kind: "action", legacy: "/handoff" },
  // /compact is a pi built-in: pi.getCommands() never lists it and sendUserMessage cannot run it.
  { id: "compact", label: "Compact now", page: "session", kind: "action", prefill: "/compact " },
  { id: "compress", label: "Compress (no model call)", page: "session", kind: "action", legacy: "/compress" },
  { id: "compaction", label: "Auto-compaction", page: "session", kind: "action", valueKey: "compaction", legacy: "/compaction" },
  { id: "session.new", label: "New session", page: "session", kind: "action", prefill: "/new " },
  { id: "session.fork", label: "Fork", page: "session", kind: "action", prefill: "/fork " },
  { id: "session.clone", label: "Clone", page: "session", kind: "action", prefill: "/clone " },
  { id: "session.tree", label: "Session tree", page: "session", kind: "action", prefill: "/tree " },
  { id: "session.resume", label: "Resume a session", page: "session", kind: "action", prefill: "/resume " },
  { id: "session.name", label: "Name this session", page: "session", kind: "action", prefill: "/name " },
  { id: "clear", label: "Start fresh", page: "session", kind: "action", legacy: "/clear" },

  // --- connect ---
  { id: "remote", label: "Remote control", page: "connect", kind: "action", legacy: "/remote" },
  { id: "console", label: "Web console", page: "connect", kind: "action", legacy: "/console" },
  { id: "console.start", label: "Start the web console", page: "connect", kind: "action", legacy: "/console start", risk: "weakening", description: "Opens a local network listener" },

  // --- system ---
  { id: "page.display", label: "Display", page: "system", kind: "page", targetPage: "display" },
  { id: "page.updates", label: "Updates & health", page: "system", kind: "page", targetPage: "updates" },
  { id: "page.diagnostics", label: "Diagnostics", page: "system", kind: "page", targetPage: "diagnostics" },
  { id: "page.companions", label: "Companions", page: "system", kind: "page", targetPage: "companions" },
  { id: "all-commands", label: "All commands", page: "system", kind: "page", targetPage: "all-commands" },
  { id: "help", label: "Help & keys", page: "system", kind: "page", targetPage: "help" },

  // --- display ---
  { id: "footer", label: "Status bar", page: "display", kind: "action", legacy: "/footer" },
  { id: "tips", label: "Tips", page: "display", kind: "action", legacy: "/tips" },
  { id: "caveman", label: "Output style", page: "display", kind: "action", legacy: "/caveman" },

  // --- updates & health ---
  { id: "doctor", label: "Doctor", page: "updates", kind: "page", targetPage: "doctor", description: "Read-only checks: version, profile, companions, registries" },
  { id: "update.status", label: "Update: status", page: "updates", kind: "action", legacy: "/update status" },
  { id: "update.kit", label: "Update: kit", page: "updates", kind: "action", legacy: "/update kit", changesSession: true },
  { id: "update.pi", label: "Update: pi", page: "updates", kind: "action", legacy: "/update pi", changesSession: true },
  { id: "update.all", label: "Update: all", page: "updates", kind: "action", legacy: "/update all", changesSession: true },

  // --- diagnostics ---
  { id: "trace", label: "Trace summary", page: "diagnostics", kind: "action", legacy: "/trace" },
  { id: "capture", label: "Tool capture", page: "diagnostics", kind: "action", legacy: "/capture" },
  { id: "skills", label: "Skills", page: "diagnostics", kind: "action", legacy: "/skills" },
  { id: "firewall.reload", label: "Reload firewall policy", page: "diagnostics", kind: "action", legacy: "/firewall reload" },

  // --- companions ---
  { id: "lens.health", label: "pi-lens health", page: "companions", kind: "action", legacy: "/lens-health" },
  { id: "websearch", label: "Web search", page: "companions", kind: "action", legacy: "/websearch" },
  { id: "litellm.refresh", label: "LiteLLM refresh", page: "companions", kind: "action", legacy: "/litellm-refresh" },
];

// --- building the model ------------------------------------------------------------------------

/** The command name a typed equivalent invokes ("/auto on" -> "auto"). */
export function legacyCommandName(legacy: string): string {
  return legacy.trim().replace(/^\/+/, "").split(/\s+/)[0] ?? "";
}

/** A control's group maps to the page a hub row lives on. */
export function pageForGroup(group: ControlGroup): string {
  switch (group) {
    case "levels":
      return "main";
    case "work":
    case "lab":
      return "work";
    default:
      return group;
  }
}

const UNAVAILABLE = "not loaded in this profile";

function rowFromDef(def: RowDef, values: HubValues, commands: Set<string>): HubRow {
  const kind: RowKind = def.kind ?? (def.targetPage ? "page" : "action");
  let available = true;
  let unavailableReason: string | undefined;
  if (def.legacy && kind === "action") {
    const name = legacyCommandName(def.legacy);
    if (!commands.has(name)) {
      available = false;
      unavailableReason = def.unavailableReason ?? UNAVAILABLE;
    }
  }
  const value = def.valueKey ? values[def.valueKey] : undefined;
  // Without the firewall's registry there is no level: say why on the Security row.
  const description = def.id === "security" && values.securityMissing ? "the tool-firewall extension is not loaded" : def.description;
  return {
    id: def.id,
    page: def.page,
    label: def.label,
    description,
    legacy: def.legacy,
    value: typeof value === "string" ? value : undefined,
    values: def.values,
    kind,
    targetPage: def.targetPage,
    special: def.special,
    prefill: def.prefill,
    risk: def.risk,
    asksItself: def.asksItself,
    changesSession: def.changesSession,
    available,
    unavailableReason,
  };
}

function rowFromControl(control: KitControl, commands: Set<string>): HubRow {
  const legacy = control.legacy;
  const page = pageForGroup(control.group);
  let value: string | undefined;
  try {
    const current = control.value?.();
    if (typeof current === "string") value = current;
  } catch {
    value = undefined;
  }
  let values: string[] | undefined;
  try {
    const offered = control.values?.();
    if (Array.isArray(offered)) values = offered.filter((v): v is string => typeof v === "string");
  } catch {
    values = undefined;
  }
  let available = true;
  let unavailableReason: string | undefined;
  if (legacy) {
    const name = legacyCommandName(legacy);
    if (!commands.has(name)) {
      available = false;
      unavailableReason = UNAVAILABLE;
    }
  }
  return {
    id: control.id,
    page,
    label: control.label,
    description: control.description,
    legacy,
    value,
    values,
    kind: legacy ? "action" : "value",
    targetPage: undefined,
    special: undefined,
    prefill: undefined,
    risk: control.risk,
    changesSession: control.changesSession,
    available,
    unavailableReason,
  };
}

export interface BuildModelInput {
  values: HubValues;
  /** Command names registered in this session (`pi.getCommands()`). */
  commands: string[];
  /** Controls registered by owning extensions; a matching id replaces the fallback row. */
  controls?: KitControl[];
}

/** Build the hub model: fallback rows, with any registered control of the same id replacing one. */
export function buildModel(input: BuildModelInput): HubModel {
  const commands = new Set(input.commands);
  const controlsById = new Map<string, KitControl>();
  for (const control of input.controls ?? []) controlsById.set(control.id, control);

  const rows: HubRow[] = [];
  const used = new Set<string>();
  for (const def of ROWS) {
    const control = controlsById.get(def.id);
    if (control) {
      rows.push(rowFromControl(control, commands));
      used.add(def.id);
    } else {
      rows.push(rowFromDef(def, input.values, commands));
    }
  }
  // A control with no fallback row is appended to its group's page.
  for (const [id, control] of controlsById) {
    if (used.has(id)) continue;
    rows.push(rowFromControl(control, commands));
  }
  return { pages: PAGES, rows };
}

/** Rows on a page, in table order. */
export function pageRows(model: HubModel, page: string): HubRow[] {
  return model.rows.filter((row) => row.page === page);
}

/** The parent page, or null for the main page. */
export function parentPage(model: HubModel, page: string): string | null {
  return model.pages.find((p) => p.id === page)?.parent ?? null;
}

/** Search every row on every page: label, description, id, typed command or current value. */
export function searchRows(model: HubModel, query: string): HubRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return model.rows;
  return model.rows.filter((row) => {
    const haystack = [row.id, row.label, row.description ?? "", row.legacy ?? "", row.value ?? ""].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}

/** The row with an id, if the model has one. */
export function findRow(model: HubModel, id: string): HubRow | undefined {
  return model.rows.find((row) => row.id === id);
}
