#!/usr/bin/env node
// Runs INSIDE a clean, network-less gate container (lib/docker.ts checkRunArgs) to judge one
// acceptance check. Mounted read-only from the supervisor's checkout, so the worker cannot
// change it. Inputs, all read-only mounts or environment set by the supervisor:
//   /in/branch.bundle   the accepted history (plain data)
//   /run/checks.json    the check definitions from the run directory (never read from the clone)
//   /overlay            held-out files copied over the clone before the check runs
//   CHECK_ID CHECK_SHA CHECK_BRANCH
// It clones the bundle, checks out the sha, applies the overlay and runs the definition with a
// scrubbed environment. The container's exit status is the verdict (0 = pass); /gate holds a log
// and a small result file the supervisor treats as evidence, not as the verdict.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** True when `target` is `root` or lies inside it (a path.relative check, not a string prefix). */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Copies the held-out overlay tree over the clone without following anything the worker planted.
 * The clone is worker-controlled: a directory or file in it may be a symlink that points
 * out of the clone (to /gate, /run or the overlay itself), and fs.cpSync would write through it.
 * Every destination component is lstat'ed: a symlink, or a non-directory where a directory is
 * needed, refuses the whole overlay (the check then fails as a gate error, never as a pass). An
 * existing regular file is replaced by unlinking it and copying with COPYFILE_EXCL. A symlink
 * inside the overlay itself is refused too. Returns a problem, or null when the overlay applied.
 * tests/autonomy-gate-overlay-smoke.ts pins this.
 */
export function applyOverlay(overlay: string, dest: string): string | null {
  const walk = (rel: string): string | null => {
    const from = path.join(overlay, rel);
    for (const name of fs.readdirSync(from)) {
      const childRel = rel ? path.join(rel, name) : name;
      const source = fs.lstatSync(path.join(overlay, childRel));
      const target = path.join(dest, childRel);
      if (!isWithin(dest, target)) return `overlay entry ${childRel} escapes the clone`;
      let existing: fs.Stats | null;
      try { existing = fs.lstatSync(target); } catch { existing = null; }
      if (existing?.isSymbolicLink()) return `overlay target ${childRel} is a symbolic link in the clone`;
      if (source.isSymbolicLink()) return `overlay entry ${childRel} is a symbolic link`;
      if (source.isDirectory()) {
        if (existing && !existing.isDirectory()) return `overlay target ${childRel} is not a directory in the clone`;
        if (!existing) fs.mkdirSync(target);
        const inner = walk(childRel);
        if (inner) return inner;
      } else if (source.isFile()) {
        if (existing && !existing.isFile()) return `overlay target ${childRel} is not a regular file in the clone`;
        if (existing) fs.unlinkSync(target);
        fs.copyFileSync(path.join(overlay, childRel), target, fs.constants.COPYFILE_EXCL);
      } else return `overlay entry ${childRel} is not a file or directory`;
    }
    return null;
  };
  const top = fs.lstatSync(dest);
  if (!top.isDirectory()) return "the clone is not a directory";
  return walk("");
}

/** A component of `target` below `root` that is a symlink (so the check would run outside the overlaid clone), or null. */
export function symlinkedComponent(root: string, target: string): string | null {
  let current = path.resolve(root);
  for (const part of path.relative(current, path.resolve(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(current); } catch { return null; } // missing: the spawn reports it
    if (st.isSymbolicLink()) return `cwd component ${path.relative(root, current)} is a symbolic link in the clone`;
  }
  return null;
}

function main(): void {

const { CHECK_ID: id, CHECK_SHA: sha, CHECK_BRANCH: branch } = process.env;
const started = Date.now();
/** One command check from /run/checks.json (service-health checks are judged elsewhere). */
interface CommandCheck { id: string; type?: string; run: string | string[]; cwd?: string; timeoutMinutes?: number }

function fail(code: number, message: string): never {
  try { fs.writeFileSync("/gate/check-result.json", JSON.stringify({ id, exitCode: code, timedOut: code === 124, seconds: Math.round((Date.now() - started) / 1000), error: message })); } catch { /* the exit code still says it */ }
  console.error(`[check-runner] ${message}`);
  process.exit(code === 124 ? 124 : code || 125);
}

if (!id || sha === undefined || !/^[0-9a-f]{40}$/.test(sha) || !branch) fail(125, "CHECK_ID, CHECK_SHA and CHECK_BRANCH are required");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The definition of check `id`, or null when there is no well-formed command check of that id. */
function findCheck(file: unknown, wanted: string | undefined): CommandCheck | null {
  const checks = isRecord(file) ? file.checks ?? [] : [];
  if (!Array.isArray(checks)) return null;
  const c: unknown = checks.find((x: unknown) => isRecord(x) && x.id === wanted);
  if (!isRecord(c) || typeof c.id !== "string" || c.type === "service-health") return null;
  const { run, cwd, timeoutMinutes, type } = c;
  const runOk = typeof run === "string" || (Array.isArray(run) && run.length > 0 && run.every((a) => typeof a === "string"));
  if (!runOk) return null;
  if (cwd !== undefined && typeof cwd !== "string") return null;
  if (timeoutMinutes !== undefined && (typeof timeoutMinutes !== "number" || !(timeoutMinutes > 0))) return null;
  if (type !== undefined && typeof type !== "string") return null;
  return { id: c.id, run, ...(cwd === undefined ? {} : { cwd }), ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }), ...(type === undefined ? {} : { type }) };
}
const def = findCheck(JSON.parse(fs.readFileSync("/run/checks.json", "utf8")), id) ?? fail(125, `no command check ${JSON.stringify(id)} in /run/checks.json`);

const home = "/gate/home";
fs.mkdirSync(home, { recursive: true });
const gitEnv = { PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: "0" };
const git = (args: string[], cwd?: string) => spawnSync("git", ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], { cwd, env: gitEnv, encoding: "utf8" });
const src = "/gate/src";
fs.rmSync(src, { recursive: true, force: true });
let r = git(["clone", "--quiet", "--no-checkout", "--branch", branch, "/in/branch.bundle", src]);
if (r.status !== 0) fail(125, `cannot clone the bundle: ${r.stderr.trim().slice(0, 300)}`);
r = git(["checkout", "--quiet", "--detach", sha], src);
if (r.status !== 0) fail(125, `cannot check out ${sha}: ${r.stderr.trim().slice(0, 300)}`);
if (fs.existsSync("/overlay")) {
  const problem = applyOverlay("/overlay", src);
  if (problem) fail(125, `cannot apply the held-out overlay: ${problem}`);
}

const cwd = path.join(src, def.cwd ?? "");
if (!isWithin(src, cwd)) fail(125, "cwd escapes the clone");
const cwdProblem = symlinkedComponent(src, cwd);
if (cwdProblem) fail(125, cwdProblem);
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: "/tmp", CI: "1", LANG: "C.UTF-8", NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT: "false" };
const [cmd = "", ...rest] = Array.isArray(def.run) ? def.run : ["sh", "-c", def.run];
const args = rest;
const log = fs.createWriteStream("/gate/check.log");
let logged = 0;
const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
const sink = (chunk: Buffer): void => { if (logged < 8 * 1024 * 1024) { logged += chunk.length; log.write(chunk); } };
child.stdout.on("data", sink);
child.stderr.on("data", sink);
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; try { if (child.pid === undefined) throw new Error("no pid"); process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, (def.timeoutMinutes ?? 15) * 60_000);
child.on("error", (e) => { clearTimeout(timer); fail(127, `cannot run the check: ${e.message}`); });
child.on("close", (code, signal) => {
  clearTimeout(timer);
  const exitCode = timedOut ? 124 : code ?? (signal ? 137 : 1);
  log.end(() => {
    fs.writeFileSync("/gate/check-result.json", JSON.stringify({ id, exitCode, timedOut, seconds: Math.round((Date.now() - started) / 1000) }));
    process.exit(exitCode === 0 ? 0 : timedOut ? 124 : 1);
  });
});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
