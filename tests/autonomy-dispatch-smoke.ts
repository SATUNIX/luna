#!/usr/bin/env node
/**
 * Offline tests of the host-owned steward board's atomic claim (A-92b): the extended item metadata
 * is validated strictly and never defaulted; two REAL child processes race `board claim` through
 * the CLI under control/board.lock and exactly one wins; the loser names the winner; a re-claim by
 * the same agent is idempotent; blocked, missing and malformed items are refused; and both a claim
 * and `board --file` wait for the board lock. No container or provider is involved.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimBoardItem, claimNextItem, ITEM_KEYS, type StewardBoard, validateBoard } from "../packages/autonomy/lib/board.ts";
import { createRunLock } from "../packages/autonomy/lib/runlock.ts";
import { makeChecker, rm, tempDir } from "./autonomy-helpers.ts";

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
  writeBoard(path.dirname(source), { items: [{ id: "V-01", title: "Uploaded", priority: "P0" }] });
  const upload = runCli(home, ["board", "--run", "lock-run", "--file", source, "--json"]);
  assert.equal(await settled(upload, 300), false, "board --file waits for the board lock");
  assert.equal(readBoard(control).items[0]?.title, EXTENDED.title, "nothing is written while the lock is held");
  lock.release();
  assert.equal((await upload).code, 0);
  assert.equal(readBoard(control).items[0]?.title, "Uploaded");

  const claimLock = createRunLock({ file: lockFile });
  assert.equal(claimLock.acquire().acquired, true);
  const claim = runCli(home, ["board", "claim", "V-01", "--run", "lock-run", "--by", "alice", "--json"]);
  assert.equal(await settled(claim, 300), false, "claim waits for the board lock");
  assert.equal(itemOf(readBoard(control), "V-01").assignee, undefined);
  claimLock.release();
  const claimed = await claim;
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.deepEqual([itemOf(readBoard(control), "V-01").assignee, itemOf(readBoard(control), "V-01").status], ["alice", "in_progress"]);
  assert.deepEqual(fs.readdirSync(control).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), []);
});

for (const dir of dirs) rm(dir);
done();
