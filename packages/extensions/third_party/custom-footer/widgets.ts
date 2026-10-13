/**
 * Widgets and text for the working line: the todo checklist, activity phrases, and usage tips.
 * Pure functions; the extension decides when to show them.
 */
import path from "node:path";
import { footerGlyphs } from "./render.ts";
import type { Theme, TodoItem } from "./render.ts";

export function renderTodoWidget(items: TodoItem[], theme: Theme, max = 8): string[] {
  if (!items.length) return [];
  const done = items.filter((i) => i.state === "done").length;
  const cells = 10;
  const filled = Math.round((done / items.length) * cells);
  const glyphs = footerGlyphs(theme);
  const header = `${theme.bold(theme.fg("accent", "Todos"))} ${theme.fg(done === items.length ? "success" : "text", `${done}/${items.length}`)} ${theme.fg("success", glyphs.filled.repeat(filled))}${theme.fg("dim", glyphs.empty.repeat(cells - filled))}`;
  if (done === items.length) return [`${header} ${theme.fg("success", "all done")}`];
  // The hint rides on the header line, so it costs no row; hiding the list is otherwise easy to miss.
  const hint = theme.fg("dim", "  /footer todos off hides this");
  // Show active first, then open, then the most recent done items, capped.
  const order = [...items.filter((i) => i.state === "active"), ...items.filter((i) => i.state === "open"), ...items.filter((i) => i.state === "done")];
  const shown = order.slice(0, max).sort((a, b) => a.id - b.id);
  const lines = [`${header}${hint}`];
  for (const item of shown) {
    if (item.state === "done") lines.push(`  ${theme.fg("success", glyphs.done)} ${theme.fg("dim", `#${item.id} ${item.text}`)}`);
    else if (item.state === "active") lines.push(`  ${theme.fg("accent", glyphs.active)} ${theme.bold(theme.fg("text", `#${item.id} ${item.text}`))}`);
    else lines.push(`  ${theme.fg("muted", glyphs.open)} ${theme.fg("text", `#${item.id} ${item.text}`)}`);
  }
  if (items.length > shown.length) lines.push(theme.fg("dim", `  ${glyphs.more} ${items.length - shown.length} more`));
  return lines;
}


export const PHRASES = [
  "Working", "Thinking it through", "Connecting the dots", "Checking assumptions", "Planning the next step",
  "Weighing the options", "Following the thread", "Cross-referencing", "Tracing the logic", "Gathering context",
  "Mapping the terrain", "Untangling", "Triangulating", "Recalibrating", "Crunching", "Pondering",
  "Sifting through details", "Lining things up", "Double-checking", "Piecing it together",
];

export function toolPhrase(toolName: string, args: any): string {
  const clip = (s: unknown, n = 40) => {
    const v = String(s ?? "").replace(/\s+/g, " ").trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  };
  const base = (p: unknown) => (typeof p === "string" ? path.basename(p) : "");
  switch (toolName) {
    case "read": return `Reading ${base(args?.path) || "a file"}`;
    case "edit": return `Editing ${base(args?.path) || "a file"}`;
    case "write": return `Writing ${base(args?.path) || "a file"}`;
    case "bash": return args?.command ? `Running \`${clip(args.command)}\`` : "Running a command";
    case "grep": case "find": case "ls": return "Searching the workspace";
    case "subagent": case "dispatch_specialist": case "dispatch_validator": return "Delegating to a subagent";
    case "todo": return "Updating the todo list";
    case "verify_completion": return "Verifying completion";
    case "record_verdict": case "verdict_status": return "Checking the verifier board";
    default:
      if (/^memory/.test(toolName)) return "Consulting memory";
      return `Using ${toolName}`;
  }
}

export type Tip = { text: string; requires?: string };

export const TIPS: Tip[] = [
  { text: "/compress shrinks the context instantly, with no model call.", requires: "compress" },
  { text: "/save writes a snapshot of this session to disk or the vault. It does not compact.", requires: "save" },
  { text: "/verify runs an independent reviewer against the goal and todo list.", requires: "verify" },
  { text: "/verdicts shows what done means and what still blocks completion.", requires: "verdicts" },
  { text: "/goal <text> sets the mission goal that the verifier checks.", requires: "goal" },
  { text: "/kit lists every kit command.", requires: "kit" },
  { text: "/handoff writes a resume note for the next session.", requires: "handoff" },
  { text: "/footer status shows every detail the bar drops when it is narrow. /footer light|default|heavy picks the density." },
  { text: "/effort picks how deep and broad the agent works and how much it delegates (E1 to E5)." },
  { text: "/footer todos off hides the todo checklist." },
  { text: "/tips off hides these tips." },
  { text: "/fork branches from an earlier message. The original branch stays." },
  { text: "/tree moves between branches of this session." },
  { text: "!command runs a shell command. !!command keeps the output out of context." },
  { text: "/model switches the model. /settings opens the settings menu." },
  { text: "/new starts a fresh session. Run /save first to keep a snapshot." },
  { text: "Press Esc to interrupt the agent." },
];

export function pick<T>(list: T[], avoid?: T): T {
  if (list.length <= 1) return list[0];
  let item = list[Math.floor(Math.random() * list.length)];
  if (item === avoid) item = list[(list.indexOf(item) + 1) % list.length];
  return item;
}
