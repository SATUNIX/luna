#!/usr/bin/env node
/**
 * Validate every Mermaid diagram in the repository's Markdown.
 *
 * GitHub renders ```mermaid fences, so a diagram with a syntax error shows up as a red box on the
 * page that was meant to explain something. This parses each fenced block with Mermaid's own
 * parser (the same one the renderer uses), so a broken diagram fails the gate instead. It checks
 * syntax, not layout: it does not render.
 *
 * Mermaid needs a DOM only for label sanitising, so a jsdom window is installed before it loads.
 *
 * Usage:
 *   node packages/core/check-mermaid.ts          # check every .md file
 *   node packages/core/check-mermaid.ts --list   # list the diagrams found, parse nothing
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./lib/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".cache", "dist", "site", "coverage", ".pi"]);

export interface MermaidDiagram {
  /** The line of the opening fence (1-based). */
  line: number;
  code: string;
  closed: boolean;
}

/** The part of Mermaid this check uses; a test can pass a stand-in. */
export interface MermaidParser {
  parse(code: string): unknown;
}

export interface MermaidCheckResult {
  checked: number;
  problems: string[];
}

/** jsdom ships no type declarations (and @types/jsdom is not a dependency): the slice used here. */
interface Jsdom {
  readonly window: { readonly document: unknown; readonly navigator: unknown };
}
type JsdomConstructor = new (html: string) => Jsdom;
const JSDOM_MODULE: string = "jsdom";

/** Every Markdown file under `root`, repo-relative and sorted. */
export function listMarkdown(root: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** The ```mermaid blocks of one document: `{ line, code }`, `line` being the line of the opening fence. */
export function extractDiagrams(markdown: string): MermaidDiagram[] {
  const diagrams: MermaidDiagram[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*mermaid\b/i.exec(lines[i] ?? "");
    if (!open) continue;
    const fence = open[2] ?? "";
    const close = new RegExp(`^\\s*${fence.charAt(0)}{${fence.length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    for (let line = lines[j]; line !== undefined && !close.test(line); line = lines[++j]) body.push(line);
    diagrams.push({ line: i + 1, code: body.join("\n"), closed: j < lines.length });
    i = j;
  }
  return diagrams;
}

async function loadMermaid(): Promise<MermaidParser> {
  // A non-literal specifier: TypeScript would otherwise reject the import of an untyped module.
  const jsdom: unknown = await import(JSDOM_MODULE);
  const JSDOM = isRecord(jsdom) ? jsdom.JSDOM : undefined;
  if (typeof JSDOM !== "function") throw new Error("jsdom has no JSDOM export");
  const dom = new (JSDOM as JsdomConstructor)("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  return mermaid;
}

/** Parse every diagram in `files` (repo-relative, read from `root`). */
export async function checkFiles(files: readonly string[], root: string = ROOT, mermaid: MermaidParser | null = null): Promise<MermaidCheckResult> {
  const parser = mermaid ?? (await loadMermaid());
  let checked = 0;
  const problems: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const diagram of extractDiagrams(text)) {
      checked++;
      if (!diagram.closed) {
        problems.push(`${file}:${diagram.line}: the mermaid fence is never closed`);
        continue;
      }
      if (!diagram.code.trim()) {
        problems.push(`${file}:${diagram.line}: the mermaid block is empty`);
        continue;
      }
      try {
        await parser.parse(diagram.code);
      } catch (error) {
        const message = isRecord(error) ? error.message : undefined;
        const detail = String(message ?? error).split("\n").slice(0, 3).join(" | ");
        problems.push(`${file}:${diagram.line}: ${detail}`);
      }
    }
  }
  return { checked, problems };
}

async function main(): Promise<void> {
  const files = listMarkdown();
  if (process.argv.includes("--list")) {
    for (const file of files) {
      for (const d of extractDiagrams(fs.readFileSync(path.join(ROOT, file), "utf8"))) console.log(`${file}:${d.line}`);
    }
    return;
  }
  const { checked, problems } = await checkFiles(files);
  for (const problem of problems) console.error(`  FAIL: ${problem}`);
  if (problems.length) {
    console.error(`[check-mermaid] ${problems.length} of ${checked} diagram(s) failed`);
    process.exit(1);
  }
  console.log(`[check-mermaid] OK: ${checked} diagram(s) in ${files.length} Markdown file(s) parse`);
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
