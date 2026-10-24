#!/usr/bin/env node
// The TypeScript ratchet (internal/docs/typescript-quality-plan.md, stage 6). Every package is
// strict TypeScript; this keeps it that way:
//   1. no JavaScript source comes back, except the files listed below with their reason;
//   2. every tracked .ts file belongs to a type project that `npm run test:typecheck` checks, and
//      to the lint gate (`eslint.config.ts`), so nothing new escapes either;
//   3. every eslint-disable names its reason, and their number cannot grow without this file
//      being edited in review;
//   4. the lint gate refuses a cast of JSON.parse output or an awaited .json() body outside the
//      tests (UXD-6), and still allows `as unknown` and a JSON.stringify round trip.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ESLint } from "eslint";
import { ROOT } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

/** Ceiling on eslint-disable comments in TypeScript sources. Lower it when one goes; raising it needs a reason in review. */
const MAX_ESLINT_DISABLES = 15;

/** JavaScript that stays JavaScript, and why. Anything else ending in .js/.mjs/.cjs fails. */
const ALLOWED_JS: readonly [RegExp, string][] = [
  [/^packages\/web-ui\/(?:public\/js|mobile\/js|mobile\/dev)\/[^/]+\.js$/, "browser output generated from packages/web-ui/src by build:web (ADR 0002; smoke:web-build checks it)"],
  [/^packages\/core\/install\.mjs$/, "shim: older kit-update code spawns this path after pulling"],
  [/^packages\/extensions\/third_party\/subagent\/wf-runner\.mjs$/, "sandbox runner: plain node runs it inside the workflow sandbox, including from node_modules, where Node will not strip types"],
  [/^packages\/kit\/workflows\/[^/]+\.js$/, "script workflows: the workflow tool runs them as plain JavaScript in the QuickJS sandbox, which does not strip types"],
  [/^packages\/container\/mcp-servers\/(?:governance|memory-mcp)\/index\.js$/, "shim: MCP configs written before the move name index.js"],
  [/^packages\/autonomy\/examples\/implement\/acceptance\/api\.acceptance\.mjs$/, "fixture: an acceptance test that belongs to the example target project"],
  [/^(?:internal\/docs|reviews)\//, "archived evidence, not run by the toolchain"],
];

/** .ts files deliberately outside every type project. */
const UNPROJECTED_TS: readonly [RegExp, string][] = [
  [/^packages\/extensions\/src\/_template\//, "the new-extension template, copied and renamed by new-extension.ts"],
  [/^packages\/(?:core|autonomy)\/examples\//, "example target projects, not toolchain code"],
];

let checks = 0;
const ok = (name: string): void => {
  checks += 1;
  console.log(`  ok  ${name}`);
};
/** The repository's files: git's list in a checkout, a walk of the tree in an export without .git. */
function repositoryFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!["node_modules", ".git", "dist"].includes(entry.name)) walk(child);
        } else if (entry.isFile()) out.push(child);
      }
    };
    walk("");
    return out;
  }
}

const tracked = repositoryFiles();

// 1. No JavaScript source outside the allow-list.
{
  const js = tracked.filter((f) => /\.(?:m?js|cjs)$/.test(f));
  const stray = js.filter((f) => !ALLOWED_JS.some(([re]) => re.test(f)));
  assert.deepEqual(stray, [], `JavaScript source is TypeScript now; convert these or add them to ALLOWED_JS with a reason: ${stray.join(", ")}`);
  ok(`no JavaScript source outside the allow-list (${js.length} allowed files)`);
}

// 2a. Every .ts file is in a type project that test:typecheck runs.
const manifest = parseJson(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
// Every `test:typecheck*` script (test:typecheck, test:typecheck-release) runs in check:all.
const typecheck = Object.entries(scripts)
  .filter(([name]) => name.startsWith("test:typecheck"))
  .map(([, command]) => (typeof command === "string" ? command : ""))
  .join(" && ");
const projects = [...typecheck.matchAll(/tsc -p (\S+)/g)].map((m) => m[1] ?? "");
assert.ok(projects.length >= 5, `test:typecheck names its projects (${typecheck})`);
{
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const inProject = new Set<string>();
  for (const project of projects) {
    const listed = execFileSync(process.execPath, [tsc, "-p", project, "--listFilesOnly"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of listed.split("\n")) {
      const rel = path.relative(ROOT, line.trim()).split(path.sep).join("/");
      if (rel && !rel.startsWith("..") && !rel.startsWith("node_modules/")) inProject.add(rel);
    }
  }
  const sources = tracked.filter((f) => f.endsWith(".ts") && !UNPROJECTED_TS.some(([re]) => re.test(f)));
  const outside = sources.filter((f) => !inProject.has(f));
  assert.deepEqual(outside, [], `.ts files no type project checks (add them to a tsconfig in test:typecheck): ${outside.join(", ")}`);
  ok(`${sources.length} .ts files are all type-checked by ${projects.length} projects`);

  // 2b. ...and linted.
  const eslint = new ESLint({ cwd: ROOT, flags: ["unstable_native_nodejs_ts_config"] });
  const unlinted: string[] = [];
  for (const file of sources) {
    const config: unknown = await eslint.calculateConfigForFile(path.join(ROOT, file));
    const rules = isRecord(config) && isRecord(config.rules) ? config.rules : {};
    if (!("@typescript-eslint/no-explicit-any" in rules)) unlinted.push(file);
  }
  assert.deepEqual(unlinted, [], `.ts files the lint gate does not cover (add them to LINTED in eslint.config.ts): ${unlinted.join(", ")}`);
  ok(`all ${sources.length} .ts files are under the strict lint rules`);
}

// 3. eslint-disable comments carry a reason and stay under the ceiling.
{
  const disables: string[] = [];
  for (const file of tracked.filter((f) => f.endsWith(".ts") && fs.existsSync(path.join(ROOT, f)))) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    text.split("\n").forEach((line, index) => {
      // A directive starts its comment: `// eslint-disable…` or `/* eslint-disable… */`.
      if (/^\s*(?:\/\/|\/\*)\s*eslint-disable/.test(line)) disables.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  const unexplained = disables.filter((d) => !/eslint-disable[^\n]*\s--\s+\S/.test(d));
  assert.deepEqual(unexplained, [], `eslint-disable needs "-- <reason>": ${unexplained.join("\n")}`);
  assert.ok(disables.length <= MAX_ESLINT_DISABLES, `${disables.length} eslint-disable comments exceed the ceiling of ${MAX_ESLINT_DISABLES}:\n${disables.join("\n")}`);
  ok(`${disables.length} eslint-disable comments, each with a reason (ceiling ${MAX_ESLINT_DISABLES})`);
}

// 4. Untrusted JSON is never cast outside the tests (eslint.config.ts UNTRUSTED_CASTS).
{
  const eslint = new ESLint({ cwd: ROOT, flags: ["unstable_native_nodejs_ts_config"] });
  // Linted as a file the gate covers (and its type project includes), with this text in place of its own.
  const filePath = path.join(ROOT, "packages", "core", "lib", "guard.ts");
  const cases: readonly [string, boolean][] = [
    ["export const a = JSON.parse(\"{}\") as { x: number };\n", true],
    ["export async function b(r: Response): Promise<string[]> { return (await r.json()) as string[]; }\n", true],
    ["export const c = JSON.parse(\"{}\") as unknown;\n", false],
    ["export const d = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;\n", false],
  ];
  for (const [code, refused] of cases) {
    const [result] = await eslint.lintText(code, { filePath });
    const messages = result?.messages ?? [];
    const flagged = messages.some((m) => m.ruleId === "no-restricted-syntax" && /Do not cast/.test(m.message));
    assert.equal(flagged, refused, `${refused ? "must refuse" : "must allow"}: ${code.trim()}`);
  }
  ok(`the lint gate refuses casts of untrusted JSON (${cases.length} cases)`);
}

console.log(`[typescript-coverage-smoke] OK (${checks} checks)`);
