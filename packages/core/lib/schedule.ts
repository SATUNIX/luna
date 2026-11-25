/**
 * Scheduled Luna runs (`luna schedule`, `/schedule`): a spec per schedule in the state home, and a
 * systemd user timer (or, without systemd, a crontab line) that runs `luna schedule run-now <id>
 * --digest <sha256>` at the chosen times. The prompt stays in the spec; a unit file or crontab line
 * carries only generated values (the id, the normalised time, the digest) and paths limited to
 * SAFE_PATH.
 *
 * The spec is not trusted at run time. `add` (the moment the operator confirms) resolves everything
 * that decides what runs - the absolute pi, node and luna paths, the directory, the kind, the prompt
 * or config, the caps - into the spec, and writes the SHA-256 of its canonical form into the unit file
 * or crontab line. `run-now` recomputes it and refuses on a mismatch: a changed spec must be removed
 * and added again. Nothing executable is looked up through a PATH the spec supplies; pi is run by the
 * absolute path recorded at `add`.
 *
 * Each job is one `luna exec` (headless: an action rated ask is refused, docs/headless.md) or one
 * `pi-autonomy up --config <file>` (which starts only an authorised contract). An exec job always
 * carries `--max-turns`, `--max-cost` and `--timeout`, each with a default and a maximum
 * (CAP_MAXIMA); the systemd unit is stopped after the timeout; a schedule never runs twice at once (a
 * lock the kernel releases when the holder exits). A job runs with LUNA_SCHEDULE_JOB set and the CLI
 * and /schedule refuse to change schedules under it: a guard against accident, not enforcement (a
 * process can unset it). The enforcement against a job scheduling a job is the firewall rule (V5-15)
 * plus the headless refusal of ask-rated actions.
 *
 * Every call to `systemctl` or `crontab` goes through `deps.run`, so tests never touch the real ones.
 * Pinned by tests/luna-cli-smoke.ts (tests/schedule-checks.ts).
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "../shared/ceiling.ts";
import { planExec } from "./headless.ts";

export type Backend = "systemd" | "cron";
export type ScheduleKind = "exec" | "autonomy";

export interface ScheduleSpec {
  schemaVersion: 2;
  id: string;
  /** The normalised time: hourly, daily HH:MM, weekly <day> HH:MM, every Nm, every Nh. */
  when: string;
  kind: ScheduleKind;
  /** exec: the prompt. */
  prompt?: string;
  /** exec: the `luna exec` caps, always --max-turns, --max-cost and --timeout, in that order. */
  limits?: string[];
  /** autonomy: the run config. */
  config?: string;
  cwd: string;
  backend: Backend;
  /** Absolute paths resolved at add: pi (exec), node and the luna entry. */
  piBin?: string;
  nodeBin: string;
  lunaBin: string;
  createdAt: string;
}

export interface RunResult { status: number | null; stdout: string; stderr: string }
export interface ScheduleDeps {
  env: NodeJS.ProcessEnv;
  /** Runs systemctl or crontab; `input` is written to stdin. */
  run: (cmd: string, args: readonly string[], input?: string) => RunResult;
  now: () => Date;
  /** The node binary and the luna entry the job runs. */
  nodeBin: string;
  lunaBin: string;
}

export const defaultDeps = (): ScheduleDeps => ({
  env: process.env,
  run: (cmd, args, input) => {
    const r = spawnSync(cmd, [...args], { encoding: "utf8", input, timeout: 30_000 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? r.error.message : (r.stderr ?? "") };
  },
  now: () => new Date(),
  nodeBin: process.execPath,
  lunaBin: path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "luna.ts"),
});

export const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Set for the job: a guard against accident (see the header), not enforcement. */
export const JOB_ENV = "LUNA_SCHEDULE_JOB";
/** The caps an exec job gets when the operator names none, and the most each may be. */
export const DEFAULT_LIMITS: Readonly<Record<string, string>> = { "--max-turns": "50", "--max-cost": "2", "--timeout": "30m" };
export const CAP_MAXIMA = { turns: 500, usd: 50, seconds: 12 * 3600 } as const;
const CAP_FLAGS = ["--max-turns", "--max-cost", "--timeout"] as const;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
/**
 * A path written into a unit file or crontab line, where it is double-quoted: letters and digits of
 * any script, space and _./@+-. No newline, %, quote, $, backslash, backtick or control character.
 */
const SAFE_PATH = /^\/[\p{L}\p{N}_./@+ -]*$/u;
const DIGEST = /^[0-9a-f]{64}$/;
const TAG = (id: string): string => `# luna-schedule:${id}`;
const UNIT = (id: string): string => `luna-schedule-${id}`;

/** systemd OnCalendar and cron fields for a `when`, with its normalised form, or the reason it is not understood. */
export function parseWhen(when: string): { calendar: string; cron: string; normal: string } | { error: string } {
  const w = when.trim().toLowerCase().replace(/\s+/g, " ");
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (w === "hourly") return { calendar: "hourly", cron: "0 * * * *", normal: w };
  let m = /^daily ([01]?\d|2[0-3]):([0-5]\d)$/.exec(w);
  if (m) {
    const H = Number(m[1]), M = Number(m[2]);
    return { calendar: `*-*-* ${pad(H)}:${pad(M)}:00`, cron: `${M} ${H} * * *`, normal: `daily ${pad(H)}:${pad(M)}` };
  }
  m = /^weekly (mon|tue|wed|thu|fri|sat|sun) ([01]?\d|2[0-3]):([0-5]\d)$/.exec(w);
  if (m) {
    const name = m[1] ?? "";
    const H = Number(m[2]), M = Number(m[3]);
    const day = DAYS.indexOf(name as (typeof DAYS)[number]);
    return { calendar: `${name.replace(/^./, (c) => c.toUpperCase())} *-*-* ${pad(H)}:${pad(M)}:00`, cron: `${M} ${H} * * ${(day + 1) % 7}`, normal: `weekly ${name} ${pad(H)}:${pad(M)}` };
  }
  m = /^every ([1-9]\d?)([mh])$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "m" && n >= 5 && n <= 59) return { calendar: `*:0/${n}`, cron: `*/${n} * * * *`, normal: `every ${n}m` };
    if (m[2] === "h" && n <= 23) return { calendar: `0/${n}:00`, cron: `0 */${n} * * *`, normal: `every ${n}h` };
  }
  return { error: `"${when}" is not a schedule: use hourly, daily HH:MM, weekly <mon..sun> HH:MM, every Nm (5-59) or every Nh (1-23)` };
}

function home(deps: ScheduleDeps): string {
  return deps.env.HOME || os.homedir();
}
export function scheduleDir(deps: ScheduleDeps): string {
  return path.join(deps.env.XDG_STATE_HOME || path.join(home(deps), ".local", "state"), "luna", "schedules");
}
function unitDir(deps: ScheduleDeps): string {
  return path.join(deps.env.XDG_CONFIG_HOME || path.join(home(deps), ".config"), "systemd", "user");
}
const specFile = (deps: ScheduleDeps, id: string): string => path.join(scheduleDir(deps), `${id}.json`);

/** systemd when `systemctl --user` answers, else cron when `crontab -l` runs, else null. */
export function detectBackend(deps: ScheduleDeps): Backend | null {
  if (deps.run("systemctl", ["--user", "show-environment"]).status === 0) return "systemd";
  const c = deps.run("crontab", ["-l"]);
  // crontab -l exits 1 with "no crontab for <user>" when there is none yet: that is still a usable crontab.
  if (c.status === 0 || (c.status === 1 && /no crontab/i.test(c.stderr))) return "cron";
  return null;
}

/** The spec's fields that decide what runs, in a fixed order: what the digest covers. */
function canonical(spec: ScheduleSpec): string {
  return JSON.stringify([spec.schemaVersion, spec.id, spec.when, spec.kind, spec.prompt ?? null, spec.limits ?? null, spec.config ?? null, spec.cwd, spec.backend, spec.piBin ?? null, spec.nodeBin, spec.lunaBin]);
}
export const specDigest = (spec: ScheduleSpec): string => crypto.createHash("sha256").update(canonical(spec)).digest("hex");

const str = (v: unknown): v is string => typeof v === "string";

export function readSpec(deps: ScheduleDeps, id: string): ScheduleSpec | null {
  if (!ID.test(id)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(specFile(deps, id), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r.schemaVersion !== 2 || r.id !== id || !str(r.when) || (r.kind !== "exec" && r.kind !== "autonomy") || !str(r.cwd) || (r.backend !== "systemd" && r.backend !== "cron") || !str(r.nodeBin) || !str(r.lunaBin)) return null;
    const spec: ScheduleSpec = { schemaVersion: 2, id, when: r.when, kind: r.kind, cwd: r.cwd, backend: r.backend, nodeBin: r.nodeBin, lunaBin: r.lunaBin, createdAt: str(r.createdAt) ? r.createdAt : "" };
    if (str(r.prompt)) spec.prompt = r.prompt;
    const limits: unknown = r.limits;
    if (Array.isArray(limits) && limits.every(str)) spec.limits = limits.filter(str);
    if (str(r.config)) spec.config = r.config;
    if (str(r.piBin)) spec.piBin = r.piBin;
    return spec;
  } catch {
    return null;
  }
}

export function listSpecs(deps: ScheduleDeps): ScheduleSpec[] {
  let names: string[];
  try { names = fs.readdirSync(scheduleDir(deps)); } catch { return []; }
  return names.filter((n) => n.endsWith(".json")).map((n) => readSpec(deps, n.slice(0, -5))).filter((s): s is ScheduleSpec => s !== null).sort((a, b) => a.id.localeCompare(b.id));
}

export interface AddRequest { id: string; when: string; kind: ScheduleKind; prompt?: string; limits?: readonly string[]; config?: string; cwd: string; backend?: Backend }

/** The operator's caps with a default for each one missing, in CAP_FLAGS order. */
function withDefaults(limits: readonly string[] | undefined): string[] {
  const given = new Map<string, string>();
  for (let i = 0; i + 1 < (limits?.length ?? 0); i += 2) given.set(limits?.[i] ?? "", limits?.[i + 1] ?? "");
  return CAP_FLAGS.flatMap((f) => [f, given.get(f) ?? DEFAULT_LIMITS[f] ?? ""]);
}

/** Why a set of caps is not acceptable (missing, malformed or over CAP_MAXIMA), or null. */
export function capsProblem(limits: readonly string[] | undefined): string | null {
  const l = limits ?? [];
  const missing = CAP_FLAGS.filter((f) => !l.includes(f));
  if (missing.length) return `no ${missing.join(", ")}`;
  const value = (f: string): string => l[l.indexOf(f) + 1] ?? "";
  const plan = planExec([...l, "--", "x"]);
  if (typeof plan === "string") return plan;
  if (Number(value("--max-turns")) > CAP_MAXIMA.turns) return `--max-turns is at most ${String(CAP_MAXIMA.turns)}`;
  if (Number(value("--max-cost")) > CAP_MAXIMA.usd) return `--max-cost is at most ${String(CAP_MAXIMA.usd)}`;
  if ((parseDuration(value("--timeout")) ?? Infinity) > CAP_MAXIMA.seconds) return `--timeout is at most ${String(CAP_MAXIMA.seconds / 3600)}h`;
  return null;
}

/** What `add` would write, for the confirmation question. */
export function describeAdd(req: AddRequest): string {
  const what = req.kind === "exec" ? `luna exec ${withDefaults(req.limits).join(" ")} "${(req.prompt ?? "").slice(0, 120)}"` : `pi-autonomy up --config ${req.config ?? ""}`;
  const when = parseWhen(req.when);
  return `schedule ${req.id}: ${"error" in when ? req.when : when.normal}, in ${req.cwd}, runs ${what}`;
}

/** The absolute path of an executable `name` on deps.env.PATH (symlinks resolved), or null. Read at add only. */
function resolveOnPath(deps: ScheduleDeps, name: string): string | null {
  for (const dir of (deps.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* next */ }
  }
  return null;
}

/** Validate a request; the problem, or null. */
export function checkAdd(deps: ScheduleDeps, req: AddRequest): string | null {
  if (!ID.test(req.id)) return `"${req.id}" is not a schedule name: lowercase letters, digits and -, at most 40`;
  if (readSpec(deps, req.id)) return `schedule ${req.id} already exists; remove it first`;
  const when = parseWhen(req.when);
  if ("error" in when) return when.error;
  for (const [label, p] of [["directory", req.cwd], ["node", deps.nodeBin], ["luna", deps.lunaBin], ["state directory", scheduleDir(deps)]] as const) {
    if (!SAFE_PATH.test(p)) return `the ${label} path ${p} has characters a unit file or crontab line cannot carry safely (allowed: letters, digits, space and _./@+-)`;
  }
  try { if (!fs.statSync(req.cwd).isDirectory()) return `${req.cwd} is not a directory`; } catch { return `${req.cwd} does not exist`; }
  if (req.kind === "exec") {
    if (!(req.prompt ?? "").trim()) return "an exec schedule needs a prompt";
    const caps = capsProblem(withDefaults(req.limits));
    if (caps) return caps;
    if (resolveOnPath(deps, "pi") === null) return "pi is not on PATH; a scheduled luna exec needs it";
  } else {
    if (!req.config) return "an autonomy schedule needs --config <run.json>";
    if (!path.isAbsolute(req.config) || !fs.existsSync(req.config)) return `${req.config} is not an existing absolute path`;
  }
  return null;
}

const quoted = (p: string): string => `"${p}"`;

/** Replace `file` whole through an exclusively created temporary file, as profiles.ts writes the operator's files. */
function writeWhole(file: string, text: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Create a spec file that must not exist yet: exclusive, 0600, never through a link. */
function createSpec(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
}

/** Seconds the systemd unit may run before it is stopped: the job's timeout and a margin. */
function unitTimeout(spec: ScheduleSpec): number {
  if (spec.kind !== "exec") return 600;
  const t = spec.limits?.[spec.limits.indexOf("--timeout") + 1];
  return Math.min(t === undefined ? 1800 : (parseDuration(t) ?? 1800), CAP_MAXIMA.seconds) + 300;
}

/** Write the spec and install the timer or crontab line with the spec's digest. The operator has already confirmed. */
export function addSchedule(deps: ScheduleDeps, req: AddRequest): { ok: true; spec: ScheduleSpec; digest: string } | { ok: false; error: string } {
  const problem = checkAdd(deps, req);
  if (problem) return { ok: false, error: problem };
  const backend = req.backend ?? detectBackend(deps);
  if (!backend) return { ok: false, error: "neither systemd user timers (systemctl --user) nor crontab is available" };
  const when = parseWhen(req.when);
  if ("error" in when) return { ok: false, error: when.error };
  const spec: ScheduleSpec = { schemaVersion: 2, id: req.id, when: when.normal, kind: req.kind, cwd: req.cwd, backend, nodeBin: deps.nodeBin, lunaBin: deps.lunaBin, createdAt: deps.now().toISOString() };
  if (req.kind === "exec") {
    spec.prompt = req.prompt ?? "";
    spec.limits = withDefaults(req.limits);
    spec.piBin = resolveOnPath(deps, "pi") ?? "";
  } else spec.config = req.config ?? "";
  const digest = specDigest(spec);
  try { createSpec(specFile(deps, req.id), `${JSON.stringify(spec, null, 2)}\n`); } catch (error) {
    return { ok: false, error: `could not create the spec ${specFile(deps, req.id)}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const job = `${quoted(deps.nodeBin)} ${quoted(deps.lunaBin)} schedule run-now ${req.id} --digest ${digest}`;
  if (backend === "systemd") {
    const dir = unitDir(deps);
    const timeout = unitTimeout(spec);
    writeWhole(path.join(dir, `${UNIT(req.id)}.service`), `[Unit]\nDescription=Luna schedule ${req.id}\n\n[Service]\nType=oneshot\nWorkingDirectory=${req.cwd}\nExecStart=${job}\nTimeoutStartSec=${String(timeout)}\nRuntimeMaxSec=${String(timeout)}\n`, 0o644);
    writeWhole(path.join(dir, `${UNIT(req.id)}.timer`), `[Unit]\nDescription=Luna schedule ${req.id} (${when.normal})\n\n[Timer]\nOnCalendar=${when.calendar}\nPersistent=false\n\n[Install]\nWantedBy=timers.target\n`, 0o644);
    for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", `${UNIT(req.id)}.timer`]]) {
      const r = deps.run("systemctl", args);
      if (r.status !== 0) return { ok: false, error: `systemctl ${args.join(" ")} failed: ${r.stderr.trim().slice(0, 300)}; the spec and unit files were written, run luna schedule remove ${req.id} to undo` };
    }
  } else {
    const current = readCrontab(deps);
    if (current === null) return { ok: false, error: "crontab -l failed" };
    const log = path.join(scheduleDir(deps), `${req.id}.log`);
    const line = `${when.cron} cd ${quoted(req.cwd)} && ${job} >> ${quoted(log)} 2>&1 ${TAG(req.id)}`;
    const r = deps.run("crontab", ["-"], `${[...current.filter((l) => !l.endsWith(TAG(req.id))), line].join("\n")}\n`);
    if (r.status !== 0) return { ok: false, error: `crontab - failed: ${r.stderr.trim().slice(0, 300)}` };
  }
  return { ok: true, spec, digest };
}

function readCrontab(deps: ScheduleDeps): string[] | null {
  const r = deps.run("crontab", ["-l"]);
  if (r.status === 0) return r.stdout.split("\n").filter((l) => l.length > 0);
  if (r.status === 1 && /no crontab/i.test(r.stderr)) return [];
  return null;
}

/** The digest pinned in the installed unit file or crontab line, or null when there is none. */
export function installedDigest(deps: ScheduleDeps, id: string, backend: Backend): string | null {
  const find = (text: string): string | null => /schedule run-now [a-z0-9-]+ --digest ([0-9a-f]{64})\b/.exec(text)?.[1] ?? null;
  if (backend === "systemd") {
    try { return find(fs.readFileSync(path.join(unitDir(deps), `${UNIT(id)}.service`), "utf8").split("\n").find((l) => l.startsWith("ExecStart=")) ?? ""); } catch { return null; }
  }
  return find(readCrontab(deps)?.find((l) => l.endsWith(TAG(id))) ?? "");
}

/**
 * The spec a job may run: it must exist, have acceptable caps, and hash to the digest pinned at add
 * (`pinned`, from the unit's command line, or else read from the installed unit or crontab line).
 */
export function trustedSpec(deps: ScheduleDeps, id: string, pinned?: string): { ok: true; spec: ScheduleSpec } | { ok: false; error: string } {
  const spec = readSpec(deps, id);
  if (!spec) return { ok: false, error: `no schedule ${id}` };
  const want = pinned ?? installedDigest(deps, id, spec.backend);
  if (want === null || !DIGEST.test(want)) return { ok: false, error: `schedule ${id} has no digest in its ${spec.backend === "systemd" ? "unit file" : "crontab line"}; remove it and add it again` };
  if (specDigest(spec) !== want) return { ok: false, error: `schedule ${id} was changed since it was added (its spec no longer matches the digest pinned at add); it does not run: remove it and add it again` };
  if (spec.kind === "exec") {
    const caps = capsProblem(spec.limits);
    if (caps) return { ok: false, error: `schedule ${id}: ${caps}; remove it and add it again` };
    if (!spec.piBin || !path.isAbsolute(spec.piBin)) return { ok: false, error: `schedule ${id} has no pi path; remove it and add it again` };
  }
  return { ok: true, spec };
}

/** The backend of a stored spec, for remove: schemaVersion 1 predates the pinned node/luna paths. */
function storedBackend(deps: ScheduleDeps, id: string): Backend | null {
  if (!ID.test(id)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(specFile(deps, id), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if ((r.schemaVersion !== 1 && r.schemaVersion !== 2) || r.id !== id || (r.backend !== "systemd" && r.backend !== "cron")) return null;
    return r.backend;
  } catch {
    return null;
  }
}

/** Stop and delete the timer or crontab line, then the spec. */
export function removeSchedule(deps: ScheduleDeps, id: string): { ok: boolean; message: string } {
  const backend = storedBackend(deps, id);
  if (!backend) return { ok: false, message: `no schedule ${id}` };
  if (backend === "systemd") {
    deps.run("systemctl", ["--user", "disable", "--now", `${UNIT(id)}.timer`]);
    for (const ext of ["timer", "service"]) fs.rmSync(path.join(unitDir(deps), `${UNIT(id)}.${ext}`), { force: true });
    deps.run("systemctl", ["--user", "daemon-reload"]);
  } else {
    const current = readCrontab(deps);
    if (current === null) return { ok: false, message: "crontab -l failed; nothing was removed" };
    const r = deps.run("crontab", ["-"], `${current.filter((l) => !l.endsWith(TAG(id))).join("\n")}\n`);
    if (r.status !== 0) return { ok: false, message: `crontab - failed: ${r.stderr.trim().slice(0, 300)}; nothing was removed` };
  }
  fs.rmSync(specFile(deps, id), { force: true });
  return { ok: true, message: `removed schedule ${id}` };
}

/**
 * Hold the run lock of a schedule until `release` (or until this process exits, when the kernel drops
 * it): a listening socket file in the operator-only state directory, mode 0600. The kernel releases
 * the listener when the process exits, so a crashed or killed run never leaves a live lock; a socket
 * file nothing answers on is taken over. A file, not the abstract namespace, keeps another local user
 * from binding or connecting to the lock (DE-118). Null when a live run holds it.
 */
export async function takeRunLock(deps: ScheduleDeps, id: string): Promise<(() => void) | null> {
  const dir = scheduleDir(deps);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const address = path.join(dir, `${id}.lock.sock`);
  const listen = (): Promise<net.Server | "busy"> => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolve("busy"); else reject(error); });
    server.listen(address, () => resolve(server));
  });
  const alive = (): Promise<boolean> => new Promise((resolve) => {
    const s = net.connect(address);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await listen();
    if (got !== "busy") {
      fs.chmodSync(address, 0o600);
      got.unref();
      return () => { got.close(); fs.rmSync(address, { force: true }); };
    }
    if (await alive()) return null;
    fs.rmSync(address, { force: true });
  }
  return null;
}

/** The command line a job runs for a spec: luna exec with the caps, then the prompt after --. */
export function jobArgv(spec: ScheduleSpec): { kind: "exec"; argv: string[] } | { kind: "autonomy"; argv: string[] } {
  return spec.kind === "exec" ? { kind: "exec", argv: [...(spec.limits ?? []), "--", spec.prompt ?? ""] } : { kind: "autonomy", argv: ["up", "--config", spec.config ?? "", "--json"] };
}

export function formatList(specs: readonly ScheduleSpec[]): string {
  if (specs.length === 0) return "No schedules.";
  return specs.map((s) => `${s.id}  ${s.when}  ${s.backend}  ${s.kind === "exec" ? `exec "${(s.prompt ?? "").slice(0, 60)}"` : `autonomy ${s.config ?? ""}`}  (${s.cwd})`).join("\n");
}
