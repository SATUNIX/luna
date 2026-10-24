#!/usr/bin/env node
// dual-review smoke: a review that times out, blows the output cap, or fails to spawn must
// still report a result instead of silently disappearing. Deterministic and offline — the
// child process is faked with an EventEmitter and the spawner is injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadExtension, fakePi, type FakePiApi, type Steer } from "../packages/core/eval/harness.ts";

const REVIEWER = "extensions/dual-review/index.ts";
const RESULT_TYPE = "dual-review-result";

interface DelegationRequest {
  kind: string;
  role: string;
  readOnly: boolean;
}

interface PreparedChild {
  ok: boolean;
  code?: string;
  reason?: string;
  args?: string[];
  env?: Record<string, string>;
  slot?: { attach: (pid: number) => void; settle: (outcome: string) => void };
}

interface DelegationGuard {
  prepareChild(request: DelegationRequest): PreparedChild;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin?: { on: (event: string, listener: () => void) => unknown; end: (chunk: string) => void };
  kills: Array<string | undefined>;
  kill: (signal?: string) => boolean;
  pid?: number;
}

interface ChildSpawnOptions {
  cwd?: string;
  shell?: boolean;
  env: Record<string, string | undefined>;
}

type SpawnChild = (command: string, argv: string[], options: ChildSpawnOptions) => FakeChild;
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type RunExecFile = (command: string, args: string[], options: object, callback: ExecCallback) => void;

interface ToolResult {
  content?: Array<{ text?: string }>;
}

interface ReviewTool {
  execute(id: string, params: { content: string }, signal: AbortSignal | undefined, onUpdate: undefined, ctx: { cwd: string }): Promise<ToolResult | undefined>;
}

interface ReviewNote {
  msg: string;
  level: string | undefined;
}

interface ReviewContext {
  cwd: string;
  ui: { notify: (msg: string, level?: string) => void };
}

interface ReviewCommand {
  handler(args: string, ctx: ReviewContext): Promise<void>;
}

interface ResultEntry {
  message: { customType: string; content: string };
}

type Reviewer = (api: FakePiApi, spawnChild: SpawnChild, runExecFile?: RunExecFile) => void;

interface SpawnCall {
  argv: string[];
  options: ChildSpawnOptions;
}

// The reviewer is a child agent: every launch goes through delegation-guard (the parent's protections, the effort
// ledger). The tests stand in for the guard's registry and record what was asked of it.
const DELEGATION = Symbol.for("pi-kit.delegation");
// globalThis seen with the registry slot the delegation guard publishes under.
const registry: typeof globalThis & { [DELEGATION]?: DelegationGuard } = globalThis;
const requests: DelegationRequest[] = [];
const attached: number[] = [];
const settled: string[] = [];
function installGuard({ refuse }: { refuse?: string } = {}): void {
  requests.length = attached.length = settled.length = 0;
  registry[DELEGATION] = {
    prepareChild(request) {
      requests.push(request);
      if (refuse) return { ok: false, code: "budget", reason: refuse };
      return { ok: true, args: ["--no-extensions", "-e", "/kit/tool-firewall/index.ts", "-e", "/kit/secret-guard/index.ts"], env: { PI_KIT_CHILD_REQUIRE: "tool-firewall,secret-guard,protected-paths,delegation-guard,effort" }, slot: { attach: (pid) => attached.push(pid), settle: (outcome) => settled.push(outcome) } };
    },
  };
}
installGuard();

// A fake child: EventEmitter plus stream EventEmitters and a kill spy. `close` is emitted by
// the test, not by kill, so we control when the result is reported.
function fakeChild(): FakeChild {
  const kills: Array<string | undefined> = [];
  const child: FakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kills,
    kill: (signal?: string) => {
      child.kills.push(signal);
      return true;
    },
  });
  return child;
}

const resultMessages = (pi: { steers: Steer[] }): ResultEntry[] =>
  pi.steers.filter((entry): entry is Steer & ResultEntry => typeof entry.message === "object" && !Array.isArray(entry.message) && entry.message.customType === RESULT_TYPE);

async function launch(spawnChild: SpawnChild, signal?: AbortSignal) {
  const reviewer = await loadExtension<Reviewer>(REVIEWER);
  const pi = fakePi();
  reviewer(pi.api, spawnChild);
  const tool = pi.tools.get("dual_review") as ReviewTool | undefined;
  assert.ok(tool, "dual_review tool must be registered");
  const result = await tool.execute("id", { content: "diff --git a/x b/x" }, signal, undefined, { cwd: process.cwd() });
  return Object.assign(pi, { toolResult: result?.content?.[0]?.text ?? "" });
}

// Load the extension with an injected execFile and hand back the /review command plus a record
// of ui.notify calls, so git-error and empty-diff paths can be exercised directly.
async function loadForReview(spawnChild: SpawnChild, runExecFile: RunExecFile) {
  const reviewer = await loadExtension<Reviewer>(REVIEWER);
  const pi = fakePi();
  reviewer(pi.api, spawnChild, runExecFile);
  const cmd: ReviewCommand | undefined = pi.commands.get("review");
  assert.ok(cmd, "/review command must be registered");
  const notes: ReviewNote[] = [];
  const ctx: ReviewContext = { cwd: "/tmp/whatever", ui: { notify: (msg, level) => notes.push({ msg, level }) } };
  return { pi, cmd, notes, ctx };
}

async function run(): Promise<void> {
  // (a) Over the 100000-char cap: the reviewer is killed and the truncated output (with its
  // marker) is reported exactly once. Fails on the pre-fix source, which drops it silently.
  {
    const child = fakeChild();
    const pi = await launch(() => child);
    child.stdout.emit("data", Buffer.from("x".repeat(100_001)));
    assert.deepEqual(child.kills, ["SIGTERM"], "over-cap output must SIGTERM the reviewer");
    child.emit("close", 0);
    const messages = resultMessages(pi);
    assert.equal(messages.length, 1, "over-cap review must be reported exactly once");
    const [first] = messages;
    assert.ok(first);
    assert.match(first.message.content, /\[review output limit reached\]/);
  }

  // (b) Spawn failure: reported exactly once, and an error-then-close pair cannot double-send.
  {
    const child = fakeChild();
    const pi = await launch(() => child);
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("close", -1);
    const messages = resultMessages(pi);
    assert.equal(messages.length, 1, "a spawn error must be reported exactly once");
    const [first] = messages;
    assert.ok(first);
    assert.match(first.message.content, /failed to start/);
    assert.match(first.message.content, /ENOENT/);
  }

  // (c) Genuine user abort: no result is sent.
  {
    const child = fakeChild();
    const controller = new AbortController();
    const pi = await launch(() => child, controller.signal);
    controller.abort();
    child.emit("close", -1);
    assert.equal(resultMessages(pi).length, 0, "a user-cancelled review must send nothing");
  }

  // (d) Git failure must surface as a git-diff error, never as "no diff to review."
  {
    const { cmd, notes, ctx } = await loadForReview(
      fakeChild,
      (_cmd, _args, _opts, cb) =>
        cb(
          new Error("fatal: not a git repository (or any of the parent directories): .git"),
          "",
          "fatal: not a git repository (or any of the parent directories): .git",
        ),
    );
    await cmd.handler("", ctx);
    assert.ok(
      notes.some((n) => n.msg.includes("git diff failed") && n.msg.includes("not a git repository")),
      "a git failure must be reported as a git diff failure",
    );
    assert.ok(
      !notes.some((n) => n.msg.includes("no diff to review.")),
      "a git failure must not be reported as no diff to review",
    );
  }

  // (e) A genuinely clean tree still reports "no diff to review." and launches no reviewer.
  {
    const child = fakeChild();
    let spawned = 0;
    const { pi, cmd, notes, ctx } = await loadForReview(
      () => { spawned++; return child; },
      (_cmd, _args, _opts, cb) => cb(null, "", ""),
    );
    await cmd.handler("", ctx);
    assert.ok(
      notes.some((n) => n.msg.includes("no diff to review.")),
      "a clean tree must be reported as no diff to review",
    );
    assert.equal(spawned, 0, "a clean tree must not spawn a reviewer");
    assert.equal(resultMessages(pi).length, 0, "a clean tree must send no review result");
  }

  // (f) A non-empty diff launches the reviewer and its result is delivered on close.
  {
    const child = fakeChild();
    let spawned = 0;
    const { pi, cmd, notes, ctx } = await loadForReview(
      () => { spawned++; return child; },
      (_cmd, _args, _opts, cb) => cb(null, "diff --git a/x b/x", ""),
    );
    await cmd.handler("", ctx);
    assert.equal(spawned, 1, "a non-empty diff must spawn a reviewer");
    assert.ok(notes.some((n) => n.msg.includes("reviewer launched")), "launch must be announced");
    child.emit("close", 0);
    const messages = resultMessages(pi);
    assert.equal(messages.length, 1, "a launched review must report a result on close");
  }

  // (g) The launch contract: the guard is asked for a read-only reviewer (discretionary for the model's tool, user for /review), the
  // child is started with the guard's arguments and environment plus the read-only tools, and its slot is attached and settled.
  {
    installGuard();
    let spawnedWith = null as SpawnCall | null;
    const child = fakeChild();
    child.pid = 4321;
    const written: string[] = [];
    child.stdin = { on: () => child.stdin, end: (chunk) => { written.push(chunk); } };
    const pi = await launch((cmd, argv, options) => { spawnedWith = { argv, options }; return child; });
    assert.equal(requests.length, 1);
    assert.ok(spawnedWith, "the reviewer must have been spawned");
    const [request] = requests;
    assert.ok(request);
    assert.deepEqual([request.kind, request.role, request.readOnly], ["discretionary", "reviewer", true], "the model-callable tool is a discretionary, read-only reviewer");
    for (const arg of ["--no-extensions", "/kit/tool-firewall/index.ts", "/kit/secret-guard/index.ts", "read,grep,find,ls", "--print"]) assert.ok(spawnedWith.argv.includes(arg), `the child is started with ${arg}`);
    assert.equal(spawnedWith.argv.filter((a) => a === "--no-extensions").length, 1, "once, from the guard");
    // ORC-7: the prompt and the diff go over the child's stdin, never argv (readable by any local user through ps).
    assert.equal(spawnedWith.argv.some((a) => a.includes("diff --git")), false, "the diff is not on the child's argv");
    assert.equal(written.length, 1, "the prompt is written to stdin once");
    assert.match(written[0] ?? "", /^You are a code reviewer\.[\s\S]*\n\ndiff --git a\/x b\/x$/, "stdin carries the review prompt and the diff");
    assert.equal(spawnedWith.options.env.PI_KIT_CHILD_REQUIRE, "tool-firewall,secret-guard,protected-paths,delegation-guard,effort", "the child is told what it must have loaded");
    assert.equal(spawnedWith.options.env.PI_KIT_INTERNAL_CHILD, "1");
    assert.equal(spawnedWith.options.shell, false);
    assert.deepEqual(attached, [4321], "the ledger slot is attached to the process");
    assert.deepEqual(settled, [], "and is open while the reviewer runs");
    child.emit("error", new Error("boom"));
    child.emit("close", 1);
    assert.deepEqual(settled, ["closed"], "settled exactly once, whether the child errors, closes or both");
    assert.equal(resultMessages(pi).length, 1);
    const cmdSetup = await loadForReview(() => fakeChild(), (_c, _a, _o, cb) => cb(null, "diff --git a/x b/x", ""));
    await cmdSetup.cmd.handler("", cmdSetup.ctx);
    assert.equal(requests.at(-1)?.kind, "user", "/review is the operator's own request");
  }

  // (h) No guard, or a guard that refuses (effort budget, missing protections): nothing is started, and the reason is reported.
  {
    Reflect.deleteProperty(registry, DELEGATION);
    let spawned = 0;
    const noGuard = await launch(() => { spawned++; return fakeChild(); });
    assert.equal(spawned, 0, "without delegation-guard the reviewer cannot get its protections, so it is not started");
    assert.match(noGuard.toolResult, /Review not started: the delegation-guard extension is not loaded/);
    const viaCommand = await loadForReview(() => { spawned++; return fakeChild(); }, (_c, _a, _o, cb) => cb(null, "diff --git a/x b/x", ""));
    await viaCommand.cmd.handler("", viaCommand.ctx);
    assert.equal(spawned, 0);
    assert.ok(viaCommand.notes.some((n) => n.level === "error" && /reviewer not started: the delegation-guard extension is not loaded/.test(n.msg)));
    assert.ok(!viaCommand.notes.some((n) => /reviewer launched/.test(n.msg)), "a refused launch is never announced as launched");
    installGuard({ refuse: "delegation is off at effort E1 (minimal)" });
    const refused = await launch(() => { spawned++; return fakeChild(); });
    assert.equal(spawned, 0, "a refusal from the guard starts nothing");
    assert.match(refused.toolResult, /Review not started: delegation is off at effort E1/);
    assert.equal(resultMessages(refused).length, 0);
    installGuard();
  }

  console.log("[test:smoke dual-review] OK");
}

await run();
