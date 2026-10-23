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

console.log("extensions-catalogue smoke: OK");
