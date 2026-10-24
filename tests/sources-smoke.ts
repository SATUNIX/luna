#!/usr/bin/env node
/**
 * Offline checks for packages/core/sources.json readers (readSources). A missing file,
 * malformed JSON, or a value that is not an object with an `external` array must fall
 * back to `{ external: [] }` instead of throwing or leaving callers to dereference an
 * unexpected shape. The last case is a wiring positive control: the installer still
 * runs the sources path end to end.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSources } from "../packages/core/lib/sources.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tests = {
  "readSources() returns the repo sources with a non-empty external list": () => {
    const sources = readSources();
    assert.ok(Array.isArray(sources.external), "external is an array");
    assert.ok(sources.external.length > 0, "repo sources.json has externals");
  },

  "readSources(file) falls back to { external: [] } for malformed payloads": () => {
    const dir = scratch("pi-kit-sources-bad-");
    try {
      const file = path.join(dir, "sources.json");
      for (const payload of [null, "[]", '"nope"', "{}", '{"external":5}']) {
        fs.writeFileSync(file, payload ?? "null");
        assert.doesNotThrow(() => readSources(file), `throws for ${payload ?? "null"}`);
        assert.deepEqual(readSources(file), { external: [] }, `fallback for ${payload ?? "null"}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "readSources(file) round-trips a well-formed sources file": () => {
    const dir = scratch("pi-kit-sources-good-");
    try {
      const file = path.join(dir, "sources.json");
      const value = { external: [{ name: "x", mode: "reference", source: "npm:x", provides: ["x"], profiles: ["lite"] }] };
      fs.writeFileSync(file, JSON.stringify(value));
      assert.deepEqual(readSources(file), value);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "installer dry-run reaches the sources path and exits 0": () => {
    const agent = scratch("pi-kit-sources-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.ts");
    try {
      const result = spawnSync(process.execPath, [installer, "--profile", "lite", "--dry-run"], {
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_KIT_DELIVERY: "", PI_SYSTEM_GIT_SOURCE: "" },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
  }
}
if (failed) {
  console.error(`\n[sources-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[sources-smoke] all ${Object.keys(tests).length} checks passed`);