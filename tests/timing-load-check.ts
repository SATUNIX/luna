#!/usr/bin/env node
/**
 * timing-load-check.ts — prove the CPU-time smoke guards pass on a saturated host.
 *
 * Usage:
 *   node tests/timing-load-check.ts
 *
 * It starts one CPU burner per core, so every core is kept busy while the changed smokes run,
 * then runs each smoke five times and exits non-zero if any run fails. This reproduces the
 * "busy host" that used to turn correct code red under wall-clock bounds; with the CPU-time
 * guards in `tests/timing.ts` every run must still pass.
 *
 * This is CPU-heavy by design and is deliberately NOT part of `check:all` / the CI gate — it
 * would slow every run down to prove something the guards prove on their own. Run it directly
 * (or from the cycle's acceptance evidence) when the guards change.
 */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SMOKES = [
  "tests/firewall-gate-smoke.ts",
  "tests/redaction-corpus-smoke.ts",
  "tests/workflow-redaction-smoke.ts",
  "tests/save-smoke.ts",
  "tests/tool-firewall-smoke.ts",
  "tests/workflow-plan-smoke.ts",
  "tests/skill-routing-smoke.ts",
  "tests/compress-smoke.ts",
] as const;

const RUNS = 5;
// Burn for an hour; the finally below kills every burner as soon as the smokes finish.
const BURNER = "const end = Date.now() + 3_600_000; let x = 1; while (Date.now() < end) x = (x + Math.sqrt(x + 1)) % 1e9;";

const burners: ReturnType<typeof spawn>[] = [];
try {
  const cores = Math.max(1, os.cpus().length);
  console.log(`[timing-load-check] starting ${cores} CPU burners, then running ${SMOKES.length} smokes ${RUNS}x`);
  for (let i = 0; i < cores; i++) burners.push(spawn(process.execPath, ["-e", BURNER], { stdio: "ignore" }));

  let failed = 0;
  for (const file of SMOKES) {
    for (let run = 1; run <= RUNS; run++) {
      const result = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
      const pass = result.status === 0;
      if (!pass) failed++;
      console.log(`${pass ? "PASS" : "FAIL"} ${file} run ${run}/${RUNS}${pass ? "" : ` (status ${String(result.status)})`}`);
      if (!pass) console.error((result.stderr ?? "").trim() || "(no stderr)");
    }
  }
  if (failed > 0) {
    console.error(`[timing-load-check] ${failed} of ${SMOKES.length * RUNS} runs failed under load`);
    process.exitCode = 1;
  } else {
    console.log(`[timing-load-check] all ${SMOKES.length * RUNS} runs passed under full CPU load`);
  }
} finally {
  for (const burner of burners) burner.kill("SIGKILL");
}
