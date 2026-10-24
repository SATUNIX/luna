#!/usr/bin/env node
// B-104 regression: a malformed extension.json must be reported with its path, not
// thrown as a bare SyntaxError, and verify.ts must not mask the parse failure as
// generated-doc drift. Builds a throwaway workspace, copies packages/core into it,
// and exercises the copied registry.ts directly and via its CLI.
// Deterministic and offline - no pi/docker/network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Registry from "../packages/core/registry.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-registry-parse-"));

try {
  const ws = path.join(base, "ws");
  fs.mkdirSync(path.join(ws, "packages", "extensions", "src"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "extensions", "third_party"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "kit", "profiles"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "kit", "skills"), { recursive: true });
  fs.cpSync(path.join(REPO, "packages", "core"), path.join(ws, "packages", "core"), { recursive: true });
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), "{}\n");

  // Valid fixture so the catalogue builder succeeds and we can record "correct" bytes.
  const goodDir = path.join(ws, "packages", "extensions", "src", "good");
  fs.mkdirSync(goodDir, { recursive: true });
  fs.writeFileSync(path.join(goodDir, "extension.json"), JSON.stringify({
    name: "good",
    summary: "Valid fixture extension.",
    category: "workflow",
    entry: "index.ts",
    hooks: [],
    profiles: [],
    platforms: ["linux"],
    runtime: { nodeBuiltins: [], npm: [], piPeers: [], services: [], models: [] },
    status: "stub",
  }, null, 2) + "\n");

  // registry.ts derives WORKSPACE_ROOT from its own location, so the copied module
  // at <ws>/packages/core/registry.ts resolves everything under <ws>.
  const registryUrl = pathToFileURL(path.join(ws, "packages", "core", "registry.ts")).href;
  // The copy has the same source as packages/core/registry.ts: the test states its shape, as
  // loadModule does, and the typeof check below confirms the export it relies on first.
  const loaded: unknown = await import(registryUrl);
  const registry = loaded as typeof Registry;

  const goodMetaPath = path.join(goodDir, "extension.json");
  assert.equal(typeof registry.parseExtensionManifest, "function", "parseExtensionManifest must be exported");
  assert.throws(
    () => registry.parseExtensionManifest(path.join(goodDir, "missing.json")),
    (error) => error instanceof Error && error.message.includes("missing.json") && error.message.includes("cannot read"),
    "a read failure must name the manifest path",
  );
  assert.deepEqual(registry.parseExtensionManifest(goodMetaPath).name, "good");

  // Valid workspace: generated content matches itself; an altered string drifts.
  const correct = registry.extensionsCatalogueContent();
  assert.match(correct, /\| `good` \| First-party \|/, "valid fixture must appear in the catalogue");
  assert.deepEqual(registry.extensionsCatalogueDrift(correct), { stale: false }, "correct bytes must not be stale");
  assert.deepEqual(registry.extensionsCatalogueDrift(`${correct}\n`), { stale: true }, "altered bytes must be detected as drift");

  // Introduce a malformed manifest (dir name must not start with "_").
  const badDir = path.join(ws, "packages", "extensions", "src", "bad");
  fs.mkdirSync(badDir, { recursive: true });
  const badMetaPath = path.join(badDir, "extension.json");
  fs.writeFileSync(badMetaPath, "{ this is not json\n");

  assert.throws(
    () => registry.buildRegistryEntries(),
    (error) => {
      assert.ok(error instanceof Error, "buildRegistryEntries must throw an Error");
      assert.ok(error.message.includes(badMetaPath), `error must name the manifest path: ${error.message}`);
      assert.match(error.message, /invalid JSON/, "error must identify the JSON parse failure");
      return true;
    },
    "buildRegistryEntries must throw a descriptive error for a malformed manifest",
  );

  // CLI must exit non-zero and put the offending path on stderr.
  const cli = spawnSync(process.execPath, [path.join(ws, "packages", "core", "registry.ts")], { encoding: "utf8" });
  assert.notEqual(cli.status, 0, "registry CLI must exit non-zero on a malformed manifest");
  assert.ok(`${cli.stdout ?? ""}${cli.stderr ?? ""}`.includes(badMetaPath), `CLI output must name the manifest path: ${cli.stderr}`);

  // The drift helper must surface the parse error rather than claim staleness.
  const drift = registry.extensionsCatalogueDrift(correct);
  assert.equal(drift.stale, false, "a parse failure is not doc drift");
  assert.ok(typeof drift.error === "string" && drift.error.includes(badMetaPath), `drift.error must name the manifest: ${drift.error}`);

  console.log("registry-parse smoke: OK");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
