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
if (fs.existsSync("/overlay")) fs.cpSync("/overlay", src, { recursive: true, force: true, dereference: false });

const cwd = path.join(src, def.cwd ?? "");
if (!cwd.startsWith(src)) fail(125, "cwd escapes the clone");
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
