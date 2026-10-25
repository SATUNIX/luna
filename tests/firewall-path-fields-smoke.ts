#!/usr/bin/env node
// tool-firewall PATH_FIELDS lint, offline.
//
// The firewall checks a non-shell tool call's path arguments by field name (classify.ts PATH_FIELDS): a field
// it does not know is never compared with the protected paths. This test reads the parameter schemas of the
// tools the kit registers and of pi's built-in tools, and fails on a path-like parameter name (path, file,
// dir, root, cwd, folder) that is neither in PATH_FIELDS nor in the reviewed exemptions below. It also fails
// when the scan finds nothing, so a change in how schemas are written cannot pass it silently.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as Classify from "../packages/extensions/src/tool-firewall/classify.ts";

const restoreIsolation = isolateKitEnv();
const C = await loadModule<typeof Classify>("extensions/tool-firewall/classify.ts");
const ROOT = path.resolve(import.meta.dirname, "..");

// Path-like names that are not tool parameters, with the reason.
const EXEMPT: Record<string, string> = {
  full_output_path: "pi bash tool output schema (a result field the tool writes, not an argument)",
};
const FIELD = /\b([A-Za-z_]*(?:[Pp]ath|[Ff]ile|[Dd]ir|[Rr]oot|cwd|[Ff]older)[A-Za-z_]*)\s*:\s*Type\./g;

const found: Array<{ file: string; name: string }> = [];
function scan(dir: string, ext: RegExp): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") scan(p, ext); continue; }
    if (!ext.test(e.name)) continue;
    for (const m of fs.readFileSync(p, "utf8").matchAll(FIELD)) found.push({ file: path.relative(ROOT, p), name: m[1] ?? "" });
  }
}
for (const pkg of ["extensions", "kit"]) scan(path.join(ROOT, "packages", pkg), /\.ts$/);
const piTools = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools");
scan(piTools, /\.js$/);

assert.ok(found.some((f) => f.file.includes("pi-coding-agent") && f.name === "path"), "pi's built-in tool schemas were scanned (their `path` parameter was found)");
assert.ok(found.filter((f) => f.file.startsWith("packages")).length >= 3, "the kit's tool schemas were scanned");

const known: ReadonlySet<string> = new Set(C.PATH_FIELDS);
const missing = found.filter((f) => !known.has(f.name) && !Object.hasOwn(EXEMPT, f.name)).map((f) => `${f.file}: ${f.name}`);
assert.deepEqual(missing, [], `tool parameters that look like paths but are not in PATH_FIELDS (classify.ts); add each there or, after review, to EXEMPT here:\n${missing.join("\n")}`);

// The lint is only useful if a listed field is really checked: a protected target through each kit field is high.
const env: Classify.ClassifyEnv = { cwd: "/work/repo", workspace: "/work/repo", home: "/u/op", tmpRoots: ["/tmp"], knownHosts: new Set(), policy: "coding" };
for (const name of new Set(found.filter((f) => f.file.startsWith("packages")).map((f) => f.name))) {
  const t = C.effectiveTier(C.classifyToolCall("custom_tool", { [name]: "/u/op/.ssh/id_rsa" }, env, { decision: "allow" }, "ask"), false);
  assert.equal(t, "high", `a kit tool's ${name} argument naming a private key is checked (got ${t})`);
}
console.log(`  OK: ${found.length} path-like tool parameters, all in PATH_FIELDS or reviewed exemptions`);
restoreIsolation();
console.log("[firewall-path-fields-smoke] OK");
