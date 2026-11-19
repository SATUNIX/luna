/**
 * Run by tests/luna-cli-smoke.ts (imported at its end). `luna schedule` and `/schedule` (V5-14):
 * packages/core/lib/schedule.ts, schedule-cli.ts and packages/extensions/src/schedule.
 *
 * Never calls the real systemctl or crontab: the library takes an injected runner, and the CLI run
 * as a subprocess gets a PATH holding only a fake `systemctl` and `crontab` that log their
 * arguments. HOME, XDG_STATE_HOME and XDG_CONFIG_HOME are temporary.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, loadExtension, setEnv } from "../packages/core/eval/harness.ts";
import { addSchedule, checkAdd, listSpecs, parseWhen, readSpec, removeSchedule, scheduleDir, type RunResult, type ScheduleDeps } from "../packages/core/lib/schedule.ts";
import { runScheduleCli, type ScheduleIO } from "../packages/core/lib/schedule-cli.ts";

const ok = (m: string): void => console.log(`  OK: ${m}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-schedule-"));
const LUNA = path.resolve("packages/core/luna.ts");

function world(name: string, answer: (cmd: string, args: readonly string[]) => RunResult) {
  const home = path.join(tmp, name);
  const work = path.join(home, "work dir");
  fs.mkdirSync(work, { recursive: true });
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const deps: ScheduleDeps = {
    env: { HOME: home, XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config") },
    run: (cmd, args, input) => { calls.push({ cmd, args: [...args], ...(input === undefined ? {} : { input }) }); return answer(cmd, args); },
    now: () => new Date("2026-11-19T00:00:00Z"),
    nodeBin: "/usr/bin/node",
    lunaBin: "/opt/luna/packages/core/luna.ts",
  };
  return { home, work, calls, deps, units: path.join(home, "config", "systemd", "user") };
}
const okRun: RunResult = { status: 0, stdout: "", stderr: "" };

try {
  // 1. The schedule language.
  assert.deepEqual(parseWhen("hourly"), { calendar: "hourly", cron: "0 * * * *" });
  assert.deepEqual(parseWhen("daily 2:05"), { calendar: "*-*-* 02:05:00", cron: "5 2 * * *" });
  assert.deepEqual(parseWhen("Weekly SUN 23:59"), { calendar: "Sun *-*-* 23:59:00", cron: "59 23 * * 0" });
  assert.deepEqual(parseWhen("weekly mon 09:30"), { calendar: "Mon *-*-* 09:30:00", cron: "30 9 * * 1" });
  assert.deepEqual(parseWhen("every 15m"), { calendar: "*:0/15", cron: "*/15 * * * *" });
  assert.deepEqual(parseWhen("every 6h"), { calendar: "0/6:00", cron: "0 */6 * * *" });
  for (const bad of ["daily 24:00", "every 1m", "every 24h", "* * * * *", "daily 9:5", "weekly funday 10:00", "now; rm -rf /"]) assert.ok("error" in parseWhen(bad), bad);
  ok("hourly, daily, weekly and every N parse to systemd and cron times; anything else is refused");

  // 2. systemd: spec and unit files written, timer enabled, nothing the operator typed in a unit file.
  {
    const w = world("systemd", () => okRun);
    const prompt = `Summarise the TODOs; $(touch /tmp/pwned) "quoted" %h`;
    const r = addSchedule(w.deps, { id: "nightly", when: "daily 02:00", kind: "exec", prompt, limits: ["--max-turns", "20"], cwd: w.work });
    assert.ok(r.ok, JSON.stringify(r));
    const spec = readSpec(w.deps, "nightly");
    assert.equal(spec?.prompt, prompt);
    assert.equal(spec?.backend, "systemd");
    assert.equal(fs.statSync(path.join(scheduleDir(w.deps), "nightly.json")).mode & 0o777, 0o600);
    const service = fs.readFileSync(path.join(w.units, "luna-schedule-nightly.service"), "utf8");
    const timer = fs.readFileSync(path.join(w.units, "luna-schedule-nightly.timer"), "utf8");
    assert.match(service, /^ExecStart="\/usr\/bin\/node" "\/opt\/luna\/packages\/core\/luna.ts" schedule run-now nightly$/m);
    assert.match(service, new RegExp(`^WorkingDirectory=${w.work.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
    assert.match(timer, /^OnCalendar=\*-\*-\* 02:00:00$/m);
    assert.ok(!service.includes("Summarise") && !timer.includes("Summarise"), "the prompt stays in the spec");
    assert.deepEqual(w.calls.map((c) => [c.cmd, ...c.args].join(" ")), ["systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable --now luna-schedule-nightly.timer"]);
    assert.match(checkAdd(w.deps, { id: "nightly", when: "hourly", kind: "exec", prompt: "x", cwd: w.work }) ?? "", /already exists/);
    w.calls.length = 0;
    assert.equal(removeSchedule(w.deps, "nightly").ok, true);
    assert.deepEqual(w.calls.map((c) => [c.cmd, ...c.args].join(" ")), ["systemctl --user disable --now luna-schedule-nightly.timer", "systemctl --user daemon-reload"]);
    assert.ok(!fs.existsSync(path.join(w.units, "luna-schedule-nightly.timer")) && !fs.existsSync(path.join(w.units, "luna-schedule-nightly.service")) && readSpec(w.deps, "nightly") === null);
    assert.equal(removeSchedule(w.deps, "nightly").ok, false);
    ok("systemd: spec 0600, service and timer written, timer enabled; the prompt never reaches a unit file; remove undoes it all");
  }

  // 3. crontab fallback: one tagged line, the operator's other lines kept.
  {
    let table = "MAILTO=me\n0 5 * * * /usr/bin/backup\n";
    const w = world("cron", (cmd, args) => {
      if (cmd === "systemctl") return { status: 1, stdout: "", stderr: "Failed to connect to bus" };
      if (args[0] === "-l") return { status: 0, stdout: table, stderr: "" };
      return okRun;
    });
    const real = w.deps.run;
    w.deps.run = (cmd, args, input) => { const r = real(cmd, args, input); if (cmd === "crontab" && args[0] === "-" && input !== undefined) table = input; return r; };
    assert.ok(addSchedule(w.deps, { id: "tidy", when: "every 30m", kind: "exec", prompt: "tidy up", cwd: w.work }).ok);
    const lines = table.trim().split("\n");
    assert.deepEqual(lines.slice(0, 2), ["MAILTO=me", "0 5 * * * /usr/bin/backup"], "existing lines are kept");
    assert.match(lines[2] ?? "", /^\*\/30 \* \* \* \* cd ".*work dir" && "\/usr\/bin\/node" "\/opt\/luna\/packages\/core\/luna.ts" schedule run-now tidy >> ".*tidy\.log" 2>&1 # luna-schedule:tidy$/);
    assert.ok(!table.includes("tidy up"), "the prompt stays in the spec");
    assert.equal(readSpec(w.deps, "tidy")?.backend, "cron");
    assert.ok(removeSchedule(w.deps, "tidy").ok);
    assert.equal(table, "MAILTO=me\n0 5 * * * /usr/bin/backup\n", "remove drops only the tagged line");
    const none = world("none", () => ({ status: 127, stdout: "", stderr: "not found" }));
    const r = addSchedule(none.deps, { id: "x", when: "hourly", kind: "exec", prompt: "p", cwd: none.work });
    assert.ok(!r.ok && /neither systemd user timers/.test(r.error));
    ok("crontab: one tagged line beside the operator's own, removed alone; no scheduler at all is reported");
  }

  // 4. Refusals before anything is written.
  {
    const w = world("refuse", () => okRun);
    const base = { id: "a", when: "hourly", kind: "exec" as const, prompt: "p", cwd: w.work };
    for (const [req, why] of [
      [{ ...base, id: "Bad Name" }, /not a schedule name/],
      [{ ...base, when: "sometimes" }, /not a schedule/],
      [{ ...base, prompt: " " }, /needs a prompt/],
      [{ ...base, cwd: path.join(tmp, "missing") }, /does not exist/],
      [{ ...base, cwd: `${w.work}/a"b` }, /cannot carry safely/],
      [{ id: "a", when: "hourly", kind: "autonomy" as const, config: "relative.json", cwd: w.work }, /not an existing absolute path/],
    ] as const) assert.match(checkAdd(w.deps, req) ?? "", why, JSON.stringify(req));
    assert.equal(w.calls.length, 0);
    assert.deepEqual(listSpecs(w.deps), []);
    ok("bad names, times, prompts, directories and paths are refused before anything is written");
  }

  // 5. The CLI: add is operator-confirmed; run-now runs the stored job.
  {
    const w = world("cli", () => okRun);
    const out: string[] = [];
    const ran: Array<{ how: string; argv: string[]; cwd: string }> = [];
    const io = (interactive: boolean, answer = ""): ScheduleIO => ({
      stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => out.push(t) }, interactive,
      ask: () => Promise.resolve(answer),
      exec: (argv, cwd) => { ran.push({ how: "exec", argv, cwd }); return Promise.resolve(0); },
      autonomy: (argv, cwd) => { ran.push({ how: "autonomy", argv, cwd }); return 0; },
    });
    const add = ["add", "daily-review", "--at", "daily 09:00", "--prompt", "review yesterday", "--cwd", w.work, "--max-turns", "10"];
    assert.equal(await runScheduleCli(add, w.deps, io(false)), 2);
    assert.match(out.join(""), /needs the operator: run it on a terminal to confirm, or pass --yes/);
    assert.equal(w.calls.length, 0, "a refused add touches no scheduler");
    assert.equal(await runScheduleCli(add, w.deps, io(true, "n")), 1);
    assert.deepEqual(listSpecs(w.deps), [], "a declined add writes nothing");
    assert.equal(await runScheduleCli(add, w.deps, io(true, "y")), 0);
    assert.equal(listSpecs(w.deps).length, 1);
    assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 0);
    assert.deepEqual(ran, [{ how: "exec", argv: ["--max-turns", "10", "review yesterday"], cwd: w.work }], "run-now runs luna exec with the stored limits and prompt in the stored directory");
    const config = path.join(w.work, "run.json");
    fs.writeFileSync(config, "{}");
    assert.equal(await runScheduleCli(["add", "loop", "--at", "weekly fri 18:00", "--config", config, "--cwd", w.work, "--yes"], w.deps, io(false)), 0, "--yes is the operator's confirmation");
    assert.equal(await runScheduleCli(["run-now", "loop"], w.deps, io(false)), 0);
    assert.deepEqual(ran.at(-1), { how: "autonomy", argv: ["up", "--config", config, "--json"], cwd: w.work });
    for (const bad of [["add", "x", "--at", "hourly"], ["add", "x", "--at", "hourly", "--prompt", "p", "--config", config], ["add", "x", "--at", "hourly", "--config", config, "--max-turns", "3", "--yes"], ["add", "x", "--bogus"], ["run-now", "missing"], ["frob"]]) {
      assert.notEqual(await runScheduleCli(bad, w.deps, io(false)), 0, bad.join(" "));
    }
    out.length = 0;
    assert.equal(await runScheduleCli(["list"], w.deps, io(false)), 0);
    assert.match(out.join(""), /daily-review {2}daily 09:00 {2}systemd {2}exec "review yesterday"/);
    ok("the CLI refuses add without a terminal or --yes, honours a declined answer, and run-now runs the stored job");
  }

  // 6. The real luna binary, with only a fake systemctl and crontab on PATH.
  if (process.platform !== "win32") {
    const home = path.join(tmp, "subprocess");
    const bin = path.join(home, "bin");
    const log = path.join(home, "calls.log");
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.mkdirSync(bin);
    for (const name of ["systemctl", "crontab"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config"), PATH: bin };
    const luna = (...args: string[]) => spawnSync(process.execPath, [LUNA, "schedule", ...args], { cwd: path.join(home, "work"), env, encoding: "utf8", timeout: 60_000 });
    const added = luna("add", "ping", "--at", "every 10m", "--prompt", "say hi", "--yes");
    assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
    assert.ok(fs.existsSync(path.join(home, "config", "systemd", "user", "luna-schedule-ping.timer")));
    assert.match(luna("list").stdout, /ping {2}every 10m {2}systemd/);
    assert.equal(luna("remove", "ping").status, 0);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable --now luna-schedule-ping.timer", "systemctl --user disable --now luna-schedule-ping.timer", "systemctl --user daemon-reload"]);
    const refused = luna("add", "ping", "--at", "hourly", "--prompt", "x");
    assert.equal(refused.status, 2, "without a terminal and without --yes, add refuses");
    ok("luna schedule add/list/remove as a process writes and removes the units through the fake systemctl only");
  }

  // 7. /schedule asks through pi before it creates anything.
  {
    const mod = await loadExtension<(pi: unknown, run: (args: readonly string[], cwd: string) => Promise<{ code: number; out: string }>) => void>("extensions/schedule/index.ts");
    const runs: string[][] = [];
    const pi = fakePi();
    mod(pi.api, (args) => { runs.push([...args]); return Promise.resolve({ code: 0, out: "fine" }); });
    const notes: string[] = [];
    const ctx = (hasUI: boolean, confirm: boolean) => ({ cwd: "/work", hasUI, ui: { notify: (m: string) => notes.push(m), confirm: () => Promise.resolve(confirm) } });
    const handler = pi.commands.get("schedule").handler;
    await handler("list", ctx(true, true));
    await handler("add nightly daily 02:00 -- Summarise the open TODOs", ctx(false, true));
    assert.match(notes.at(-1) ?? "", /needs the operator to confirm/);
    await handler("add nightly daily 02:00 -- Summarise the open TODOs", ctx(true, false));
    assert.equal(notes.at(-1), "Not created.");
    await handler("add nightly daily 02:00 -- Summarise the open TODOs", ctx(true, true));
    await handler("run-now nightly", ctx(true, true));
    await handler("add nightly", ctx(true, true));
    assert.deepEqual(runs, [["list"], ["add", "nightly", "--at", "daily 02:00", "--prompt", "Summarise the open TODOs", "--cwd", "/work", "--yes"], ["run-now", "nightly"]], "only a confirmed add reaches the CLI, and only then with --yes");
    const restore = setEnv("PI_SUBAGENT_CHILD", "1");
    const child = fakePi();
    mod(child.api, () => Promise.resolve({ code: 0, out: "" }));
    restore();
    assert.equal(child.commands.find("schedule"), undefined, "not registered in a subagent child");
    ok("/schedule add asks through pi's confirm dialog, refuses without a UI, and passes --yes only after a yes");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("schedule checks: OK");
