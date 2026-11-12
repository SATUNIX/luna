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
import {
  Container,
  SettingsList,
  stripTerminalSequences,
  type SettingItem,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { legacyCommandName, findRow, pageRows, parentPage, type HubModel, type HubRow } from "./model.ts";
import { doctorLines, type DoctorLine } from "./doctor.ts";
import { withInputHold } from "./shared/input-owner.ts";
import { withOverlayFrame } from "./overlay-frame.ts";
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
  // SAFETY: the remote-control bridge publishes this symbol-keyed mirror at runtime; the peer
  // type does not declare it, and the value is checked below before use.
  const host = ui as unknown as Record<symbol, unknown>;
  const original: unknown = host[MIRROR_KEY];
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

// --- display text ------------------------------------------------------------------------------

/**
 * Every invisible or control code point: format characters (bidi overrides, zero-width joiners),
 * control characters (ESC, C0 and C1, so a C1 CSI byte cannot act as one) and default-ignorable
 * code points (variation selectors, Hangul fillers, ...). Same Unicode classes as HIDDEN_CHARS in
 * packages/autonomy/lib/notebook.ts, repeated here because the hub imports only pi peers and
 * sibling modules. Display text is one line, so tabs and newlines go too.
 */
const HIDDEN_DISPLAY_CHARS = /[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

/** A repository-controlled string cannot flood a page or the header strip. */
const MAX_DISPLAY_LENGTH = 500;

/**
 * The one filter for every repository-controlled display string: pi-tui's sequence strip first, then
 * every remaining control/format code point (alternate-screen sequences, resets, C1 CSI, bidi
 * overrides), then trim, then the length bound. Capping by code point keeps a surrogate pair whole.
 */
function displayText(text: string): string {
  const filtered = stripTerminalSequences(text).replace(HIDDEN_DISPLAY_CHARS, "").trim();
  return Array.from(filtered).slice(0, MAX_DISPLAY_LENGTH).join("");
}

// --- page content ------------------------------------------------------------------------------

function informationalPage(page: string, title: string, lines: Array<{ label: string; value: string; command?: string }>): HubRow[] {
  return lines.map((line, index) => {
    const command = line.command ? displayText(line.command) : undefined;
    return {
      id: `${page}.${index}`,
      page,
      label: displayText(line.label),
      value: displayText(line.value),
      command,
      description: command ? displayText(`more: ${command}`) : undefined,
      kind: "action",
      available: true,
    };
  });
}

function securityRows(deps: HubDeps, page: string): HubRow[] {
  const values = deps.values;
  const note = values.securityMissing ? "the tool-firewall extension is not loaded" : "the tool firewall (pi-kit.security)";
  return informationalPage(page, "Security", [
    { label: "Effective", value: values.securityEffective ?? "unknown" },
    { label: "Requested", value: values.securityRequested ?? "same as effective" },
    { label: "Source", value: note, command: "/security status" },
  ]);
}

function helpRows(page: string, hubKey = "alt+m"): HubRow[] {
  return informationalPage(page, "Help & keys", [
    { label: "Open", value: `/menu, /kit, /helpers, or the ${hubKey} key` },
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
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => displayText(part))
    .join(" · ");
}

function pageTitle(model: HubModel, page: string, values: HubValues): string {
  const title = model.pages.find((p) => p.id === page)?.title ?? page;
  return displayText(page === "main" ? `Control centre — ${headerLine(values)}` : title);
}

// --- renderers ---------------------------------------------------------------------------------

function textPage(deps: HubDeps): string {
  const lines: string[] = [`Control centre — ${headerLine(deps.values)}`];
  for (const page of deps.model.pages) {
    const rows = rowsForPage(page.id, deps);
    if (rows.length === 0) continue;
    lines.push("", `${displayText(page.title)}${page.parent ? ` (${displayText(page.parent)})` : ""}`);
    for (const row of rows) {
      const value = row.value ? `: ${row.value}` : "";
      const typed = typedSuffix(row);
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
        // A cancelled or timed-out value dialog counts as cancel: close the hub, do not
        // reopen the page the operator came from (docs/control-center.md, "Renderers by mode").
        if (value === undefined) return undefined;
        return { id: row.id, value };
      }
      return { id: row.id };
    },
  };
}

/** The typed command a row runs or pre-fills; informational rows carry the command they name. */
function typedCommand(row: HubRow): string | undefined {
  const prefill = row.prefill?.trim();
  const raw = row.legacy ?? (prefill ? prefill : undefined) ?? row.command;
  if (!raw) return undefined;
  // A registered control supplies its own legacy text; keep it from adding a newline or escape.
  return displayText(raw) || undefined;
}

/** `  [/command]`, or nothing when there is no typed command or the label already is it. */
function typedSuffix(row: HubRow): string {
  const typed = typedCommand(row);
  return typed && typed !== row.label ? `  [${typed}]` : "";
}

function rowLabel(row: HubRow): string {
  const value = row.value ? `: ${row.value}` : "";
  const unavailable = row.available ? "" : ` — ${row.unavailableReason ?? "unavailable"}`;
  return `${row.label}${value}${typedSuffix(row)}${unavailable}`;
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
        (tui, theme, _keybindings, done) =>
          withOverlayFrame(tui, theme, (finish) => {
            const items: SettingItem[] = input.rows.map((row) => {
              const description = row.available ? row.description : row.unavailableReason;
              return {
                id: row.id,
                label: `${row.label}${typedSuffix(row)}${row.available ? "" : " (unavailable)"}`,
                ...(description ? { description } : {}),
                currentValue: row.value ?? "",
                // Every row carries `values` so Enter/Space activates it: a multi-value row cycles, an
                // action row re-selects its one value and fires onChange.
                values: row.values && row.values.length > 0 ? row.values : [row.value ?? ""],
              };
            });
            const titleLines = (): string[] => [theme.fg("accent", theme.bold(input.title)), ""];
            const listTheme = getSettingsListTheme();
            const container = new Container();
            const list = new SettingsList(
              items,
              15,
              listTheme,
              (id, newValue) => {
                const row = input.rows.find((r) => r.id === id);
                if (!row) return;
                finish({ id, value: row.values && row.values.length > 0 ? newValue : undefined });
              },
              () => finish(input.parent ? "back" : undefined),
              { enableSearch: true },
            );
            if (input.focus) list.selectItem(input.focus);
            container.addChild(list);
            // Whether the title (and its blank line) is painted above the list. A host with no
            // reported terminal height still gets the title; the smoke fake is such a host.
            const titleShown = (): boolean => {
              const rows = tui.terminal?.rows;
              return typeof rows !== "number" || !Number.isFinite(rows) || rows >= 14;
            };
            // The host centers an overlay on the terminal and clips it, so content taller than the
            // screen loses its top border, title and search line. Read the live row count per
            // render; a host that exposes no terminal (the smoke fake) keeps the 15-row default.
            return {
              render: (width: number) => {
                // SAFETY: this is the trusted in-process SettingsList; `maxVisible` is private and
                // has no setter, so the read is narrowed to the one field this renderer changes.
                const runtime = list as unknown as { maxVisible: number };
                // Reset first, so a terminal that grew again recovers the full 15 rows.
                runtime.maxVisible = 15;
                const rows = tui.terminal?.rows;
                if (typeof rows !== "number" || !Number.isFinite(rows)) {
                  return [...titleLines(), ...container.render(width)];
                }
                // The title and its blank line cost two rows; there is no room for them on a short
                // terminal, so drop them before trimming the list's own hint/description lines.
                const withTitle = titleShown();
                const render = (): string[] => (withTitle ? [...titleLines(), ...container.render(width)] : container.render(width));
                const budget = Math.max(1, rows - 2); // the frame's top and bottom border lines
                let lines = render();
                while (lines.length > budget && runtime.maxVisible > 1) {
                  runtime.maxVisible -= 1;
                  lines = render();
                }
                if (lines.length <= budget) return lines;
                const focus = lines.findIndex((line) => line.includes(listTheme.cursor));
                // If clipping would hide the focused row, the row outranks the blank line and the
                // hint/description tail: keep the search line with it, or the row alone at budget 1.
                if (focus < 0 || focus < budget) return lines.slice(0, budget);
                const focused = lines[focus];
                if (focused === undefined) return lines.slice(0, budget);
                return budget >= 2 ? [lines[0] ?? "", focused] : [focused];
              },
              invalidate: () => container.invalidate(),
              handleInput: (data: string) => {
                list.handleInput?.(data);
                tui.requestRender();
              },
              handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
                // The title is rendered outside the container, so the list starts two rows below
                // the component's origin when it is shown. Container measures from its own y=0.
                const withTitle = titleShown();
                return container.handleMouse(withTitle ? { ...event, y: event.y - 2 } : event);
              },
            };
          }, done),
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
  // Pages reached by navigation, most recent last. Back pops here first, so a page opened through
  // another page returns there even when PAGES declares a different static parent.
  const stack: string[] = [];
  const loop = async (): Promise<void> => {
    for (;;) {
      const rows = rowsForPage(page, deps);
      // The effective back target: where navigation came from, else the page's declared parent.
      const back = stack.at(-1) ?? parentPage(deps.model, page);
      const result = await renderer.show({ model: deps.model, page, rows, title: pageTitle(deps.model, page, deps.values), parent: back, focus });
      focus = undefined;
      if (result === undefined) return;
      if (result === "back") {
        const target = stack.pop() ?? parentPage(deps.model, page);
        if (!target) return;
        // Back on the returned-to page, the cursor returns to the row that opened this page.
        focus = deps.model.rows.find((r) => r.page === target && r.targetPage === page)?.id;
        page = target;
        continue;
      }
      const row = findRow(deps.model, result.id) ?? rows.find((r) => r.id === result.id);
      if (!row) continue;
      if (row.kind === "page" && row.targetPage) {
        stack.push(page);
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
  };
  // The TUI hub owns the keyboard for the whole session, not one page: a per-page hold would be
  // released between pages, and an approval could take focus (and keys) from the next page. Released
  // on every exit (return, Esc, throw), and on a reload, which never settles the overlay.
  await (deps.ctx.mode === "tui" ? withInputHold("the kit hub", loop) : loop());
}

/** Re-export for callers that build deps from disk. */
export { doctorLines };
export type { DoctorLine };
