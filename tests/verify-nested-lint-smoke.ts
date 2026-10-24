#!/usr/bin/env node
// B-103 regression: the self-containment lint (and every other per-extension pass) must
// scan `.ts` modules at ANY depth, not just the extension dir's top level. This runs the
// real `verify.ts` against a throwaway workspace whose only extension has a top-level
// `index.ts` plus a nested `sub/bad.ts` that imports outside the extension dir. Pre-fix
// `readdirSync(...).filter(.ts)` never sees `sub/bad.ts`, so it passes silently.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Shape of the error `execFileSync` throws when the child exits non-zero. */
interface ExecFileError {
  status?: number | null;
  stdout?: string;
  stderr?: string;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-verify-nested-lint-"));

try {
  const ws = path.join(base, "ws");
  fs.mkdirSync(path.join(ws, "packages", "extensions", "src"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "extensions", "third_party"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "kit", "profiles"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "kit", "skills"), { recursive: true });
  fs.cpSync(path.join(REPO, "packages", "core"), path.join(ws, "packages", "core"), { recursive: true });
  // Minimal workspace package.json so the verifier can run past its early checks.
  fs.writeFileSync(path.join(ws, "package.json"), "{}\n");

  const ext = path.join(ws, "packages", "extensions", "src", "nested");
  fs.mkdirSync(path.join(ext, "sub"), { recursive: true });
  fs.writeFileSync(path.join(ext, "extension.json"), JSON.stringify({
    name: "nested",
    summary: "Regression fixture with a nested self-containment violation.",
    category: "workflow",
    entry: "index.ts",
    hooks: [],
    profiles: [],
    platforms: ["linux"],
    runtime: { nodeBuiltins: [], npm: [], piPeers: [], services: [], models: [] },
    status: "stub",
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(ext, "index.ts"), "export {};\n");
  // No-false-positive fixture: a nested file importing a sibling inside the same
  // extension. Resolving `../shared.ts` against extDir (pre-fix) wrongly points
  // outside the extension dir.
  fs.writeFileSync(path.join(ext, "shared.ts"), "export const shared = 1;\n");
  fs.writeFileSync(path.join(ext, "sub", "good.ts"), 'import { shared } from "../shared.ts";\nexport { shared };\n');
  fs.writeFileSync(path.join(ext, "sub", "bad.ts"), 'import { x } from "../../../outside.ts";\nexport { x };\n');

  // Shim `npx` so the verifier's `tsc --noEmit` step does not run/fail for reasons unrelated
  // to the nested lint; the assertion under test happens in the per-extension loop.
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const npxShim = path.join(bin, "npx");
  fs.writeFileSync(npxShim, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(npxShim, 0o755);

  let output = "";
  let status = 0;
  try {
    output = execFileSync(process.execPath, [path.join(ws, "packages", "core", "verify.ts")], {
      cwd: ws,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        NODE_PATH: path.join(REPO, "node_modules"),
      },
    });
  } catch (caught) {
    const error = caught as ExecFileError;
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  assert.notEqual(status, 0, "verify must fail on a nested self-containment violation");
  assert.match(output, /self-containment violation in sub[/\\]bad\.ts/, "the nested violation must be reported with its relative path");
  assert.doesNotMatch(output, /self-containment violation in sub[/\\]good\.ts/, "an intra-extension nested import must not be a false positive");
  assert.doesNotMatch(output, /TypeError/, "the nested scan must not crash the verifier with a TypeError");

  console.log("verify-nested-lint smoke: OK");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
