#!/usr/bin/env node
// B-092 regression: a null `extension.json` (valid JSON, wrong shape) must make the offline
// verifier report a clean schema failure, not abort the whole gate with a TypeError that hides
// every later check. The test runs the real `verify.ts` against a throwaway workspace whose only
// extension carries `null`, so it proves the end-to-end path rather than a copy of the logic.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The fields `execFileSync` attaches to the error it throws on a non-zero exit. */
interface ExecFailure {
  status?: number | null;
  stdout?: string;
  stderr?: string;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-manifest-guard-"));

try {
  const ws = path.join(base, "ws");
  fs.mkdirSync(path.join(ws, "packages", "extensions", "src"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "extensions", "third_party"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "kit", "profiles"), { recursive: true });
  fs.mkdirSync(path.join(ws, "packages", "kit", "skills"), { recursive: true });
  fs.cpSync(path.join(REPO, "packages", "core"), path.join(ws, "packages", "core"), { recursive: true });
  // Minimal workspace package.json so the verifier can run past its early checks.
  fs.writeFileSync(path.join(ws, "package.json"), "{}\n");

  const broken = path.join(ws, "packages", "extensions", "src", "broken");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "extension.json"), "null\n");
  fs.writeFileSync(path.join(broken, "index.ts"), "export {};\n");

  // Shim `npx` so the verifier's `tsc --noEmit` step does not run/fail for reasons unrelated to
  // the manifest guard; the crash under test happens before that step on the pre-fix source.
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
  } catch (error: unknown) {
    const failure: ExecFailure = typeof error === "object" && error !== null ? error : {};
    status = failure.status ?? 1;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  assert.notEqual(status, 0, "verify must fail on a null manifest, not pass silently");
  assert.match(output, /extension\.json schema invalid/, "the null manifest must be reported as schema-invalid");
  assert.doesNotMatch(output, /TypeError/, "a null manifest must not crash the verifier with a TypeError");
  // Prove the gate continued past the bad manifest instead of aborting there: the type-check step
  // runs only after the per-extension loop. Pre-fix the TypeError aborts before this marker.
  assert.match(output, /tsc --noEmit/, "the verifier must continue to later checks after the clean failure");

  console.log("core-manifest-guard smoke: OK");
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
