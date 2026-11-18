#!/usr/bin/env node
/**
 * Offline tests of the host-owned steward board's atomic claim (A-92b): the extended item metadata
 * is validated strictly and never defaulted; two REAL child processes race `board claim` through
 * the CLI under control/board.lock and exactly one wins; the loser names the winner; a re-claim by
 * the same agent is idempotent; blocked, missing and malformed items are refused; and both a claim
 * and `board --file` wait for the board lock. No container or provider is involved.
 *
 * The `dispatch` template (A-92a): the contract resolver requires its streams and engineers; `init`,
 * `plan` and `start` accept it and the run's contract names them; a cycle claims the top ready item
 * of its stream for its engineer under the real board lock, continues an open claim, skips a
 * withheld item and claims nothing when nothing is claimable; the cycle prompt carries the one
 * claimed item; and a merged cycle that reports the item done records submittedAt and sha. The
 * cycles run on the deterministic fake runtime (tests/autonomy-harness.ts).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoardLockBusy, claimBoardItem, claimNextItem, ITEM_KEYS, keepHostClaims, type StewardBoard, validateBoard } from "../packages/autonomy/lib/board.ts";
import { createRunLock } from "../packages/autonomy/lib/runlock.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { claimForCycle, cycleEngineer, cycleRotation, dispatchCandidate, recordSubmission, reviseSubmissions } from "../packages/autonomy/lib/dispatch.ts";
import { isCycleTemplate } from "../packages/autonomy/lib/templates/index.ts";
import { main } from "../packages/autonomy/cli.ts";
import { RunStore } from "../packages/autonomy/lib/store.ts";
import { FakeRuntime } from "../packages/autonomy/tests/fake-runtime.ts";
import { type RawContract, makeChecker, rm, tempDir, testEffort } from "./autonomy-helpers.ts";
import { NODE_EXIT, cleanup as cleanupHarness, harness, runOnce, type ScriptContext } from "./autonomy-harness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "packages", "autonomy", "cli.ts");
const { check, done } = makeChecker("autonomy-dispatch-smoke");

interface ChildResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface ClaimJson {
  ok?: boolean;
  code?: string;
  error?: string;
  already?: boolean;
  item?: { id: string; assignee?: string; claimedAt?: string; status?: string };
  board?: StewardBoard;
  assignee?: string | null;
  claimedAt?: string | null;
  id?: string;
}

const dirs: string[] = [];
const scratch = (): string => { const dir = tempDir("autonomy-dispatch-"); dirs.push(dir); return dir; };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A run directory with only the fields `openStore` needs for a board command. */
function newRun(home: string, run: string, template = "self-improve"): string {
  const control = path.join(home, run, "control");
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(home, run, "state.json"), JSON.stringify({ schemaVersion: 1, run, template, status: "ready" }));
  return control;
}

const writeBoard = (control: string, board: unknown): void => {
  fs.writeFileSync(path.join(control, "board.json"), `${JSON.stringify(board, null, 2)}\n`);
};
const readBoard = (control: string): StewardBoard => validateBoard(JSON.parse(fs.readFileSync(path.join(control, "board.json"), "utf8")));
const itemOf = (board: StewardBoard, id: string): StewardBoard["items"][number] => {
  const item = board.items.find((candidate) => candidate.id === id);
  assert.ok(item, `board has ${id}`);
  return item;
};
const claimJson = (text: string): ClaimJson => JSON.parse(text) as ClaimJson;

/** Run the real CLI script as a child process with a temporary autonomy home. */
function runCli(home: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, PI_AUTONOMY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * A child process that waits at a shared file barrier and then runs the real CLI `main`. The
 * barrier makes the two claim attempts overlap instead of racing only by spawn latency.
 */
const BARRIER_SCRIPT = `
import fs from "node:fs";
const barrier = process.env.BARRIER;
const cli = process.env.CLI_PATH;
const args = JSON.parse(process.env.CLAIM_ARGS ?? "[]");
const deadline = Date.now() + 10000;
while (!fs.existsSync(barrier)) {
  if (Date.now() > deadline) { console.error("barrier timeout"); process.exit(70); }
  await new Promise((resolve) => setTimeout(resolve, 1));
}
const { main } = await import(cli);
process.exit(await main(args));
`;

function claimAfterBarrier(home: string, barrier: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", BARRIER_SCRIPT], {
      env: { ...process.env, PI_AUTONOMY_HOME: home, BARRIER: barrier, CLI_PATH: CLI, CLAIM_ARGS: JSON.stringify(args) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const settled = (promise: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);

const EXTENDED = {
  id: "V-01",
  title: "Improve the menu",
  detail: "Keyboard-first",
  priority: "P1",
  acceptance: "A tested keyboard workflow",
  status: "ready",
  assignee: "alice",
  claimedAt: "2026-10-01T00:00:00.000Z",
  submittedAt: "2026-10-01T01:00:00.000Z",
  sha: "a".repeat(40),
  rounds: 2,
  verdict: "pending",
  verdictBy: "steward",
  findings: ["first finding"],
} as const;

await check("board items accept the claim and review metadata, validate it strictly, and never materialise defaults", () => {
  assert.deepEqual([...ITEM_KEYS], ["id", "title", "detail", "priority", "acceptance", "status", "assignee", "claimedAt", "submittedAt", "sha", "rounds", "verdict", "verdictBy", "findings"]);
  assert.deepEqual(validateBoard({ items: [{ id: "V-01", title: "x", priority: "P1" }] }), { items: [{ id: "V-01", title: "x", priority: "P1" }] }, "optional claim keys are absent, not defaulted");
  assert.deepEqual(validateBoard({ stream: "ux", items: [EXTENDED] }).items[0], EXTENDED);
  const bad: unknown[] = [
    { ...EXTENDED, claimedAt: "yesterday" },
    { ...EXTENDED, submittedAt: "2026-13-01T00:00:00.000Z" },
    { ...EXTENDED, sha: "A".repeat(40) },
    { ...EXTENDED, sha: "a".repeat(39) },
    { ...EXTENDED, rounds: 1.5 },
    { ...EXTENDED, rounds: -1 },
    { ...EXTENDED, rounds: 1001 },
    { ...EXTENDED, rounds: "2" },
    { ...EXTENDED, verdict: "done" },
    { ...EXTENDED, verdictBy: "" },
    { ...EXTENDED, verdictBy: "x".repeat(201) },
    { ...EXTENDED, findings: Array.from({ length: 11 }, (_, i) => `f${i}`) },
    { ...EXTENDED, findings: [""] },
    { ...EXTENDED, findings: ["x".repeat(1001)] },
    { ...EXTENDED, findings: "one" },
  ];
  for (const item of bad) assert.throws(() => validateBoard({ items: [item] }));
});

await check("the pure claim and next-item selector refuse non-ready work and never mutate the input board", () => {
  const board: StewardBoard = {
    stream: "ux",
    items: [
      { id: "V-01", title: "blocked", priority: "P0", status: "blocked" },
      { id: "V-02", title: "busy", priority: "P0", status: "in_progress" },
      { id: "V-03", title: "owned", priority: "P0", assignee: "bob", claimedAt: "2026-10-01T00:00:00.000Z", status: "in_progress" },
      { id: "V-04", title: "approved", priority: "P0", verdict: "approved" },
      { id: "V-05", title: "next", priority: "P2" },
      { id: "V-06", title: "earlier priority", priority: "P1" },
    ],
  };
  const before = JSON.stringify(board);
  assert.equal(claimNextItem(board)?.id, "V-06");
  assert.equal(claimNextItem(board, undefined, ["api"]), null);
  assert.equal(claimNextItem(board, undefined, ["ux"])?.id, "V-06");
  const claimed = claimNextItem(board, "alice");
  assert.equal(claimed?.id, "V-06");
  assert.equal(claimed?.assignee, "alice");
  assert.equal(claimed?.status, "in_progress");
  assert.equal(JSON.stringify(board), before, "the selector does not mutate its board");
  const won = claimBoardItem(board, "V-05", "alice", "2026-10-01T00:00:00.000Z");
  assert.deepEqual([won.outcome, won.item.assignee, won.item.status], ["winner", "alice", "in_progress"]);
  const again = claimBoardItem(won.board, "V-05", "alice", "2026-11-01T00:00:00.000Z");
  assert.deepEqual([again.outcome, again.item.claimedAt], ["already", "2026-10-01T00:00:00.000Z"], "the timestamp is not rewritten");
  const lost = claimBoardItem(won.board, "V-05", "bob", "2026-11-01T00:00:00.000Z");
  assert.deepEqual([lost.outcome, lost.item.assignee], ["loser", "alice"]);
  assert.throws(() => claimBoardItem(board, "V-01", "alice", "2026-10-01T00:00:00.000Z"), /blocked/);
  assert.throws(() => claimBoardItem(board, "V-99", "alice", "2026-10-01T00:00:00.000Z"), /not on the board/);
});

await check("two real child processes racing board claim produce exactly one winner, and the loser names the owner", async () => {
  const home = scratch();
  const control = newRun(home, "race-run");
  writeBoard(control, { stream: "ux", items: [{ id: "V-01", title: "Race", priority: "P1", status: "ready" }] });
  const barrier = path.join(scratch(), "go");
  const attempts = ["a", "b"].map((by) => ({ by, promise: claimAfterBarrier(home, barrier, ["board", "claim", "V-01", "--run", "race-run", "--by", by, "--json"]) }));
  await sleep(150); // both children are waiting at the barrier
  fs.writeFileSync(barrier, "go");
  const results = await Promise.all(attempts.map(async ({ by, promise }) => ({ by, result: await promise })));
  for (const { by, result } of results) assert.ok(result.code === 0 || result.code === 3, `${by}: exit ${String(result.code)} ${result.stderr}`);
  const winners = results.filter(({ result }) => result.code === 0);
  const losers = results.filter(({ result }) => result.code === 3);
  assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify(results.map(({ by, result }) => ({ by, code: result.code, out: result.stdout, err: result.stderr })))}`);
  assert.equal(losers.length, 1);
  const winner = winners[0];
  const loser = losers[0];
  assert.ok(winner && loser, "both sides of the race are present");
  const won = claimJson(winner.result.stdout);
  const refused = claimJson(loser.result.stdout);
  assert.deepEqual([won.ok, won.already, won.item?.assignee, won.item?.id], [true, false, winner.by, "V-01"]);
  assert.deepEqual([refused.ok, refused.code, refused.assignee, refused.id], [false, "refused", winner.by, "V-01"]);
  assert.equal(refused.claimedAt, won.item?.claimedAt);

  const board = readBoard(control);
  const item = itemOf(board, "V-01");
  assert.deepEqual([item.assignee, item.status], [winner.by, "in_progress"]);
  assert.equal(item.claimedAt, won.item?.claimedAt, "assignee, claimedAt and status are in the one written item");

  const again = await runCli(home, ["board", "claim", "V-01", "--run", "race-run", "--by", winner.by, "--json"]);
  assert.equal(again.code, 0, again.stderr);
  const repeated = claimJson(again.stdout);
  assert.deepEqual([repeated.ok, repeated.already, repeated.item?.claimedAt], [true, true, won.item?.claimedAt]);
  assert.equal(readBoard(control).items[0]?.claimedAt, won.item?.claimedAt, "an idempotent re-claim does not rewrite claimedAt");

  const other = await runCli(home, ["board", "claim", "V-01", "--run", "race-run", "--by", loser.by, "--json"]);
  assert.equal(other.code, 3);
  assert.equal(claimJson(other.stdout).assignee, winner.by);
  assert.deepEqual(fs.readdirSync(control).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), [], "no lock or temporary file is left behind");
});

await check("claim refuses blocked, missing and ownerless-request items, and stays available to dispatch runs", async () => {
  const home = scratch();
  const control = newRun(home, "blocked-run", "dispatch");
  writeBoard(control, { items: [{ id: "V-01", title: "Blocked", priority: "P0", status: "blocked" }] });
  const blocked = await runCli(home, ["board", "claim", "V-01", "--run", "blocked-run", "--by", "a", "--json"]);
  assert.deepEqual([blocked.code, claimJson(blocked.stdout).code], [3, "refused"]);
  assert.equal(itemOf(readBoard(control), "V-01").assignee, undefined);
  const missing = await runCli(home, ["board", "claim", "V-99", "--run", "blocked-run", "--by", "a", "--json"]);
  assert.deepEqual([missing.code, claimJson(missing.stdout).code], [3, "refused"]);
  const noBy = await runCli(home, ["board", "claim", "V-01", "--run", "blocked-run", "--json"]);
  assert.equal(noBy.code, 2);
  assert.equal(claimJson(noBy.stdout).code, "usage");
  writeBoard(control, { items: [{ id: "V-02", title: "Stale", priority: "P1", status: "in_progress" }] });
  const stale = await runCli(home, ["board", "claim", "V-02", "--run", "blocked-run", "--by", "a", "--json"]);
  assert.deepEqual([stale.code, claimJson(stale.stdout).code], [3, "refused"]);
  assert.equal(itemOf(readBoard(control), "V-02").assignee, undefined, "an ownerless in-progress item is not silently re-claimed");
  const listed = await runCli(home, ["board", "--run", "blocked-run", "--json"]);
  assert.equal(listed.code, 0, "board stays available for a dispatch run");
  const nonBoard = newRun(home, "plain-run", "implement");
  writeBoard(nonBoard, { items: [{ id: "V-01", title: "Nope", priority: "P0" }] });
  const refused = await runCli(home, ["board", "claim", "V-01", "--run", "plain-run", "--by", "a", "--json"]);
  assert.deepEqual([refused.code, claimJson(refused.stdout).code], [3, "refused"]);
});

await check("board --file rejects invalid claim metadata and both writes wait for control/board.lock", async () => {
  const home = scratch();
  const control = newRun(home, "lock-run");
  writeBoard(control, { items: [{ id: "V-01", title: "Ready", priority: "P1" }] });
  const source = path.join(scratch(), "board.json");
  writeBoard(path.dirname(source), { items: [EXTENDED] });
  const accepted = await runCli(home, ["board", "--run", "lock-run", "--file", source, "--json"]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(readBoard(control).items[0], EXTENDED);

  for (const bad of [
    { ...EXTENDED, claimedAt: "not-a-timestamp" },
    { ...EXTENDED, sha: "b".repeat(41) },
    { ...EXTENDED, rounds: 1001 },
    { ...EXTENDED, verdict: "maybe" },
    { ...EXTENDED, verdictBy: "" },
    { ...EXTENDED, findings: ["", "x"] },
  ]) {
    writeBoard(path.dirname(source), { items: [bad] });
    const rejected = await runCli(home, ["board", "--run", "lock-run", "--file", source, "--json"]);
    assert.equal(rejected.code, 2, JSON.stringify(bad));
    assert.deepEqual(readBoard(control).items[0], EXTENDED, "a rejected upload leaves the previous board intact");
  }

  // The held lock makes both writers wait; after release each completes against the new board.
  const lockFile = path.join(control, "board.lock");
  const lock = createRunLock({ file: lockFile });
  assert.equal(lock.acquire().acquired, true);
  writeBoard(path.dirname(source), { items: [{ id: "V-02", title: "Uploaded", priority: "P0" }] });
  const upload = runCli(home, ["board", "--run", "lock-run", "--file", source, "--json"]);
  assert.equal(await settled(upload, 300), false, "board --file waits for the board lock");
  assert.equal(readBoard(control).items[0]?.title, EXTENDED.title, "nothing is written while the lock is held");
  lock.release();
  assert.equal((await upload).code, 0);
  assert.equal(readBoard(control).items[0]?.title, "Uploaded");

  const claimLock = createRunLock({ file: lockFile });
  assert.equal(claimLock.acquire().acquired, true);
  const claim = runCli(home, ["board", "claim", "V-02", "--run", "lock-run", "--by", "alice", "--json"]);
  assert.equal(await settled(claim, 300), false, "claim waits for the board lock");
  assert.equal(itemOf(readBoard(control), "V-02").assignee, undefined);
  claimLock.release();
  const claimed = await claim;
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.deepEqual([itemOf(readBoard(control), "V-02").assignee, itemOf(readBoard(control), "V-02").status], ["alice", "in_progress"]);
  assert.deepEqual(fs.readdirSync(control).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), []);
});


// --- the dispatch template (A-92a) ---------------------------------------------------------------

const git = (cwd: string, args: readonly string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A source repository whose base passes the `gate` check below. */
function greenRepo(): string {
  const src = scratch();
  git(src, ["init", "--quiet", "-b", "main"]);
  fs.writeFileSync(path.join(src, "AUDIT_OK"), "base\n");
  git(src, ["add", "."]);
  git(src, ["commit", "--quiet", "-m", "base"]);
  return src;
}

const DISPATCH = { streams: ["ux", "api"], engineers: ["alice", "bob"] };

const dispatchRaw = (src: string, over: RawContract = {}): RawContract => ({
  schemaVersion: 1, run: "dispatch-test-1", template: "dispatch",
  objective: { title: "Dispatch", spec: "Work the claimed board item." },
  inputs: { repository: { path: src, ref: "main" } },
  acceptance: { checks: [{ id: "gate", run: NODE_EXIT("require('fs').existsSync('AUDIT_OK')"), timeoutMinutes: 1, required: true }], review: true },
  permissions: { unattended: { authorised: true, autoApprove: true } },
  budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 },
  promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", repo: src, branch: "pi-autonomy/integration" }] },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, dispatch: DISPATCH },
  ...over,
});

const problemPaths = (raw: RawContract): string[] => resolveContract(raw, { effort: testEffort }).problems.filter((p) => p.level === "error").map((p) => p.path);

await check("dispatch contract: streams and engineers are required and bounded; the option is the dispatch template's alone", () => {
  const src = greenRepo();
  const ok = resolveContract(dispatchRaw(src), { effort: testEffort });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepEqual(ok.contract?.templateOptions["dispatch"], DISPATCH);
  assert.equal(isCycleTemplate("dispatch"), true);
  assert.equal(isCycleTemplate("self-improve"), true);
  assert.equal(isCycleTemplate("implement"), false);
  const integration = { branch: "pi-autonomy/integration", review: true };
  const bad: Array<[unknown, string]> = [
    [undefined, "templateOptions.dispatch"],
    [{ engineers: ["alice"] }, "templateOptions.dispatch.streams"],
    [{ streams: ["ux"] }, "templateOptions.dispatch.engineers"],
    [{ streams: [], engineers: ["alice"] }, "templateOptions.dispatch.streams"],
    [{ streams: ["UX"], engineers: ["alice"] }, "templateOptions.dispatch.streams"],
    [{ streams: ["ux", "ux"], engineers: ["alice"] }, "templateOptions.dispatch.streams"],
    [{ streams: Array.from({ length: 21 }, (_, i) => `s${i}`), engineers: ["alice"] }, "templateOptions.dispatch.streams"],
    [{ streams: ["ux"], engineers: ["alice", "alice"] }, "templateOptions.dispatch.engineers"],
    [{ streams: ["ux"], engineers: ["al ice"] }, "templateOptions.dispatch.engineers"],
    [{ streams: ["ux"], engineers: ["alice\u0007"] }, "templateOptions.dispatch.engineers"],
    [{ streams: ["ux"], engineers: ["x".repeat(65)] }, "templateOptions.dispatch.engineers"],
    [{ streams: ["ux"], engineers: [7] }, "templateOptions.dispatch.engineers"],
    [{ streams: ["ux"], engineers: ["alice"], extra: true }, "templateOptions.dispatch.extra"],
  ];
  for (const [dispatch, where] of bad) {
    const paths = problemPaths(dispatchRaw(src, { templateOptions: { integration, ...(dispatch === undefined ? {} : { dispatch }) } }));
    assert.ok(paths.includes(where), `${JSON.stringify(dispatch)}: ${paths.join(", ")}`);
  }
  // A self-improve run ignores (and warns about) the dispatch option rather than half-dispatching.
  const si = resolveContract(dispatchRaw(src, { template: "self-improve" }), { effort: testEffort });
  assert.equal(si.ok, true, JSON.stringify(si.problems));
  assert.ok(si.problems.some((p) => p.level === "warning" && p.path === "templateOptions.dispatch"));
  assert.ok(problemPaths(dispatchRaw(src, { generations: { enabled: true } })).includes("generations.enabled"), "a dispatch run drives its own cycles");
});

await check("init --template dispatch, plan and start accept the template, and the run's contract names the streams and engineers", async () => {
  const home = scratch();
  const src = greenRepo();
  const out: string[] = []; const err: string[] = [];
  const cli = async (...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> => {
    out.length = 0; err.length = 0;
    const code = await main(argv, {
      home, effort: testEffort, isTTY: false, signals: false, pid: 9100, now: () => new Date("2026-10-01T00:00:00.000Z"),
      stdout: { write: (text) => { out.push(text); } }, stderr: { write: (text) => { err.push(text); } },
      spawnSupervisor: () => 4242,
      runtimeFactory: ({ contract, cfg, store }) => new FakeRuntime({ store, cfg, contract }),
    });
    const parsed: unknown = JSON.parse(out.join("") || "{}");
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "--json prints one object");
    return { code, json: { ...parsed } };
  };
  const file = path.join(scratch(), "run.json");
  const missing = await cli("init", "--template", "dispatch", "--run", "dispatch-cli-1", "--repo", src, "--check", "gate=true", "--out", file, "--json");
  assert.equal(missing.code, 2, "a dispatch contract without streams and engineers is not written");
  const misplaced = await cli("init", "--template", "implement", "--streams", "ux", "--out", file, "--json");
  assert.equal(misplaced.code, 2, "--streams belongs to the dispatch template");
  const init = await cli("init", "--template", "dispatch", "--run", "dispatch-cli-1", "--repo", src, "--check", "gate=true", "--streams", "ux, api", "--engineers", "alice,bob", "--unattended", "--out", file, "--json");
  assert.equal(init.code, 0, out.join("") + err.join(""));
  const plan = await cli("plan", "--config", file, "--json");
  assert.equal(plan.code, 0, out.join("") + err.join(""));
  assert.deepEqual([plan.json["ok"], plan.json["template"]], [true, "dispatch"]);
  assert.equal((await cli("plan", "--config", file, "--authorise", "--by", "alice", "--yes", "--json")).code, 0);
  const start = await cli("start", "--config", file, "--detach", "--json");
  assert.equal(start.code, 0, out.join("") + err.join(""));
  const contract = new RunStore("dispatch-cli-1", { home }).readContract();
  assert.equal(contract?.template, "dispatch");
  assert.deepEqual(contract?.templateOptions["dispatch"], { streams: ["ux", "api"], engineers: ["alice", "bob"] }, "the written contract names the streams and the engineers");
  assert.equal(contract?.promotion.policy, "local-branch", "a dispatch run gets the cycle templates' local integration branch");
  for (const verb of [["backlog", "--run", "dispatch-cli-1", "--message", "Look at the menu", "--json"], ["inbox", "--run", "dispatch-cli-1", "--json"], ["board", "--run", "dispatch-cli-1", "--json"]]) {
    const r = await cli(...verb);
    assert.equal(r.code, 0, `${verb[0] ?? ""} is available to a dispatch run: ${out.join("")}${err.join("")}`);
  }
});

const OPTIONS = { streams: ["ux"], engineers: ["alice", "bob"] };
const T0 = "2026-10-01T00:00:00.000Z";

await check("a cycle's claim: the top ready item of its stream in one locked write, an open claim continued, withheld items skipped, nothing when nothing is claimable", async () => {
  assert.deepEqual([1, 2, 3].map((n) => cycleEngineer(OPTIONS, n)), ["alice", "bob", "alice"], "engineers take the cycles in turn");
  assert.deepEqual([1, 2, 3].map((n) => cycleRotation({ streams: ["ux"], engineers: ["a", "b", "c"] }, n)), [["a", "b", "c"], ["b", "c", "a"], ["c", "a", "b"]], "each cycle offers its own engineer first, then the rest in turn");
  const control = scratch();
  writeBoard(control, { stream: "ux", items: [
    { id: "V-01", title: "blocked", priority: "P0", status: "blocked" },
    { id: "V-02", title: "owned by bob", priority: "P0", status: "in_progress", assignee: "bob", claimedAt: T0 },
    { id: "V-03", title: "top ready", priority: "P1", detail: "d3", acceptance: "a3" },
    { id: "V-04", title: "next ready", priority: "P2" },
  ] });
  // The claim waits for the board lock like `board claim` does.
  const lock = createRunLock({ file: path.join(control, "board.lock") });
  assert.equal(lock.acquire().acquired, true);
  const pending = claimForCycle(control, { options: OPTIONS, engineers: ["alice"], attempts: undefined, at: "2026-10-02T00:00:00.000Z" });
  assert.equal(await settled(pending, 300), false, "the claim waits for control/board.lock");
  assert.equal(itemOf(readBoard(control), "V-03").assignee, undefined, "nothing is written while the lock is held");
  lock.release();
  const first = await pending;
  assert.deepEqual([first.outcome, first.engineer], ["claimed", "alice"]);
  assert.deepEqual(first.board, { stream: "ux", items: [{ id: "V-03", title: "top ready", priority: "P1", detail: "d3", acceptance: "a3", assignee: "alice", claimedAt: "2026-10-02T00:00:00.000Z", status: "in_progress" }] }, "the snapshot is the one claimed item");
  const v3 = itemOf(readBoard(control), "V-03");
  assert.deepEqual([v3.assignee, v3.claimedAt, v3.status], ["alice", "2026-10-02T00:00:00.000Z", "in_progress"], "assignee, claimedAt and in_progress are on the item in one write");

  const again = await claimForCycle(control, { options: OPTIONS, engineers: ["alice"], attempts: undefined, at: "2026-10-03T00:00:00.000Z" });
  assert.deepEqual([again.outcome, again.board.items[0]?.id, again.board.items[0]?.claimedAt], ["continued", "V-03", "2026-10-02T00:00:00.000Z"], "an open claim is continued, not re-stamped");
  const bob = await claimForCycle(control, { options: OPTIONS, engineers: ["bob"], attempts: undefined, at: "2026-10-03T00:00:00.000Z" });
  assert.deepEqual([bob.outcome, bob.board.items[0]?.id], ["continued", "V-02"], "each engineer continues its own claim");

  const withheld = { "V-03": { attempts: 2, lastReason: "gate red", withheld: true } };
  const skipped = await claimForCycle(control, { options: OPTIONS, engineers: ["alice"], attempts: withheld, at: "2026-10-04T00:00:00.000Z" });
  assert.deepEqual([skipped.outcome, skipped.board.items[0]?.id], ["claimed", "V-04"], "a withheld open claim is not continued; the next ready item is claimed");
  assert.equal(dispatchCandidate(readBoard(control), OPTIONS, "carol", { "V-04": withheld["V-03"] }), null);

  const before = fs.readFileSync(path.join(control, "board.json"), "utf8");
  const empty = await claimForCycle(control, { options: OPTIONS, engineers: ["carol"], attempts: undefined, at: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual([empty.outcome, empty.board.items, empty.engineer], ["none", [], "carol"], "nothing claimable: an empty snapshot");
  assert.equal(fs.readFileSync(path.join(control, "board.json"), "utf8"), before, "and no write");
  // An engineer whose turn finds nothing does not stall another engineer's open claim.
  const fallback = await claimForCycle(control, { options: OPTIONS, engineers: ["carol", "bob"], attempts: undefined, at: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual([fallback.outcome, fallback.engineer, fallback.board.items[0]?.id], ["continued", "bob", "V-02"], "the next engineer's open claim takes the cycle");
  assert.equal(fs.readFileSync(path.join(control, "board.json"), "utf8"), before, "a continued claim writes nothing");
  writeBoard(control, { stream: "api", items: [{ id: "V-09", title: "other stream", priority: "P0" }] });
  const offStream = await claimForCycle(control, { options: OPTIONS, engineers: ["alice"], attempts: undefined, at: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual([offStream.outcome, itemOf(readBoard(control), "V-09").assignee], ["none", undefined], "a board of another stream is not this run's");
  writeBoard(control, { items: [{ id: "V-10", title: "no stream", priority: "P0" }] });
  const noStream = await claimForCycle(control, { options: OPTIONS, engineers: ["alice"], attempts: undefined, at: "2026-10-05T00:00:00.000Z" });
  assert.deepEqual([noStream.outcome, itemOf(readBoard(control), "V-10").assignee], ["none", undefined], "a board that names no stream is not this run's either");

  // A submitted item is no longer an open claim: its engineer's next cycle claims the next item.
  writeBoard(control, { stream: "ux", items: [
    { id: "V-05", title: "submitted", priority: "P0", status: "in_progress", assignee: "alice", claimedAt: T0, submittedAt: "2026-10-02T00:00:00.000Z", sha: "a".repeat(40) },
    { id: "V-06", title: "next", priority: "P1" },
  ] });
  const afterSubmit = await claimForCycle(control, { options: OPTIONS, engineers: ["alice"], attempts: undefined, at: "2026-10-06T00:00:00.000Z" });
  assert.deepEqual([afterSubmit.outcome, afterSubmit.board.items[0]?.id], ["claimed", "V-06"], "the submitted item is not continued");
  assert.equal(itemOf(readBoard(control), "V-05").submittedAt, "2026-10-02T00:00:00.000Z");

  // A board lock held past the bounded wait is BoardLockBusy, which a dispatch cycle treats as an idle poll.
  const held = createRunLock({ file: path.join(control, "board.lock") });
  assert.equal(held.acquire().acquired, true);
  await assert.rejects(claimForCycle(control, { options: OPTIONS, engineers: ["bob"], attempts: undefined, at: T0 }), BoardLockBusy);
  held.release();
  assert.deepEqual(fs.readdirSync(control).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), []);
});

await check("a submission is recorded only for the claimant, once, with a 40-character sha", async () => {
  const control = scratch();
  writeBoard(control, { items: [{ id: "V-01", title: "x", priority: "P1", status: "in_progress", assignee: "alice", claimedAt: T0 }] });
  assert.match(await recordSubmission(control, { id: "V-01", engineer: "alice", sha: "abc", at: T0 }) ?? "", /not a 40-character commit/);
  assert.match(await recordSubmission(control, { id: "V-01", engineer: "bob", sha: "a".repeat(40), at: T0 }) ?? "", /assigned to alice/);
  assert.match(await recordSubmission(control, { id: "V-07", engineer: "alice", sha: "a".repeat(40), at: T0 }) ?? "", /no longer on the board/);
  assert.equal(await recordSubmission(control, { id: "V-01", engineer: "alice", sha: "b".repeat(40), at: "2026-10-02T00:00:00.000Z" }), null);
  assert.deepEqual(itemOf(readBoard(control), "V-01"), { id: "V-01", title: "x", priority: "P1", status: "in_progress", assignee: "alice", claimedAt: T0, submittedAt: "2026-10-02T00:00:00.000Z", sha: "b".repeat(40) });
  assert.match(await recordSubmission(control, { id: "V-01", engineer: "alice", sha: "c".repeat(40), at: T0 }) ?? "", /already submitted/);
});

await check("rewritten or discarded integration history revises the recorded submissions of the run's engineers", async () => {
  const control = scratch();
  const claim = { priority: "P1", status: "in_progress", claimedAt: T0, submittedAt: "2026-10-02T00:00:00.000Z" } as const;
  writeBoard(control, { stream: "ux", items: [
    { id: "V-01", title: "kept", assignee: "alice", sha: "a".repeat(40), ...claim },
    { id: "V-02", title: "rebased", assignee: "alice", sha: "b".repeat(40), ...claim },
    { id: "V-03", title: "discarded", assignee: "bob", sha: "c".repeat(40), ...claim },
    { id: "V-04", title: "another run's", assignee: "carol", sha: "d".repeat(40), ...claim },
  ] });
  const map = new Map([["b".repeat(40), "e".repeat(40)], ["c".repeat(40), null], ["d".repeat(40), null]]);
  const revised = await reviseSubmissions(control, ["alice", "bob"], (sha) => (map.has(sha) ? map.get(sha) ?? null : sha));
  assert.deepEqual(revised, [{ id: "V-02", from: "b".repeat(40), to: "e".repeat(40) }, { id: "V-03", from: "c".repeat(40), to: null }]);
  const board = readBoard(control);
  assert.equal(itemOf(board, "V-01").sha, "a".repeat(40));
  assert.equal(itemOf(board, "V-02").sha, "e".repeat(40), "a rebased submission follows its commit");
  const reopened = itemOf(board, "V-03");
  assert.deepEqual([reopened.assignee, reopened.status, reopened.submittedAt, reopened.sha], ["bob", "in_progress", undefined, undefined], "a discarded submission is an open claim again");
  assert.equal(itemOf(board, "V-04").sha, "d".repeat(40), "only the run's own engineers' submissions are revised");
  const before = fs.readFileSync(path.join(control, "board.json"), "utf8");
  assert.deepEqual(await reviseSubmissions(control, ["alice", "bob"], (sha) => sha), []);
  assert.equal(fs.readFileSync(path.join(control, "board.json"), "utf8"), before, "nothing revised: no write");
});

await check("board --file keeps claims written since the steward read the board", async () => {
  const T1 = "2026-10-03T00:00:00.000Z";
  const onDisk = { stream: "ux", items: [
    { id: "V-01", title: "claimed", priority: "P1", status: "in_progress", assignee: "alice", claimedAt: T0 },
    { id: "V-02", title: "submitted", priority: "P1", status: "in_progress", assignee: "bob", claimedAt: T0, submittedAt: T1, sha: "a".repeat(40) },
    { id: "V-03", title: "reassigned", priority: "P1", status: "in_progress", assignee: "carol", claimedAt: T0 },
    { id: "V-04", title: "blocked", priority: "P1", status: "in_progress", assignee: "dave", claimedAt: T0 },
    { id: "V-05", title: "dropped", priority: "P1", status: "in_progress", assignee: "erin", claimedAt: T0 },
  ] };
  const stale = { stream: "ux", items: [
    { id: "V-01", title: "claimed, retitled", priority: "P0", status: "ready" },
    { id: "V-02", title: "submitted", priority: "P1", status: "in_progress", assignee: "bob", claimedAt: T0 },
    { id: "V-03", title: "reassigned", priority: "P1", status: "in_progress", assignee: "frank", claimedAt: T1 },
    { id: "V-04", title: "blocked", priority: "P1", status: "blocked" },
    { id: "V-06", title: "new", priority: "P2" },
  ] };
  const pure = keepHostClaims(validateBoard(onDisk), validateBoard(stale));
  assert.deepEqual(pure.kept, ["V-01", "V-02", "V-04"]);
  const home = scratch();
  const control = newRun(home, "keep-run", "dispatch");
  writeBoard(control, onDisk);
  const source = path.join(scratch(), "board.json");
  writeBoard(path.dirname(source), stale);
  const saved = await runCli(home, ["board", "--run", "keep-run", "--file", source, "--json"]);
  assert.equal(saved.code, 0, saved.stderr);
  const board = readBoard(control);
  assert.deepEqual(board, pure.board, "the CLI writes the merged board");
  assert.deepEqual(itemOf(board, "V-01"), { id: "V-01", title: "claimed, retitled", priority: "P0", status: "in_progress", assignee: "alice", claimedAt: T0 }, "a claim the file leaves out is kept, with the steward's other edits");
  assert.deepEqual([itemOf(board, "V-02").submittedAt, itemOf(board, "V-02").sha], [T1, "a".repeat(40)], "a submission recorded since is kept");
  assert.deepEqual([itemOf(board, "V-03").assignee, itemOf(board, "V-03").claimedAt], ["frank", T1], "naming another assignee reassigns");
  assert.deepEqual([itemOf(board, "V-04").assignee, itemOf(board, "V-04").status], ["dave", "blocked"], "the file may block a claimed item");
  assert.equal(board.items.some((i) => i.id === "V-05"), false, "an item the file drops is dropped");
  assert.equal(itemOf(board, "V-06").assignee, undefined);
});

const note = (t: ScriptContext, board: string): void => t.note(`Outcome: successful\nMode: fix\n\n${board}\n`);
const merging = async (system: string): Promise<string> => (/You review one cycle/.test(system) ? JSON.stringify({ verdict: "MERGE", reason: "evidenced and tested", concerns: [] }) : JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 }));

await check("dispatch cycles end to end: each prompt carries only its claimed item, a done merge records submittedAt and sha, and an open claim is continued", async () => {
  const prompts: string[] = [];
  const h = harness(dispatchRaw(greenRepo(), { templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, dispatch: { streams: ["ux"], engineers: ["alice", "bob"] } } }), {
    manager: merging,
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", `step ${t.step}\n`);
      note(t, t.step === 1 ? "Board: V-02 done - Keyboard menu with tests." : "Board: V-04 progress - Started the export.");
      t.commit(`cycle ${t.step}`);
    },
  });
  writeBoard(h.store.p.control, { stream: "ux", items: [
    { id: "V-01", title: "Blocked redesign", priority: "P0", status: "blocked" },
    { id: "V-02", title: "Keyboard menu", priority: "P1", detail: "Arrow keys move the selection.", acceptance: "A tested keyboard workflow." },
    { id: "V-03", title: "Colour themes", priority: "P2", detail: "Dark and light.", acceptance: "Both themes render." },
    { id: "V-04", title: "Export to CSV", priority: "P0", status: "in_progress", assignee: "bob", claimedAt: T0, detail: "One file per table.", acceptance: "A CSV round-trips." },
  ] });
  const { state, rt } = await runOnce(h);
  assert.equal(prompts.length, 2, JSON.stringify(state.outcome));
  const [first = "", second = ""] = prompts;
  // The board section of a prompt; the rest may quote the previous cycle's note.
  const assigned = (prompt: string): string => prompt.split("## Assigned work")[1]?.split("\n\n")[0] ?? "";
  assert.match(first, /## Assigned work \(dispatch: one claimed item\)/);
  assert.match(first, /ONE board item claimed for this cycle by alice \(stream ux\)/);
  for (const text of ["V-02 [P1] Keyboard menu", "Arrow keys move the selection.", "Acceptance: A tested keyboard workflow.", "Board: V-02 done|progress|blocked"]) assert.ok(first.includes(text), `cycle 1 prompt has ${text}`);
  assert.doesNotMatch(first, /V-01|V-03|V-04|Colour themes|Export to CSV|Blocked redesign/, "no other item reaches the prompt");
  assert.match(second, /claimed for this cycle by bob/);
  for (const text of ["V-04 [P0] Export to CSV", "One file per table.", "Acceptance: A CSV round-trips."]) assert.ok(second.includes(text), `cycle 2 prompt has ${text}`);
  assert.doesNotMatch(assigned(second), /V-02|V-03|Keyboard menu/, "bob continues his open claim; the submitted item is not offered again");
  assert.deepEqual(state.selfImprove?.history.map((c) => c.merged), [true, true]);

  const board = readBoard(h.store.p.control);
  const done = itemOf(board, "V-02");
  assert.deepEqual([done.assignee, done.status], ["alice", "in_progress"]);
  assert.ok(done.claimedAt !== undefined && done.submittedAt !== undefined && done.submittedAt >= done.claimedAt, "claimed, then submitted");
  assert.match(done.sha ?? "", /^[0-9a-f]{40}$/);
  const g = rt.repo.g;
  assert.ok(g, "the host mirror is open");
  assert.notEqual(g(["merge-base", "--is-ancestor", done.sha ?? "", "refs/heads/pi-autonomy/integration"], { allowFail: true }), null, "the sha is on the integration branch");
  assert.equal(g(["show", `${done.sha ?? ""}:AUDIT_OK`]), "step 1", "the sha is the integration head the done cycle merged");
  const progress = itemOf(board, "V-04");
  assert.deepEqual([progress.assignee, progress.claimedAt, progress.submittedAt, progress.sha], ["bob", T0, undefined, undefined], "a progress report records nothing");
  assert.deepEqual(itemOf(board, "V-03"), { id: "V-03", title: "Colour themes", priority: "P2", detail: "Dark and light.", acceptance: "Both themes render." }, "an unclaimed item is untouched");
  assert.deepEqual(state.selfImprove?.history[0]?.board, [{ id: "V-02", status: "done", note: "Keyboard menu with tests." }]);
});

await check("dispatch cycles: when the cycle's engineer has nothing, another engineer's open claim is continued instead of the run idling", async () => {
  const prompts: string[] = [];
  let sleeps = 0;
  const h = harness(dispatchRaw(greenRepo(), { templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, dispatch: { streams: ["ux"], engineers: ["alice", "bob"] } } }), {
    manager: merging,
    hooks: { onSleep: () => { sleeps++; if (sleeps > 3) h.store.enqueue("cancel"); } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", `step ${t.step}\n`);
      note(t, t.step === 1 ? "Board: V-02 progress - Half the keys work." : "Board: V-02 done - All keys work, with tests.");
      t.commit(`cycle ${t.step}`);
    },
  });
  writeBoard(h.store.p.control, { stream: "ux", items: [{ id: "V-02", title: "Keyboard menu", priority: "P1", detail: "Arrow keys.", acceptance: "A tested keyboard workflow." }] });
  const { state } = await runOnce(h);
  assert.equal(prompts.length, 2, `both cycles run: ${JSON.stringify(state.outcome)}`);
  const [first = "", second = ""] = prompts;
  assert.match(first, /claimed for this cycle by alice/);
  assert.match(second, /claimed for this cycle by alice/, "cycle 2 is bob's turn, but bob has nothing: alice's open claim takes it");
  assert.ok(second.includes("V-02 [P1] Keyboard menu"));
  const v2 = itemOf(readBoard(h.store.p.control), "V-02");
  assert.equal(v2.assignee, "alice");
  assert.match(v2.sha ?? "", /^[0-9a-f]{40}$/, "the continued claim's done merge records the submission for alice");
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /cycle 02 dispatch: continued V-02 for alice/);
});

await check("a dispatch cycle that finds the board lock busy past the bounded wait polls again instead of pausing the run", async () => {
  let lock: ReturnType<typeof createRunLock> | null = null;
  let sessions = 0;
  const h = harness(dispatchRaw(greenRepo()), {
    manager: merging,
    hooks: { onSleep: () => { lock?.release(); h.store.enqueue("cancel"); } },
    script: async () => { sessions++; },
  });
  writeBoard(h.store.p.control, { stream: "ux", items: [{ id: "V-01", title: "ready", priority: "P1" }] });
  const boardLock = createRunLock({ file: path.join(h.store.p.control, "board.lock") });
  assert.equal(boardLock.acquire().acquired, true);
  lock = boardLock;
  const { state } = await runOnce(h);
  assert.notEqual(state.status, "paused", JSON.stringify(state.outcome));
  assert.equal(sessions, 0);
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /dispatch: the board lock is busy/);
  assert.equal(itemOf(readBoard(h.store.p.control), "V-01").assignee, undefined, "nothing was claimed while the lock was held");
});

await check("a dispatch run with nothing claimable sleeps with no worker session or model call", async () => {
  let sessions = 0;
  let calls = 0;
  const h = harness(dispatchRaw(greenRepo()), {
    manager: async (system) => { calls++; return merging(system); },
    hooks: { onSleep: () => { if (h.state().selfImprove?.idle) h.store.enqueue("cancel"); } },
    script: async () => { sessions++; },
  });
  writeBoard(h.store.p.control, { stream: "ux", items: [
    { id: "V-01", title: "blocked", priority: "P0", status: "blocked" },
    { id: "V-02", title: "someone else's", priority: "P1", status: "in_progress", assignee: "carol", claimedAt: T0 },
    { id: "V-03", title: "approved", priority: "P1", verdict: "approved" },
  ] });
  const { state } = await runOnce(h);
  assert.equal(sessions, 0, "no worker session starts");
  assert.equal(calls, 0, "no manager or review call");
  assert.ok(state.selfImprove?.idle, "the host sleeps on the empty queue");
  assert.deepEqual(readBoard(h.store.p.control).items.map((i) => i.assignee ?? null), [null, "carol", null], "nothing is claimed");
});

for (const dir of dirs) rm(dir);
cleanupHarness();
done();
