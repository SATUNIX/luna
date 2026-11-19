/**
 * Scheduled Luna runs (`luna schedule`, `/schedule`): a spec per schedule in the state home, and a
 * systemd user timer (or, without systemd, a crontab line) that runs the job at the
 * chosen times (`luna schedule run-now <id>`). The timer or crontab line never carries the prompt: the job reads the spec, so
 * nothing the operator typed is quoted into a unit file or a shell line.
 *
 * Each job is one `luna exec` (headless: attended-only actions are refused, docs/headless.md) or
 * one `pi-autonomy up --config <file>` (which starts only an authorised contract). Creating a
 * schedule is operator-confirmed: the CLI asks on a terminal or takes `--yes`, and `/schedule` asks
 * through pi's confirm dialog; nothing here is a model tool.
 *
 * Every call to `systemctl` or `crontab` goes through `deps.run`, so tests never touch the real
 * ones. Pinned by tests/schedule-smoke.ts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Backend = "systemd" | "cron";
export type ScheduleKind = "exec" | "autonomy";

export interface ScheduleSpec {
  schemaVersion: 1;
  id: string;
  /** What the operator typed: hourly, daily HH:MM, weekly <day> HH:MM, every Nm, every Nh. */
  when: string;
  kind: ScheduleKind;
  /** exec: the prompt. */
  prompt?: string;
  /** exec: extra `luna exec` limits, e.g. ["--max-turns", "20"]. */
  limits?: string[];
  /** autonomy: the run config. */
  config?: string;
  cwd: string;
  backend: Backend;
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
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
/** A path written into a unit file or crontab line: quoted there, so only these characters are allowed. */
const SAFE_PATH = /^\/[A-Za-z0-9_./@+ -]*$/;
const TAG = (id: string): string => `# luna-schedule:${id}`;
const UNIT = (id: string): string => `luna-schedule-${id}`;

/** systemd OnCalendar and cron fields for a `when`, or the reason it is not understood. */
export function parseWhen(when: string): { calendar: string; cron: string } | { error: string } {
  const w = when.trim().toLowerCase().replace(/\s+/g, " ");
  const hhmm = (h: string, m: string): [number, number] | null => {
    const H = Number(h), M = Number(m);
    return H <= 23 && M <= 59 ? [H, M] : null;
  };
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (w === "hourly") return { calendar: "hourly", cron: "0 * * * *" };
  let m = /^daily ([01]?\d|2[0-3]):([0-5]\d)$/.exec(w);
  if (m) {
    const t = hhmm(m[1] ?? "", m[2] ?? "");
    if (t) return { calendar: `*-*-* ${pad(t[0])}:${pad(t[1])}:00`, cron: `${t[1]} ${t[0]} * * *` };
  }
  m = /^weekly (mon|tue|wed|thu|fri|sat|sun) ([01]?\d|2[0-3]):([0-5]\d)$/.exec(w);
  if (m) {
    const t = hhmm(m[2] ?? "", m[3] ?? "");
    const day = DAYS.indexOf((m[1] ?? "") as (typeof DAYS)[number]);
    if (t && day >= 0) return { calendar: `${(m[1] ?? "").replace(/^./, (c) => c.toUpperCase())} *-*-* ${pad(t[0])}:${pad(t[1])}:00`, cron: `${t[1]} ${t[0]} * * ${(day + 1) % 7}` };
  }
  m = /^every ([1-9]\d?)([mh])$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "m" && n >= 5 && n <= 59) return { calendar: `*:0/${n}`, cron: `*/${n} * * * *` };
    if (m[2] === "h" && n <= 23) return { calendar: `0/${n}:00`, cron: `0 */${n} * * *` };
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

export function readSpec(deps: ScheduleDeps, id: string): ScheduleSpec | null {
  if (!ID.test(id)) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(specFile(deps, id), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (r.schemaVersion !== 1 || r.id !== id || typeof r.when !== "string" || (r.kind !== "exec" && r.kind !== "autonomy") || typeof r.cwd !== "string" || (r.backend !== "systemd" && r.backend !== "cron")) return null;
    const spec: ScheduleSpec = { schemaVersion: 1, id, when: r.when, kind: r.kind, cwd: r.cwd, backend: r.backend, createdAt: typeof r.createdAt === "string" ? r.createdAt : "" };
    if (typeof r.prompt === "string") spec.prompt = r.prompt;
    if (Array.isArray(r.limits) && r.limits.every((x) => typeof x === "string")) spec.limits = r.limits;
    if (typeof r.config === "string") spec.config = r.config;
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

export interface AddRequest { id: string; when: string; kind: ScheduleKind; prompt?: string; limits?: string[]; config?: string; cwd: string; backend?: Backend }

/** What `add` would write, for the confirmation question. */
export function describeAdd(req: AddRequest): string {
  const what = req.kind === "exec" ? `luna exec ${(req.limits ?? []).join(" ")}${req.limits?.length ? " " : ""}"${(req.prompt ?? "").slice(0, 120)}"` : `pi-autonomy up --config ${req.config ?? ""}`;
  return `schedule ${req.id}: ${req.when}, in ${req.cwd}, runs ${what}`;
}

/** Validate a request; the problem, or null. */
export function checkAdd(deps: ScheduleDeps, req: AddRequest): string | null {
  if (!ID.test(req.id)) return `"${req.id}" is not a schedule name: lowercase letters, digits and -, at most 40`;
  if (readSpec(deps, req.id)) return `schedule ${req.id} already exists; remove it first`;
  const when = parseWhen(req.when);
  if ("error" in when) return when.error;
  for (const [label, p] of [["directory", req.cwd], ["node", deps.nodeBin], ["luna", deps.lunaBin]] as const) {
    if (!SAFE_PATH.test(p)) return `the ${label} path ${p} has characters a unit file or crontab line cannot carry safely (allowed: letters, digits, space and _./@+-)`;
  }
  try { if (!fs.statSync(req.cwd).isDirectory()) return `${req.cwd} is not a directory`; } catch { return `${req.cwd} does not exist`; }
  if (req.kind === "exec" && !(req.prompt ?? "").trim()) return "an exec schedule needs a prompt";
  if (req.kind === "autonomy") {
    if (!req.config) return "an autonomy schedule needs --config <run.json>";
    if (!path.isAbsolute(req.config) || !fs.existsSync(req.config)) return `${req.config} is not an existing absolute path`;
  }
  return null;
}

const quoted = (p: string): string => `"${p}"`;

/**
 * Replace `file` whole: a temporary file created exclusively (a planted name is refused, not
 * followed) and renamed over it, as profiles.ts and settings.ts write the operator's own files.
 * These paths are under HOME and XDG directories, not in a workspace.
 */
function writeWhole(file: string, text: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Write the spec and install the timer or crontab line. The operator has already confirmed. */
export function addSchedule(deps: ScheduleDeps, req: AddRequest): { ok: true; spec: ScheduleSpec } | { ok: false; error: string } {
  const problem = checkAdd(deps, req);
  if (problem) return { ok: false, error: problem };
  const backend = req.backend ?? detectBackend(deps);
  if (!backend) return { ok: false, error: "neither systemd user timers (systemctl --user) nor crontab is available" };
  const when = parseWhen(req.when);
  if ("error" in when) return { ok: false, error: when.error };
  const spec: ScheduleSpec = { schemaVersion: 1, id: req.id, when: req.when, kind: req.kind, cwd: req.cwd, backend, createdAt: deps.now().toISOString() };
  if (req.kind === "exec") { spec.prompt = req.prompt ?? ""; if (req.limits?.length) spec.limits = req.limits; }
  else spec.config = req.config ?? "";
  writeWhole(specFile(deps, req.id), `${JSON.stringify(spec, null, 2)}\n`, 0o600);
  const job = `${quoted(deps.nodeBin)} ${quoted(deps.lunaBin)} schedule run-now ${req.id}`;
  if (backend === "systemd") {
    const dir = unitDir(deps);
    writeWhole(path.join(dir, `${UNIT(req.id)}.service`), `[Unit]\nDescription=Luna schedule ${req.id}\n\n[Service]\nType=oneshot\nWorkingDirectory=${req.cwd}\nExecStart=${job}\n`, 0o644);
    writeWhole(path.join(dir, `${UNIT(req.id)}.timer`), `[Unit]\nDescription=Luna schedule ${req.id} (${req.when})\n\n[Timer]\nOnCalendar=${when.calendar}\nPersistent=false\n\n[Install]\nWantedBy=timers.target\n`, 0o644);
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
  return { ok: true, spec };
}

function readCrontab(deps: ScheduleDeps): string[] | null {
  const r = deps.run("crontab", ["-l"]);
  if (r.status === 0) return r.stdout.split("\n").filter((l) => l.length > 0);
  if (r.status === 1 && /no crontab/i.test(r.stderr)) return [];
  return null;
}

/** Stop and delete the timer or crontab line, then the spec. */
export function removeSchedule(deps: ScheduleDeps, id: string): { ok: boolean; message: string } {
  const spec = readSpec(deps, id);
  if (!spec) return { ok: false, message: `no schedule ${id}` };
  if (spec.backend === "systemd") {
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

/** The command line a job runs for a spec (`luna schedule run-now <id>`, which the timer runs too). */
export function jobArgv(spec: ScheduleSpec): { kind: "exec"; argv: string[] } | { kind: "autonomy"; argv: string[] } {
  return spec.kind === "exec" ? { kind: "exec", argv: [...(spec.limits ?? []), spec.prompt ?? ""] } : { kind: "autonomy", argv: ["up", "--config", spec.config ?? "", "--json"] };
}

export function formatList(specs: readonly ScheduleSpec[]): string {
  if (specs.length === 0) return "No schedules.";
  return specs.map((s) => `${s.id}  ${s.when}  ${s.backend}  ${s.kind === "exec" ? `exec "${(s.prompt ?? "").slice(0, 60)}"` : `autonomy ${s.config ?? ""}`}  (${s.cwd})`).join("\n");
}
