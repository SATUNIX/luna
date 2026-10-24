#!/usr/bin/env node
// The previous entry point of the autonomy kit, kept so existing scripts keep working.
//
// It is now a thin mapping onto the operator CLI (cli.ts). The detached supervisor process
// that `start --detach` launches is `cli.ts supervise --run <id>`, which this entry also accepts:
//
//   supervisor.ts start    --config run.json   ->  cli.ts start --config run.json
//   supervisor.ts resume   --run <id>          ->  cli.ts resume --run <id>
//   supervisor.ts status   --run <id>          ->  cli.ts status --run <id>
//   supervisor.ts stop     --run <id>          ->  cli.ts pause --run <id>      (park; `resume` continues)
//   supervisor.ts boundary --config run.json   ->  cli.ts boundary --config run.json --probe
//
// A v0 config file (the old shape: no schemaVersion, cycles/gitRemote/promotion at the top level)
// is mapped onto the self-improve template with a deprecation warning, and now needs an explicit
// gitRemote and promotion (the old defaults are gone). Anything else is passed straight to cli.ts.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CliDeps, main } from "./cli.ts";
import { runPaths as runPathsIn, stateHome } from "./lib/paths.ts";

/** The run directory layout for a run id under the current state home (the shape lib/paths.ts defines). */
export function runPaths(run: string): ReturnType<typeof runPathsIn> { return runPathsIn(run, stateHome()); }

/** A legacy argument list mapped onto cli.ts, with the deprecation notes to print. */
export interface LegacyMapping { argv: string[]; notes: string[] }

/** The dependency overrides (tests): legacyMain writes its notes to `stderr`; the whole object is passed on to cli.ts main(). */
export type LegacyOverrides = Partial<CliDeps>;

/** Map a legacy argument list onto cli.ts. */
export function mapLegacy(argv: string[]): LegacyMapping {
  const [cmd, ...rest] = argv;
  const notes: string[] = [];
  if (cmd === "stop") {
    notes.push("`stop` is now `pause`: the worker is stopped and the run is parked; `resume` continues it and `cancel` ends it");
    return { argv: ["pause", ...rest], notes };
  }
  if (cmd === "boundary" && !rest.includes("--probe") && !rest.includes("--run")) {
    notes.push("`boundary --config` alone now prints the boundary without starting containers; `supervisor.ts boundary` keeps its old meaning by adding --probe");
    return { argv: ["boundary", ...rest, "--probe"], notes };
  }
  if (cmd === "start" || cmd === "resume" || cmd === "status" || cmd === "boundary") notes.push(`supervisor.ts is the legacy entry point; use \`pi-autonomy ${cmd}\` (packages/autonomy/cli.ts)`);
  return { argv, notes };
}

/** Run a legacy invocation; returns the exit code. */
export async function legacyMain(argv: string[], overrides: LegacyOverrides = {}): Promise<number> {
  const { argv: mapped, notes } = mapLegacy(argv);
  const stderr = overrides.stderr ?? process.stderr;
  for (const n of notes) stderr.write(`[pi-autonomy] note: ${n}\n`);
  return main(mapped, overrides);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void legacyMain(process.argv.slice(2)).then((code) => process.exit(code));
}
