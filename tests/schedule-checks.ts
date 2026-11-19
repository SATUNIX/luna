/**
 * Run by tests/luna-cli-smoke.ts (imported at its end). `luna schedule` and `/schedule` (V5-14):
 * packages/core/lib/schedule.ts, schedule-cli.ts and packages/extensions/src/schedule.
 *
 * Never calls the real systemctl or crontab: the library takes an injected runner, and the CLI run
 * as a subprocess gets a PATH holding only a fake `systemctl` and `crontab` that log their
 * arguments. HOME, XDG_STATE_HOME and XDG_CONFIG_HOME are temporary.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, loadExtension, setEnv } from "../packages/core/eval/harness.ts";
import { addSchedule, CAP_MAXIMA, checkAdd, JOB_ENV, listSpecs, parseWhen, readSpec, removeSchedule, scheduleDir, specDigest, takeRunLock, type RunResult, type ScheduleDeps } from "../packages/core/lib/schedule.ts";
import { runScheduleCli, type ScheduleIO } from "../packages/core/lib/schedule-cli.ts";

const ok = (m: string): void => console.log(`  OK: ${m}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-schedule-"));
const LUNA = path.resolve("packages/core/luna.ts");

function world(name: string, answer: (cmd: string, args: readonly string[]) => RunResult) {
  const home = path.join(tmp, name);
  const work = path.join(home, "work dir");
  const bin = path.join(home, "bin");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const deps: ScheduleDeps = {
    env: { HOME: home, XDG_STATE_HOME: path.join(home, "state"), XDG_CONFIG_HOME: path.join(home, "config"), PATH: bin },
    run: (cmd, args, input) => { calls.push({ cmd, args: [...args], ...(input === undefined ? {} : { input }) }); return answer(cmd, args); },
    now: () => new Date("2026-11-19T00:00:00Z"),
    nodeBin: "/usr/bin/node",
    lunaBin: "/opt/luna/packages/core/luna.ts",
  };
  return { home, work, bin, calls, deps, units: path.join(home, "config", "systemd", "user") };
}
const okRun: RunResult = { status: 0, stdout: "", stderr: "" };

try {
  // 1. The schedule language.
  assert.deepEqual(parseWhen("hourly"), { calendar: "hourly", cron: "0 * * * *", normal: "hourly" });
  assert.deepEqual(parseWhen("daily 2:05"), { calendar: "*-*-* 02:05:00", cron: "5 2 * * *", normal: "daily 02:05" });
  assert.deepEqual(parseWhen("Weekly SUN 23:59"), { calendar: "Sun *-*-* 23:59:00", cron: "59 23 * * 0", normal: "weekly sun 23:59" });
  assert.deepEqual(parseWhen("weekly mon 09:30"), { calendar: "Mon *-*-* 09:30:00", cron: "30 9 * * 1", normal: "weekly mon 09:30" });
  assert.deepEqual(parseWhen("every 15m"), { calendar: "*:0/15", cron: "*/15 * * * *", normal: "every 15m" });
  assert.deepEqual(parseWhen("every 6h"), { calendar: "0/6:00", cron: "0 */6 * * *", normal: "every 6h" });
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
    assert.ok(r.ok);
    assert.equal(r.digest, specDigest(spec ?? r.spec), "the digest covers the spec as written");
    assert.ok(service.split("\n").includes(`ExecStart="/usr/bin/node" "/opt/luna/packages/core/luna.ts" schedule run-now nightly --digest ${r.digest}`), service);
    assert.match(service, new RegExp(`^WorkingDirectory=${w.work.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
    assert.match(timer, /^OnCalendar=\*-\*-\* 02:00:00$/m);
    assert.match(service, /^TimeoutStartSec=2100$/m, "the unit is stopped after the job's timeout (default 30m) and a margin");
    assert.match(service, /^RuntimeMaxSec=2100$/m);
    assert.deepEqual(spec?.limits, ["--max-turns", "20", "--max-cost", "2", "--timeout", "30m"], "the caps not given get their defaults");
    assert.equal(spec?.piBin, fs.realpathSync(path.join(w.bin, "pi")), "pi is resolved to an absolute path at add, never looked up at run time");
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
    assert.match(lines[2] ?? "", /^\*\/30 \* \* \* \* cd ".*work dir" && "\/usr\/bin\/node" "\/opt\/luna\/packages\/core\/luna.ts" schedule run-now tidy --digest [0-9a-f]{64} >> ".*tidy\.log" 2>&1 # luna-schedule:tidy$/);
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
      [{ ...base, cwd: `${w.work}/a%hb` }, /cannot carry safely/],
      [{ ...base, cwd: `${w.work}/a\nExecStart=/bin/x` }, /cannot carry safely/],
      [{ ...base, limits: ["--max-turns", "0"] }, /--max-turns needs a whole number/],
      [{ ...base, limits: ["--max-turns", String(CAP_MAXIMA.turns + 1)] }, /--max-turns is at most 500/],
      [{ ...base, limits: ["--max-cost", "1e9"] }, /--max-cost is at most 50/],
      [{ ...base, limits: ["--timeout", "9999h"] }, /--timeout is at most 12h/],
      [{ id: "a", when: "hourly", kind: "autonomy" as const, config: "relative.json", cwd: w.work }, /not an existing absolute path/],
    ] as const) assert.match(checkAdd(w.deps, req) ?? "", why, JSON.stringify(req));
    for (const state of ["/tmp/s$(id)", "/tmp/s%h", "/tmp/s\"q", "/tmp/s\nx"]) {
      const odd: ScheduleDeps = { ...w.deps, env: { ...w.deps.env, XDG_STATE_HOME: state } };
      assert.match(checkAdd(odd, base) ?? "", /state directory [\s\S]* cannot carry safely/, `XDG_STATE_HOME=${JSON.stringify(state)}`);
    }
    assert.equal(w.calls.length, 0);
    assert.deepEqual(listSpecs(w.deps), []);
    // Letters of any script are fine (a non-ASCII HOME); %, quotes, $ and newlines are not.
    const intl = path.join(w.home, "Ünïcødé 作業");
    fs.mkdirSync(intl);
    assert.equal(checkAdd({ ...w.deps, env: { ...w.deps.env, XDG_STATE_HOME: path.join(w.home, "état") } }, { ...base, cwd: intl }), null);
    // A newline in --at is normalised away: the timer carries only the normalised expression.
    assert.ok(addSchedule(w.deps, { ...base, id: "nl", when: "daily\n02:00" }).ok);
    const timer = fs.readFileSync(path.join(w.units, "luna-schedule-nl.timer"), "utf8");
    assert.match(timer, /^Description=Luna schedule nl \(daily 02:00\)$/m);
    assert.ok(!/^02:00$/m.test(timer), "no stray unit line");
    assert.equal(readSpec(w.deps, "nl")?.when, "daily 02:00");
    // A link planted where the spec goes is refused, and nothing is installed.
    fs.mkdirSync(scheduleDir(w.deps), { recursive: true });
    fs.symlinkSync(path.join(w.home, "elsewhere.json"), path.join(scheduleDir(w.deps), "planted.json"));
    w.calls.length = 0;
    const planted = addSchedule(w.deps, { ...base, id: "planted" });
    assert.ok(!planted.ok && /could not create the spec/.test(planted.error), JSON.stringify(planted));
    assert.ok(!fs.existsSync(path.join(w.home, "elsewhere.json")), "the link is not followed");
    assert.ok(!w.calls.some((c) => c.args.includes("enable")), "no timer is enabled");
    ok("bad names, times, prompts, caps, directories and state paths (newline, %, quote, $()) are refused; --at is normalised; a planted link is refused");
  }

  // 5. The CLI: add is operator-confirmed; run-now runs the stored job.
  {
    const w = world("cli", () => okRun);
    const out: string[] = [];
    const ran: Array<{ how: string; argv: string[]; cwd: string }> = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const bins: string[] = [];
    const io = (interactive: boolean, answer = ""): ScheduleIO => ({
      stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => out.push(t) }, interactive,
      ask: () => Promise.resolve(answer),
      exec: (argv, cwd, env, piBin) => { ran.push({ how: "exec", argv, cwd }); envs.push(env); bins.push(piBin); return Promise.resolve(0); },
      autonomy: (argv, cwd, env, node, cli) => { ran.push({ how: "autonomy", argv, cwd }); envs.push(env); bins.push(`${node} ${cli}`); return 0; },
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
    assert.deepEqual(ran, [{ how: "exec", argv: ["--max-turns", "10", "--max-cost", "2", "--timeout", "30m", "--", "review yesterday"], cwd: w.work }], "run-now runs luna exec with the caps, then the prompt after --, in the stored directory");
    assert.equal(envs[0]?.[JOB_ENV], "daily-review", "the job runs marked as a scheduled job");
    assert.equal(bins[0], fs.realpathSync(path.join(w.bin, "pi")), "pi is started from the absolute path pinned at add");
    assert.equal(envs[0]?.PATH, w.deps.env.PATH, "the job's PATH is the scheduler's own, not one from the spec");
    const config = path.join(w.work, "run.json");
    fs.writeFileSync(config, "{}");
    assert.equal(await runScheduleCli(["add", "loop", "--at", "weekly fri 18:00", "--config", config, "--cwd", w.work, "--yes"], w.deps, io(false)), 0, "--yes is the operator's confirmation");
    assert.equal(await runScheduleCli(["run-now", "loop"], w.deps, io(false)), 0);
    assert.deepEqual(ran.at(-1), { how: "autonomy", argv: ["up", "--config", config, "--json"], cwd: w.work });
    assert.equal(bins.at(-1), "/usr/bin/node /opt/luna/packages/autonomy/cli.ts", "pi-autonomy is started from the node and luna paths pinned at add");
    for (const bad of [["add", "x", "--at", "hourly"], ["add", "x", "--at", "hourly", "--prompt", "p", "--config", config], ["add", "x", "--at", "hourly", "--config", config, "--max-turns", "3", "--yes"], ["add", "x", "--bogus"], ["run-now", "missing"], ["frob"]]) {
      assert.notEqual(await runScheduleCli(bad, w.deps, io(false)), 0, bad.join(" "));
    }
    out.length = 0;
    assert.equal(await runScheduleCli(["list"], w.deps, io(false)), 0);
    assert.match(out.join(""), /daily-review {2}daily 09:00 {2}systemd {2}exec "review yesterday"/);

    // DE-118: a job cannot schedule a job; caps are required; two runs never overlap; an option-shaped prompt is a prompt.
    const asJob: ScheduleDeps = { ...w.deps, env: { ...w.deps.env, [JOB_ENV]: "daily-review" } };
    for (const verb of [["add", "x", "--at", "hourly", "--prompt", "p", "--cwd", w.work, "--yes"], ["remove", "daily-review"], ["run-now", "daily-review"]]) {
      out.length = 0;
      assert.equal(await runScheduleCli(verb, asJob, io(false)), 2, verb.join(" "));
      assert.match(out.join(""), /a scheduled job cannot add, remove or start schedules/);
    }
    assert.equal(await runScheduleCli(["list"], asJob, io(false)), 0, "a job may list schedules");
    assert.equal(listSpecs(w.deps).length, 2, "nothing changed");
    const release = await takeRunLock(w.deps, "daily-review");
    assert.ok(release);
    out.length = 0;
    assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 75, "a run while another holds the lock is skipped");
    assert.match(out.join(""), /already running; this run is skipped/);
    release();
    // The lock is held by a socket the kernel releases: a holder killed with SIGKILL leaves nothing stale.
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(path.resolve("packages/core/lib/schedule.ts"))}); const r = await m.takeRunLock(${JSON.stringify(w.deps)}, "daily-review"); console.log(r ? "held" : "busy"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
    const said = await new Promise<string>((resolve) => holder.stdout.once("data", (d: Buffer) => resolve(d.toString().trim())));
    assert.equal(said, "held");
    assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 75, "another process holds it");
    holder.kill("SIGKILL");
    await new Promise((r) => holder.on("close", r));
    assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 0, "after the holder is killed the next run takes the lock");
    // The spec is not trusted: any change to what runs is refused at run time (DE-118 round 2).
    const specPath = path.join(scheduleDir(w.deps), "daily-review.json");
    const original = fs.readFileSync(specPath, "utf8");
    const evil = path.join(w.home, "evil");
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, "pi"), "#!/bin/sh\ntouch /tmp/pwned\n", { mode: 0o755 });
    for (const [field, value] of [["prompt", "something else"], ["piBin", path.join(evil, "pi")], ["cwd", evil], ["limits", ["--max-turns", "999999999", "--max-cost", "1000000000", "--timeout", "9999h"]], ["nodeBin", path.join(evil, "pi")], ["kind", "autonomy"]] as const) {
      const tampered = { ...(JSON.parse(original) as Record<string, unknown>), [field]: value };
      fs.writeFileSync(specPath, JSON.stringify(tampered));
      out.length = 0;
      const before = ran.length;
      assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 1, `a spec with a changed ${field} does not run`);
      assert.match(out.join(""), /was changed since it was added/);
      assert.equal(ran.length, before);
    }
    // A field outside the digest (the old pathDirs) changes nothing that runs.
    fs.writeFileSync(specPath, JSON.stringify({ ...(JSON.parse(original) as Record<string, unknown>), pathDirs: [evil] }));
    assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 0);
    assert.equal(bins.at(-1), fs.realpathSync(path.join(w.bin, "pi")), "a spec-supplied PATH is never used to find pi");
    assert.ok(!(envs.at(-1)?.PATH ?? "").includes(evil));
    fs.writeFileSync(specPath, original);
    out.length = 0;
    assert.equal(await runScheduleCli(["run-now", "daily-review", "--digest", "0".repeat(64)], w.deps, io(false)), 1, "a digest that does not match is refused");
    assert.match(out.join(""), /was changed since it was added/);
    fs.rmSync(path.join(w.units, "luna-schedule-daily-review.service"));
    out.length = 0;
    assert.equal(await runScheduleCli(["run-now", "daily-review"], w.deps, io(false)), 1, "without its unit there is no pinned digest");
    assert.match(out.join(""), /has no digest in its unit file/);
    assert.equal(await runScheduleCli(["add", "opt", "--at", "hourly", "--prompt", "--help", "--cwd", w.work, "--yes"], w.deps, io(false)), 0, "a prompt that looks like an option is accepted");
    await runScheduleCli(["run-now", "opt"], w.deps, io(false));
    assert.deepEqual(ran.at(-1)?.argv.slice(-2), ["--", "--help"], "and passed after --, so luna exec reads it as the prompt");
    const noPi: ScheduleDeps = { ...w.deps, env: { ...w.deps.env, PATH: "/nonexistent" } };
    assert.match(checkAdd(noPi, { id: "np", when: "hourly", kind: "exec", prompt: "p", cwd: w.work }) ?? "", /pi is not on PATH/);
    ok("the CLI refuses add without a terminal or --yes; run-now runs only a spec matching the digest pinned at add, from pinned paths, one at a time (kernel-released lock)");
  }

  // 6. The real luna binary, with only a fake systemctl and crontab on PATH.
  if (process.platform !== "win32") {
    const home = path.join(tmp, "subprocess");
    const bin = path.join(home, "bin");
    const log = path.join(home, "calls.log");
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.mkdirSync(bin);
    for (const name of ["systemctl", "crontab"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
    const asJob = spawnSync(process.execPath, [LUNA, "schedule", "add", "inner", "--at", "hourly", "--prompt", "x", "--yes"], { cwd: path.join(home, "work"), env: { ...env, [JOB_ENV]: "ping" }, encoding: "utf8" });
    assert.equal(asJob.status, 2, "a process marked as a scheduled job cannot add a schedule");
    assert.match(asJob.stderr, /a scheduled job cannot add, remove or start schedules/);
    ok("luna schedule add/list/remove as a process writes and removes the units through the fake systemctl only; a job cannot add one");
  }

  // 7. /schedule asks through pi before it creates anything.
  {
    const mod = await loadExtension<(pi: unknown, run: (args: readonly string[], cwd: string) => Promise<{ code: number; out: string }>, start?: (args: readonly string[], cwd: string) => { ok: boolean; out: string }) => void>("extensions/schedule/index.ts");
    const runs: string[][] = [];
    const started: string[][] = [];
    const pi = fakePi();
    mod(pi.api, (args) => { runs.push([...args]); return Promise.resolve({ code: 0, out: "fine" }); }, (args) => { started.push([...args]); return { ok: true, out: "started" }; });
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
    assert.deepEqual(runs, [["list"], ["add", "nightly", "--at", "daily 02:00", "--prompt", "Summarise the open TODOs", "--cwd", "/work", "--yes"]], "only a confirmed add reaches the CLI, and only then with --yes");
    assert.deepEqual(started, [["run-now", "nightly"]], "run-now is started detached, so no command timeout kills the job");
    const inJob = setEnv(JOB_ENV, "nightly");
    runs.length = 0;
    await handler("add nightly daily 02:00 -- again", ctx(true, true));
    assert.match(notes.at(-1) ?? "", /scheduled job: it cannot add, remove or start schedules/);
    await handler("list", ctx(true, true));
    inJob();
    assert.deepEqual(runs, [["list"]], "inside a scheduled job only list reaches the CLI");
    const ext = await import("../packages/extensions/src/schedule/index.ts");
    assert.equal(ext.nodeBinary("/usr/local/bin/node"), "/usr/local/bin/node");
    assert.equal(ext.nodeBinary("/opt/pi/bin/pi"), "node", "a compiled pi is not node: use node from PATH");
    const restore = setEnv("PI_SUBAGENT_CHILD", "1");
    const child = fakePi();
    mod(child.api, () => Promise.resolve({ code: 0, out: "" }), () => ({ ok: true, out: "" }));
    restore();
    assert.equal(child.commands.find("schedule"), undefined, "not registered in a subagent child");
    ok("/schedule add asks through pi's confirm dialog, refuses without a UI, and passes --yes only after a yes");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("schedule checks: OK");
