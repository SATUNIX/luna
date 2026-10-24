// Pre-push leak scan (packages/core/prepush-scan.ts, packages/core/lib/leak-scan.ts).
// Every blocked value below is built by concatenation, so this file passes the scan it tests.
// Each case pushes to a bare repository in a temporary directory through the installed hook,
// with a temporary HOME, PI_CODING_AGENT_DIR and git configuration.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addedLines, PRIVATE_PATH_PREFIXES } from "../packages/core/prepush-scan.ts";
import { blockedMatches } from "../packages/core/lib/leak-scan.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prepush-"));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: path.join(temp, "home"),
  PI_CODING_AGENT_DIR: path.join(temp, "home", "agent"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(temp, "gitconfig"),
  LANG: "C",
};
fs.mkdirSync(env.PI_CODING_AGENT_DIR ?? "", { recursive: true });
fs.writeFileSync(env.GIT_CONFIG_GLOBAL ?? "", "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");

const sha = (x: string): string => crypto.createHash("sha256").update(x).digest("hex");
const HOME_PATH = "/ho" + "me/alice/notes";
const PRIVATE_IP = "10." + "20.30.40";
const LAB_IP = "192." + "168.1.9";
const HOST = "build" + ".internal";
const TOKEN = "gh" + "p_" + "a".repeat(36);
const AWS = "AK" + "IA" + "B".repeat(16);
const PEM = "-----BEGIN " + "PRIVATE KEY-----";

let passed = 0;
function ok(name: string): void { passed++; console.log(`  ok  ${name}`); }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function commit(repo: string, file: string, content: string, message = `add ${file}`, extraEnv: NodeJS.ProcessEnv = {}): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo, env: { ...env, ...extraEnv }, stdio: "ignore" });
}
function push(repo: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync("git", ["push", "-q", "origin", ...args], { cwd: repo, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function scan(repo: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join(repo, "packages/core/prepush-scan.ts"), ...args], { cwd: repo, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

try {
  // 1. The rules: each blocked class matches; documentation addresses and public hosts do not.
  for (const value of [HOME_PATH, PRIVATE_IP, LAB_IP, "172." + "20.0.1", HOST, "nas" + ".lan", TOKEN, "github" + "_pat_" + "c".repeat(30), AWS, PEM]) {
    assert.equal(blockedMatches(`x ${value} y`).length, 1, "a blocked class matches");
  }
  for (const value of ["example.com", "192.0.2.1", "172.32.0.1", "/usr/home", "ghp_short"]) assert.deepEqual(blockedMatches(value), [], `${value} is not blocked`);
  ok("blocked classes match; documentation addresses and public hosts do not");

  // 2. Hunk parsing consumes exactly the hunk's lines, so content that looks like a header is content.
  const patch = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-old", "-gone", "+++ b/decoy", "+@@ -9 +9 @@", "\\ No newline at end of file", "@@ -0,0 +10 @@", "+last\r", ""].join("\n");
  assert.deepEqual(addedLines(patch), [{ file: "f", lineNo: 1, text: "++ b/decoy" }, { file: "f", lineNo: 2, text: "@@ -9 +9 @@" }, { file: "f", lineNo: 10, text: "last" }]);
  ok("added lines are read by hunk count; header-like content stays content; CR is stripped");

  // A bare "public" remote and a clone that carries the scanner (untracked) and its exceptions.
  const remote = path.join(temp, "remote.git");
  fs.mkdirSync(remote);
  git(remote, "init", "-q", "--bare");
  const repo = path.join(temp, "clone");
  git(temp, "clone", "-q", remote, repo);
  for (const f of ["packages/core/prepush-scan.ts", "packages/core/lib/leak-scan.ts", "packages/core/lib/guard.ts"]) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(repo, f));
  }
  fs.writeFileSync(path.join(repo, ".git/info/exclude"), "packages/core/*.ts\npackages/core/lib/\n");
  const excepted = `fixture address ${PRIVATE_IP}`;
  const exceptions = { schemaVersion: 1, scanExceptions: [{ path: "docs/fixture.md", matchSha256: sha(PRIVATE_IP), lineSha256: sha(excepted), reason: "test" }] };
  commit(repo, "packages/core/leak-scan-exceptions.json", JSON.stringify(exceptions, null, 2) + "\n");
  commit(repo, "README.md", "public\n");

  // 3. install writes an executable hook, is idempotent, and never replaces a different hook.
  const installed = scan(repo, "install");
  assert.equal(installed.status, 0, installed.out);
  const hook = path.join(repo, ".git/hooks/pre-push");
  assert.ok((fs.statSync(hook).mode & 0o111) !== 0, "hook is executable");
  assert.equal(scan(repo, "install").status, 0, "reinstalling the same hook is fine");
  const other = path.join(temp, "other");
  git(temp, "clone", "-q", remote, other);
  fs.mkdirSync(path.join(other, "packages/core/lib"), { recursive: true });
  for (const f of ["packages/core/prepush-scan.ts", "packages/core/lib/leak-scan.ts", "packages/core/lib/guard.ts"]) fs.copyFileSync(path.join(ROOT, f), path.join(other, f));
  fs.writeFileSync(path.join(other, ".git/hooks/pre-push"), "#!/bin/sh\nexit 0\n");
  const refused = scan(other, "install");
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /already exists/);
  assert.equal(fs.readFileSync(path.join(other, ".git/hooks/pre-push"), "utf8"), "#!/bin/sh\nexit 0\n", "the other hook is left untouched");
  fs.chmodSync(hook, 0o644);
  assert.equal(scan(repo, "install").status, 0, "reinstalling over a non-executable copy of the hook");
  assert.equal(fs.statSync(hook).mode & 0o777, 0o755, "reinstall restores the hook's mode");
  const otherHook = path.join(other, ".git/hooks/pre-push");
  fs.rmSync(otherHook);
  fs.symlinkSync(path.join(temp, "missing-target"), otherHook);
  const dangling = scan(other, "install");
  assert.notEqual(dangling.status, 0, "a dangling symlink at the hook path is refused");
  assert.match(dangling.out, /already exists/);
  assert.ok(!fs.existsSync(path.join(temp, "missing-target")), "nothing is written through the symlink");
  ok("install writes an executable hook, reinstalls idempotently and refuses to replace another hook or write through a dangling symlink");

  // 4. A clean first push passes; a later push checks only the new commits.
  let r = push(repo, "main");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /2 commit\(s\) checked/);
  commit(repo, "docs/a.md", "fine\n");
  r = push(repo, "main");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 commit\(s\) checked/);
  ok("a clean push passes; commits already on the remote are not rescanned");

  // 5. Each blocked class in an added line refuses the push, and the value is never printed.
  for (const [i, value] of [HOME_PATH, LAB_IP, HOST, TOKEN, AWS, PEM].entries()) {
    git(repo, "switch", "-q", "-c", `leak-${i}`, "main");
    commit(repo, "docs/leak.md", `line one\nsee ${value} here\n`);
    r = push(repo, `leak-${i}`);
    assert.equal(r.status, 1, `push refused for class ${i}: ${r.out}`);
    assert.match(r.out, /docs\/leak\.md:2: blocked identifier \(value redacted\)/);
    assert.ok(!r.out.includes(value), "the value is not printed");
    assert.equal(git(remote, "branch", "--list", `leak-${i}`).trim(), "", "nothing reached the remote");
  }
  ok("each blocked class refuses the push, names file:line and never prints the value");

  // 6. A value added then removed inside the same push is still refused: history is public too.
  git(repo, "switch", "-q", "-c", "fixup", "main");
  commit(repo, "docs/b.md", `${HOME_PATH}\n`);
  commit(repo, "docs/b.md", "clean\n", "remove it");
  r = push(repo, "fixup");
  assert.equal(r.status, 1, r.out);
  ok("a leak removed by a later commit in the same push is still refused");

  // 7. Commit messages and author identities are scanned.
  git(repo, "switch", "-q", "-c", "msg", "main");
  commit(repo, "docs/c.md", "x\n", `deploy to ${HOST}`);
  r = push(repo, "msg");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /message line 1/);
  git(repo, "switch", "-q", "-c", "author", "main");
  commit(repo, "docs/d.md", "x\n", "plain", { GIT_AUTHOR_EMAIL: "bot@builder" + ".lan" });
  r = push(repo, "author");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /author or committer/);
  ok("commit messages and author identities are scanned");

  // 8. Private sidecar paths are refused even when their content is clean.
  for (const prefix of PRIVATE_PATH_PREFIXES) {
    const branch = `priv-${prefix.replace(/\W/g, "")}`;
    git(repo, "switch", "-q", "-c", branch, "main");
    commit(repo, `${prefix}notes.md`, "clean\n");
    r = push(repo, branch);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /adds or changes a private path/);
  }
  ok("files under internal/, reviews/ and examples/engagement/ are refused");

  // 9. An audited exception admits its exact line only; any edit to the line is refused again.
  git(repo, "switch", "-q", "-c", "exc", "main");
  commit(repo, "docs/fixture.md", `${excepted}\n`);
  r = push(repo, "exc");
  assert.equal(r.status, 0, r.out);
  commit(repo, "docs/fixture.md", `${excepted} changed\n`);
  r = push(repo, "exc");
  assert.equal(r.status, 1, r.out);
  commit(repo, "docs/other.md", `${excepted}\n`);
  assert.equal(scan(repo, "range", "HEAD~1..HEAD").status, 1, "the exception is bound to its file");
  ok("an exception admits its exact line in its file only");

  // 10. A change to the exceptions file is called out for review; deleting a branch is not scanned.
  git(repo, "switch", "-q", "-c", "exc-change", "main");
  commit(repo, "packages/core/leak-scan-exceptions.json", JSON.stringify({ ...exceptions, scanExceptions: [] }) + "\n");
  r = push(repo, "exc-change");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /needs owner review/);
  r = push(repo, "--delete", "exc-change");
  assert.equal(r.status, 0, r.out);
  ok("an exceptions change is called out for owner review; a branch deletion passes");

  // 11. Misuse and git errors refuse instead of passing.
  assert.equal(scan(repo).status, 2);
  assert.equal(scan(repo, "range", "no-such-ref").status, 2);
  ok("usage errors and unknown revisions exit 2 (push refused)");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`prepush-scan smoke: ${passed} checks passed`);
