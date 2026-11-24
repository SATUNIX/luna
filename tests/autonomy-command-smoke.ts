#!/usr/bin/env node
// /autonomy (packages/extensions/src/autonomy-run): the operator's way to start autonomous runs
// from inside pi. What must hold:
//   - it is a command and registers NO tool, so a model cannot start, authorise or promote a run;
//   - `start` shows the boundary and needs the person to confirm it on screen; declining starts
//     nothing; accepting records an authorisation bound to the digest and only then starts;
//   - with no screen, `start` refuses unless the contract already carries an authorisation for
//     exactly this boundary (the CLI decides, the extension never widens it);
//   - promote / reconfigure / cancel / resume --approve ask first; a decline changes nothing;
//   - arguments never reach a shell, and a malformed run id is rejected before any process starts;
//   - `status <run>` of a run with generations (Memento mode) sets the footer status line to its
//     generation n/N and last rotation reason, and clears it for a run without them;
//   - `status` with no run sets a one-line fleet footer (counts by status, plus the first blocked
//     run and its question) and clears it for an empty fleet; without a screen it is untouched;
//   - the live run widget (renderAutonomyWidget) lists runs at 80 and 120 columns with no line
//     wider than the terminal, is shown by `status` while a run is active, hides when none is,
//     and `watch off` hides it; it shows a run still in `setup` after a background start and a
//     run after `resume`; paused and blocked runs alone are not polled, and a run paused before
//     its first cycle (step 0) does not show it; the only hooks are session_start and
//     session_shutdown;
//   - `inbox` lists cards (or waiting runs) and answers with a literal --value (any text, even one
//     starting with `--`); bad ids spawn nothing;
//   - against the REAL CLI, `templates` and `plan` work end to end (no container engine needed).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, type ExtensionFactory } from "../packages/core/eval/harness.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { array, isRecord, parseJson, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as AutonomyRun from "../packages/extensions/src/autonomy-run/index.ts";

const restoreKit = isolateKitEnv();
// The extension is called with the harness's fake pi API, not pi's ExtensionAPI, so its default export is the harness's factory type.
const mod = await loadModule<Omit<typeof AutonomyRun, "default"> & { default: ExtensionFactory }>("extensions/autonomy-run/index.ts");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let checks = 0;
const ok = (name: string): void => { checks += 1; console.log(`  ok  ${name}`); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-cmd-"));
const LOG = path.join(work, "calls.jsonl");
const AUTH = path.join(work, "authorised");

// A stand-in for cli.ts that records every call and answers the JSON protocol.
const FAKE = path.join(work, "fake-cli.mjs");
fs.writeFileSync(FAKE, `
import fs from "node:fs";
const args = process.argv.slice(2);
const json = args.includes("--json");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
const cmd = args[0];
(() => {
const out =(o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
const text = (t, code = 0) => { console.log(t); process.exit(code); };
const authorised = () => fs.existsSync(process.env.FAKE_AUTH);
if (cmd === "plan") {
  const DIGEST = "d1".repeat(32);
  if (args.includes("--authorise")) {
    const shown = args[args.indexOf("--digest") + 1];
    if (args.includes("--digest") && shown !== (process.env.FAKE_NOW_DIGEST || DIGEST)) return out({ ok: false, command: "plan", error: "the boundary changed since it was shown to you", code: "refused" }, 3);
    fs.writeFileSync(process.env.FAKE_AUTH, args.join(" "));
    return out({ ok: true, command: "plan", authorisation: { status: "authorised" } });
  }
  const data = { ok: true, command: "plan", run: "demo-run-1", digest: DIGEST, authorisation: { status: authorised() ? "authorised" : "missing" }, problems: [] };
  if (json) return out(data);
  text("Boundary for run demo-run-1 (template implement)\\ndigest " + (process.env.FAKE_TEXT_DIGEST || data.digest) + "\\nFilesystem\\n  worker writes: /work");
}
if (cmd === "start") {
  if (!authorised()) return out({ ok: false, command: "start", error: "not authorised", code: "refused" }, 3);
  return out({ ok: true, command: "start", run: "demo-run-1", started: true, detached: args.includes("--detach"), pid: 4242, log: "/tmp/demo.log", status: "succeeded" });
}
if (cmd === "status" && json && args.includes("--run")) {
  const run = args[args.indexOf("--run") + 1];
  const generations = process.env.FAKE_GENERATIONS === "1" ? { current: 2, max: 4, iterationMinutes: 30, iterationUsd: null, lastRotation: { generation: 1, at: "2026-10-23T00:00:00.000Z", box: "minutes", action: "none", notebook: true, reset: false, problems: [] }, notebook: null, notebookError: null } : null;
  return out({ ok: true, command: "status", run, status: "running", generations });
}
if (cmd === "status" && json) return out({ ok: true, command: "status", runs: JSON.parse(process.env.FAKE_FLEET || "[]") });
if (cmd === "events" && json) return out({ ok: true, command: "events", events: JSON.parse(process.env.FAKE_EVENTS || "[]"), skipped: 0 });
if (cmd === "promote") {
  if (!args.includes("--yes")) return out({ ok: false, command: "promote", error: "this promotion needs your approval: fast-forward branch pi/demo. Re-run with --yes, or from a terminal.", code: "refused" }, 3);
  return json ? out({ ok: true, command: "promote", status: "done" }) : text("promotion done");
}
if (cmd === "inbox") {
  if (process.env.FAKE_INBOX_REFUSED === "1") return out({ ok: false, command: "inbox", error: "unknown inbox card D9", code: "refused" }, 3);
  if (!args.includes("--run")) return text("run demo-run-1: unpublished 2 commits (waiting on operator)");
  return text("D3  open\\n    question: ship it?\\nanswer with: pi-autonomy inbox --run demo-run-1 --answer <id> --value <text>");
}
if (cmd === "reconfigure") {
  if (!args.includes("--yes")) return out({ ok: false, command: "reconfigure", error: "reconfigure changes the run's effort or budgets, so it needs your confirmation: re-run with --yes", code: "refused" }, 3);
  return json ? out({ ok: true, command: "reconfigure" }) : text("reconfigured");
}
if (json) return out({ ok: true, command: cmd });
text(cmd + " ok");
})();
`);

const restores = [setEnv("PI_AUTONOMY_CLI", FAKE), setEnv("FAKE_LOG", LOG), setEnv("FAKE_AUTH", AUTH)];
/** Every recorded CLI invocation: its argument vector. */
const calls = (): string[][] => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => parseJsonAs(array(string()), l, "call")) : []);
/** The first recorded call matching `pred`; asserts there is one. */
const findCall = (pred: (c: string[]) => boolean): string[] => {
  const call = calls().find(pred);
  assert.ok(call, "the expected CLI call was made");
  return call;
};
/** The `i`th entry of `xs`, asserting it exists. */
const at = <T>(xs: readonly T[], i: number, what: string): T => { const x = xs[i]; assert.ok(x !== undefined, what); return x; };
const reset = () => { fs.rmSync(LOG, { force: true }); fs.rmSync(AUTH, { force: true }); };

interface SessionOptions {
  hasUI?: boolean;
  /** Answers the person gives to successive confirm dialogs; false once they run out. */
  answers?: boolean[];
}

interface Note {
  message: string;
  level: string;
}

interface Asked {
  title: string;
  body: string;
}

interface Session {
  pi: ReturnType<typeof fakePi>;
  ctx: { hasUI: boolean; cwd: string; ui: { notify(message: string, level: string): void; confirm(title: string, body: string): Promise<boolean | undefined>; setStatus(key: string, text: string | undefined): void; setWidget(key: string, content: unknown): void } };
  notes: Note[];
  /** Every setStatus call, in order. */
  statuses: Array<[string, string | undefined]>;
  /** Every setWidget call, in order (the session is not the terminal UI, so content is lines or undefined). */
  widgets: Array<[string, unknown]>;
  asked: Asked[];
  run(args: string): Promise<unknown>;
}

function session({ hasUI = true, answers = [] }: SessionOptions = {}): Session {
  const pi = fakePi();
  mod.default(pi.api);
  const notes: Note[] = [];
  const asked: Asked[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, unknown]> = [];
  const queue = [...answers];
  const ctx = {
    hasUI,
    cwd: work,
    ui: {
      notify: (message: string, level: string) => notes.push({ message, level }),
      confirm: async (title: string, body: string) => { asked.push({ title, body }); return queue.length ? queue.shift() : false; },
      setStatus: (key: string, text: string | undefined) => { statuses.push([key, text]); },
      setWidget: (key: string, content: unknown) => { widgets.push([key, content]); },
    },
  };
  return { pi, ctx, notes, asked, statuses, widgets, run: (args: string) => pi.commands.get("autonomy").handler(args, ctx) };
}

/** The last notification a session showed. */
const lastNote = (s: Session): Note => {
  const note = s.notes.at(-1);
  assert.ok(note, "a notification was shown");
  return note;
};
const errWrites: string[] = [];
const realStderr = process.stderr.write.bind(process.stderr);

try {
  // 1. A command, and no tool.
  {
    const s = session();
    assert.ok(s.pi.commands.has("autonomy"));
    assert.equal(s.pi.tools.size, 0, "no tool: a model cannot start or authorise a run");
    assert.deepEqual([...s.pi.handlers.keys()].sort(), ["session_shutdown", "session_start"], "only session lifecycle hooks (the live widget): nothing observes or steers the model");
    ok("/autonomy is a command; the extension registers no tool and only session lifecycle hooks");
  }

  // 2. Declined: the boundary is shown, nothing is authorised, nothing starts.
  {
    reset();
    const s = session({ answers: [false] });
    await s.run("start run.json");
    assert.equal(s.asked.length, 1);
    const shown = at(s.asked, 0, "the boundary was shown").body;
    assert.match(shown, /Boundary for run demo-run-1/);
    assert.match(shown, /digest d1d1d1/, "the digest is on the screen the person confirms");
    assert.equal(calls().some((c) => c[0] === "start"), false, "declining starts nothing");
    assert.equal(fs.existsSync(AUTH), false, "declining records no authorisation");
    assert.match(lastNote(s).message, /Not authorised\. Nothing was started/);
    ok("declining the boundary starts nothing and records nothing");
  }

  // 3. Accepted: authorise (bound to the digest, by the person) then start detached.
  {
    reset();
    const s = session({ answers: [true] });
    // A detached start returns while the new run is still in `setup` (its container is being built).
    const restoreFleet = setEnv("FAKE_FLEET", JSON.stringify([{ run: "demo-run-1", template: "implement", status: "setup", step: 0, spentUsd: 0, budgetUsd: 5 }]));
    try {
      await s.run("start run.json");
      assert.match(lastNote(s).message, /Run demo-run-1 started \(supervisor pid 4242\)/);
      const seq = calls().map((c) => at(c, 0, "a command") + (c.includes("--authorise") ? ":authorise" : ""));
      // After a background start the run list (and the events, as a run is starting) are read for the live widget.
      assert.deepEqual(seq, ["plan", "plan", "plan:authorise", "start", "status", "events"]);
      const [, setup] = at(s.widgets, 0, "the widget is shown for a run still in setup");
      assert.ok(Array.isArray(setup) && setup.some((l) => typeof l === "string" && /demo-run-1 .*cycle 0 +setup/.test(l)), "the run is listed as in setup");
      const running = setEnv("FAKE_FLEET", JSON.stringify([{ run: "demo-run-1", template: "implement", status: "running", step: 1, spentUsd: 0.1, budgetUsd: 5 }]));
      try { await s.run("watch"); } finally { running(); }
      const [, now] = at(s.widgets, 1, "the widget is refreshed once the run is running");
      assert.ok(Array.isArray(now) && now.some((l) => typeof l === "string" && /demo-run-1 .*cycle 1 +running/.test(l)), "the run is listed as running");
    } finally {
      restoreFleet();
      // The widget is polling: stop it with the session.
      await s.pi.handlers.get("session_shutdown")({}, s.ctx);
    }
    const start = findCall((c) => c[0] === "start");
    assert.ok(start.includes("--detach") && start.includes("--yes") && start.includes("--config"));
    assert.ok(path.isAbsolute(at(start, start.indexOf("--config") + 1, "--config has a value")), "the contract path is resolved against the working directory");
    const authorise = findCall((c) => c.includes("--authorise"));
    assert.ok(authorise.includes("--by") && authorise[authorise.indexOf("--by") + 1] === os.userInfo().username);
    assert.equal(authorise[authorise.indexOf("--digest") + 1], "d1".repeat(32), "the authorisation is bound to the digest that was on screen");
    ok("accepting authorises the shown boundary (by its digest) as the person, then starts the run in the background");
  }

  // 3b. The file changes between the person reading the boundary and the authorisation: nothing is authorised.
  {
    reset();
    const restoreNow = setEnv("FAKE_NOW_DIGEST", "e2".repeat(32));
    try {
      const s = session({ answers: [true] });
      await s.run("start run.json");
      assert.equal(calls().some((c) => c[0] === "start"), false, "no start after a boundary that changed under the person");
      assert.equal(fs.existsSync(AUTH), false, "the changed boundary was not authorised");
      assert.match(lastNote(s).message, /could not record the authorisation: .*changed since it was shown/);
    } finally {
      restoreNow();
    }
    // Two reads of the file that disagree (the text on screen is not the digest that would be authorised): refused before asking.
    reset();
    const restoreText = setEnv("FAKE_TEXT_DIGEST", "e2".repeat(32));
    try {
      const s = session({ answers: [true] });
      await s.run("start run.json");
      assert.equal(s.asked.length, 0, "the person is not asked to confirm a boundary that is not the one that would be authorised");
      assert.equal(calls().some((c) => c[0] === "start" || c.includes("--authorise")), false);
      assert.match(lastNote(s).message, /changed while its boundary was being read/);
    } finally {
      restoreText();
    }
    ok("a boundary that changes between reading and authorising is refused: the authorisation carries the shown digest, and the text and digest must agree");
  }

  // 4. A contract already authorised for this exact boundary is still confirmed on screen; no second authorisation.
  {
    reset();
    fs.writeFileSync(AUTH, "x");
    const s = session({ answers: [true] });
    await s.run("start run.json --foreground");
    assert.equal(calls().some((c) => c.includes("--authorise")), false, "no new authorisation when the contract already carries one");
    assert.equal(findCall((c) => c[0] === "start").includes("--detach"), false, "--foreground runs in the foreground");
    ok("a pre-authorised contract is still shown and confirmed; --foreground does not detach");
  }

  // 5. No screen: refuse unless the contract already carries the authorisation.
  {
    reset();
    const s = session({ hasUI: false });
    process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
    try { await s.run("start run.json"); } finally { process.stderr.write = realStderr; }
    assert.equal(calls().some((c) => c[0] === "start"), false, "no start without a screen and without an authorisation");
    assert.match(errWrites.join(""), /no screen to confirm the boundary on/);
    reset();
    fs.writeFileSync(AUTH, "x");
    const s2 = session({ hasUI: false });
    process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
    try { await s2.run("start run.json"); } finally { process.stderr.write = realStderr; }
    assert.equal(calls().some((c) => c[0] === "start"), true, "a contract authorised for exactly this boundary may start headless");
    ok("headless start needs an existing authorisation for exactly this boundary");
  }

  // 6. Confirm-first commands.
  {
    reset();
    const declined = session({ answers: [false] });
    await declined.run("promote demo-run-1");
    assert.equal(declined.asked.length, 1);
    assert.match(at(declined.asked, 0, "the promotion was shown").body, /fast-forward branch pi\/demo/, "the CLI's own description of the promotion is what is shown");
    assert.equal(calls().some((c) => c[0] === "promote" && c.includes("--yes")), false, "declining promotes nothing");
    const accepted = session({ answers: [true] });
    await accepted.run("promote demo-run-1");
    assert.equal(calls().some((c) => c[0] === "promote" && c.includes("--yes")), true);
    const rc = session({ answers: [false] });
    await rc.run("reconfigure demo-run-1 --effort E5");
    assert.equal(calls().some((c) => c[0] === "reconfigure" && c.includes("--yes")), false, "declining reconfigure changes nothing");
    const cancel = session({ answers: [false] });
    await cancel.run("cancel demo-run-1");
    assert.equal(calls().some((c) => c[0] === "cancel"), false, "declining cancel cancels nothing");
    const approve = session({ answers: [false] });
    await approve.run("resume demo-run-1 --approve");
    assert.equal(calls().some((c) => c[0] === "resume"), false, "declining an approval answers nothing");
    ok("promote, reconfigure, cancel and resume --approve ask first; a decline changes nothing");
  }

  // 7. Arguments: quotes are honoured, a bad run id never spawns anything, no shell is involved.
  {
    assert.deepEqual(mod.splitArgs(`init implement --spec "a b  c" --check unit='npm test' plain`), ["init", "implement", "--spec", "a b  c", "--check", "unit=npm test", "plain"]);
    assert.deepEqual(mod.splitArgs("  a   b "), ["a", "b"]);
    reset();
    const s = session();
    await s.run("status ../../etc/passwd");
    await s.run("steer $(touch /tmp/pwned) hello");
    await s.run("cancel ;rm -rf");
    assert.equal(calls().length, 0, "a malformed run id starts no process");
    await s.run("steer demo-run-1 $(touch /tmp/pwned-by-autonomy) hello");
    const steer = findCall((c) => c[0] === "steer");
    assert.equal(steer[steer.indexOf("--message") + 1], "$(touch /tmp/pwned-by-autonomy) hello", "the message is one literal argument");
    assert.equal(fs.existsSync("/tmp/pwned-by-autonomy"), false, "nothing is interpreted by a shell");
    ok("quoting is honoured, malformed run ids are rejected before any process, arguments are never shell-interpreted");
  }

  // 7a. Owner inbox: list waiting runs or a run's cards, and answer with a literal value.
  {
    reset();
    const s = session();
    await s.run("inbox");
    assert.deepEqual(findCall((c) => c[0] === "inbox"), ["inbox"], "no argument lists waiting runs");
    reset();
    await s.run("inbox demo-run-1");
    assert.deepEqual(findCall((c) => c[0] === "inbox"), ["inbox", "--run", "demo-run-1"]);
    reset();
    const value = "Ship it; $(rm -rf /)";
    await s.run(`inbox demo-run-1 --answer D3 --value "${value}"`);
    const answer = findCall((c) => c[0] === "inbox");
    assert.deepEqual(answer, ["inbox", "--run", "demo-run-1", "--answer", "D3", `--value=${value}`]);
    reset();
    await s.run(`inbox demo-run-1 --answer D3 --value "--force it"`);
    assert.deepEqual(findCall((c) => c[0] === "inbox"), ["inbox", "--run", "demo-run-1", "--answer", "D3", "--value=--force it"], "a value starting with -- is passed in the equals form");
    ok("inbox passes a free-text value that starts with -- in the equals form");
    reset();
    await s.run(`inbox --run demo-run-1 --answer D3 --value yes`);
    assert.deepEqual(findCall((c) => c[0] === "inbox"), ["inbox", "--run", "demo-run-1", "--answer", "D3", "--value=yes"], "the CLI hint's --run form is accepted");
    reset();
    await s.run("inbox --run");
    assert.equal(calls().length, 0, "--run without a run id starts no process");
    ok("inbox accepts the --run form the CLI prints as its hint");
    reset();
    await s.run("inbox demo-run-1 --file cards.json");
    assert.deepEqual(findCall((c) => c[0] === "inbox"), ["inbox", "--run", "demo-run-1", "--file", path.join(work, "cards.json")], "--file is resolved against the working directory");
    reset();
    await s.run("inbox demo-run-1 --bogus x");
    assert.equal(calls().length, 0, "an unknown flag starts no process");
    assert.equal(lastNote(s).level, "error");
    assert.match(lastNote(s).message, /usage: \/autonomy inbox/);
    reset();
    await s.run("inbox ../../etc/passwd");
    await s.run("inbox BAD_ID!");
    assert.equal(calls().length, 0, "a malformed run id starts no process");
    reset();
    const restoreRefused = setEnv("FAKE_INBOX_REFUSED", "1");
    try {
      await s.run("inbox demo-run-1 --answer D9 --value x");
      assert.equal(lastNote(s).level, "error");
      assert.match(lastNote(s).message, /unknown inbox card D9/);
    } finally { restoreRefused(); }
    await s.run("help");
    assert.match(lastNote(s).message, /inbox/);
    ok("inbox lists cards or waiting runs, answers literally, rejects bad ids, surfaces refusals");
  }

  // 7b. Generations (Memento mode): `status <run>` sets the footer status line, or clears it.
  {
    reset();
    const restoreGen = setEnv("FAKE_GENERATIONS", "1");
    try {
      const s = session();
      await s.run("status demo-run-1");
      assert.deepEqual(s.statuses, [["autonomy", "memento demo-run-1: gen 2/4, running; last rotation: time box"]]);
      assert.match(lastNote(s).message, /status ok/, "the CLI's own status text is still what is shown");
      await s.run("status");
      assert.deepEqual(s.statuses, [["autonomy", "memento demo-run-1: gen 2/4, running; last rotation: time box"], ["autonomy", undefined]], "the run list replaces the run line with the fleet line (empty here)");
    } finally { restoreGen(); }
    const plain = session();
    await plain.run("status demo-run-1");
    assert.deepEqual(plain.statuses, [["autonomy", undefined]], "a run without generations clears the line");
    const headless = session({ hasUI: false });
    process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
    try { await headless.run("status demo-run-1"); } finally { process.stderr.write = realStderr; }
    assert.equal(headless.statuses.length, 0, "no screen: no status line");
    assert.equal(mod.generationStatusLine({ run: "demo-run-1", status: "running", generations: { current: 3, max: 4, lastRotation: { box: "usd", notebook: false } } }), "memento demo-run-1: gen 3/4, running; last rotation: dollar box, no notebook");
    assert.equal(mod.generationStatusLine({ run: "demo-run-1", generations: { current: 0, max: 4, lastRotation: null } }), "memento demo-run-1: gen -/4");
    assert.equal(mod.generationStatusLine({ run: "../x\u001b[2J", generations: { current: 1, max: 4 } }), undefined, "a run id that is not one shows nothing");
    assert.equal(mod.generationStatusLine({ run: "demo-run-1", generations: null }), undefined);
    assert.equal(mod.generationStatusLine("not json"), undefined);
    ok("status <run> shows generation n/N and the last rotation reason in the status line; cleared without generations, untouched without a screen");
  }

  // 7c. The fleet footer: `status` with no run summarises the fleet and clears it when empty.
  {
    reset();
    const fleet = [
      { run: "demo-run-1", template: "implement", status: "running", outcome: null, step: 3, spentUsd: 1.5, budgetUsd: 10, blocker: null },
      { run: "demo-blocked-1", template: "self-improve", status: "blocked", outcome: null, step: 2, spentUsd: 0.25, budgetUsd: 5, blocker: { kind: "external", waiting: "waiting_provider", question: "which database?" } },
    ];
    const restoreFleet = setEnv("FAKE_FLEET", JSON.stringify(fleet));
    try {
      const s = session();
      await s.run("status");
      assert.deepEqual(s.statuses, [["autonomy", "autonomy: 2 runs \u2014 1 running, 1 blocked; blocked: demo-blocked-1 (waiting on provider: which database?)"]]);
      assert.match(lastNote(s).message, /status ok/, "the CLI's own status text is still what is shown");
      // A run is running, so the live widget started polling (case 7d): stop it with the session.
      await s.pi.handlers.get("session_shutdown")({}, s.ctx);
      const empty = setEnv("FAKE_FLEET", "[]");
      try {
        const none = session();
        await none.run("status");
        assert.deepEqual(none.statuses, [["autonomy", undefined]], "an empty fleet clears the line");
      } finally { empty(); }
      const headless = session({ hasUI: false });
      process.stderr.write = (chunk) => { errWrites.push(String(chunk)); return true; };
      try { await headless.run("status"); } finally { process.stderr.write = realStderr; }
      assert.equal(headless.statuses.length, 0, "no screen: no fleet line");
    } finally { restoreFleet(); }
    assert.equal(mod.fleetStatusLine({ runs: [{ run: "a-1", status: "succeeded" }] }), "autonomy: 1 run \u2014 1 succeeded");
    assert.equal(mod.fleetStatusLine({ runs: [] }), undefined, "no runs: nothing to show");
    assert.equal(mod.fleetStatusLine({ runs: [{ run: "a-1" }] }), undefined, "a row without a usable status clears the line");
    assert.equal(mod.fleetStatusLine("not json"), undefined);
    const long = "x".repeat(100);
    assert.match(mod.fleetStatusLine({ runs: [{ run: "a-1", status: "blocked", blocker: { kind: "question", question: long } }] }) ?? "", /x{80}\u2026\)$/, "the question is truncated");
    assert.equal(mod.fleetStatusLine({ runs: [{ run: "a\u001b-1", status: "blocked", blocker: { kind: "question", question: "line1\nline2\u001b[2J" } }] }), "autonomy: 1 run \u2014 1 blocked; blocked: a-1 (line1 line2[2J)", "worker text is collapsed to one visible line");
    assert.equal(mod.fleetStatusLine({ runs: [{ run: "a-1", status: "blocked", blocker: { kind: "external", waiting: "waiting_budget", question: "why?" } }] }), "autonomy: 1 run \u2014 1 blocked; blocked: a-1 (waiting on budget: why?)", "a budget-parked run says so, not just its question");
    ok("status with no run sets a one-line fleet footer, clears it when empty, and is untouched without a screen");
  }

  // 7d. The live run widget: the pure renderer, then the poller driven through /autonomy.
  {
    const now = Date.parse("2026-11-18T12:00:00.000Z");
    const ago = (s: number): string => new Date(now - s * 1000).toISOString();
    const report = {
      ok: true,
      runs: [
        { run: "todo-api-1", template: "implement", status: "running", step: 3, spentUsd: 1.5, budgetUsd: 10, updatedAt: ago(600) },
        { run: "fleet-dispatch-with-a-long-name-7", template: "dispatch", status: "recovering", step: 12, spentUsd: 23.456, budgetUsd: 100, updatedAt: ago(90) },
        { run: "self-improve-2", template: "self-improve", status: "blocked", step: 1, spentUsd: null, budgetUsd: null, updatedAt: ago(7200), blocker: { kind: "external", waiting: "waiting_provider", question: "which database?" } },
        { run: "old-run-1", template: "implement", status: "succeeded", step: 9, spentUsd: 4, budgetUsd: 5, updatedAt: ago(9000) },
      ],
    };
    const eventsReport = {
      ok: true,
      events: [
        { v: 1, at: ago(400), run: "todo-api-1", type: "cycle.started", n: 3, resume: false },
        { v: 1, at: ago(12), run: "todo-api-1", type: "gate.result", n: 3, sha: "abc1234", green: true, failing: [] },
        { v: 1, at: ago(30), run: "fleet-dispatch-with-a-long-name-7", type: "cycle.started", n: 14, resume: true, engineer: "e1", item: "PG-07\u001b[2J" },
        { v: 1, at: ago(5), run: "todo-api-1", type: "not.a.type" },
      ],
    };
    const runs = mod.widgetRuns(report);
    const events = mod.widgetEvents(eventsReport);
    assert.equal(runs.length, 4, "every well-formed row is read");
    assert.deepEqual(at(runs, 2, "the blocked run").blocker, { kind: "external", question: "which database?", waiting: "waiting_provider" }, "a blocked run's question and waiting reason are read, so the widget can say why it is blocked");
    assert.equal(at(runs, 0, "a running run").blocker, null, "a run that records no blocker has none");
    assert.equal(events.length, 3, "an unknown event type is left out");
    assert.equal(at(events, 2, "the dispatch cycle").phase, "working on PG-07[2J", "a worker-written item is one visible line");
    for (const width of [80, 120]) {
      const lines = mod.renderAutonomyWidget(runs, events, now, width);
      assert.equal(lines.length, 5, `${width} columns: a heading, the three runs that have not ended and why the blocked one waits`);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width} columns: no line is wider than the terminal (${line})`);
      assert.match(at(lines, 0, "heading"), /^autonomy: 2 active, 1 waiting/);
      assert.ok(!lines.some((l) => l.includes("old-run-1")), "an ended run is not listed");
      assert.ok(!lines.some((l) => l.includes("\u001b")), "worker text reaches the widget as one visible line");
    }
    const wide = mod.renderAutonomyWidget(runs, events, now, 120);
    assert.match(at(wide, 1, "first run"), /todo-api-1 +implement +cycle 3 +gate green +\$1\.50\/\$10\.00 +12s ago$/, "run, template, cycle, phase, spend/budget and last-event age");
    assert.match(at(wide, 2, "second run"), /cycle 14 +recovering +\$23\.46\/\$100\.00 +30s ago$/, "the newest cycle number from the event log");
    assert.match(at(wide, 3, "third run"), /self-improve-2 .*cycle 1 +blocked +\$- +2h ago$/, "a waiting run is listed after the active ones");
    assert.equal(at(wide, 4, "the blocked line"), "  blocked: self-improve-2 (waiting on provider: which database?)", "the widget says what a blocked run waits on and the question to answer");
    for (const width of [1, 10, 40]) for (const line of mod.renderAutonomyWidget(runs, events, now, width)) assert.ok(visibleWidth(line) <= width, `${width} columns: narrow terminals are safe`);
    const idle = runs.filter((r) => !mod.isActiveRun(r) && r.status !== "blocked");
    assert.deepEqual(mod.renderAutonomyWidget(idle, events, now, 120), [], "no active or blocked run: nothing to show");
    // Which runs show the widget and which keep it refreshing (a run's step is a number from 0, never null).
    const row = (status: string, step: number, blocker: AutonomyRun.WidgetBlocker | null = null): AutonomyRun.WidgetRun => ({ run: `r-${status}-${step}`, template: "implement", status, step, spentUsd: 0, budgetUsd: 5, blocker, updatedMs: now });
    const pausedEarly = row("paused", 0);
    const pausedMid = row("paused", 2);
    assert.deepEqual(mod.renderAutonomyWidget([pausedEarly], [], now, 120), [], "a run paused before its first cycle does not show the widget");
    // A blocked run is shown even when nothing is moving, with the question the owner has to answer.
    const blockedOnly = mod.renderAutonomyWidget([row("blocked", 3, { kind: "question", question: "ship it?", waiting: "waiting_budget" })], [], now, 120);
    assert.match(at(blockedOnly, 0, "heading"), /^autonomy: 0 active, 1 waiting/, "a blocked run alone is shown, counted as waiting, not active");
    assert.equal(at(blockedOnly, 2, "the blocked line"), "  blocked: r-blocked-3 (waiting on budget: ship it?)", "and its question is shown");
    const noQuestion = mod.renderAutonomyWidget([row("blocked", 3)], [], now, 120);
    assert.match(at(noQuestion, 1, "the blocked run"), /r-blocked-3 +implement +cycle 3 +blocked +\$0\.00\/\$5\.00 +0s ago$/, "a blocked run that records no question is still listed");
    assert.equal(noQuestion.length, 2, "with no invented reason line");
    assert.match(at(mod.renderAutonomyWidget([pausedMid], [], now, 120), 0, "heading"), /^autonomy: 1 active/, "a run paused part-way through shows it");
    for (const status of ["setup", "ready", "running", "recovering"]) {
      assert.ok(mod.isActiveRun(row(status, 0)), `${status} is shown`);
      assert.ok(mod.widgetPolls([row(status, 0)], now, 0), `${status} changes on its own: the widget keeps refreshing`);
    }
    assert.equal(mod.widgetPolls([pausedMid, pausedEarly, row("blocked", 3)], now, 0), false, "paused and blocked runs change only when the operator acts: no refreshing");
    assert.equal(mod.widgetPolls([], now, now + 1), true, "after start or resume it refreshes for a grace period");
    assert.equal(mod.widgetPolls([pausedMid], now, now), false, "and stops when the grace period is over");
    assert.deepEqual(mod.widgetRuns("not json"), []);
    assert.deepEqual(mod.widgetEvents({ events: [{ run: "a-1", at: "yesterday", type: "push", ok: true }] }), [], "an event without a usable time is left out");

    // The poller: `status` shows it while a run is active, `watch on` re-reads and hides it when none is, `watch off` hides it.
    reset();
    const restoreFleet = setEnv("FAKE_FLEET", JSON.stringify(report.runs));
    const restoreEvents = setEnv("FAKE_EVENTS", JSON.stringify(eventsReport.events));
    try {
      const s = session();
      await s.run("status");
      assert.deepEqual(calls().map((c) => at(c, 0, "a command")), ["status", "status", "events"], "the fleet report is reused; the events are read once");
      const [key, content] = at(s.widgets, 0, "the widget was shown");
      assert.equal(key, "autonomy");
      assert.ok(Array.isArray(content), "outside the terminal UI the widget is lines");
      const shown: unknown[] = content;
      assert.equal(shown.length, 5, "a heading, three runs and the blocked run's question");
      for (const l of shown) assert.ok(typeof l === "string" && visibleWidth(l) <= 80, "rendered at 80 columns");
      const empty = setEnv("FAKE_FLEET", "[]");
      try {
        await s.run("watch on");
        assert.deepEqual(s.widgets.at(-1), ["autonomy", undefined], "no active run: the widget hides itself");
      } finally { empty(); }
      await s.run("watch");
      assert.equal(s.widgets.length, 3, "watch (on) shows it again while a run is active");
      await s.run("watch off");
      assert.deepEqual(s.widgets.at(-1), ["autonomy", undefined], "watch off hides it");
      const before = calls().length;
      await s.run("watch sideways");
      assert.match(lastNote(s).message, /usage: \/autonomy watch/);
      await s.run("status");
      assert.equal(s.widgets.length, 4, "off for the session: status does not show it again");
      assert.equal(calls().length, before + 2, "status reads the run list (text and JSON) and no events");
      // Shutdown stops the poller: a later tick has no session to draw on.
      await s.pi.handlers.get("session_shutdown")({}, s.ctx);
      // Resuming a run checks the widget at once (and keeps checking for a while).
      const paused = setEnv("FAKE_FLEET", JSON.stringify([{ run: "demo-run-1", template: "implement", status: "paused", step: 2, spentUsd: 1, budgetUsd: 5 }]));
      const r = session();
      try {
        reset();
        await r.run("resume demo-run-1");
        assert.deepEqual(calls().map((c) => at(c, 0, "a command")), ["resume", "status", "events"], "resume, then the run list and events for the widget");
        const [, lines] = at(r.widgets, 0, "the widget is shown after resume");
        assert.ok(Array.isArray(lines) && lines.some((l) => typeof l === "string" && /demo-run-1 .*cycle 2 +paused/.test(l)), "the resumed run is listed before the run list shows it running");
      } finally {
        paused();
        await r.pi.handlers.get("session_shutdown")({}, r.ctx);
      }
    } finally { restoreEvents(); restoreFleet(); }
    ok("the live run widget renders at 80 and 120 columns within the width, shows while a run is active and hides when none is");
  }

  // 8. A missing CLI is a message, not a crash.
  {
    const restore = setEnv("PI_AUTONOMY_CLI", path.join(work, "does-not-exist.mjs"));
    try {
      const s = session();
      await s.run("templates");
      assert.match(lastNote(s).message, /not installed at/);
      assert.equal(lastNote(s).level, "error");
    } finally { restore(); }
    ok("a missing CLI is reported, not thrown");
  }

  // 9. The REAL CLI: templates and plan need no container engine.
  {
    for (const r of restores.splice(0)) r();
    const s = session({ answers: [false] });
    await s.run("templates");
    const listing = lastNote(s).message;
    for (const id of ["implement", "deploy", "self-improve", "dispatch"]) assert.match(listing, new RegExp(`^${id} `, "m"));
    await s.run(`plan ${path.join(ROOT, "packages", "autonomy", "examples", "implement.json")}`);
    const plan = lastNote(s).message;
    assert.match(plan, /Boundary for run todo-api-1/);
    assert.match(plan, /never mounted: your home directory, credential stores, the host root, the container-engine socket/);
    assert.match(plan, /authorisation: missing/);
    // Declining at the real start shows the same boundary and starts no run.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-cmd-home-"));
    const restoreHome = setEnv("PI_AUTONOMY_HOME", home);
    try {
      const contract = path.join(work, "implement.json");
      fs.cpSync(path.join(ROOT, "packages", "autonomy", "examples", "implement"), path.join(work, "implement"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "packages", "autonomy", "examples", "implement.json"), contract);
      const declined = session({ answers: [false] });
      await declined.run(`start ${contract}`);
      assert.match(at(declined.asked, 0, "the boundary was shown").body, /Boundary for run todo-api-1/);
      assert.equal(fs.existsSync(path.join(home, "todo-api-1")), false, "declining leaves no run directory behind");
      const raw = parseJson(fs.readFileSync(contract, "utf8"));
      assert.ok(isRecord(raw), "the contract is still a JSON object");
      assert.equal(raw.authorisation, undefined, "declining writes no authorisation into the contract");
    } finally { restoreHome(); rmWorkspace(home); }
    ok("against the real CLI: templates and plan work, and declining start leaves no run and no authorisation");
  }
} finally {
  process.stderr.write = realStderr;
  for (const r of restores.splice(0)) r();
  restoreKit();
  rmWorkspace(work);
}

console.log(`[autonomy-command-smoke] OK (${checks} checks)`);
