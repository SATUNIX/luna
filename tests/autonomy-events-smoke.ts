#!/usr/bin/env node
/**
 * The host event log (packages/autonomy/lib/events.ts) and its reader, `pi-autonomy events`:
 *   - a dispatch cycle through the engine (fake runtime, real git) writes run.started, run.status,
 *     dispatch.claim, cycle.started, gate.result, dispatch.submit, push and cycle.ended, in order;
 *   - a finite (implement) run writes its run.* events;
 *   - `events` returns them in file order and filters by --since (ISO or duration), --run, --type
 *     (a type or a family) and --limit; text output is one line per event;
 *   - lines that are not events are skipped and counted; rotation keeps the order;
 *   - free text is redacted and every field bounded; the file is mode 0600;
 *   - a symbolic link at the log's name is refused by the writer and the reader;
 *   - a log that cannot be written never fails the run;
 *   - a publication that keeps failing writes one failed `push` per distinct error, not one per retry;
 *   - a secret split by a hidden character is joined before redaction, and multi-byte text is
 *     bounded in bytes so the event is written, not dropped;
 *   - rotation happens only under the rotation lock (a held lock defers it, a stale one is taken).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, makeChecker, rm, tempDir, type RawContract } from "./autonomy-helpers.ts";
import { cleanup, harness, NODE_EXIT, runOnce, simpleRaw, solve, type ScriptContext } from "./autonomy-harness.ts";
import { main } from "../packages/autonomy/cli.ts";
import { EVENTS_FILE, EVENTS_ROTATED, EVENTS_ROTATE_LOCK, MAX_LINE_BYTES, type EventInput, type HostEvent, appendEvent, parseEvent, readEvents, redactEventText } from "../packages/autonomy/lib/events.ts";
import { UnsafePathError } from "../packages/core/shared/safe-fs.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

const { check, done } = makeChecker("autonomy-events-smoke");
const dirs: string[] = [];
const scratch = (): string => { const d = tempDir("autonomy-events-"); dirs.push(d); return d; };
const SECRET = "ghp" + "_" + "c".repeat(36);

/** Run `pi-autonomy <argv>` in-process against `home`. */
async function cli(home: string, argv: readonly string[], now = new Date("2026-10-01T12:00:00Z")): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await main(argv, { signals: false, home, now: () => now, stdout: { write: (s: string): number => out.push(s) }, stderr: { write: (s: string): number => err.push(s) } });
  return { code, out: out.join(""), err: err.join("") };
}

/** The events of a `--json` reply, each through the strict parser. */
function jsonEvents(out: string): HostEvent[] {
  const reply = parseJson(out);
  assert.ok(isRecord(reply) && reply.ok === true && Array.isArray(reply.events), out);
  return reply.events.map((e: unknown) => { const ev = parseEvent(e); assert.ok(ev, JSON.stringify(e)); return ev; });
}

/** True when `want` occurs in `seen` in order (other entries may come between). */
function inOrder(seen: readonly string[], want: readonly string[]): boolean {
  let i = 0;
  for (const s of seen) if (s === want[i]) i += 1;
  return i === want.length;
}

const git = (cwd: string, args: readonly string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

function greenRepo(): string {
  const src = scratch();
  git(src, ["init", "--quiet", "-b", "main"]);
  fs.writeFileSync(path.join(src, "AUDIT_OK"), "base\n");
  git(src, ["add", "."]);
  git(src, ["commit", "--quiet", "-m", "base"]);
  return src;
}

const dispatchRaw = (src: string): RawContract => ({
  schemaVersion: 1, run: "events-dispatch-1", template: "dispatch",
  objective: { title: "Dispatch", spec: "Work the claimed board item." },
  inputs: { repository: { path: src, ref: "main" } },
  acceptance: { checks: [{ id: "gate", run: NODE_EXIT("require('fs').existsSync('AUDIT_OK')"), timeoutMinutes: 1, required: true }], review: true },
  permissions: { unattended: { authorised: true, autoApprove: true } },
  budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
  promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", repo: src, branch: "pi-autonomy/integration" }] },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, dispatch: { streams: ["ux"], engineers: ["alice"] } },
});
const merging = async (system: string): Promise<string> => (/You review one cycle/.test(system) ? JSON.stringify({ verdict: "MERGE", reason: "evidenced and tested", concerns: [] }) : JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 }));

await check("a dispatch cycle writes the documented event sequence, and `events --since` returns it in order", async () => {
  const h = harness(dispatchRaw(greenRepo()), {
    manager: merging,
    script: async (t: ScriptContext) => { t.write("AUDIT_OK", "step 1\n"); t.note("Outcome: successful\nMode: fix\n\nBoard: V-02 done - Keyboard menu with tests.\n"); t.commit("cycle 1"); },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ stream: "ux", items: [{ id: "V-02", title: "Keyboard menu", priority: "P1", acceptance: "A tested keyboard workflow." }] }));
  const { state } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.merged, true, JSON.stringify(state.outcome));

  const { events, skipped } = readEvents(h.home);
  assert.equal(skipped, 0);
  assert.ok(events.every((e) => e.run === "events-dispatch-1" && e.v === 1));
  const types = events.map((e) => e.type);
  const sequence = ["run.status", "run.started", "run.status", "dispatch.claim", "cycle.started", "gate.result", "dispatch.submit", "push", "cycle.ended"];
  assert.ok(inOrder(types, sequence), types.join(" "));
  const statuses = events.flatMap((e) => (e.type === "run.status" ? [`${e.from}>${e.to}`] : []));
  assert.deepEqual(statuses.slice(0, 2), ["setup>ready", "ready>running"]);
  const find = <T extends HostEvent["type"]>(type: T): Extract<HostEvent, { type: T }> => {
    const e = events.find((x): x is Extract<HostEvent, { type: T }> => x.type === type);
    assert.ok(e, `a ${type} event`);
    return e;
  };
  const started = find("cycle.started");
  assert.deepEqual([started.n, started.resume, started.engineer, started.item], [1, false, "alice", "V-02"]);
  const gate = find("gate.result");
  assert.deepEqual([gate.n, gate.green, gate.failing], [1, true, []]);
  assert.match(gate.sha, /^[0-9a-f]{40}$/);
  const ended = find("cycle.ended");
  assert.deepEqual([ended.n, ended.outcome, ended.gate, ended.merged, ended.mergeReason], [1, "completed", "green", true, undefined]);
  const submit = find("dispatch.submit");
  assert.deepEqual([submit.item, submit.engineer], ["V-02", "alice"]);
  const push = find("push");
  assert.deepEqual([push.ok, push.branch], [true, "pi-autonomy/integration"]);
  assert.equal(find("dispatch.claim").outcome.length > 0, true);
  assert.equal(fs.statSync(path.join(h.home, EVENTS_FILE)).mode & 0o777, 0o600, "the log is the user's alone");

  const r = await cli(h.home, ["events", "--since", "2026-01-01T00:00:00Z", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(jsonEvents(r.out), events, "the verb returns the file's events in file order");
  const text = await cli(h.home, ["events", "--since", "2026-01-01T00:00:00Z"]);
  assert.equal(text.out.trim().split("\n").length, events.length, "one line per event");
  assert.match(text.out, /events-dispatch-1 gate\.result n=1 sha=[0-9a-f]{40} green=true failing=/);
});

await check("a finite run writes its run events; a log that cannot be written never fails the run", async () => {
  const ok = harness(simpleRaw({ run: "events-finite-1" }), { script: solve });
  const done1 = await runOnce(ok);
  assert.equal(done1.state.status, "succeeded");
  const types = readEvents(ok.home).events.map((e) => e.type);
  assert.ok(inOrder(types, ["run.status", "run.started", "run.status"]), types.join(" "));
  const last = readEvents(ok.home, { types: ["run.status"] }).events.at(-1);
  assert.ok(last?.type === "run.status" && last.to === "succeeded");

  const blocked = harness(simpleRaw({ run: "events-finite-2" }), { script: solve });
  fs.mkdirSync(path.join(blocked.home, EVENTS_FILE)); // a directory where the log goes: every append fails
  const done2 = await runOnce(blocked);
  assert.equal(done2.state.status, "succeeded", "the run is not failed by its event log");
  assert.match(fs.readFileSync(blocked.store.p.log, "utf8"), /event log: run\.status event not written/);
});

await check("a publication that keeps failing writes one failed push event, not one per retry", async () => {
  const src = greenRepo();
  const bare = scratch();
  git(bare, ["init", "--quiet", "--bare"]);
  // The remote refuses every push with the same message, counting them: the seed, the cycle start,
  // the cycle's ticks and the merge each retry the publication.
  const hook = path.join(bare, "hooks", "pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh\necho refused >> "${bare}/refusals"\necho "remote refused" >&2\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
  const raw: RawContract = {
    schemaVersion: 1, run: "events-push-1", template: "self-improve",
    objective: { title: "Improve", spec: "Fix what is broken.", backlog: [{ id: "B-1", title: "Add the marker", detail: "AUDIT_OK must say step 1." }] },
    inputs: { repository: { path: src, ref: "main" } },
    acceptance: { checks: [{ id: "gate", run: NODE_EXIT("require('fs').existsSync('AUDIT_OK')"), timeoutMinutes: 1, required: true }], review: true },
    permissions: { unattended: { authorised: true, autoApprove: true } },
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 8, maxMinutes: 5000 },
    promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: false }], requiresOperatorApproval: false },
    templateOptions: { integration: { branch: "pi-autonomy/integration", review: true } },
  };
  const h = harness(raw, {
    manager: merging,
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    hooks: { onSleep: () => { if (h.state().selfImprove?.idle) fs.writeFileSync(path.join(h.store.p.root, "STOP"), ""); } },
    script: async (t: ScriptContext) => {
      t.write("AUDIT_OK", "step 1\n");
      t.note("Outcome: successful\nMode: fix\n\nDone.\n");
      t.commit("add the marker");
      t.write("autonomy/BACKLOG.md", "# Backlog\n\n| ID | Status | Priority | Item | Source |\n|----|--------|----------|------|--------|\n| B-1 | done | P2 | Add the marker | brief |\n");
      t.commit("backlog done");
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.merged, true, JSON.stringify(state.outcome));
  const refusals = fs.readFileSync(path.join(bare, "refusals"), "utf8").trim().split("\n").length;
  assert.ok(refusals >= 2, `the publication was retried while it failed (${refusals} refusals)`);
  const pushes = readEvents(h.home, { types: ["push"] }).events;
  assert.equal(pushes.length, 1, `one failed push event for ${refusals} refusals with one message`);
  assert.ok(pushes[0]?.type === "push" && !pushes[0].ok && pushes[0].sha === null && /remote refused/.test(pushes[0].error ?? ""));
  assert.equal(state.selfImprove?.publishError?.includes("remote refused"), true);
});

const at = (minute: number): string => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const statusEvent = (run: string, to: string): EventInput => ({ type: "run.status", run, from: "running", to, reason: null });

await check("events filters by --since (ISO or duration), --run, --type and --limit, in file order", async () => {
  const home = scratch();
  const log: string[] = [];
  const write = (e: EventInput, minute: number): void => { assert.ok(appendEvent(home, e, (l) => log.push(l), { at: at(minute) })); };
  write(statusEvent("a", "paused"), 0);
  write({ type: "cycle.started", run: "b", n: 1, resume: false }, 10);
  write({ type: "cycle.ended", run: "a", n: 1, outcome: "completed", gate: "green", merged: true, reason: "done" }, 20);
  write({ type: "failure", run: "b", code: "worker_unavailable", detail: "no engine" }, 30);
  assert.deepEqual(log, []);
  const ids = (out: string): string[] => jsonEvents(out).map((e) => `${e.run}:${e.type}`);
  assert.deepEqual(ids((await cli(home, ["events", "--json"])).out), ["a:run.status", "b:cycle.started", "a:cycle.ended", "b:failure"]);
  assert.deepEqual(ids((await cli(home, ["events", "--since", at(20), "--json"])).out), ["a:cycle.ended", "b:failure"]);
  assert.deepEqual(ids((await cli(home, ["events", "--since", "30m", "--json"], new Date(at(50)))).out), ["a:cycle.ended", "b:failure"], "a duration counts back from now");
  assert.deepEqual(ids((await cli(home, ["events", "--run", "b", "--json"])).out), ["b:cycle.started", "b:failure"]);
  assert.deepEqual(ids((await cli(home, ["events", "--type", "cycle", "--json"])).out), ["b:cycle.started", "a:cycle.ended"], "a family names its types");
  assert.deepEqual(ids((await cli(home, ["events", "--type", "failure,run.status", "--json"])).out), ["a:run.status", "b:failure"]);
  assert.deepEqual(ids((await cli(home, ["events", "--limit", "2", "--json"])).out), ["a:cycle.ended", "b:failure"], "the most recent, still oldest first");
  assert.equal((await cli(home, ["events", "--type", "nonsense"])).code, 2);
  assert.equal((await cli(home, ["events", "--since", "yesterday"])).code, 2);
  assert.equal((await cli(home, ["events", "--since", "999999999d"])).code, 2, "a duration beyond the earliest time is a usage error");
  assert.equal((await cli(home, ["events", "--limit", "-1"])).code, 2);
  assert.match((await cli(scratch(), ["events"])).out, /no events under/);
});

await check("lines that are not events are skipped and counted; a bounded writer never writes one", async () => {
  const home = scratch();
  const log: string[] = [];
  appendEvent(home, statusEvent("a", "paused"), (l) => log.push(l), { at: at(1) });
  const file = path.join(home, EVENTS_FILE);
  fs.appendFileSync(file, ["not json", JSON.stringify({ v: 2, at: at(2), run: "a", type: "run.status", from: "x", to: "y", reason: null }), JSON.stringify({ v: 1, at: at(2), run: "a", type: "unknown.kind" }), JSON.stringify({ v: 1, at: "yesterday", run: "a", type: "failure", code: "x", detail: "" }), `{"pad":"${"x".repeat(MAX_LINE_BYTES)}"}`, ""].join("\n"));
  appendEvent(home, statusEvent("a", "running"), (l) => log.push(l), { at: at(3) });
  const r = readEvents(home);
  assert.deepEqual(r.events.map((e) => e.type === "run.status" && e.to), ["paused", "running"]);
  assert.equal(r.skipped, 5);
  assert.match((await cli(home, ["events"])).out, /5 line\(s\) that are not events were skipped/);

  // Free text is redacted and clipped, lists capped, identifiers made one visible line.
  appendEvent(home, { type: "failure", run: "a\nb", code: "boom", detail: `token ${SECRET} ${"y".repeat(10_000)}` }, (l) => log.push(l), { at: at(4) });
  appendEvent(home, { type: "gate.result", run: "a", n: 2, sha: "a".repeat(40), green: false, failing: Array.from({ length: 50 }, (_, i) => `check-${i}-${"z".repeat(300)}`) }, (l) => log.push(l), { at: at(5) });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(SECRET), "a secret in free text is redacted");
  for (const line of raw.split("\n").filter(Boolean).slice(-2)) assert.ok(Buffer.byteLength(line) < MAX_LINE_BYTES, `bounded line of ${Buffer.byteLength(line)} bytes`);
  const [failure, gate] = readEvents(home, { since: at(4) }).events;
  assert.ok(failure?.type === "failure" && failure.run === "a b" && failure.detail.length <= 500);
  assert.ok(gate?.type === "gate.result" && gate.failing.length === 20);
  assert.equal(appendEvent(home, { type: "failure", run: "", code: "x", detail: "" }, (l) => log.push(l)), false, "an event the schema refuses is dropped");
  assert.match(log.join("\n"), /failure event dropped/);
});

await check("rotation renames the full log to events.jsonl.1 and the reader keeps the order", () => {
  const home = scratch();
  const log: string[] = [];
  appendEvent(home, statusEvent("r", "s1"), (l) => log.push(l), { at: at(1) });
  appendEvent(home, statusEvent("r", "s2"), (l) => log.push(l), { at: at(2) });
  const full = fs.statSync(path.join(home, EVENTS_FILE)).size;
  appendEvent(home, statusEvent("r", "s3"), (l) => log.push(l), { at: at(3), rotateBytes: full - 1 });
  appendEvent(home, statusEvent("r", "s4"), (l) => log.push(l), { at: at(4), rotateBytes: full - 1 });
  assert.ok(fs.existsSync(path.join(home, EVENTS_ROTATED)), "the older generation is kept");
  assert.equal(fs.readFileSync(path.join(home, EVENTS_FILE), "utf8").trim().split("\n").length, 2);
  const r = readEvents(home);
  assert.deepEqual(r.events.map((e) => e.type === "run.status" && e.to), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(r.files.map((f) => path.basename(f)), [EVENTS_ROTATED, EVENTS_FILE]);
  assert.deepEqual(log, []);
});

await check("a secret split by a hidden character is redacted; multi-byte text is bounded in bytes, not dropped", () => {
  const home = scratch();
  const log: string[] = [];
  const split = `${SECRET.slice(0, 12)}\u200b${SECRET.slice(12)}`;
  assert.ok(!redactEventText(`token ${split}`).includes(SECRET), "joined, then redacted");
  appendEvent(home, { type: "failure", run: "a", code: "boom", detail: `token ${split}` }, (l) => log.push(l), { at: at(1) });
  const wide = "\u6f22".repeat(600); // three UTF-8 bytes each
  const quoted = '"'.repeat(600); // two bytes each once escaped
  assert.ok(appendEvent(home, { type: "cycle.ended", run: wide, n: 1, outcome: wide, gate: "red", merged: false, reason: wide, mergeReason: quoted }, (l) => log.push(l), { at: at(2) }), log.join("\n"));
  assert.ok(appendEvent(home, { type: "gate.result", run: wide, n: 1, sha: "a".repeat(64), green: false, failing: Array.from({ length: 30 }, () => wide) }, (l) => log.push(l), { at: at(3) }), log.join("\n"));
  assert.ok(appendEvent(home, { type: "push", run: wide, branch: quoted, sha: null, ok: false, error: "\u{1F600}".repeat(400) }, (l) => log.push(l), { at: at(4) }), log.join("\n"));
  const raw = fs.readFileSync(path.join(home, EVENTS_FILE), "utf8");
  assert.ok(!raw.includes(SECRET), "the joined secret never reaches the file");
  for (const line of raw.split("\n").filter(Boolean)) assert.ok(Buffer.byteLength(line) < MAX_LINE_BYTES, `bounded line of ${Buffer.byteLength(line)} bytes`);
  const r = readEvents(home);
  assert.deepEqual([r.events.map((e) => e.type), r.skipped], [["failure", "cycle.ended", "gate.result", "push"], 0]);
  assert.deepEqual(log, []);
});

await check("rotation waits for a held rotation lock and takes a stale one", () => {
  const home = scratch();
  const log: string[] = [];
  const lock = path.join(home, EVENTS_ROTATE_LOCK);
  appendEvent(home, statusEvent("r", "s1"), (l) => log.push(l), { at: at(1) });
  fs.writeFileSync(lock, "");
  appendEvent(home, statusEvent("r", "s2"), (l) => log.push(l), { at: at(2), rotateBytes: 1 });
  assert.ok(!fs.existsSync(path.join(home, EVENTS_ROTATED)), "another appender is rotating: this one only appends");
  assert.ok(fs.existsSync(lock), "and leaves the other's lock alone");
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);
  appendEvent(home, statusEvent("r", "s3"), (l) => log.push(l), { at: at(3), rotateBytes: 1 });
  assert.equal(fs.readFileSync(path.join(home, EVENTS_ROTATED), "utf8").trim().split("\n").length, 2, "a stale lock is taken and the full log rotated");
  assert.ok(!fs.existsSync(lock), "the lock is released after rotating");
  assert.deepEqual(readEvents(home).events.map((e) => e.type === "run.status" && e.to), ["s1", "s2", "s3"]);
  assert.deepEqual(log, []);
});

await check("a symbolic link at the log's name is refused by the writer and the reader", async () => {
  const home = scratch();
  const elsewhere = path.join(scratch(), "target.txt");
  fs.writeFileSync(elsewhere, "untouched\n");
  fs.symlinkSync(elsewhere, path.join(home, EVENTS_FILE));
  const log: string[] = [];
  assert.equal(appendEvent(home, statusEvent("a", "paused"), (l) => log.push(l)), false);
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "untouched\n", "the link was not followed");
  assert.match(log.join("\n"), /symbolic link/);
  assert.throws(() => readEvents(home), UnsafePathError);
  const r = await cli(home, ["events"]);
  assert.equal(r.code, 3, "refused");
  assert.match(r.err, /symbolic link/);
});

cleanup();
for (const d of dirs) rm(d);
done();
