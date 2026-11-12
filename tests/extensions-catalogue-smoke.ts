#!/usr/bin/env node
/**
 * B-098 regression coverage: docs/EXTENSIONS.md is a generated catalogue and must
 * be byte-identical to what packages/core/registry.ts produces. verify.ts compares
 * the two, but this smoke also pins the builder directly and proves the catalogue
 * still names real extensions.
 *
 * Deterministic and offline - no pi/docker/network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, object, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import { buildRegistryEntries, extensionsCatalogueContent } from "../packages/core/registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const content = extensionsCatalogueContent();
assert.match(content, /^# Extensions Catalog\n/, "catalogue must start with the generated heading");
assert.match(content, /\| `conductor` \| First-party \|/, "catalogue must list the first-party conductor extension");
assert.match(content, /\| `subagent` \| Vendored \|/, "catalogue must list the vendored subagent extension");

// The committed doc must be exactly what the generator emits (the drift gate).
const doc = fs.readFileSync(path.join(ROOT, "docs", "EXTENSIONS.md"), "utf8");
assert.equal(doc, content, "docs/EXTENSIONS.md is stale vs packages/core/registry.ts (run npm run catalog)");

// Entry collection covers both in-repo avenues and has no placeholder rows.
const entries = buildRegistryEntries();
assert.ok(entries.some((e) => e.name === "conductor" && e.avenue === "First-party"));
assert.ok(entries.some((e) => e.avenue === "Vendored"));
assert.ok(entries.every((e) => typeof e.name === "string" && e.name.length > 0));

// A README that advertises which profiles include the extension must agree with the
// machine-readable manifest. Only first-party directories that actually state it are checked.
const ExtensionManifest = object({ profiles: array(string()) });
for (const entry of fs.readdirSync(path.join(ROOT, "packages", "extensions", "src"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const readmePath = path.join(ROOT, "packages", "extensions", "src", entry.name, "README.md");
  const manifestPath = path.join(ROOT, "packages", "extensions", "src", entry.name, "extension.json");
  if (!fs.existsSync(readmePath) || !fs.existsSync(manifestPath)) continue;
  const match = /^Included in: (.*)$/m.exec(fs.readFileSync(readmePath, "utf8"));
  if (match === null) continue;
  const fromReadme = [...(match[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  const manifest = parseJsonAs(ExtensionManifest, fs.readFileSync(manifestPath, "utf8"), manifestPath);
  assert.deepEqual(
    [...fromReadme].sort(),
    [...manifest.profiles].sort(),
    `${entry.name}: README 'Included in:' list must match extension.json profiles`,
  );
}

console.log("extensions-catalogue smoke: OK");
