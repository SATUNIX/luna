#!/usr/bin/env node
// Suppression inventory. Every way a finding is switched off is listed, with its
// reason, in packages/core/scan-suppressions.json: inline markers (eslint-disable, nosemgrep, the
// TypeScript expect-error directive, zizmor: ignore, noqa and the like), .semgrepignore paths, the CodeQL
// paths-ignore and query-filters, the gitleaks allowlists and the zizmor config ignores. This fails
// in both directions: a suppression the inventory does not list, and a listed one that is gone.
// Each gitleaks allowlist must also be bound to named files (`paths` with `condition = "AND"`), so a
// fixture line copied into any other file is still a finding. The allowlist paths are
// repository-relative and anchored, so they must match the paths each gitleaks scan reports: the
// full-history `gitleaks git` scan reports repository paths, and the GitLab `secrets-public` dir
// scan reports paths relative to the directory it scans, which must be the export root.
// The inventory lists private files too; in a public export, where they are absent by design, an
// entry or allowlist path for a file that is not there is skipped. Mutated copies show each
// check fails.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, object, parseJsonAs, string, type Infer } from "../packages/core/lib/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = "packages/core/scan-suppressions.json";
const SELF = "tests/suppression-inventory-smoke.ts";
const PathReason = object({ path: string(), reason: string() });
const Inventory = object({
  inline: array(object({ file: string(), marker: string(), lineSha256: string(), reason: string() })),
  semgrepignore: array(PathReason),
  codeql: object({ pathsIgnore: array(PathReason), queryFilters: array(object({ id: string(), reason: string() })) }),
  gitleaks: array(object({ description: string() })),
  zizmor: array(object({ rule: string(), target: string(), reason: string() })),
});
type Inventory = Infer<typeof Inventory>;

/** An inline suppression marker in a comment; a mention inside quotes or backticks is not one. */
const MARKER = /(?<![`'"\w])(?:\/\/|#|\/\*|<!--)\s*(nosemgrep|eslint-disable(?:-next-line|-line)?|@ts-ignore|@ts-expect-error|@ts-nocheck|zizmor:\s*ignore|gitleaks:allow|lgtm|noqa|nosec|type:\s*ignore|codeql\[)/;
const sha = (line: string): string => crypto.createHash("sha256").update(line.trim()).digest("hex");

/** Every inline marker in the given files, as `file|marker|sha` keys. */
export function inlineMarkers(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    for (const line of text.split(/\r?\n/)) {
      const m = MARKER.exec(line);
      if (m) out.push(`${file}|${(m[1] ?? "").replace(/\s+/g, " ")}|${sha(line)}`);
    }
  }
  return out.sort();
}

/** The gitleaks allowlists: description, condition and path patterns. */
export function gitleaksAllowlists(toml: string): Array<{ description: string; condition: string; paths: number; patterns: string[] }> {
  if (/^\[allowlist\]/m.test(toml)) throw new Error(".gitleaks.toml uses the global [allowlist] table, which applies to every file");
  return toml.split(/^\[\[allowlists\]\]\s*$/m).slice(1).map((block) => {
    const pathsText = block.match(/^paths\s*=\s*\[([\s\S]*?)\]\s*$/m)?.[1] ?? "";
    return {
      description: block.match(/^description\s*=\s*"([^"]*)"/m)?.[1] ?? "",
      condition: block.match(/^condition\s*=\s*"([^"]*)"/m)?.[1] ?? "",
      paths: [...pathsText.matchAll(/'''[^']+'''/g)].length,
      patterns: [...pathsText.matchAll(/'''([^']+)'''/g)].map((m) => m[1] ?? ""),
    };
  });
}

const listLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
function yamlList(text: string, key: string): string[] {
  const body = text.match(new RegExp(`^${key}:\\s*\\n((?:(?:\\s+.*|\\s*)\\n)*)`, "m"))?.[1] ?? "";
  return body.split("\n").filter((l) => !l.trim().startsWith("#"));
}
const codeqlPaths = (text: string): string[] => yamlList(text, "paths-ignore").map((l) => l.match(/^\s*-\s*(\S+)\s*$/)?.[1]).filter((v): v is string => v !== undefined);
const codeqlFilters = (text: string): string[] => [...yamlList(text, "query-filters").join("\n").matchAll(/^\s*id:\s*(\S+)/gm)].map((m) => m[1] ?? "");
const zizmorIgnores = (text: string): string[] => {
  const out: string[] = [];
  let rule = "";
  for (const line of text.split(/\r?\n/)) {
    rule = line.match(/^ {2}([a-z0-9-]+):\s*$/)?.[1] ?? rule;
    const target = line.match(/^\s+-\s+([A-Za-z0-9_.-]+\.yml(?::\d+)?)\s*$/)?.[1];
    if (target !== undefined) out.push(`${rule}|${target}`);
  }
  return out.sort();
};

/**
 * How the GitLab `secrets-public` job's dir scan names an export file: gitleaks reports the path
 * it was given joined with the file's path below it, relative to the job's working directory.
 * Reads the job's `cd <dir>` (if any) and the last argument of its `gitleaks dir` line; null when
 * the job is not there (the public tree has no .gitlab-ci.yml).
 */
export function secretsPublicReport(gitlab: string | null, exportRoot = "public-build"): ((file: string) => string) | null {
  if (gitlab === null) return null;
  const body = gitlab.match(/^secrets-public:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
  const cd = body.match(/^\s*- cd (\S+)\s*$/m)?.[1] ?? ".";
  const target = body.match(/gitleaks dir [^\n]*?(\S+)\s*$/m)?.[1];
  if (target === undefined) throw new Error(".gitlab-ci.yml secrets-public has no gitleaks dir line");
  const below = path.posix.relative(path.posix.normalize(path.posix.join(cd, target)), exportRoot);
  return (file: string): string => path.posix.normalize(path.posix.join(target, below, file));
}

type Sources = { files: ReadonlyMap<string, string>; semgrepignore: string; codeql: string; gitleaks: string; zizmor: string; tracked?: readonly string[]; exported?: boolean; gitlab?: string | null };

/** Problems between the inventory and the repository's suppressions; [] when they agree. */
export function problems(inv: Inventory, src: Sources): string[] {
  const out: string[] = [];
  const diff = (kind: string, actual: readonly string[], listed: readonly string[]): void => {
    const remaining = [...listed];
    for (const a of actual) {
      const i = remaining.indexOf(a);
      if (i >= 0) remaining.splice(i, 1);
      else out.push(`${kind} ${a}: not in ${INVENTORY} (add it with its reason)`);
    }
    for (const r of remaining) out.push(`${kind} ${r}: listed in ${INVENTORY} but no longer present (remove it)`);
  };
  // In a public export the private files are absent by design; their entries are checked in the private tree.
  const present = (file: string): boolean => !src.exported || src.files.has(file) || (src.tracked ?? []).includes(file);
  diff("inline", inlineMarkers(src.files), inv.inline.filter((e) => present(e.file)).map((e) => `${e.file}|${e.marker}|${e.lineSha256}`));
  diff(".semgrepignore", listLines(src.semgrepignore), inv.semgrepignore.map((e) => e.path));
  diff("codeql paths-ignore", codeqlPaths(src.codeql), inv.codeql.pathsIgnore.map((e) => e.path));
  diff("codeql query-filter", codeqlFilters(src.codeql), inv.codeql.queryFilters.map((e) => e.id));
  diff("zizmor", zizmorIgnores(src.zizmor), inv.zizmor.map((e) => `${e.rule}|${e.target}`));
  let lists: ReturnType<typeof gitleaksAllowlists> = [];
  try { lists = gitleaksAllowlists(src.gitleaks); } catch (e) { out.push(e instanceof Error ? e.message : String(e)); }
  diff("gitleaks allowlist", lists.map((l) => l.description), inv.gitleaks.map((e) => e.description));
  for (const l of lists) {
    if (!l.description) out.push("gitleaks: an allowlist has no description");
    if (l.condition !== "AND" || l.paths === 0) out.push(`gitleaks allowlist "${l.description}": must set condition = "AND" and name its files in paths`);
    // Each allowlist must name a file this tree tracks, and must still match it as every scan reports it.
    if (src.tracked === undefined) continue;
    const patterns = l.patterns.map((p) => new RegExp(p));
    const named = src.tracked.filter((f) => patterns.some((re) => re.test(f)));
    if (!named.length && !src.exported) out.push(`gitleaks allowlist "${l.description}": its paths name no tracked file`);
    const report = secretsPublicReport(src.gitlab ?? null);
    for (const f of named) {
      if (report !== null && !patterns.some((re) => re.test(report(f)))) out.push(`gitleaks allowlist "${l.description}": secrets-public reports ${f} as ${report(f)}, which its paths do not match`);
    }
  }
  const reasons = [...inv.inline, ...inv.semgrepignore, ...inv.codeql.pathsIgnore, ...inv.codeql.queryFilters, ...inv.zizmor];
  for (const r of reasons) if (r.reason.trim().length < 10 || /^todo\b/i.test(r.reason)) out.push(`${JSON.stringify(r)}: needs a real reason`);
  return out;
}

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const files = new Map<string, string>();
for (const f of tracked) {
  if (f.endsWith(".md") || f === INVENTORY || f === SELF) continue;
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const buf = fs.readFileSync(full);
  if (!buf.includes(0)) files.set(f, buf.toString("utf8"));
}
const exported = !fs.existsSync(path.join(ROOT, "internal/public-release/manifest.json"));
const gitlab = fs.existsSync(path.join(ROOT, ".gitlab-ci.yml")) ? read(".gitlab-ci.yml") : null;
const src: Sources = { files, semgrepignore: read(".semgrepignore"), codeql: read(".github/codeql/codeql-config.yml"), gitleaks: read(".gitleaks.toml"), zizmor: read(".github/zizmor.yml"), tracked, exported, gitlab };
const inv = parseJsonAs(Inventory, read(INVENTORY), INVENTORY);
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };

assert.deepEqual(problems(inv, src), []);
ok(`${exported ? "(public export: entries for absent private files skipped) " : ""}${inv.inline.length} inline markers, ${inv.semgrepignore.length} .semgrepignore paths, ${inv.codeql.pathsIgnore.length + inv.codeql.queryFilters.length} CodeQL exclusions, ${inv.gitleaks.length} gitleaks allowlists and ${inv.zizmor.length} zizmor ignores are each listed with a reason`);

const firstInline = inv.inline[0];
assert.ok(firstInline, "the inventory lists inline markers");
const firstFile = files.get(firstInline.file) ?? "";
const mutations: Array<[string, Sources | Inventory, RegExp]> = [
  ["a new inline marker", { ...src, files: new Map([...files, ["packages/x.ts", "const a = 1; // eslint-disable-line no-console\n"]]) }, /inline packages\/x\.ts\|eslint-disable-line\|.*not in/],
  ["an edited suppressed line", { ...src, files: new Map([...files, [firstInline.file, firstFile.replace(/(\/\/|#)(\s*)(nosemgrep|eslint-disable|@ts-expect-error|zizmor|noqa)/, "$1$2$3 edited")]]) }, /no longer present/],
  ["a new .semgrepignore path", { ...src, semgrepignore: src.semgrepignore + "packages/\n" }, /\.semgrepignore packages\/: not in/],
  ["a new CodeQL query filter", { ...src, codeql: src.codeql + "  - exclude:\n      id: js/sql-injection\n" }, /codeql query-filter js\/sql-injection: not in/],
  ["a gitleaks allowlist without paths", { ...src, gitleaks: src.gitleaks.replace(/^paths = \['''\^tests\/save-smoke[^\n]*\n/m, "") }, /must set condition = "AND" and name its files/],
  ["a gitleaks allowlist with condition OR", { ...src, gitleaks: src.gitleaks.replace(/^condition = "AND"$/m, 'condition = "OR"') }, /must set condition = "AND"/],
  ["a global gitleaks [allowlist]", { ...src, gitleaks: src.gitleaks + "\n[allowlist]\nregexes = ['''x''']\n" }, /global \[allowlist\]/],
  ["a new zizmor ignore", { ...src, zizmor: src.zizmor + "      - ci.yml:10\n" }, /zizmor self-repository\|ci\.yml:10: not in/],
  ["an inventory entry whose file is gone", { ...inv, inline: [...inv.inline, { file: "packages/gone.ts", marker: "nosemgrep", lineSha256: "0".repeat(64), reason: "a file that was deleted" }] }, exported ? /^$/ : /packages\/gone\.ts\|nosemgrep.*no longer present/],
  ["an allowlist naming no tracked file", { ...src, gitleaks: src.gitleaks.replace("^tests/save-smoke", "^tests/gone-smoke") }, exported ? /^$/ : /its paths name no tracked file/],
  ...(gitlab === null ? [] : [["a dir scan from the repository root", { ...src, gitlab: gitlab.replace("    - cd public-build\n    - gitleaks dir --config ../.gitleaks.toml --redact --exit-code 1 .", "    - gitleaks dir --config .gitleaks.toml --redact --exit-code 1 public-build") }, /secrets-public reports tests\/save-smoke\.ts as public-build\/tests\/save-smoke\.ts/] satisfies [string, Sources, RegExp]]),
  ["an entry without a reason", { ...inv, semgrepignore: inv.semgrepignore.map((e, i) => (i === 0 ? { ...e, reason: "TODO" } : e)) }, /needs a real reason/],
];
let caught = 0;
for (const [label, changed, expected] of mutations) {
  if (expected.source === "^$") continue; // a mutation that only the private tree can catch
  const found = "inline" in changed ? problems(changed, src) : problems(inv, changed);
  assert.ok(found.some((p) => expected.test(p)), `mutation "${label}" is caught (got: ${found.join("; ")})`);
  caught++;
}
ok(`each of ${caught} mutations is caught`);

console.log(`suppression-inventory smoke: ${passed} checks passed`);
