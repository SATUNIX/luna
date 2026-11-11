#!/usr/bin/env node
// Brand smoke: keep the Luna rename honest. Checks the site name, the README title and hero,
// and that every pi-system occurrence in the scanned prose sits inside a backtick span naming
// one of the allowed package identities. Deterministic; reads files only, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["@satunix/pi-system", "@satunix/pi-system-lite", "pi-system"]);
let checks = 0;

function ok(condition: boolean, message: string): void {
  assert.ok(condition, message);
  checks++;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function walkMarkdown(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

interface Span {
  start: number;
  end: number;
  text: string;
}

function backtickSpans(line: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end === -1) break;
      spans.push({ start: i, end: end + 1, text: line.slice(i + 1, end) });
      i = end + 1;
    } else {
      i++;
    }
  }
  return spans;
}

const mkdocs = read("mkdocs.yml");
ok(/^site_name:\s*Luna\s*$/m.test(mkdocs), "mkdocs.yml sets site_name to Luna");

const readme = read("README.md");
const firstHeading = readme.split(/\r?\n/).find((line) => /^#{1,6}\s/.test(line));
ok(firstHeading === "# Luna", "README.md's first heading is '# Luna'");

const heroLine = readme.split(/\r?\n/).find((line) => /<img\b/i.test(line) && /luna-/i.test(line));
ok(heroLine !== undefined, "README.md has a hero img line naming Luna");
if (heroLine !== undefined) {
  ok(/src="[^"]*docs\/assets\/luna-[^"]*"/i.test(heroLine), "README.md hero img src names Luna");
  ok(/alt="[^"]*Luna[^"]*"/i.test(heroLine), "README.md hero img alt contains Luna");
}

const brandingPath = path.join(ROOT, "docs", "branding.md");
ok(fs.existsSync(brandingPath), "docs/branding.md exists");
const branding = fs.readFileSync(brandingPath, "utf8");
for (const identity of ALLOWED) {
  ok(branding.includes(`\`${identity}\``), `docs/branding.md mentions \`${identity}\``);
}
ok(mkdocs.includes("branding.md"), "mkdocs.yml lists branding.md in its nav");

const scanned: string[] = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
];
const docs: string[] = [];
walkMarkdown(path.join(ROOT, "docs"), docs);
for (const file of docs) {
  if (relative(file) === "docs/branding.md") continue;
  scanned.push(file);
}

const problems: string[] = [];
for (const file of scanned) {
  const absolute = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const spans = backtickSpans(line);
    for (const match of line.matchAll(/pi-system/gi)) {
      const at = match.index ?? 0;
      const span = spans.find((candidate) => at >= candidate.start && at < candidate.end);
      const where = `${relative(absolute)}:${index + 1}`;
      if (span === undefined) {
        problems.push(`${where}: bare pi-system in ${JSON.stringify(line)}`);
      } else if (![...ALLOWED].some((identity) => span.text.includes(identity))) {
        problems.push(`${where}: \`${span.text}\` does not name an allowed identity in ${JSON.stringify(line)}`);
      }
    }
  });
}
assert.deepEqual(problems, [], `unbackticked or disallowed pi-system prose:\n${problems.join("\n")}`);
checks++;

const agents = read("AGENTS.md");
ok(agents.includes("modular pi system"), "AGENTS.md keeps the space-form 'modular pi system'");

console.log(`[brand-smoke] all ${checks} checks passed`);
