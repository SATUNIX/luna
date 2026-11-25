#!/usr/bin/env node
/**
 * The `luna` command: --bare starts pi with no Luna extensions; `exec` is a thin headless wrapper
 * (final answer on stdout, progress on stderr, --json passthrough, the shared ceiling as environment,
 * exit 13 passed through); an extension switched off in overrides.json is found before pi starts.
 * Offline: a fake `pi` on PATH records its arguments.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { array, isRecord, object, parseJsonAs, record as recordOf, string } from "../packages/core/lib/guard.ts";
import { goalCoreSelected, pendingDisables, planExec } from "../packages/core/lib/headless.ts";
import { piSpawnPlan } from "../packages/core/lib/pi-cli.ts";

isolateKitEnv();
if (process.platform === "win32") {
  console.log("skip: the fake pi is a POSIX script");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-cli-"));
try {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const record = path.join(tmp, "record.json");
  const events = [
    { type: "session", id: "x" },
    { type: "tool_execution_start", toolName: "read", args: {} },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "the answer" }] } },
  ];
  const fakePi = (stream: unknown[]) => fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env node
const fs = require("node:fs");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PI_KIT_CEILING") || k === "PI_KIT_AUTO_PROFILE"));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env }));
for (const e of ${JSON.stringify(stream)}) console.log(JSON.stringify(e));
process.exit(Number(process.env.FAKE_PI_EXIT || 0));
`, { mode: 0o755 });
  fakePi(events);
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(agent);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: agent };
  const luna = (args: string[], extra: NodeJS.ProcessEnv = {}, input?: string, cwd?: string) =>
    spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "luna.ts"), ...args], { env: { ...env, ...extra }, encoding: "utf8", ...(input !== undefined ? { input } : {}), ...(cwd !== undefined ? { cwd } : {}) });
  const Recorded = object({ args: array(string()), env: recordOf(string()) });
  const recorded = () => parseJsonAs(Recorded, fs.readFileSync(record, "utf8"));

  // --bare: pi gets the flags that drop every Luna extension, and the rest of the command line unchanged.
  const bare = luna(["--bare", "--model", "x"]);
  assert.equal(bare.status, 0);
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]) assert.ok(recorded().args.includes(flag), `--bare passes ${flag}`);
  assert.deepEqual(recorded().args.slice(-2), ["--model", "x"]);

  // A ceiling needs goal-core loaded by the install in force (lib/headless.ts goalCoreProblem): with no
  // install, or a kit entry that does not load it (a blank user profile, a remove, a hand edit), the
  // limits are refused before pi starts; an unfiltered kit entry loads everything.
  const kit = { source: ROOT, extensions: ["packages/extensions/src/tool-firewall/index.ts", "packages/extensions/src/goal-core/index.ts"] };
  const install = (entry: unknown, dir = agent) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi-kit.json"), JSON.stringify({ kitSource: ROOT, profile: "mine", scope: "global", mode: "local" }));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [entry] }));
  };
  const noInstall = luna(["exec", "--max-turns", "3", "p"]);
  assert.equal(noInstall.status, 2);
  assert.match(noInstall.stderr, /a ceiling was requested but no Luna install was found/);
  install({ ...kit, extensions: ["packages/extensions/src/tool-firewall/index.ts"] });
  const noGoalCore = luna(["exec", "--max-cost", "1", "p"]);
  assert.equal(noGoalCore.status, 2, "a profile without goal-core voids no limit silently");
  assert.match(noGoalCore.stderr, /does not load goal-core, which enforces it/);
  install({ ...kit, extensions: ["!packages/extensions/src/goal-core/index.ts"] });
  assert.equal(luna(["exec", "--timeout", "1m", "p"]).status, 2, "an exclusion pattern is not a load");
  const GC = "packages/extensions/src/goal-core/index.ts";
  install({ ...kit, extensions: [GC, `-${GC}`] });
  assert.equal(luna(["exec", "--max-turns", "3", "p"]).status, 2, "a later force-exclude wins over the include, as in pi");
  install({ ...kit, extensions: [GC, "!**/goal-core/**"] });
  assert.equal(luna(["exec", "--max-turns", "3", "p"]).status, 2, "a glob exclusion that may reach it counts against");
  install(kit);
  const envCeiling = luna(["exec", "p"], { PI_KIT_CEILING_TURNS: "5" });
  assert.equal(envCeiling.status, 0, envCeiling.stderr);
  install({ ...kit, extensions: ["packages/extensions/src/tool-firewall/index.ts"] });
  const envUnenforced = luna(["exec", "p"], { PI_KIT_CEILING_TURNS: "5" });
  assert.equal(envUnenforced.status, 2, "a ceiling set in the environment needs goal-core too");
  assert.match(envUnenforced.stderr, /does not load goal-core/);
  assert.equal(luna(["exec", "p"], { PI_KIT_CEILING_TURNS: "" }).status, 0, "an empty variable is no ceiling");
  // pi's filter order: includes, then ! excludes, then + exact force-includes, then - exact force-excludes.
  assert.equal(goalCoreSelected([GC]), true);
  assert.equal(goalCoreSelected([]), false, "an empty list loads nothing, as in pi (applyPackageFilter)");
  assert.equal(goalCoreSelected(["!other/index.ts"]), true);
  assert.equal(goalCoreSelected([`./${GC}`]), true);
  assert.equal(goalCoreSelected(["packages/extensions/src/*/index.ts"]), false, "an include glob cannot be proved");
  assert.equal(goalCoreSelected([GC, "!packages/extensions/src/goal-*/index.ts"]), false);
  assert.equal(goalCoreSelected([GC, "!index.ts"]), false, "a ! pattern matches by base name too");
  assert.equal(goalCoreSelected([GC, `!${GC}`, `+${GC}`]), true, "a force-include overrides an exclusion");
  assert.equal(goalCoreSelected([`+${GC}`, `-${GC}`]), false, "a force-exclude overrides everything");
  install({ ...kit, extensions: [] });
  const emptyList = luna(["exec", "--max-turns", "3", "p"]);
  assert.equal(emptyList.status, 2, "an empty extensions list loads nothing, so nothing enforces the limit");
  assert.match(emptyList.stderr, /does not load goal-core/);
  // A project install is the whole set only when pi trusts the project and the entry is not an
  // autoload:false delta; otherwise the global install must load goal-core too.
  const proj = path.join(tmp, "proj");
  const noGC = { ...kit, extensions: ["packages/extensions/src/tool-firewall/index.ts"] };
  install(noGC);
  install(kit, path.join(proj, ".pi"));
  const trustFile = path.join(agent, "trust.json");
  fs.writeFileSync(trustFile, JSON.stringify({ [fs.realpathSync(proj)]: true }));
  assert.equal(luna(["exec", "--max-turns", "3", "p"], {}, undefined, proj).status, 0, "a trusted project install with goal-core wins over the global one");
  install({ ...kit, autoload: false }, path.join(proj, ".pi"));
  const delta = luna(["exec", "--max-turns", "3", "p"], {}, undefined, proj);
  assert.equal(delta.status, 2, "an autoload:false project entry is a delta; the global install without goal-core is in force");
  assert.match(delta.stderr, /does not load goal-core/);
  install(kit, path.join(proj, ".pi"));
  fs.writeFileSync(trustFile, JSON.stringify({ [fs.realpathSync(proj)]: false }));
  assert.equal(luna(["exec", "--max-turns", "3", "p"], {}, undefined, proj).status, 2, "an untrusted project's install is not loaded; the global one is");
  fs.rmSync(trustFile);
  assert.equal(luna(["exec", "--max-turns", "3", "p"], {}, undefined, proj).status, 2, "no trust record: not proven trusted, the global install counts");
  fs.rmSync(path.join(agent, "trust.json"), { force: true });
  fs.rmSync(proj, { recursive: true });
  install(ROOT);
  assert.equal(luna(["exec", "--max-turns", "3", "p"]).status, 0, "an unfiltered kit entry loads goal-core");
  assert.equal(luna(["exec", "p"]).status, 0, "no limits, no check");
  install(kit);

  // exec: the final answer is the only thing on stdout; progress is on stderr.
  const run = luna(["exec", "--ephemeral", "--max-turns", "5", "--max-cost", "1.5", "--timeout", "2m", "do it"]);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "the answer\n");
  assert.match(run.stderr, /tool read/);
  const seen = recorded();
  assert.ok(seen.args.includes("--no-session") && seen.args.includes("json"));
  assert.equal(seen.args.at(-1), "do it");
  assert.deepEqual({ ...seen.env }, { PI_KIT_CEILING_TURNS: "5", PI_KIT_CEILING_USD: "1.5", PI_KIT_CEILING_SECONDS: "120", PI_KIT_AUTO_PROFILE: "0" });

  // The prompt from stdin; --json hands pi's event stream through untouched.
  const piped = luna(["exec", "--json", "-"], {}, "from stdin\n");
  assert.equal(recorded().args.at(-1), "from stdin");
  assert.deepEqual(piped.stdout.trim().split("\n").map((l) => { const e: unknown = JSON.parse(l); return isRecord(e) ? e.type : undefined; }), ["session", "tool_execution_start", "message_end"]);

  // A parked run (pi exits 13) keeps its code.
  assert.equal(luna(["exec", "go"], { FAKE_PI_EXIT: "13" }).status, 13);

  // A tool-using session whose final message is empty prints the last tool outcome, not silence (PG-41).
  fakePi([
    { type: "session", id: "x" },
    { type: "tool_execution_start", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hello from tool\nsecond line" }] } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
  ]);
  const emptyAfterTool = luna(["exec", "go"]);
  assert.equal(emptyAfterTool.status, 0);
  assert.equal(emptyAfterTool.stdout, "Tool bash finished: hello from tool\n");

  // The tool text is raw tool output, so the fallback line must not echo a secret it holds (DE-124).
  // The text comes from the shared redaction corpus, so no committed line holds a whole token shape.
  const corpus = parseJsonAs(
    object({ entries: array(object({ id: string(), text: array(string()), secret: array(string()) })) }),
    fs.readFileSync(path.join(ROOT, "tests", "fixtures", "secret-corpus.json"), "utf8"),
  );
  const secretEntry = corpus.entries.find((entry) => entry.id === "env-db-password");
  assert.ok(secretEntry !== undefined, "the redaction corpus fixture env-db-password exists");
  const secretText = secretEntry.text.join("");
  fakePi([
    { type: "session", id: "x" },
    { type: "tool_execution_start", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: `${secretText}\ncurl: (22) the requested URL returned error` }] } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
  ]);
  const secretAfterTool = luna(["exec", "go"]);
  assert.equal(secretAfterTool.status, 0);
  assert.ok(!secretAfterTool.stdout.includes(secretEntry.secret.join("")), "the status line does not echo the tool's secret");
  assert.equal(secretAfterTool.stdout, `Tool bash finished: ${secretText.replace(secretEntry.secret.join(""), "[REDACTED]")}\n`);

  // The t5 shape: a tool starts an autonomy run, then the model answers with no text. Name the run and its state.
  fakePi([
    { type: "session", id: "x" },
    { type: "tool_execution_start", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "run todo-api-1 started (supervisor pid 123, status running); follow it with: pi-autonomy status --run todo-api-1" }] } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
  ]);
  const startedRun = luna(["exec", "go"]);
  assert.equal(startedRun.status, 0);
  assert.equal(startedRun.stdout, "Run todo-api-1 started; state: running.\n");

  // `pi-autonomy up --json` returns {runId, pid, status, ...} without a `started` field, and the
  // status line must still name the run. This is the shape the owner-bench t5 run produced.
  fakePi([
    { type: "session", id: "x" },
    { type: "tool_execution_start", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: JSON.stringify({ runId: "todo-api-1", pid: 123, status: "running", digest: "abc", root: "/tmp/run", log: "/tmp/run/supervisor.log" }) }] } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
  ]);
  const startedRunJson = luna(["exec", "go"]);
  assert.equal(startedRunJson.status, 0);
  assert.equal(startedRunJson.stdout, "Run todo-api-1 started; state: running.\n");

  // An empty answer with no tool calls keeps today's behaviour: stdout stays empty.
  fakePi([
    { type: "session", id: "x" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
  ]);
  const emptyNoTool = luna(["exec", "go"]);
  assert.equal(emptyNoTool.status, 0);
  assert.equal(emptyNoTool.stdout, "");
  fakePi(events);

  // A bad limit is refused, never read as no limit.
  // A ceiling is refused when overrides.json switches off the extension that enforces it.
  fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["goal-core"] } }));
  const refused = luna(["exec", "--max-turns", "3", "p"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /goal-core/);
  fs.rmSync(path.join(agent, "pi-kit"), { recursive: true });
  fs.rmSync(path.join(agent, ".pi-kit.json"));

  for (const bad of [["--max-turns", "0", "p"], ["--max-cost", "abc", "p"], ["--timeout", "soon", "p"], ["--wat", "p"], [], ["--"], ["--", "a", "b"], ["p", "--", "q"]]) {
    assert.equal(typeof planExec(bad), "string", `refused: ${bad.join(" ")}`);
  }
  // After --, the prompt is literal: an option-shaped prompt and "-" are prompts, not flags or stdin (DE-118).
  for (const literal of ["--help", "-", "--max-turns 3"]) {
    const plan = planExec(["--max-turns", "2", "--", literal]);
    assert.ok(typeof plan === "object", `-- ${literal}: ${typeof plan === "string" ? plan : ""}`);
    assert.equal(plan.stdinPrompt, false);
    assert.deepEqual(plan.piArgs.slice(-2), ["--", literal]);
    assert.equal(plan.env.PI_KIT_CEILING_TURNS, "2");
  }

  // Windows: pi is an npm .cmd shim that Node cannot start without a shell, and a shell splits the prompt.
  // exec starts pi's node entry named in the shim, with no shell, so the prompt stays one argument.
  const shim = '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n';
  const winDeps = { platform: "win32" as const, nodePath: "C:\\node\\node.exe", env: { PATH: "C:\\x;C:\\npm" }, readFile: (file: string) => (file === "C:\\npm\\pi.cmd" ? shim : undefined) };
  assert.deepEqual(piSpawnPlan("pi", ["--mode", "json", "--", "two words & more"], winDeps), {
    command: "C:\\node\\node.exe",
    args: ["C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js", "--mode", "json", "--", "two words & more"],
  });
  const missing = piSpawnPlan("pi", ["a b"], { ...winDeps, readFile: () => undefined });
  assert.equal(typeof missing === "string" && /could not find pi's node entry/.test(missing), true, "no shim found: a reason, never a shell");
  assert.deepEqual(piSpawnPlan("pi", ["a b"], { platform: "linux" }), { command: "pi", args: ["a b"] });

  // overrides.json: a removed extension the marker still lists is pending; none once applied.
  fs.mkdirSync(path.join(agent, "pi-kit"));
  fs.writeFileSync(path.join(agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["herdr", "branch-lab"] } }));
  fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "global", extensions: ["herdr", "effort"] }));
  assert.deepEqual(pendingDisables(agent), { profile: "balanced", names: ["herdr"] });
  fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "global", extensions: ["effort"] }));
  assert.equal(pendingDisables(agent), null);
  console.log("luna-cli-smoke: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// `luna schedule` and /schedule (V5-14).
await import("./schedule-checks.ts");
