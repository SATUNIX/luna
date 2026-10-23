#!/usr/bin/env node
// The check gate must not be able to go green while a test is not running. This proves the wiring
// detector (packages/core/lib/wiring.ts) on fixtures, then applies it to the real repository, and
// shows the real gate would notice a suite being unwired (mutation: drop one script, expect a hit).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "../packages/core/eval/harness.ts";
import { MANUAL_ONLY, describeProblems, findWiringProblems, listTestFiles, scriptTargets } from "../packages/core/lib/wiring.ts";

let checks = 0;
const ok = (name: string): void => { checks += 1; console.log(`  ok  ${name}`); };

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-wiring-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const GOOD = 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n';

try {
  // 1. script targets: flags are skipped, chains and && are split, several scripts may share a file.
  {
    const t = scriptTargets({
      a: "node tests/a-smoke.mjs",
      b: "node --test tests/b-smoke.mjs && node tests/c-smoke.mjs",
      c: "bash tests/d.sh; python3 -m nothing",
      d: "node tests/a-smoke.mjs --flag",
    });
    assert.deepEqual([...t.keys()].sort(), ["tests/a-smoke.mjs", "tests/b-smoke.mjs", "tests/c-smoke.mjs", "tests/d.sh"]);
    assert.deepEqual(t.get("tests/a-smoke.mjs"), ["a", "d"]);
    ok("script targets: flags skipped, chains split, shared files listed once per script");
  }

  // 2. an unwired test is reported; a wired one and a harness a wired test names are not.
  {
    const dir = fixture({
      "tests/wired-smoke.mjs": `import "./helper-harness.mjs";\n${GOOD}`,
      "tests/helper-harness.mjs": "export const x = 1;\n",
      "tests/orphan-smoke.mjs": GOOD,
    });
    try {
      const p = findWiringProblems({ root: dir, scripts: { "smoke:wired": "node tests/wired-smoke.mjs" }, manual: {} });
      assert.deepEqual(p.unwired, ["tests/orphan-smoke.mjs"]);
      assert.match(describeProblems(p).join("\n"), /unwired test .*orphan-smoke\.mjs/);
      ok("an unwired test is reported; a wired test and the harness it names are not");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // 3. a script whose target file is gone is reported (a rename that left the script behind).
  {
    const dir = fixture({ "tests/real-smoke.mjs": GOOD });
    try {
      const p = findWiringProblems({ root: dir, scripts: { "smoke:real": "node tests/real-smoke.mjs", "smoke:gone": "node tests/renamed-smoke.mjs" }, manual: {} });
      assert.deepEqual(p.missingTargets, [{ script: "smoke:gone", file: "tests/renamed-smoke.mjs" }]);
      ok("a script that runs a missing test file is reported");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // 4. a wired test that asserts nothing counts as zero work, not as a pass.
  {
    const dir = fixture({
      "tests/empty-smoke.mjs": 'console.log("all good");\n',
      "tests/exits-smoke.mjs": 'if (!process.env.X) process.exit(1);\n',
      "tests/throws-smoke.mjs": 'throw new Error("nope");\n',
    });
    try {
      const p = findWiringProblems({
        root: dir,
        scripts: { a: "node tests/empty-smoke.mjs", b: "node tests/exits-smoke.mjs", c: "node tests/throws-smoke.mjs" },
        manual: {},
      });
      assert.deepEqual(p.noAssertions, ["tests/empty-smoke.mjs"]);
      ok("a test with no assertion, throw or failing exit is reported; the others count as testing");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // 5. the manual-only exemption is explicit, reported with its reason, and only covers listed files.
  {
    const dir = fixture({ "tests/needs-docker.sh": "set -e\ndocker version\n", "tests/other.sh": "set -e\ntrue\n" });
    try {
      const p = findWiringProblems({ root: dir, scripts: {}, manual: { "tests/needs-docker.sh": "needs a container engine" } });
      assert.deepEqual(p.unwired, ["tests/other.sh"]);
      assert.deepEqual(p.manual, [{ file: "tests/needs-docker.sh", reason: "needs a container engine" }]);
      ok("a manual-only file is exempt with a stated reason; an unlisted one is not");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // 6. the real repository: nothing is unwired, no script is dangling, nothing asserts nothing,
  //    and every exemption names a file that exists (a stale exemption would hide a future orphan).
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  {
    const p = findWiringProblems({ root: ROOT, scripts: pkg.scripts });
    assert.deepEqual(describeProblems(p), [], "the repository has wiring problems");
    const files = listTestFiles(ROOT);
    for (const file of Object.keys(MANUAL_ONLY)) assert.ok(files.includes(file), `MANUAL_ONLY names a file that no longer exists: ${file}`);
    assert.ok(files.length > 100, `expected the repository's test files to be found, got ${files.length}`);
    ok(`the repository is fully wired (${files.length} test files, ${Object.keys(MANUAL_ONLY).length} manual-only with reasons)`);
  }

  // 7. mutation: with one real suite's script removed, the detector names exactly that suite.
  {
    const scripts = { ...pkg.scripts };
    assert.ok(scripts["smoke:effort"], "test premise: smoke:effort exists");
    delete scripts["smoke:effort"];
    const p = findWiringProblems({ root: ROOT, scripts });
    assert.ok(p.unwired.includes("tests/effort-smoke.ts"), `dropping smoke:effort must leave tests/effort-smoke.ts unwired: ${p.unwired.join(",")}`);
    ok("dropping a real script makes the detector name that suite");
  }

  // 8. the gate itself: check-all fails on a wiring problem and passes when there is none.
  {
    const run = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--check-wiring"], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /every test file is wired/);
    ok("check-all --check-wiring passes on the repository");
  }
} finally { /* fixtures removed above */ }

console.log(`[wiring-smoke] OK (${checks} checks)`);
