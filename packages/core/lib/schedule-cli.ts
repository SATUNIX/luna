/**
 * `luna schedule add | list | remove | run-now` (packages/core/lib/schedule.ts holds the logic).
 *
 *   luna schedule add <name> --at "<when>" (--prompt <text> | --config <run.json>) [--cwd <dir>]
 *                     [--max-turns N] [--max-cost USD] [--timeout D] [--backend systemd|cron] [--yes]
 *   luna schedule list
 *   luna schedule remove <name>
 *   luna schedule run-now <name>      run the job now (what the timer runs)
 *
 * `add` asks on a terminal, or takes `--yes`; without either it refuses. Under LUNA_SCHEDULE_JOB (a
 * scheduled job) add, remove and run-now are refused, so a job cannot schedule a job.
 * Pinned by tests/luna-cli-smoke.ts (tests/schedule-checks.ts).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runExec } from "./headless.ts";
import { addSchedule, capsProblem, checkAdd, defaultDeps, describeAdd, formatList, jobArgv, JOB_ENV, listSpecs, readSpec, removeSchedule, takeRunLock, type AddRequest, type ScheduleDeps } from "./schedule.ts";

export const SCHEDULE_USAGE = `usage: luna schedule add <name> --at "<when>" (--prompt <text> | --config <run.json>) [--cwd <dir>] [--max-turns N] [--max-cost USD] [--timeout D] [--backend systemd|cron] [--yes]
       luna schedule list
       luna schedule remove <name>
       luna schedule run-now <name>
<when>: hourly | daily HH:MM | weekly <mon..sun> HH:MM | every Nm (5-59) | every Nh (1-23)`;

export interface ScheduleIO {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** True on a terminal, where `add` may ask. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  /** Runs `luna exec` with these arguments in `cwd` with `env`; the exit code. */
  exec: (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<number>;
  /** Runs `pi-autonomy` with these arguments in `cwd` with `env`; the exit code. */
  autonomy: (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => number;
}

export function defaultIO(deps: ScheduleDeps): ScheduleIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    ask: async (question) => {
      process.stdout.write(question);
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(""); } finally { rl.close(); }
    },
    exec: async (argv, cwd, env) => { process.chdir(cwd); return runExec(argv, { env }); },
    autonomy: (argv, cwd, env) => {
      const cli = path.join(path.dirname(path.dirname(deps.lunaBin)), "autonomy", "cli.ts");
      const r = spawnSync(deps.nodeBin, [cli, ...argv], { cwd, stdio: "inherit", env });
      return r.status ?? 1;
    },
  };
}

const VALUE_FLAGS = new Set(["--at", "--prompt", "--config", "--cwd", "--max-turns", "--max-cost", "--timeout", "--backend"]);

/** Flags and the remaining words of `add`, or the problem. */
function parseFlags(args: readonly string[]): { flags: Map<string, string>; yes: boolean; words: string[] } | string {
  const flags = new Map<string, string>();
  const words: string[] = [];
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--yes") { yes = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v === undefined) return `${a} needs a value`;
      if (flags.has(a)) return `${a} given twice`;
      flags.set(a, v);
      i++;
      continue;
    }
    if (a.startsWith("--")) return `unknown option ${a}`;
    words.push(a);
  }
  return { flags, yes, words };
}

export async function runScheduleCli(argv: readonly string[], deps: ScheduleDeps = defaultDeps(), io: ScheduleIO = defaultIO(deps)): Promise<number> {
  const [verb = "", ...rest] = argv;
  const fail = (message: string, code = 2): number => { io.stderr.write(`luna schedule: ${message}\n`); return code; };
  const job = deps.env[JOB_ENV];
  if (job && (verb === "add" || verb === "remove" || verb === "run-now")) return fail(`this is scheduled job ${job}: a scheduled job cannot add, remove or start schedules`);
  switch (verb) {
    case "list":
      if (rest.length) return fail(SCHEDULE_USAGE);
      io.stdout.write(`${formatList(listSpecs(deps))}\n`);
      return 0;
    case "remove": {
      if (rest.length !== 1) return fail(SCHEDULE_USAGE);
      const r = removeSchedule(deps, rest[0] ?? "");
      (r.ok ? io.stdout : io.stderr).write(`${r.message}\n`);
      return r.ok ? 0 : 1;
    }
    case "run-now": {
      if (rest.length !== 1) return fail(SCHEDULE_USAGE);
      const spec = readSpec(deps, rest[0] ?? "");
      if (!spec) return fail(`no schedule ${rest[0] ?? ""}`, 1);
      const caps = capsProblem(spec);
      if (caps) return fail(caps, 1);
      const release = takeRunLock(deps, spec.id);
      if (!release) return fail(`schedule ${spec.id} is already running; this run is skipped`, 75);
      try {
        const env: NodeJS.ProcessEnv = { ...deps.env, [JOB_ENV]: spec.id, PATH: [...(spec.pathDirs ?? []), deps.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
        const run = jobArgv(spec);
        return run.kind === "exec" ? await io.exec(run.argv, spec.cwd, env) : io.autonomy(run.argv, spec.cwd, env);
      } finally {
        release();
      }
    }
    case "add": {
      const parsed = parseFlags(rest);
      if (typeof parsed === "string") return fail(`${parsed}\n${SCHEDULE_USAGE}`);
      const { flags, yes, words } = parsed;
      if (words.length !== 1) return fail(SCHEDULE_USAGE);
      const prompt = flags.get("--prompt");
      const config = flags.get("--config");
      if ((prompt === undefined) === (config === undefined)) return fail("give exactly one of --prompt or --config");
      const backend = flags.get("--backend");
      if (backend !== undefined && backend !== "systemd" && backend !== "cron") return fail("--backend is systemd or cron");
      const limits: string[] = [];
      for (const f of ["--max-turns", "--max-cost", "--timeout"]) {
        const v = flags.get(f);
        if (v !== undefined) limits.push(f, v);
      }
      if (config !== undefined && limits.length) return fail("--max-turns, --max-cost and --timeout apply to a --prompt schedule; an autonomy run takes its limits from its config");
      const req: AddRequest = { id: words[0] ?? "", when: flags.get("--at") ?? "", kind: prompt !== undefined ? "exec" : "autonomy", cwd: path.resolve(flags.get("--cwd") ?? process.cwd()), ...(backend ? { backend } : {}) };
      if (prompt !== undefined) { req.prompt = prompt; if (limits.length) req.limits = limits; }
      else req.config = path.resolve(config ?? "");
      const problem = checkAdd(deps, req);
      if (problem) return fail(problem);
      // Creating a schedule is the operator's decision: asked on a terminal, or --yes on the command line.
      if (!yes) {
        if (!io.interactive) return fail("creating a schedule needs the operator: run it on a terminal to confirm, or pass --yes");
        const answer = (await io.ask(`Create ${describeAdd(req)}? [y/N] `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") { io.stdout.write("Not created.\n"); return 1; }
      }
      const r = addSchedule(deps, req);
      if (!r.ok) return fail(r.error, 1);
      io.stdout.write(`created ${describeAdd(req)} (${r.spec.backend})\n`);
      return 0;
    }
    case "":
    case "help":
    case "--help":
      io.stdout.write(`${SCHEDULE_USAGE}\n`);
      return verb === "" ? 2 : 0;
    default:
      return fail(`unknown subcommand ${verb}\n${SCHEDULE_USAGE}`);
  }
}
