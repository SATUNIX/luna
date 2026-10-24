import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// Minimum lines in a write that triggers the spec check. A non-numeric override would make
// `lineCount < MIN_LINES` always false, blocking every write/edit under STRICT=1, so fall back
// to the default when the value is not a finite number.
const MIN_LINES = (() => {
  const parsed = parseInt(process.env.PI_KIT_SPEC_PLAN_MIN_LINES ?? "30", 10);
  const fallback = Number.isFinite(parsed) ? parsed : 30;
  // A non-positive threshold would make every write (even an empty one) trigger, so clamp to 1.
  return fallback < 1 ? 1 : fallback;
})();

// PI_KIT_SPEC_PLAN_STRICT: "1" blocks, "0"/"false"/"off"/"no" disables the check entirely,
// and anything else (including unset) warns. The old code read only `=== "1"` and still warned
// for "0", so the documented off switch did not actually switch the check off.
function strictMode(): "off" | "block" | "warn" {
  const raw = (process.env.PI_KIT_SPEC_PLAN_STRICT ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "1") return "block";
  return "warn";
}

const STRICT = strictMode();

// Count the lines of *changed* content for the tool that is being called. `write` supplies a
// flat `content` string; the live `edit` payload is { path, edits: [{ oldText, newText }] }.
// Reading only content/new_string made every edit look like one line, so the guard never fired.
// Count written (added) lines: an empty string is a pure deletion and contributes 0.
// A single trailing newline delimits the final line rather than starting a new one, so strip
// it before splitting (otherwise `"a\nb\n"` counts 3 instead of 2 and the guard fires a line
// early). After stripping, an empty string still contributes 0.
function countWrittenLines(text: string): number {
  const trimmed = text.replace(/\n$/, "");
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function changedLineCount(toolName: string, input: Record<string, unknown>): number {
  if (toolName === "write") {
    // PRO-11: only a string is content; a value of any other type counts as no lines.
    const content = input.content ?? input.new_string;
    return typeof content === "string" ? countWrittenLines(content) : 0;
  }

  let lines = 0;
  if (Array.isArray(input.edits)) {
    for (const item of input.edits) {
      if (!isRecord(item)) continue;
      if (typeof item.newText === "string") lines += countWrittenLines(item.newText);
    }
  }
  // Legacy flat shape (pre-edits payload).
  if (typeof input.new_string === "string") lines += countWrittenLines(input.new_string);
  return lines;
}

const SPEC_CANDIDATES = [
  "SPEC.md", "PLAN.md", "DESIGN.md", "ADR.md",
  "docs/SPEC.md", "docs/PLAN.md", "docs/DESIGN.md",
  ".pi/PLAN.md", "_consolidation/CONSOLIDATION_PLAN.md",
];

// Source file extensions that warrant a spec check
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp",
]);

function hasSpecFile(cwd: string): boolean {
  return SPEC_CANDIDATES.some(name => fs.existsSync(path.join(cwd, name)));
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (STRICT === "off") return undefined;

    const toolName = event.toolName;
    if (toolName !== "write" && toolName !== "edit") return undefined;

    const input: unknown = event.input;
    if (!isRecord(input)) return undefined;
    const filePath = input.path;
    if (typeof filePath !== "string" || !filePath || !isSourceFile(filePath)) return undefined;

    // Check content length — only flag large changes
    const lineCount = changedLineCount(toolName, input);
    if (lineCount < MIN_LINES) return undefined;

    // If a spec/plan file exists, we're fine
    if (hasSpecFile(ctx.cwd)) return undefined;

    const msg = `spec-plan: writing ${lineCount} lines to ${path.basename(filePath)} without a spec/plan file. ` +
      `Consider creating SPEC.md or PLAN.md first. Set PI_KIT_SPEC_PLAN_STRICT=0 (or false/off/no) to disable this check.`;

    if (STRICT === "block") {
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      return { block: true, reason: msg };
    }

    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    return undefined;
  });
}
