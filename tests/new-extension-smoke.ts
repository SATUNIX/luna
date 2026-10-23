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
import { WORKSPACE_ROOT } from "../packages/core/lib/paths.ts";

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
} finally {
  rmWorkspace(work);
  restoreEnv();
}

console.log("new-extension smoke: OK");
