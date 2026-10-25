#!/usr/bin/env node
// Lockfile integrity gate (packages/core/lockfile-check.ts): every tracked npm lockfile is
// discovered and checked, not only the root one. Fixtures are temporary git repositories;
// nothing here touches the network or the real npm cache.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLockfile, discoverLockfiles, list, run } from "../packages/core/lockfile-check.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lockfile-"));
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(temp, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temp, "gitconfig"), LANG: "C" };
fs.writeFileSync(env.GIT_CONFIG_GLOBAL ?? "", "[user]\n\tname = Test\n\temail = test@example.com\n");
let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ok  ${name}`); };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const SHA = "sha512-" + "A".repeat(86) + "==";
const lock = (packages: Record<string, Record<string, unknown>>): string => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" }, ...packages } });
const good = lock({ "node_modules/left-pad": { resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: SHA } });
const write = (repo: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const quiet = <T>(fn: () => T): T => {
  const [log, error] = [console.log, console.error];
  console.log = (): void => {};
  console.error = (): void => {};
  try { return fn(); } finally { console.log = log; console.error = error; }
};

try {
  // 1. The rules, per lockfile text.
  assert.deepEqual(checkLockfile(good, "a").problems, []);
  const bad = checkLockfile(lock({
    "node_modules/from-git": { resolved: "git+https://example.com/x.git", integrity: SHA },
    "node_modules/no-hash": { resolved: "https://registry.npmjs.org/no-hash/-/no-hash-1.0.0.tgz" },
    "node_modules/scripted": { resolved: "https://registry.npmjs.org/scripted/-/scripted-1.0.0.tgz", integrity: SHA, hasInstallScript: true },
  }), "b").problems;
  assert.equal(bad.length, 3, bad.join("\n"));
  assert.ok(bad.every((p) => p.startsWith("b: ")), "each problem names its lockfile");
  assert.match(checkLockfile("{", "c").problems[0] ?? "", /^c: /, "malformed JSON is a problem, not a crash");
  assert.match(checkLockfile(JSON.stringify({ lockfileVersion: 1 }), "d").problems[0] ?? "", /lockfileVersion < 2/);
  ok("a non-registry source, a missing sha512 hash, an unreviewed install script and a malformed lockfile are each reported");

  // 2. Discovery: a nested lockfile added later is checked without editing the gate.
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  write(repo, "package-lock.json", good);
  write(repo, "node_modules/dep/package-lock.json", "not checked: installed dependencies are not sources");
  git(repo, "add", "package-lock.json");
  assert.deepEqual(discoverLockfiles(repo), ["package-lock.json"]);
  assert.equal(quiet(() => run(repo)), 0);
  write(repo, "services/extra/package-lock.json", lock({ "node_modules/evil": { resolved: "https://registry.example.org/evil-1.0.0.tgz", integrity: SHA } }));
  git(repo, "add", "services/extra/package-lock.json");
  assert.deepEqual(discoverLockfiles(repo), ["package-lock.json", "services/extra/package-lock.json"]);
  assert.equal(quiet(() => run(repo)), 1, "a bad nested lockfile fails the gate");
  ok("a lockfile added in a subdirectory is discovered and fails the gate when it is bad; node_modules is ignored");

  // 3. Without git (an unpacked tarball) the tree is walked instead; no lockfile at all fails.
  const plain = path.join(temp, "plain");
  write(plain, "package-lock.json", good);
  write(plain, "sub/npm-shrinkwrap.json", good);
  write(plain, "node_modules/x/package-lock.json", good);
  assert.deepEqual(discoverLockfiles(plain), ["package-lock.json", "sub/npm-shrinkwrap.json"]);
  const empty = path.join(temp, "empty");
  fs.mkdirSync(empty);
  assert.equal(quiet(() => run(empty)), 1, "finding no lockfile is a failure, not a pass");
  ok("outside a git checkout the tree is walked; finding no lockfile fails");

  // 3b. `--list`, which the CI audit loops walk: an empty list is a failure, not nothing to audit.
  const listed: string[] = [];
  assert.equal(list(plain, (l) => listed.push(l)), 0);
  assert.deepEqual(listed, ["package-lock.json", "sub/npm-shrinkwrap.json"]);
  assert.equal(quiet(() => list(empty, () => {})), 1, "--list over a tree with no lockfile fails");
  const cli = spawnSync(process.execPath, [path.join(ROOT, "packages/core/lockfile-check.ts"), "--list"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.split("\n").includes("package-lock.json"), "the CLI lists this checkout's root lockfile");
  ok("--list prints the lockfiles and exits non-zero when it finds none");

  // 4. This repository: the MCP server lockfiles the container installs are covered.
  const real = discoverLockfiles(ROOT);
  for (const f of ["package-lock.json", "packages/container/mcp-servers/governance/package-lock.json", "packages/container/mcp-servers/memory-mcp/package-lock.json"]) {
    if (fs.existsSync(path.join(ROOT, f))) assert.ok(real.includes(f), `${f} is checked`);
  }
  ok(`this checkout's ${real.length} lockfile(s) are all discovered`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`lockfile-check smoke: ${passed} checks passed`);
