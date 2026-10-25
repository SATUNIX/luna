#!/usr/bin/env node
/**
 * packages/autonomy/build-image.sh defaults --kit-ref to this checkout's release tag: a
 * build without the flag must not bake an older kit (firewall, containment) than the checkout.
 *   - --print-kit-ref with no --kit-ref prints v<package.json version>;
 *   - an explicit --kit-ref wins;
 *   - a ref that is not in the clone stops before any engine is called.
 * Needs bash and git; it builds nothing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

if (process.platform === "win32") {
  console.log("[autonomy-build-image-smoke] SKIP: needs bash; runs in the Linux CI job");
  process.exit(0);
}

const script = path.join(ROOT, "packages", "autonomy", "build-image.sh");
const pkg = parseJson(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
assert.ok(isRecord(pkg) && typeof pkg.version === "string", "package.json has a version");
const run = (...args: string[]) => spawnSync("bash", [script, ...args], { cwd: ROOT, encoding: "utf8" });

const byDefault = run("--print-kit-ref");
assert.equal(byDefault.status, 0, byDefault.stderr);
assert.equal(byDefault.stdout.trim(), `v${pkg.version}`, "the default kit ref is the package.json version's release tag");

const explicit = run("--kit-ref", "v0.0.0-example", "--print-kit-ref");
assert.equal(explicit.stdout.trim(), "v0.0.0-example", "an explicit --kit-ref wins");

// `--engine false`: if the script ever reached the engine it would fail with a different message.
const missing = run("--kit-ref", "refs/tags/no-such-kit-ref-for-test", "--engine", "false");
assert.equal(missing.status, 2, `an unknown kit ref exits 2 before building:\n${missing.stderr}`);
assert.match(missing.stderr, /is not in this clone/);

console.log("[autonomy-build-image-smoke] OK (default kit ref = v<package.json version>; an explicit ref wins; an unknown ref stops before the engine)");
