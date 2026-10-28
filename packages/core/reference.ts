#!/usr/bin/env node
/**
 * Generate docs/reference.md: the kit's external interface in one place.
 *
 * Every slash command and every model-callable tool the extensions register, with the description
 * and parameters taken from the registration call itself; every environment variable an extension
 * declares; and the configuration files with a published JSON schema. Command and tool names come
 * from each `extension.json`, which `npm run verify` already holds equal to the code (the command
 * contract); descriptions and parameters are read from the source with the TypeScript parser, so
 * the page cannot drift from what pi shows. Deterministic; `--check` lets verify diff a fresh regen.
 *
 * Usage:
 *   node packages/core/reference.ts            # write docs/reference.md
 *   node packages/core/reference.ts --check    # exit 1 if the committed page is stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type * as TypeScript from "typescript";
import { isRecord, parseJson } from "./lib/guard.ts";
import { DOCS_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, WORKSPACE_ROOT } from "./lib/paths.ts";

// typescript is CommonJS and loaded with require(), so NODE_PATH resolves it when verify runs in a
// copied workspace without its own node_modules (as tests/core-manifest-guard-smoke.ts does).
const ts = createRequire(import.meta.url)("typescript") as typeof TypeScript;

const ROOT = WORKSPACE_ROOT;
const DOC_PATH = path.join(DOCS_DIR, "reference.md");
/** Generated pages are not where a command is documented. */
const GENERATED = new Set(["reference.md", "EXTENSIONS.md", "capability-matrix.md", "skills-catalogue.md"]);

interface Extension { name: string; dir: string; commands: string[]; tools: string[]; env: string[] }
interface Param { name: string; type: string; optional: boolean; description: string }
interface CommandInfo { name: string; extension: string; description: string }
interface ToolInfo { name: string; extension: string; description: string; params: Param[] | null }

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

function loadExtensions(): Extension[] {
  const out: Extension[] = [];
  for (const base of [FIRST_PARTY_DIR, THIRD_PARTY_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).sort()) {
      if (name.startsWith("_")) continue;
      const manifest = path.join(base, name, "extension.json");
      if (!fs.existsSync(manifest)) continue;
      const raw = parseJson(fs.readFileSync(manifest, "utf8"));
      if (!isRecord(raw)) continue;
      const registers = isRecord(raw.registers) ? raw.registers : {};
      out.push({
        name: typeof raw.name === "string" ? raw.name : name,
        dir: path.join(base, name),
        commands: strings(registers.commands).map((c) => c.replace(/^\//, "")),
        tools: strings(registers.tools),
        env: strings(raw.env),
      });
    }
  }
  return out;
}

/** The `.ts` sources of one extension (its tests excluded). */
function sourcesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "tests") walk(p);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** `const name = <initializer>` in the file being scanned, so a description held in a constant is still read. */
let constants = new Map<string, TypeScript.Expression>();

/** The text of a string-like expression; a template's substitutions read as "…". */
function textOf(node: TypeScript.Expression | undefined, depth = 0): string | undefined {
  if (!node || depth > 3) return undefined;
  if (ts.isIdentifier(node)) return textOf(constants.get(node.text), depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `…${s.literal.text}`).join("");
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(node.left, depth);
    const right = textOf(node.right, depth);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression, depth);
  return undefined;
}

function property(obj: TypeScript.ObjectLiteralExpression, key: string): TypeScript.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key) return p.initializer;
  }
  return undefined;
}

/** `Type.X(...)` -> a short type name and the options' description, unwrapping Optional. */
function describeSchema(node: TypeScript.Expression): { type: string; optional: boolean; description: string } {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const kind = node.expression.name.text;
    const args = node.arguments;
    if (kind === "Optional" && args[0]) return { ...describeSchema(args[0]), optional: true };
    const options = [...args].reverse().find((a): a is TypeScript.ObjectLiteralExpression => ts.isObjectLiteralExpression(a));
    const description = (options && textOf(property(options, "description"))) ?? "";
    let type = kind.toLowerCase();
    if (kind === "Array" && args[0]) type = `${describeSchema(args[0]).type}[]`;
    else if (kind === "Literal" && args[0]) type = JSON.stringify(textOf(args[0]) ?? args[0].getText());
    else if ((kind === "Union" || kind === "StringEnum") && args[0] && ts.isArrayLiteralExpression(args[0])) {
      type = args[0].elements.map((e) => (ts.isStringLiteral(e) ? JSON.stringify(e.text) : describeSchema(e).type)).join(" | ");
    }
    return { type, optional: false, description };
  }
  return { type: "see source", optional: false, description: "" };
}

function paramsOf(node: TypeScript.Expression | undefined): Param[] | null {
  if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "Object") return null;
  const shape = node.arguments[0];
  if (!shape || !ts.isObjectLiteralExpression(shape)) return null;
  const out: Param[] = [];
  for (const p of shape.properties) {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return null;
    const d = describeSchema(p.initializer);
    out.push({ name: p.name.text, ...d });
  }
  return out;
}

/** Reads every registerCommand / registerTool call in an extension's sources. */
function scan(ext: Extension): { commands: Map<string, string>; tools: Map<string, { description: string; params: Param[] | null }> } {
  const commands = new Map<string, string>();
  const tools = new Map<string, { description: string; params: Param[] | null }>();
  for (const file of sourcesOf(ext.dir)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    constants = new Map();
    const collect = (node: TypeScript.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !constants.has(node.name.text)) constants.set(node.name.text, node.initializer);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: TypeScript.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const [first, second] = node.arguments;
        if (method === "registerCommand" && first) {
          const name = textOf(first);
          const description = second && ts.isObjectLiteralExpression(second) ? textOf(property(second, "description")) : undefined;
          if (name !== undefined && !commands.has(name)) commands.set(name, description ?? "");
        } else if (method === "registerTool" && first && ts.isObjectLiteralExpression(first)) {
          const name = textOf(property(first, "name"));
          if (name !== undefined && !tools.has(name)) tools.set(name, { description: textOf(property(first, "description")) ?? "", params: paramsOf(property(first, "parameters")) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { commands, tools };
}

/** Markdown table cell: one line, pipes escaped. */
const cell = (s: string): string => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/** Hand-written docs pages, read once. */
function docsPages(): Array<{ file: string; text: string }> {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md") && !GENERATED.has(f))
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(DOCS_DIR, file), "utf8") }));
}

/** How often `text` names `/name` in code: a backtick, the slash and name, then a space, a backtick or the end. */
function mentions(text: string, name: string): number {
  const needle = `\`/${name}`;
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    const next = text.charAt(at + needle.length);
    if (next === "" || next === "`" || /\s/.test(next)) count++;
  }
  return count;
}

/** The hand-written page that names `/command` in code most often, or the extension README. */
function whereCommand(name: string, ext: Extension, pages: ReadonlyArray<{ file: string; text: string }>): string {
  // The page that names it most often (ties: the first alphabetically) is where it is described.
  let page: { file: string; text: string } | undefined;
  let best = 0;
  for (const p of pages) {
    const hits = mentions(p.text, name);
    if (hits > best) {
      best = hits;
      page = p;
    }
  }
  if (page) return `[${page.file.replace(/\.md$/, "")}](${page.file})`;
  const readme = path.join(ext.dir, "README.md");
  return fs.existsSync(readme) ? `\`${path.relative(ROOT, readme).split(path.sep).join("/")}\`` : "—";
}

/** INSTALL.md's purpose for an environment variable, when its table lists it. */
function installPurposes(): Map<string, string> {
  const out = new Map<string, string>();
  const install = path.join(DOCS_DIR, "INSTALL.md");
  if (!fs.existsSync(install)) return out;
  for (const line of fs.readFileSync(install, "utf8").split(/\r?\n/)) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m?.[1] && m[4] !== undefined && !out.has(m[1])) out.set(m[1], `${m[4].trim()}${m[3]?.trim() && m[3].trim() !== "—" ? ` (default ${m[3].trim()})` : ""}`);
  }
  return out;
}

function whereEnv(name: string, pages: ReadonlyArray<{ file: string; text: string }>): string {
  const install = pages.find((p) => p.file === "INSTALL.md" && p.text.includes(`\`${name}\``));
  if (install) return "[INSTALL](INSTALL.md#environment-variables)";
  const page = pages.find((p) => p.text.includes(name));
  return page ? `[${page.file.replace(/\.md$/, "")}](${page.file})` : "—";
}

/** Configuration files a user or operator edits, with the schema or page that defines each. */
const CONFIG_FILES: ReadonlyArray<{ file: string; what: string; defined: string }> = [
  { file: "packages/kit/profiles/<name>.json", what: "A profile: which extensions, skills and prompts load, and the firewall mode", defined: "[profiles](profiles.md)" },
  { file: "packages/extensions/src/tool-firewall/default-policy.json", what: "The shipped firewall policy (a custom one is named by `PI_KIT_FIREWALL_POLICY`)", defined: "[security](security.md)" },
  { file: "packages/core/.env.example", what: "Every environment variable the kit reads, with defaults", defined: "[INSTALL](INSTALL.md#environment-variables)" },
];

function schemaRows(): string[] {
  const rows: string[] = [];
  const dirs = ["packages/core/schema", "packages/autonomy/schema"];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((n) => n.endsWith(".schema.json")).sort()) {
      const raw = parseJson(fs.readFileSync(path.join(abs, f), "utf8"));
      const title = isRecord(raw) && typeof raw.title === "string" ? raw.title : f;
      const description = isRecord(raw) && typeof raw.description === "string" ? raw.description : "";
      rows.push(`| \`${dir}/${f}\` | ${cell(title)} | ${cell(description)} |`);
    }
  }
  return rows;
}

function render(): string {
  const extensions = loadExtensions();
  const pages = docsPages();
  const commands: CommandInfo[] = [];
  const tools: ToolInfo[] = [];
  const envUsers = new Map<string, string[]>();
  for (const ext of extensions) {
    const found = scan(ext);
    for (const name of ext.commands) commands.push({ name, extension: ext.name, description: found.commands.get(name) ?? "" });
    for (const name of ext.tools) {
      const t = found.tools.get(name);
      tools.push({ name, extension: ext.name, description: t?.description ?? "", params: t?.params ?? null });
    }
    for (const v of ext.env) envUsers.set(v, [...(envUsers.get(v) ?? []), ext.name]);
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(extensions.map((e) => [e.name, e]));
  const purposes = installPurposes();

  const lines = [
    "# Interface reference",
    "",
    "> Auto-generated by `packages/core/reference.ts` from each `extension.json` and the",
    "> `registerCommand` / `registerTool` calls in the extension sources. Do not hand-edit; run",
    "> `npm run catalog`. `npm run verify` fails when this page is stale.",
    "",
    "The kit's external interface: what an operator types, what the model can call, the environment",
    "it reads and the files it is configured by. Which extensions a profile loads is in the",
    "[capability matrix](capability-matrix.md); each extension's purpose is in the",
    "[extension catalogue](EXTENSIONS.md). A command or tool exists only while its extension is loaded.",
    "",
    "## Slash commands",
    "",
    "Typed at the pi prompt as `/name [arguments]`. The arguments are free text the command parses;",
    "each description below is the one pi shows, and names the forms it accepts. A command prints its",
    "result in the session (a notice, a picker or a status block) and changes only the state it",
    "describes. Commands are for the operator: the model cannot call them.",
    "",
    "| Command | Extension | Description | Documented in |",
    "|---|---|---|---|",
  ];
  for (const c of commands) {
    const ext = byName.get(c.extension);
    lines.push(`| \`/${c.name}\` | \`${c.extension}\` | ${cell(c.description) || "—"} | ${ext ? whereCommand(c.name, ext, pages) : "—"} |`);
  }
  lines.push(
    "",
    "## Tools",
    "",
    "Called by the model, never typed. Every call passes through the tool firewall first",
    "([Security model](security.md)). Parameters are a JSON object with the fields below (`?` marks an",
    "optional one); a tool returns text content to the model, and an error result when it refuses or fails.",
    "",
  );
  for (const t of tools) {
    lines.push(`### \`${t.name}\``, "", `Extension \`${t.extension}\`. ${cell(t.description) || "No description."}`, "");
    if (t.params === null) lines.push("Parameters: built from a shared schema; see the extension source.", "");
    else if (t.params.length === 0) lines.push("Parameters: none.", "");
    else {
      lines.push("| Parameter | Type | Description |", "|---|---|---|");
      for (const p of t.params) lines.push(`| \`${p.name}${p.optional ? "?" : ""}\` | ${cell(p.type)} | ${cell(p.description) || "—"} |`);
      lines.push("");
    }
  }
  lines.push(
    "## Environment variables",
    "",
    "Read when the extension loads or when it acts, never written back. Values are strings; a path is",
    "absolute or relative to the working directory.",
    "",
    "| Variable | Read by | Purpose | Documented in |",
    "|---|---|---|---|",
  );
  for (const v of [...envUsers.keys()].sort()) {
    lines.push(`| \`${v}\` | ${(envUsers.get(v) ?? []).map((e) => `\`${e}\``).join(", ")} | ${cell(purposes.get(v) ?? "") || "—"} | ${whereEnv(v, pages)} |`);
  }
  lines.push(
    "",
    "## Configuration files",
    "",
    "| File | What it configures | Defined in |",
    "|---|---|---|",
    ...CONFIG_FILES.map((c) => `| \`${c.file}\` | ${c.what} | ${c.defined} |`),
    "",
    "### JSON schemas",
    "",
    "| Schema | Title | Description |",
    "|---|---|---|",
    ...schemaRows(),
    "",
  );
  return lines.join("\n");
}

export function referenceContent(): string {
  return render();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const content = referenceContent();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf8") : "";
    if (current !== content) {
      console.error("[reference] STALE: docs/reference.md differs from a fresh regen. Run: npm run catalog");
      process.exit(1);
    }
    console.log("[reference] OK: docs/reference.md is up to date.");
  } else {
    fs.writeFileSync(DOC_PATH, content);
    console.log(`[reference] Wrote ${path.relative(ROOT, DOC_PATH)}.`);
  }
}
