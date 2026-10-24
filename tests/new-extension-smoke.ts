#!/usr/bin/env node
/**
 * `npm run new -- <name>` must leave a tree that passes `npm run verify`, the step it names
 * (docs/building-extensions.md). The repository is copied into a temporary directory (without
 * .git and node_modules, which is linked), the scaffolder runs there, then verify runs there.
 *
 * Hermetic: a temporary HOME and PI_CODING_AGENT_DIR, no network, the real tree is not touched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, rmWorkspace, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { WORKSPACE_ROOT } from "../packages/core/lib/paths.ts";

// The value at `keys` inside nested JSON objects, or undefined.
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

const restoreEnv = isolateKitEnv();
const work = tmpWorkspace("pi-kit-new-extension-");
const SKIP = new Set([".git", "node_modules", "site"]);

try {
  const copy = path.join(work, "repo");
  fs.cpSync(WORKSPACE_ROOT, copy, { recursive: true, filter: (source) => !SKIP.has(path.basename(source)) });
  const modules = path.join(WORKSPACE_ROOT, "node_modules");
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(copy, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const home = path.join(work, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent") };

  const scaffold = spawnSync(process.execPath, [path.join(copy, "packages", "core", "new-extension.ts"), "demo-ext"], { cwd: copy, env, encoding: "utf8" });
  assert.equal(scaffold.status, 0, `new-extension exits 0 (stderr: ${scaffold.stderr.trim()})`);
  assert.match(scaffold.stdout, /Created packages\/extensions\/src\/demo-ext\//, "the scaffolder prints the real path");
  if (fs.existsSync(path.join(WORKSPACE_ROOT, "internal", "public-release", "manifest.json"))) {
    assert.match(scaffold.stdout, /internal\/public-release\/manifest\.json/, "the checklist names the public-release manifest");
    assert.match(scaffold.stdout, /packages\/extensions\/src\/demo-ext\/extension\.json/, "the checklist lists the files to classify");
  } else {
    assert.doesNotMatch(scaffold.stdout, /public-release\/manifest\.json/, "a checkout without the release manifest gets no manifest step");
  }
  const manifest = fs.readFileSync(path.join(copy, "packages", "extensions", "src", "demo-ext", "extension.json"), "utf8");
  assert.match(manifest, /"name": "demo-ext"/);
  assert.match(fs.readFileSync(path.join(copy, "docs", "EXTENSIONS.md"), "utf8"), /demo-ext/, "the catalogue was regenerated");

  const verify = spawnSync(process.execPath, [path.join(copy, "packages", "core", "verify.ts")], { cwd: copy, env, encoding: "utf8" });
  const failures = `${verify.stdout}\n${verify.stderr}`.split("\n").filter((line) => line.includes("FAIL"));
  assert.equal(verify.status, 0, `verify passes on a fresh scaffold:\n${failures.join("\n")}`);

  // verify type-checks only against the pinned pi: the pi-compat CI lane installs another pi over
  // the pinned tree, and there the tsc step reports a SKIP naming both versions instead.
  const pinned = at(parseJson(fs.readFileSync(path.join(WORKSPACE_ROOT, "package.json"), "utf8")), "devDependencies", "@earendil-works/pi-coding-agent");
  const installedPath = path.join(WORKSPACE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  const installed = fs.existsSync(installedPath) ? at(parseJson(fs.readFileSync(installedPath, "utf8")), "version") : undefined;
  if (typeof pinned === "string" && typeof installed === "string" && installed !== pinned) {
    assert.ok(verify.stdout.includes(`SKIP: installed pi ${installed} is not the pinned ${pinned}; the verify job type-checks the pin`), "an unpinned pi skips the type check");
    assert.doesNotMatch(verify.stdout, /OK: type check passed/, "an unpinned pi does not run tsc");
  } else {
    assert.match(verify.stdout, /OK: type check passed/, "the pinned pi gets the full type check");
  }
} finally {
  rmWorkspace(work);
  restoreEnv();
}

console.log("new-extension smoke: OK");
