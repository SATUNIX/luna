#!/usr/bin/env node
/**
 * Offline checks for the autonomy gate's held-out overlay (packages/autonomy/lib/check-runner.ts,
 * docs/autonomy.md): the overlay is copied over a worker-controlled clone without following any
 * symbolic link the worker committed, and a check's working directory may not pass through one.
 *   1. a plain overlay applies: new files and directories appear, an existing file is replaced;
 *   2. a clone directory that is a link to a directory outside the clone refuses the overlay, and
 *      nothing outside changes;
 *   3. a clone file that is a link to an outside file refuses the overlay, and the outside file
 *      keeps its content;
 *   4. a link inside the overlay itself is refused;
 *   5. a check cwd with a linked component is reported, and isWithin is a path check, not a prefix.
 * Benign content only (plain text files in temporary directories). No Docker, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { applyOverlay, isWithin, symlinkedComponent } from "../packages/autonomy/lib/check-runner.ts";

const restoreEnv = isolateKitEnv();
let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`  OK: ${name}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate-overlay-"));
let n = 0;
function layout(): { overlay: string; clone: string; outside: string } {
  const dir = path.join(base, String(n++));
  const overlay = path.join(dir, "overlay");
  const clone = path.join(dir, "clone");
  const outside = path.join(dir, "outside");
  for (const d of [overlay, clone, outside]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(overlay, "tests"));
  fs.writeFileSync(path.join(overlay, "tests", "held-out.txt"), "held out\n");
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
  return { overlay, clone, outside };
}

console.log("[autonomy-gate-overlay-smoke] held-out overlay containment");

try {
  check("1. a plain overlay applies over the clone", () => {
    const { overlay, clone } = layout();
    fs.mkdirSync(path.join(clone, "tests"));
    fs.writeFileSync(path.join(clone, "tests", "held-out.txt"), "worker version\n");
    fs.writeFileSync(path.join(overlay, "top.txt"), "top\n");
    assert.equal(applyOverlay(overlay, clone), null);
    assert.equal(fs.readFileSync(path.join(clone, "tests", "held-out.txt"), "utf8"), "held out\n");
    assert.equal(fs.readFileSync(path.join(clone, "top.txt"), "utf8"), "top\n");
  });

  check("2. a linked directory in the clone refuses the overlay; outside is untouched", () => {
    const { overlay, clone, outside } = layout();
    fs.symlinkSync(outside, path.join(clone, "tests"));
    const problem = applyOverlay(overlay, clone);
    assert.match(problem ?? "", /symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
  });

  check("3. a linked file in the clone refuses the overlay; the outside file keeps its content", () => {
    const { overlay, clone, outside } = layout();
    fs.mkdirSync(path.join(clone, "tests"));
    fs.symlinkSync(path.join(outside, "sentinel.txt"), path.join(clone, "tests", "held-out.txt"));
    assert.match(applyOverlay(overlay, clone) ?? "", /symbolic link/);
    assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "unchanged\n");
  });

  check("4. a link inside the overlay is refused", () => {
    const { overlay, clone, outside } = layout();
    fs.symlinkSync(path.join(outside, "sentinel.txt"), path.join(overlay, "tests", "linked.txt"));
    assert.match(applyOverlay(overlay, clone) ?? "", /symbolic link/);
    assert.equal(fs.existsSync(path.join(clone, "tests", "linked.txt")), false);
  });

  check("5. a check cwd through a link is reported; isWithin is not a string-prefix test", () => {
    const { clone, outside } = layout();
    fs.mkdirSync(path.join(clone, "pkg"));
    fs.symlinkSync(outside, path.join(clone, "linked"));
    assert.equal(symlinkedComponent(clone, path.join(clone, "pkg")), null);
    assert.match(symlinkedComponent(clone, path.join(clone, "linked", "sub")) ?? "", /symbolic link/);
    assert.equal(isWithin(clone, path.join(clone, "pkg")), true);
    assert.equal(isWithin(clone, `${clone}-sibling`), false);
    assert.equal(isWithin(clone, path.join(clone, "..", "outside")), false);
  });
} finally {
  fs.rmSync(base, { recursive: true, force: true });
  restoreEnv();
}

console.log(`\n[autonomy-gate-overlay-smoke] all ${checks} checks passed`);
