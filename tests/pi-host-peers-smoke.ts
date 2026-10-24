#!/usr/bin/env node
/**
 * Every pi host package the kit imports is declared, so it resolves by declaration rather than by
 * an accident of npm hoisting.
 *
 * pi supplies `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and `typebox`
 * to extensions (pi's docs/packages.md asks packages to list them in `peerDependencies`). The kit
 * once imported pi-tui without declaring it; the pinned tree resolved it only because pi 1.3.0
 * depends on it, and the pi-compat lane, which installs another pi over that tree, pruned the
 * root copy and every extension that imports it failed with ERR_MODULE_NOT_FOUND.
 *
 * Checks, all static and offline:
 * - each host package imported from `packages/extensions` or `tests` is a peer dependency;
 * - each `@earendil-works/*` peer is a dev dependency pinned to the same version as pi itself;
 * - the ci.yml pi-compat job installs each `@earendil-works/*` peer at the lane's pi version, so
 *   the lane tests the copy that version brings rather than the pinned one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
  return out;
}

/** The host package a module specifier names, if any (`@earendil-works/pi-ai/compat` -> pi-ai). */
export function hostPackageOf(specifier: string): string | undefined {
  return HOST_PACKAGES.find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** Host packages named by static imports, re-exports and dynamic imports in a TypeScript source. */
export function importedHostPackages(source: string): Set<string> {
  const found = new Set<string>();
  const patterns = [/\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s*["']([^"']+)["']/gm];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1] === undefined ? undefined : hostPackageOf(match[1]);
      if (name !== undefined) found.add(name);
    }
  }
  return found;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const SELF = fileURLToPath(import.meta.url);
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");
const pkg = readJson(path.join(ROOT, "package.json"));
const peers = stringMap(isRecord(pkg) ? pkg.peerDependencies : undefined);
const devs = stringMap(isRecord(pkg) ? pkg.devDependencies : undefined);
const earendilPeers = Object.keys(peers).filter((name) => name.startsWith("@earendil-works/"));

const tests: Record<string, () => void> = {
  "the import scanner finds static, type-only, subpath and dynamic imports": () => {
    const sample = [
      `import { truncateToWidth } from "@earendil-works/pi-tui";`,
      `import type { Model } from '@earendil-works/pi-ai/compat';`,
      `const m = await import("@earendil-works/pi-agent-core");`,
      `import { Type } from "typebox";`,
      `import fs from "node:fs";`,
      `import x from "@earendil-works/pi-tuitive";`,
    ].join("\n");
    assert.deepEqual([...importedHostPackages(sample)].sort(), ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]);
  },

  "every host package imported by the extensions or the tests is a peer dependency": () => {
    const missing: string[] = [];
    for (const base of ["packages/extensions", "tests"]) {
      for (const file of tsFiles(path.join(ROOT, base))) {
        if (file === SELF) continue; // this file's scanner samples are strings, not imports
        for (const name of importedHostPackages(fs.readFileSync(file, "utf8"))) {
          if (!(name in peers)) missing.push(`${rel(file)} imports ${name}`);
        }
      }
    }
    assert.deepEqual(missing, [], "add these to package.json peerDependencies (pi supplies them; see pi's docs/packages.md)");
  },

  "every pi peer is a dev dependency pinned to pi's own version": () => {
    const pin = devs["@earendil-works/pi-coding-agent"];
    assert.ok(pin !== undefined && /^\d+\.\d+\.\d+$/.test(pin), "pi-coding-agent is pinned to an exact dev version");
    for (const name of earendilPeers) assert.equal(devs[name], pin, `${name} dev dependency must be pinned to ${pin}, the tested pi`);
    for (const name of earendilPeers) assert.equal(peers[name], peers["@earendil-works/pi-coding-agent"], `${name} peer range matches pi-coding-agent's floor`);
  },

  "the pi-compat lane installs every pi peer at the lane's version": () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const job = ci.split(/^ {2}pi-compat:\s*$/m)[1]?.split(/^ {2}[A-Za-z0-9_-]+:\s*$/m)[0];
    assert.ok(job !== undefined, "ci.yml has a pi-compat job");
    const install = job.match(/npm install --no-save[\s\S]*?(?=\n\s+env:)/)?.[0];
    assert.ok(install !== undefined, "pi-compat installs pi with npm install --no-save");
    for (const name of earendilPeers) {
      assert.ok(install.includes(`"${name}@\${PI_VERSION}"`), `pi-compat must install "${name}@\${PI_VERSION}"; otherwise npm nests the lane's copy under pi and prunes the root one`);
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
    console.error(`  FAIL: ${name}\n    ${String(error instanceof Error ? error.message || error : error)}`);
  }
}
if (failed) {
  console.error(`\n[pi-host-peers-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[pi-host-peers-smoke] all ${Object.keys(tests).length} checks passed`);
