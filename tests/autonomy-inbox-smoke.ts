#!/usr/bin/env node
/** `pi-autonomy inbox`: owner cards, their deadlines, and the board items they unblock. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, makeChecker, testEffort, type RawContract } from "./autonomy-helpers.ts";
import { cleanup, harness, scratch, NODE_EXIT } from "./autonomy-harness.ts";
import { main } from "../packages/autonomy/cli.ts";

const { check, done } = makeChecker("autonomy-inbox-smoke");

function sourceRepo(): string {
  const src = scratch();
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: src, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  git("add", "."); git("commit", "--quiet", "-m", "base");
  return src;
}

const improveRaw = (src: string): RawContract => ({
  schemaVersion: 1, run: "inbox-test-1", template: "self-improve",
  objective: { title: "Improve", spec: "Keep the inbox test focused.", backlog: [] },
  inputs: { repository: { path: src, ref: "main" } },
  acceptance: { checks: [{ id: "gate", run: NODE_EXIT("true"), timeoutMinutes: 1, required: true }], review: false },
  permissions: { unattended: { authorised: true, autoApprove: true } },
  budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 4, maxMinutes: 600 },
  promotion: { policy: "none", destinations: [] },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: false } },
});

const h = harness(improveRaw(sourceRepo()));
const run = h.contract.run;
const control = h.store.p.control;
const boardFile = path.join(control, "board.json");
const inboxFile = path.join(control, "inbox.json");
const stateBefore = fs.readFileSync(h.store.p.state, "utf8");
const call = async (...argv: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const code = await main(argv, {
    home: h.home, effort: testEffort, isTTY: false, signals: false, pid: 9001,
    now: () => new Date(h.clock.now), stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) },
    lockOptions: { host: "test-host", now: () => h.clock.now, isAlive: () => true, startTimeOf: () => "start-9001", staleMs: 120_000, heartbeatMs: 3_600_000 },
  });
  return { code, stdout: out.join(""), stderr: err.join(""), json: () => JSON.parse(out.join("")) as Record<string, unknown> };
};
const writeJson = (file: string, value: unknown): void => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const items = () => (JSON.parse(fs.readFileSync(boardFile, "utf8")) as { items: Array<{ id: string; status: string }> }).items;
const cards = () => (JSON.parse(fs.readFileSync(inboxFile, "utf8")) as { cards: Array<{ id: string; outcome?: { at: string; via: string; text: string } }> }).cards;
const card = (id: string) => { const c = cards().find((x) => x.id === id); assert.ok(c, `card ${id}`); return c; };

await check("an answered card and a past-due card settle and unblock their items; an open card leaves its item blocked", async () => {
  writeJson(boardFile, { stream: "ux", items: [
    { id: "OWN-1", title: "Use the recommended default", priority: "P1", status: "blocked" },
    { id: "OWN-2", title: "Keep the local branch", priority: "P2", status: "blocked" },
    { id: "OWN-3", title: "Ship it", priority: "P2", status: "blocked" },
  ] });
  const source = path.join(scratch(), "cards.json");
  writeJson(source, { cards: [
    { id: "D1", question: "Which default?", default: "A", deadline: "2026-10-02T00:00:00Z", board: "OWN-1", answer: "Use the recommended default" },
    { id: "D2", question: "Which branch?", default: "Keep the local branch", deadline: "2026-09-29T00:00:00Z", board: "OWN-2" },
    { id: "D3", question: "Ship now?", default: "Hold", deadline: "2026-10-02T00:00:00Z", board: "OWN-3" },
  ] });
  const saved = await call("inbox", "--run", run, "--file", source);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(fs.statSync(inboxFile).mode & 0o777, 0o600, "the inbox is host-only");

  const listed = await call("inbox", "--run", run, "--json");
  assert.equal(listed.code, 0, listed.stderr);
  const data = listed.json();
  assert.deepEqual(data.decided, ["D1", "D2"]);
  assert.deepEqual(data.unblocked, ["OWN-1", "OWN-2"]);
  assert.equal(card("D1").outcome?.via, "answer");
  assert.equal(card("D1").outcome?.text, "Use the recommended default");
  assert.equal(card("D2").outcome?.via, "deadline");
  assert.equal(card("D2").outcome?.text, "Keep the local branch");
  assert.equal(card("D3").outcome, undefined);
  assert.deepEqual(items().map((i) => [i.id, i.status]), [["OWN-1", "ready"], ["OWN-2", "ready"], ["OWN-3", "blocked"]]);
  const shown = await call("inbox", "--run", run);
  assert.match(shown.stdout, /board: OWN-1/);
});

await check("settling is idempotent: a second read changes no outcome and decides nothing", async () => {
  const before = card("D2").outcome?.at;
  const again = await call("inbox", "--run", run, "--json");
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json().decided, []);
  assert.equal(card("D2").outcome?.at, before);
  assert.equal(items().find((i) => i.id === "OWN-3")?.status, "blocked");
});

await check("an answer after the list records the owner's text and unblocks the item", async () => {
  const answered = await call("inbox", "--run", run, "--answer", "D3", "--value", "Ship it", "--json");
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(answered.json().decided, ["D3"]);
  assert.equal(card("D3").outcome?.via, "answer");
  assert.equal(card("D3").outcome?.text, "Ship it");
  assert.equal(items().find((i) => i.id === "OWN-3")?.status, "ready");
  const repeated = await call("inbox", "--run", run, "--answer", "D3", "--value", "Changed my mind");
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(card("D3").outcome?.text, "Ship it", "a recorded outcome is never rewritten");
  assert.equal(fs.readFileSync(h.store.p.state, "utf8"), stateBefore, "the inbox only records; it never writes run state");
});

await check("bad input is refused and leaves the previous inbox untouched", async () => {
  const before = fs.readFileSync(inboxFile, "utf8");
  const dir = scratch();
  const invalid: Array<[string, unknown]> = [
    ["unknown key", { cards: [{ id: "X1", question: "q", default: "d", deadline: "2026-10-02T00:00:00Z", extra: 1 }] }],
    ["duplicate ids", { cards: [{ id: "X1", question: "q", default: "d", deadline: "2026-10-02T00:00:00Z" }, { id: "X1", question: "q", default: "d", deadline: "2026-10-02T00:00:00Z" }] }],
    ["bad deadline", { cards: [{ id: "X1", question: "q", default: "d", deadline: "not-a-date" }] }],
    ["missing default", { cards: [{ id: "X1", question: "q", deadline: "2026-10-02T00:00:00Z" }] }],
  ];
  for (const [name, value] of invalid) {
    const file = path.join(dir, `${name.replaceAll(" ", "-")}.json`);
    writeJson(file, value);
    const r = await call("inbox", "--run", run, "--file", file);
    assert.equal(r.code, 2, `${name}: ${r.stderr}`);
    assert.equal(fs.readFileSync(inboxFile, "utf8"), before, `${name} left the inbox unchanged`);
  }
  const unknown = await call("inbox", "--run", run, "--answer", "UNKNOWN", "--value", "x");
  assert.equal(unknown.code, 3, unknown.stderr);
  const noValue = await call("inbox", "--run", run, "--answer", "D3");
  assert.equal(noValue.code, 2, noValue.stderr);
  const tooLong = await call("inbox", "--run", run, "--answer", "D3", "--value", "x".repeat(2001));
  assert.equal(tooLong.code, 2, tooLong.stderr);
  assert.equal(fs.readFileSync(inboxFile, "utf8"), before, "an oversized answer is refused before it is written");
});

await check("the inbox is only for self-improve runs", async () => {
  const other = harness({ schemaVersion: 1, run: "inbox-implement-1", template: "implement", objective: { title: "x", spec: "y", backlog: [] }, inputs: {}, acceptance: { checks: [{ id: "gate", run: NODE_EXIT("true"), timeoutMinutes: 1, required: true }], review: false }, budget: { totalUsd: 1, perStepUsd: 1, maxSteps: 1, maxMinutes: 10 } });
  const out: string[] = [];
  const r = await main(["inbox", "--run", other.contract.run, "--json"], { home: other.home, effort: testEffort, isTTY: false, signals: false, pid: 9002, now: () => new Date(other.clock.now), stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => {} } });
  assert.equal(r, 3);
  assert.equal((JSON.parse(out.join("")) as { code: string }).code, "refused");
});

cleanup();
done();
