#!/usr/bin/env node
/** auto-commit-on-exit commits the work at shutdown but never stages credential-looking files or .pi/. Offline, throwaway repo. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadExtension, fakePi, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";

const ws = tmpWorkspace("pi-kit-autocommit-");
const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
// The extension commits through its own git calls, so the identity must be in the process
// environment too: a CI runner has no global git identity, and git refuses to commit without one.
const restoreEnv = [isolateKitEnv(), setEnv("HOME", path.join(ws, "home")), ...Object.entries(id).map(([k, v]) => setEnv(k, v))];
const repo = path.join(ws, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...id } }).trim();
const write = (name: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };

try {
  git("init", "-q", "-b", "main");
  write("a.txt", "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  write("a.txt", "two\n");
  write("kept.txt", "kept\n");
  for (const f of [".env", ".env.local", "config/api.key", "certs/x.pem", "db-credentials.json", "my_secret.txt", ".ssh/config", "id_rsa", "id_ed25519", ".npmrc", ".netrc"]) write(f, "x\n");
  write(".pi/state.json", "{}\n");

  const register = await loadExtension("vendor/auto-commit-on-exit/index.ts");
  const pi = fakePi({ cwd: repo });
  register(pi.api);
  const ctx = { cwd: repo, hasUI: false, sessionManager: { getEntries: () => [] } };
  await pi.handlers.get("session_shutdown")({}, ctx);

  assert.equal(git("rev-list", "--count", "HEAD"), "2", "the work was committed");
  const files = git("ls-tree", "-r", "--name-only", "HEAD").split("\n");
  assert.ok(files.includes("a.txt") && files.includes("kept.txt"), "ordinary changes are committed");
  assert.deepEqual(files.filter((f) => f !== "a.txt" && f !== "kept.txt"), [], `nothing credential-like or under .pi is committed: ${files.join(",")}`);
  console.log("  OK: auto-commit-on-exit commits the work and never stages credential files or .pi/");
} finally {
  for (const undo of restoreEnv) undo();
  rmWorkspace(ws);
}
console.log("\n[auto-commit-smoke] all checks passed");
