#!/usr/bin/env node
/**
 * B-100 regression coverage: extracting an extension must copy its whole tree,
 * including subdirectories, so an extension whose entry point imports a nested
 * module (conductor -> ./validate/validator.ts) stages a loadable package.
 *
 * Deterministic and offline - no pi/docker/network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractExtension, isSafeExtensionName } from "../packages/core/extract-extension.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extract-"));
const firstParty = path.join(tmp, "src");
const dstBase = path.join(tmp, "out");
const ext = path.join(firstParty, "fakeext");
fs.mkdirSync(path.join(ext, "sub"), { recursive: true });
fs.writeFileSync(
  path.join(ext, "extension.json"),
  `${JSON.stringify({ name: "fakeext", summary: "fixture", category: "testing" }, null, 2)}\n`,
);
const indexBody = 'import { helper } from "./sub/helper.ts";\nexport default helper;\n';
const helperBody = "export const helper = 42;\n";
fs.writeFileSync(path.join(ext, "index.ts"), indexBody);
fs.writeFileSync(path.join(ext, "sub", "helper.ts"), helperBody);

// N1 fixture: a manifest that is not valid JSON.
const badExt = path.join(firstParty, "badext");
fs.mkdirSync(badExt, { recursive: true });
fs.writeFileSync(path.join(badExt, "extension.json"), "{ this is not json\n");

try {
  const result = extractExtension("fakeext", { firstPartyDir: firstParty, dstBase });
  assert.equal(result.ok, true, "extractExtension must succeed for a valid fixture");

  const staged = path.join(dstBase, "pi-ext-fakeext", "extensions", "fakeext");
  // The nested file is the point: a top-level-only copy omits it and the staged
  // extension cannot resolve ./sub/helper.ts.
  assert.equal(
    fs.readFileSync(path.join(staged, "sub", "helper.ts"), "utf8"),
    helperBody,
    "nested subdirectory file must be copied into the extracted package",
  );
  assert.equal(fs.readFileSync(path.join(staged, "index.ts"), "utf8"), indexBody);

  const pkg = JSON.parse(fs.readFileSync(path.join(dstBase, "pi-ext-fakeext", "package.json"), "utf8")) as { name: string };
  assert.equal(pkg.name, "@gitops/pi-ext-fakeext");

  const meta = JSON.parse(fs.readFileSync(path.join(staged, "extension.json"), "utf8")) as { homeRepo?: string };
  assert.equal(meta.homeRepo, "git:github.com/SATUNIX/pi-ext-fakeext", "the placeholder home is the kit's own host and owner, never a private host");

  // N1: a malformed source manifest must fail before any staging dir is created.
  const captured: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    const bad = extractExtension("badext", { firstPartyDir: firstParty, dstBase });
    assert.equal(bad.ok, false, "malformed manifest must fail");
    assert.equal(bad.exitCode, 1, "malformed manifest must exit 1");
    assert.equal(
      fs.existsSync(path.join(dstBase, "pi-ext-badext")),
      false,
      "malformed manifest must not create a staging directory",
    );
  } finally {
    console.error = origError;
  }
  const stderr = captured.join("\n");
  assert.match(stderr, /badext/, "stderr must name the source extension");
  assert.match(stderr, /JSON/, "stderr must carry the underlying parse message");
  assert.match(stderr, /invalid extension\.json/);

  // Failure paths still behave: unknown extension and missing name return non-zero.
  assert.equal(extractExtension("nope", { firstPartyDir: firstParty, dstBase }).ok, false);
  assert.equal(extractExtension("", { firstPartyDir: firstParty, dstBase }).exitCode, 1);

  // B-105: unsafe names must be rejected before any path is used, and must not
  // create a staging directory.
  for (const bad of ["..", "../core", "a/b", "", "a\\b", "/tmp/x"]) {
    const rejected = extractExtension(bad, { firstPartyDir: firstParty, dstBase });
    assert.equal(rejected.ok, false, `name ${JSON.stringify(bad)} must be rejected`);
    assert.equal(rejected.exitCode, 1, `name ${JSON.stringify(bad)} must exit 1`);
    assert.equal(
      fs.existsSync(path.join(dstBase, `pi-ext-${bad}`)),
      false,
      `name ${JSON.stringify(bad)} must not create a staging directory`,
    );
  }

  // The predicate itself: unsafe names false, ordinary names true.
  for (const bad of ["..", ".", "a/b", "a\\b", "/tmp/x", ""] ) {
    assert.equal(isSafeExtensionName(bad), false, `isSafeExtensionName(${JSON.stringify(bad)})`);
  }
  for (const good of ["fakeext", "pentest-governance-domain", "a.b_c-1"]) {
    assert.equal(isSafeExtensionName(good), true, `isSafeExtensionName(${JSON.stringify(good)})`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The CLI entry still prints usage and exits 1 when invoked without a name.
const cli = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "extract-extension.ts")], {
  encoding: "utf8",
});
assert.equal(cli.status, 1, "CLI without a name must exit 1");
assert.match(cli.stderr, /Usage:/);

console.log("extract-extension smoke: OK");
