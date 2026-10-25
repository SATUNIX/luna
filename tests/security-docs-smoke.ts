#!/usr/bin/env node
// Security documentation accuracy. The security pages name files, tests,
// npm scripts, CI jobs, required checks and settings fields; this fails when one of them does not
// exist, so a renamed test or a dropped job cannot leave the documentation describing a control
// that is gone:
//   1. every row of the catalogue in docs/security-controls.md names an existing code file, an
//      existing test (or "None"), an existing npm script (or "None"), an existing workflow job and
//      a required check that .github/expected-settings.json declares (or "No");
//   2. every attacker and boundary row in docs/threat-model.md names at least one control, and
//      every control it names is in the catalogue;
//   3. every repository path and npm script the security pages mention in a code span exists, and,
//      in the private tree (where internal/public-release/manifest.json exists), is a public file,
//      so the public export never documents a file it does not ship;
//   4. every settings field the "Repository settings" table of docs/ci-security.md cites resolves
//      in .github/expected-settings.json;
//   5. SECURITY.md, CONTRIBUTING.md, docs/support.md and docs/security.md link the pages they must,
//      and mkdocs.yml lists every security page.
// Mutated copies show each check fails.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, isRecord, object, optional, parseJson, parseJsonAs, record, string } from "../packages/core/lib/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SECURITY_PAGES = [
  "SECURITY.md",
  "docs/security.md",
  "docs/security-standard.md",
  "docs/security-controls.md",
  "docs/threat-model.md",
  "docs/vulnerability-management.md",
  "docs/incident-response.md",
  "docs/operator-checklist.md",
  "docs/ci-security.md",
  "docs/supply-chain.md",
  "docs/releasing.md",
  "docs/repository-topology.md",
];
const NAV_PAGES = ["threat-model.md", "security-controls.md", "security-standard.md", "vulnerability-management.md", "incident-response.md", "operator-checklist.md"];
const REPO_ROOTS = ["tests/", "packages/", ".github/", "docs/", "apps/", "internal/"];

const PackageJson = object({ scripts: record(string()) });
const scripts = new Set(Object.keys(parseJsonAs(PackageJson, read("package.json"), "package.json").scripts));

const Settings = object({
  rulesets: array(object({
    name: string(),
    rules: object({ required_status_checks: optional(object({ required_status_checks: array(object({ context: string() })) })) }),
  })),
});
const settingsText = read(".github/expected-settings.json");
const settingsValue = parseJson(settingsText);
const mainRules = parseJsonAs(Settings, settingsText, "expected-settings").rulesets.find((r) => r.name === "main");
assert.ok(mainRules?.rules.required_status_checks, "expected-settings declares a main ruleset with required checks");
const requiredChecks = new Set(mainRules.rules.required_status_checks.required_status_checks.map((c) => c.context));

const manifestPath = path.join(ROOT, "internal/public-release/manifest.json");
const Manifest = object({ public: array(string()) });
const publicFiles: ReadonlySet<string> | null = fs.existsSync(manifestPath)
  ? new Set(parseJsonAs(Manifest, fs.readFileSync(manifestPath, "utf8"), "manifest").public)
  : null;

/** The code spans in one markdown table cell. */
function spans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** Markdown table rows whose first cell matches `id`, split into trimmed cells. */
function rows(md: string, id: RegExp): string[][] {
  const out: string[][] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
    if (id.test(cells[0] ?? "")) out.push(cells);
  }
  return out;
}

/** The jobs a workflow file defines (two-space keys under `jobs:`). */
function workflowJobs(file: string): Set<string> | null {
  const full = path.join(ROOT, ".github/workflows", file);
  if (!fs.existsSync(full)) return null;
  const jobs = new Set<string>();
  let inJobs = false;
  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (inJobs && /^\S/.test(line)) break;
    const m = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (m?.[1]) jobs.add(m[1]);
  }
  return jobs;
}

const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

/** Problems with the controls catalogue; [] when every row checks out. */
export function catalogueProblems(md: string): string[] {
  const out: string[] = [];
  const found = rows(md, /^C-\d{2}$/);
  if (found.length < 40) out.push(`catalogue has only ${found.length} control rows`);
  const seen = new Set<string>();
  for (const cells of found) {
    const [id = "", , code = "", test = "", script = "", job = "", required = ""] = cells;
    if (cells.length !== 7) { out.push(`${id}: expected 7 cells, found ${cells.length}`); continue; }
    if (seen.has(id)) out.push(`${id}: duplicate id`);
    seen.add(id);
    const codeFiles = spans(code);
    if (codeFiles.length === 0) out.push(`${id}: no code location`);
    for (const f of codeFiles) if (!exists(f)) out.push(`${id}: code ${f} does not exist`);
    if (test !== "None") {
      const tests = spans(test);
      if (tests.length === 0) out.push(`${id}: test cell is neither a file nor None`);
      for (const f of tests) if (!exists(f)) out.push(`${id}: test ${f} does not exist`);
    }
    if (script !== "None") {
      const names = spans(script);
      if (names.length === 0) out.push(`${id}: npm script cell is neither a script nor None`);
      for (const s of names) if (!scripts.has(s)) out.push(`${id}: npm script ${s} does not exist`);
    }
    const jobs = spans(job);
    if (jobs.length === 0) out.push(`${id}: no CI job`);
    for (const j of jobs) {
      const [file = "", name = ""] = j.split(":");
      const defined = workflowJobs(file);
      if (!defined) out.push(`${id}: workflow ${file} does not exist`);
      else if (!defined.has(name)) out.push(`${id}: workflow ${file} has no job ${name}`);
    }
    if (required !== "No") {
      const checks = spans(required);
      if (checks.length === 0) out.push(`${id}: required check cell is neither a check nor No`);
      for (const c of checks) if (!requiredChecks.has(c)) out.push(`${id}: ${c} is not a required check in expected-settings`);
    }
  }
  return out;
}

/** The control ids a threat-model cell names, with "C-31 to C-34" expanded. */
function controlIds(cell: string): string[] {
  const ids: string[] = [];
  for (const m of cell.matchAll(/C-(\d{2})(?:\s+to\s+C-(\d{2}))?/g)) {
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (let n = from; n <= to; n++) ids.push(`C-${String(n).padStart(2, "0")}`);
  }
  return ids;
}

/** Problems with the threat model against the catalogue's ids; [] when it agrees. */
export function threatModelProblems(md: string, catalogueIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const attackers = rows(md, /^A-\d+$/);
  const boundaries = rows(md, /^B-\d+$/);
  if (attackers.length < 8) out.push(`threat model lists only ${attackers.length} attackers`);
  if (boundaries.length < 8) out.push(`threat model lists only ${boundaries.length} boundaries`);
  const boundaryIds = new Set(boundaries.map((r) => r[0] ?? ""));
  for (const cells of attackers) {
    const [id = "", , , boundary = "", controls = ""] = cells;
    const ids = controlIds(controls);
    if (ids.length === 0) out.push(`${id}: names no control`);
    for (const c of ids) if (!catalogueIds.has(c)) out.push(`${id}: ${c} is not in the catalogue`);
    for (const b of boundary.match(/B-\d+/g) ?? []) if (!boundaryIds.has(b)) out.push(`${id}: boundary ${b} is not defined`);
  }
  for (const cells of boundaries) {
    const [id = "", , , controls = ""] = cells;
    const ids = controlIds(controls);
    if (ids.length === 0) out.push(`${id}: names no control`);
    for (const c of ids) if (!catalogueIds.has(c)) out.push(`${id}: ${c} is not in the catalogue`);
  }
  return out;
}

/** Problems with the repository paths and npm scripts one page names in code spans. */
export function referenceProblems(page: string, md: string): string[] {
  const out: string[] = [];
  for (const span of new Set([...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? ""))) {
    const script = /^(?:npm run (?:-s )?)?((?:smoke|test|security|docs|gen|build):[a-z0-9-]+)$/.exec(span);
    if (script?.[1]) {
      if (!scripts.has(script[1])) out.push(`${page}: npm script ${script[1]} does not exist`);
      continue;
    }
    // A bare top-level directory (`internal/`, `tests/`) names a tree, not a file to check.
    if (!/^[A-Za-z0-9_./-]+$/.test(span) || REPO_ROOTS.includes(span) || !REPO_ROOTS.some((r) => span.startsWith(r))) continue;
    if (!exists(span)) { out.push(`${page}: ${span} does not exist`); continue; }
    if (publicFiles && !span.endsWith("/") && fs.statSync(path.join(ROOT, span)).isFile() && !publicFiles.has(span)) {
      out.push(`${page}: ${span} is not a public file, so the public export would not have it`);
    }
  }
  return out;
}

/** Resolve a field reference such as `rulesets[main].rules.pull_request` in the settings. */
function resolves(value: unknown, ref: string): boolean {
  let cur: unknown = value;
  for (const part of ref.split(".")) {
    const m = /^([A-Za-z0-9_]+)(?:\[([A-Za-z0-9_-]+)\])?$/.exec(part);
    if (!m?.[1] || !isRecord(cur) || !Object.hasOwn(cur, m[1])) return false;
    cur = cur[m[1]];
    if (m[2] !== undefined) {
      const name = m[2];
      if (!Array.isArray(cur)) return false;
      cur = cur.find((item: unknown) => isRecord(item) && item.name === name);
      if (cur === undefined) return false;
    }
  }
  return true;
}

/** Problems with the settings fields the ci-security "Repository settings" table cites. */
export function settingsProblems(md: string, expected: unknown): string[] {
  const out: string[] = [];
  const start = md.indexOf("## Repository settings");
  if (start < 0) return ["ci-security.md has no Repository settings section"];
  const end = md.indexOf("\n## ", start + 1);
  const section = md.slice(start, end < 0 ? undefined : end);
  let fields = 0;
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|") || line.startsWith("| Setting") || line.startsWith("|---")) continue;
    const cell = line.split("|")[2] ?? "";
    for (const ref of spans(cell)) {
      fields++;
      if (!resolves(expected, ref)) out.push(`ci-security.md cites ${ref}, which expected-settings.json does not have`);
    }
  }
  if (fields < 10) out.push(`ci-security.md's settings table cites only ${fields} fields`);
  return out;
}

// 1. The catalogue.
const catalogue = read("docs/security-controls.md");
assert.deepEqual(catalogueProblems(catalogue), [], "every catalogue row names things that exist");
const catalogueIds = new Set(rows(catalogue, /^C-\d{2}$/).map((r) => r[0] ?? ""));
const firstTest = /`tests\/firewall-shell-smoke\.ts`/;
assert.ok(firstTest.test(catalogue), "the mutation below needs this test name in the catalogue");
assert.ok(catalogueProblems(catalogue.replace(firstTest, "`tests/firewall-shell-gone-smoke.ts`")).some((p) => p.includes("does not exist")), "a renamed test is caught");
assert.ok(catalogueProblems(catalogue.replace("`smoke:firewall-shell`", "`smoke:firewall-shel`")).some((p) => p.includes("npm script")), "a missing npm script is caught");
assert.ok(catalogueProblems(catalogue.replace("`ci.yml:verify`", "`ci.yml:verify-gone`")).some((p) => p.includes("has no job")), "a missing CI job is caught");
assert.ok(catalogueProblems(catalogue.replace("| `ci-complete` |", "| `ci-done` |")).some((p) => p.includes("not a required check")), "an undeclared required check is caught");

// 2. The threat model.
const threat = read("docs/threat-model.md");
assert.deepEqual(threatModelProblems(threat, catalogueIds), [], "every attacker and boundary row names catalogued controls");
assert.ok(threatModelProblems(threat.replace(/\| C-01, C-02, C-04/, "| C-99, C-02, C-04"), catalogueIds).some((p) => p.includes("C-99")), "an uncatalogued control is caught");
assert.ok(threatModelProblems(threat.replace(/(\| A-1 \|(?:[^|]*\|){3})[^|]*\|/, "$1 |"), catalogueIds).some((p) => p.includes("names no control")), "an attacker with no control is caught");

// 3. Paths and scripts on every security page.
for (const page of SECURITY_PAGES) assert.deepEqual(referenceProblems(page, read(page)), [], `${page} names only things that exist`);
assert.ok(referenceProblems("x", "see `tests/no-such-smoke.ts` and `smoke:no-such`").length === 2, "a missing file and a missing script are caught");
if (publicFiles) assert.ok(referenceProblems("x", "`internal/public-release/export.ts`").some((p) => p.includes("not a public file")), "a private file is caught in the private tree");

// 4. The settings table.
assert.deepEqual(settingsProblems(read("docs/ci-security.md"), settingsValue), [], "every settings field cited resolves");
assert.ok(settingsProblems(read("docs/ci-security.md").replace("`fork_pr_approval_policy`", "`fork_policy`"), settingsValue).length > 0, "a field the file does not have is caught");

// 5. Links and navigation.
const security = read("SECURITY.md");
for (const target of ["docs/threat-model.md", "docs/vulnerability-management.md", "docs/incident-response.md", "docs/beta.md", "docs/security-controls.md"]) {
  assert.ok(security.includes(`(${target}`), `SECURITY.md links ${target}`);
}
for (const heading of ["## Supported versions", "## Reporting a vulnerability", "## Response targets", "## Scope", "## Safe harbour"]) {
  assert.ok(security.includes(heading), `SECURITY.md has ${heading}`);
}
assert.match(security, /Acknowledge the report \| 3 working days/, "SECURITY.md states the acknowledgement target");
assert.match(security, /Triage[^|]*\| 14 days/, "SECURITY.md states the triage target");
assert.ok(read("CONTRIBUTING.md").includes("(docs/security-standard.md)"), "CONTRIBUTING.md links the secure development standard");
assert.ok(read("docs/support.md").includes("(incident-response.md)"), "support.md links incident response");
assert.ok(read("docs/security.md").includes("(threat-model.md)") && read("docs/security.md").includes("(security-controls.md)"), "security.md links the threat model and the catalogue");
assert.ok(read("docs/remote-control.md").includes("### The Yes-first decision (SEC-5)"), "remote-control.md records the SEC-5 decision");
const nav = read("mkdocs.yml");
const navLines = nav.split(/\r?\n/).map((l) => l.trim());
for (const page of NAV_PAGES) assert.ok(navLines.some((l) => l.endsWith(`: ${page}`)), `mkdocs.yml lists ${page}`);

console.log(`security-docs-smoke: ${catalogueIds.size} controls, ${rows(threat, /^A-\d+$/).length} attackers and ${SECURITY_PAGES.length} pages checked`);
