/**
 * The hub: dispatch a row, and render the model by mode.
 *
 * - TUI: `ctx.ui.custom()` hosting pi-tui's `SettingsList` (searchable, Enter/Space cycles or opens,
 *   Esc goes back). It opens as an overlay only on pi 1.3.0 or newer, where the overlay `done()` bug
 *   is fixed.
 * - RPC (hasUI, not TUI): a chain of `ctx.ui.select` dialogs. Every dialog carries a `timeout`, and
 *   a timeout counts as cancel, so a dialog nobody answers does not hold the session.
 * - print / json (no UI): a text page with every row's value and typed command, written to stderr.
 *
 * A weakening row (one that lowers oversight) is refused outside the TUI and in a child session, and
 * in the TUI runs only after a confirmation the terminal alone can answer. The terminal's own dialog
 * functions are recovered from the remote-control mirror (the same `Symbol.for` key its bridge uses)
 * without importing that extension.
 *
 * Self-containment rule: import only pi peers and sibling modules.
 */
import {
  VERSION,
  getSettingsListTheme,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { legacyCommandName, findRow, pageRows, parentPage, type HubModel, type HubRow } from "./model.ts";
import { doctorLines, type DoctorLine } from "./doctor.ts";
import type { HubValues } from "./values.ts";

/** A command as `pi.getCommands()` reports it, plus the built-ins the hub adds itself. */
export interface CommandInfo {
  name: string;
  source: string;
}

export interface HubDeps {
  ctx: ExtensionContext;
  model: HubModel;
  values: HubValues;
  /** Registered command names in this session. */
  commands: string[];
  /** Dispatch the typed equivalent as a user message (runs extension commands too). */
  sendCommand(text: string): void;
  /** Pre-fill the editor for a pi built-in picker the hub cannot open from code. */
  prefill(text: string): void;
  /** A confirmation that a mirrored phone cannot answer. */
  confirm(title: string, detail: string): Promise<boolean>;
  /** The text renderer's target (stderr). */
  write(text: string): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /** Doctor lines, built from disk when the page opens. */
  doctor(): DoctorLine[];
  /** Every command, for the All commands page. */
  allCommands(): CommandInfo[];
  getThinkingLevel?(): string | undefined;
  setThinkingLevel?(level: string): void;
  /** Re-read the values and rebuild the model, so a page reopened after a change shows it. */
  refresh?(): { model: HubModel; values: HubValues };
  /** The shortcut that opens the hub (`hubKey` in ui.json), shown on the Help page; alt+m when absent. */
  hubKey?: string;
  isChild: boolean;
}

/** A renderer choice: a row id (with the value it was cycled to), Back, or close. */
export type PageChoice = { id: string; value?: string | undefined } | "back" | undefined;

export interface PageInput {
  model: HubModel;
  page: string;
  rows: HubRow[];
  title: string;
  parent: string | null;
  /** The row to put the cursor on, when the page reopens after an action or a Back. */
  focus?: string | undefined;
}

export interface Renderer {
  show(input: PageInput): Promise<PageChoice>;
}

// --- dispatch ----------------------------------------------------------------------------------

export interface DispatchResult {
  ok: boolean;
  note?: string;
  changesSession?: boolean;
  /**
   * The row handed over to a typed command or to the editor. The hub closes, because a command's
   * own dialogs (and the editor) must get the keyboard: pi.sendUserMessage returns before the
   * command runs, so a reopened hub would sit on top of them.
   */
  handedOff?: boolean;
}

/** Commands that reload or start a session: the hub closes and does not reopen afterwards. */
const SESSION_COMMANDS = new Set(["new", "fork", "clone", "tree", "resume", "reload", "quit", "profile", "update"]);

/** Dispatch a chosen row: weaken check, then the real API, the typed command, or an editor pre-fill. */
export async function dispatchRow(row: HubRow, deps: HubDeps, value?: string): Promise<DispatchResult> {
  if (!row.available) return { ok: false, note: row.unavailableReason ?? "not available in this session" };

  if (row.risk === "weakening") {
    if (deps.isChild || deps.ctx.mode !== "tui") {
      return { ok: false, note: "change this at the terminal" };
    }
    if (!row.asksItself) {
      const confirmed = await deps.confirm(row.label, row.description ?? "This lowers oversight. Confirm at the terminal to continue.");
      if (!confirmed) return { ok: false, note: "cancelled" };
    }
  }

  if (row.special === "thinking") {
    if (value && deps.setThinkingLevel) deps.setThinkingLevel(value);
    return { ok: true };
  }
  if (row.prefill) {
    deps.prefill(row.prefill);
    return { ok: true, handedOff: true };
  }
  if (row.legacy) {
    const name = legacyCommandName(row.legacy);
    if (!deps.commands.includes(name)) return { ok: false, note: `/${name} is not registered in this session` };
    deps.sendCommand(row.legacy);
    return { ok: true, handedOff: true, changesSession: row.changesSession === true || SESSION_COMMANDS.has(name) };
  }
  // An informational row (Doctor/Security/Help lines): nothing to run.
  return { ok: true };
}

// --- terminal-only confirmation ----------------------------------------------------------------

/** The remote-control mirror records the terminal's real dialogs under this key (bridge.ts). */
const MIRROR_KEY: unique symbol = Symbol.for("pi-system.remote-control.mirror");

interface TerminalDialogs {
  select: ExtensionUIContext["select"];
}

function mirrorOf(ui: ExtensionUIContext): TerminalDialogs | undefined {
  const original: unknown = Reflect.get(ui, MIRROR_KEY);
  if (original && typeof original === "object" && typeof (original as { select?: unknown }).select === "function") {
    return { select: (original as TerminalDialogs).select };
  }
  return undefined;
}

/**
 * The terminal's own yes/no for a weakening row, bypassing any mirror a phone is also answering
 * on. pi's confirm starts on "Yes", so this is a select whose first option keeps things as they
 * are; only choosing the second one returns true.
 */
export function terminalConfirm(ui: ExtensionUIContext): (title: string, detail: string) => Promise<boolean> {
  const select = mirrorOf(ui)?.select ?? ui.select.bind(ui);
  return async (title, detail) => (await select(`${title}: ${detail}`, ["No, keep things as they are", "Yes, go ahead"])) === "Yes, go ahead";
}

// --- page content ------------------------------------------------------------------------------

function informationalPage(page: string, title: string, lines: Array<{ label: string; value: string; command?: string }>): HubRow[] {
  return lines.map((line, index) => ({
    id: `${page}.${index}`,
    page,
    label: line.label,
    value: line.value,
    description: line.command ? `more: ${line.command}` : undefined,
    kind: "action",
    available: true,
  }));
}

function securityRows(deps: HubDeps, page: string): HubRow[] {
  const values = deps.values;
  const note = values.securityMissing ? "the tool-firewall extension is not loaded" : "the tool firewall (pi-kit.security)";
  return informationalPage(page, "Security", [
    { label: "Effective", value: values.security ?? "unknown" },
    { label: "Requested", value: values.securityRequested ?? "same as effective" },
    { label: "Source", value: note, command: "/security status" },
  ]);
}

function helpRows(page: string, hubKey = "alt+m"): HubRow[] {
  return informationalPage(page, "Help & keys", [
    { label: "Open", value: `/kit, /helpers, or the ${hubKey} key` },
    { label: "Navigate", value: "Enter opens or cycles, Esc goes back, type to search" },
    { label: "Typed", value: "every row shows its typed command; every old command still works" },
    { label: "Weakening", value: "a change that lowers oversight needs a confirmation the terminal alone can answer" },
  ]);
}

/** Rows for a page: a generated page (Doctor, All commands, Security, Help) or the model's rows. */
export function rowsForPage(page: string, deps: HubDeps): HubRow[] {
  if (page === "doctor") {
    return informationalPage(
      "doctor",
      "Doctor",
      // A line the Doctor flags as drift (ok: false) keeps that flag as a leading "! ".
      deps.doctor().map((line) => ({ label: line.ok ? line.label : `! ${line.label}`, value: line.value, command: line.command })),
    );
  }
  if (page === "all-commands") {
    return deps.allCommands().map((command, index) => ({
      id: `all-commands.${index}`,
      page: "all-commands",
      label: `/${command.name}`,
      description: command.source,
      kind: "action",
      prefill: `/${command.name} `,
      available: true,
    }));
  }
  if (page === "security") return securityRows(deps, page);
  if (page === "help") return helpRows(page, deps.hubKey);
  return pageRows(deps.model, page);
}

/** The header strip: profile · effort · thinking · security · approvals. */
export function headerLine(values: HubValues): string {
  const parts = [
    values.profile ? `profile ${values.profile}` : undefined,
    values.effort,
    values.thinking ? `think ${values.thinking}` : undefined,
    values.security ? `sec ${values.security}` : undefined,
    values.approvals ? `approvals ${values.approvals}` : undefined,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function pageTitle(model: HubModel, page: string, values: HubValues): string {
  const title = model.pages.find((p) => p.id === page)?.title ?? page;
  return page === "main" ? `Control centre — ${headerLine(values)}` : title;
}

// --- renderers ---------------------------------------------------------------------------------

function textPage(deps: HubDeps): string {
  const lines: string[] = [`Control centre — ${headerLine(deps.values)}`];
  for (const page of deps.model.pages) {
    const rows = rowsForPage(page.id, deps);
    if (rows.length === 0) continue;
    lines.push("", `${page.title}${page.parent ? ` (${page.parent})` : ""}`);
    for (const row of rows) {
      const value = row.value ? `: ${row.value}` : "";
      const typed = row.legacy ? `  [${row.legacy}]` : row.prefill ? `  [${row.prefill.trim()}]` : "";
      const unavailable = row.available ? "" : `  (${row.unavailableReason ?? "unavailable"})`;
      lines.push(`  ${row.label}${value}${typed}${unavailable}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** No UI: print every row and its typed command, then stop. */
function printModel(deps: HubDeps): void {
  deps.write(textPage(deps));
}

/** RPC: a chain of select dialogs, each with a timeout; a timeout cancels. */
function selectRenderer(deps: HubDeps): Renderer {
  return {
    async show(input: PageInput): Promise<PageChoice> {
      const options = input.rows.map((row) => rowLabel(row));
      if (input.parent) options.push("‹ Back");
      options.push("Close");
      let chosen: string | undefined;
      try {
        chosen = await deps.ctx.ui.select(input.title, options, { timeout: 60_000 });
      } catch {
        return undefined;
      }
      if (chosen === undefined || chosen === "Close") return undefined;
      if (chosen === "‹ Back") return "back";
      const index = options.indexOf(chosen);
      const row = input.rows[index];
      if (!row) return undefined;
      // A value row with choices opens a second dialog so the operator picks the value.
      if (row.values && row.values.length > 0) {
        let value: string | undefined;
        try {
          value = await deps.ctx.ui.select(`${row.label} (now ${row.value ?? "?"})`, row.values, { timeout: 60_000 });
        } catch {
          return undefined;
        }
        if (value === undefined) return "back";
        return { id: row.id, value };
      }
      return { id: row.id };
    },
  };
}

function rowLabel(row: HubRow): string {
  const value = row.value ? `: ${row.value}` : "";
  const unavailable = row.available ? "" : ` — ${row.unavailableReason ?? "unavailable"}`;
  return `${row.label}${value}${unavailable}`;
}

/** True when the running pi has the overlay `done()` fix (1.3.0 or newer). */
export function supportsOverlay(version: string = VERSION): boolean {
  const parts = version.replace(/^[^0-9]*/, "").split(/[.\-+]/).map((p) => Number(p));
  const [major = 0, minor = 0] = parts;
  return major > 1 || (major === 1 && minor >= 3);
}

function tuiRenderer(deps: HubDeps): Renderer {
  return {
    async show(input: PageInput): Promise<PageChoice> {
      const overlay = supportsOverlay();
      const result = await deps.ctx.ui.custom<PageChoice>(
        (_tui, theme, _keybindings, done) => {
          const items: SettingItem[] = input.rows.map((row) => {
            const description = row.available ? row.description : row.unavailableReason;
            return {
              id: row.id,
              label: row.available ? row.label : `${row.label} (unavailable)`,
              ...(description ? { description } : {}),
              currentValue: row.value ?? "",
              // Every row carries `values` so Enter/Space activates it: a multi-value row cycles, an
              // action row re-selects its one value and fires onChange.
              values: row.values && row.values.length > 0 ? row.values : [row.value ?? ""],
            };
          });
          const container = new Container();
          container.addChild({
            render: () => [theme.fg("accent", theme.bold(input.title)), ""],
            invalidate: () => {},
          });
          const list = new SettingsList(
            items,
            15,
            getSettingsListTheme(),
            (id, newValue) => {
              const row = input.rows.find((r) => r.id === id);
              if (!row) return;
              done({ id, value: row.values && row.values.length > 0 ? newValue : undefined });
            },
            () => done(input.parent ? "back" : undefined),
            { enableSearch: true },
          );
          if (input.focus) list.selectItem(input.focus);
          container.addChild(list);
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              list.handleInput?.(data);
              _tui.requestRender();
            },
          };
        },
        overlay ? { overlay: true } : undefined,
      );
      return result;
    },
  };
}

// --- the loop ----------------------------------------------------------------------------------

/** Open the hub at `startPage`. Returns when the operator closes it or a session-changing action ran. */
export async function openHub(deps: HubDeps, startPage = "main"): Promise<void> {
  if (!deps.ctx.hasUI) {
    printModel(deps);
    return;
  }
  const renderer = deps.ctx.mode === "tui" ? tuiRenderer(deps) : selectRenderer(deps);
  let page = startPage;
  let focus: string | undefined;
  for (;;) {
    const rows = rowsForPage(page, deps);
    const result = await renderer.show({ model: deps.model, page, rows, title: pageTitle(deps.model, page, deps.values), parent: parentPage(deps.model, page), focus });
    focus = undefined;
    if (result === undefined) return;
    if (result === "back") {
      const parent = parentPage(deps.model, page);
      if (!parent) return;
      // Back on the parent, the cursor returns to the row that opened this page.
      focus = deps.model.rows.find((r) => r.page === parent && r.targetPage === page)?.id;
      page = parent;
      continue;
    }
    const row = findRow(deps.model, result.id) ?? rows.find((r) => r.id === result.id);
    if (!row) continue;
    if (row.kind === "page" && row.targetPage) {
      page = row.targetPage;
      continue;
    }
    const dispatched = await dispatchRow(row, deps, result.value);
    focus = row.id;
    if (!dispatched.ok) {
      deps.notify(dispatched.note ?? "nothing changed", "warning");
      continue;
    }
    if (dispatched.handedOff || dispatched.changesSession) return;
    // An in-place change (the thinking level) or an informational row: reopen on the same row,
    // with the values read again so the change shows.
    const next = deps.refresh?.();
    if (next) {
      deps.model = next.model;
      deps.values = next.values;
    }
  }
}

/** Re-export for callers that build deps from disk. */
export { doctorLines };
export type { DoctorLine };
