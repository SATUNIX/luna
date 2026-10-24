#!/usr/bin/env node
/**
 * Offline checks for extensions/save: /save writes a snapshot to disk without
 * compacting, resolves vault projects safely, redacts secrets, queues the
 * memory-update prompt, and copies real compaction summaries to the same log.
 * The summarizer is injected, so no model call runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";
import type * as SaveModule from "../packages/extensions/src/save/index.ts";
import type { SaveDeps } from "../packages/extensions/src/save/index.ts";
import type * as ToolCaptureModule from "../packages/extensions/src/tool-capture/index.ts";

/** The save module as the test drives it: registerSave is called with the fake pi API. */
type SaveUnderTest = Omit<typeof SaveModule, "registerSave"> & { registerSave: (api: unknown, deps: SaveDeps) => void };

// Hermetic: /save falls back to the memory vault (~/.pi/vault) when it exists, so point that
// at a path that never exists unless a test sets PI_KIT_SAVE_VAULT itself.
process.env.PI_KIT_VAULT = path.join(process.env.TMPDIR || "/tmp", `pi-kit-save-smoke-no-vault-${process.pid}`);
const mod = await loadModule<SaveUnderTest>("extensions/save/index.ts");
const FIXED = new Date("2026-09-14T05:06:07Z");

interface SetupOptions {
  summary?: string;
  fail?: string;
  gate?: Promise<void>;
}

interface SummarizeCall {
  instructions: string;
  signal: AbortSignal;
}

interface Note {
  message: string;
  level: string | undefined;
}

interface CtxOptions {
  hasUI?: boolean;
  idle?: boolean;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
}

type SaveCtx = ReturnType<typeof fakeCtx>;

function setup({ summary = "## Goal\nShip /save.\n\n## Next Steps\n1. Test it.", fail, gate }: SetupOptions = {}) {
  const calls: SummarizeCall[] = [];
  const jobs: Array<Promise<unknown>> = [];
  const pi = Object.assign(fakePi(), {
    // Every handler call runs through run(), which also awaits the background job.
    run: async (args: string, ctx: SaveCtx): Promise<void> => {
      await pi.commands.get("save").handler(args, ctx);
      await Promise.all(jobs.splice(0));
    },
  });
  mod.registerSave(pi.api, {
    onJob: (job: Promise<unknown>) => jobs.push(job),
    summarize: async (_ctx: unknown, instructions: string, signal: AbortSignal) => {
      calls.push({ instructions, signal });
      if (gate) await gate;
      if (fail) throw new Error(fail);
      return summary;
    },
    now: () => FIXED,
  });
  return { pi, calls };
}

function fakeCtx(cwd: string, { hasUI = true, idle = true, select }: CtxOptions = {}) {
  const notes: Note[] = [];
  return {
    cwd,
    hasUI,
    notes,
    model: { provider: "pentest", id: "qwen3.8-27b" },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: 51234 }),
    sessionManager: { getSessionFile: () => path.join(cwd, "session.jsonl"), getEntries: () => [], getLeafId: () => null },
    ui: { notify: (message: string, level?: string) => notes.push({ message, level }), select: select ?? (async () => undefined) },
    compact: () => { throw new Error("/save must never compact"); },
  };
}

// The most recent notification; a missing one fails the calling assertion just as before.
function lastNote(notes: Note[]): Note {
  const last = notes.at(-1);
  assert.ok(last, "expected at least one notification");
  return last;
}

function withVault(fn: (ws: string, vault: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const ws = tmpWorkspace("pi-kit-save-");
    const vault = path.join(ws, "vault");
    for (const p of ["Pi Agent Kit", "GitLab Migration"]) fs.mkdirSync(path.join(vault, "10_Projects", p), { recursive: true });
    const restores = [setEnv("PI_KIT_SAVE_VAULT", vault), setEnv("PI_KIT_SAVE_PROJECT", undefined), setEnv("PI_KIT_SAVE_DIR", undefined)];
    try { await fn(ws, vault); } finally { restores.reverse().forEach((r) => r()); rmWorkspace(ws); }
  };
}

function withoutVault(fn: (ws: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const ws = tmpWorkspace("pi-kit-save-local-");
    const restores = [setEnv("PI_KIT_SAVE_VAULT", undefined), setEnv("PI_KIT_SAVE_PROJECT", undefined), setEnv("PI_KIT_SAVE_DIR", undefined)];
    try { await fn(ws); } finally { restores.reverse().forEach((r) => r()); rmWorkspace(ws); }
  };
}

const testParseArgs = async () => {
  assert.deepEqual(mod.parseArgs(`--project "Pi Agent Kit" --no-update check the TTL fix`), { project: "Pi Agent Kit", update: false, note: "check the TTL fix" });
  assert.deepEqual(mod.parseArgs("--project=Fabric"), { project: "Fabric", note: "" });
  assert.deepEqual(mod.parseArgs(""), { note: "" });
};

const testSaveToVaultProjectWithoutCompacting = withVault(async (ws, vault) => {
  const { pi, calls } = setup();
  const ctx = fakeCtx(ws);
  await pi.run(`--project "pi agent kit" halfway through tests`, ctx);
  const dir = path.join(vault, "10_Projects", "Pi Agent Kit");
  const latest = path.join(dir, "Latest Compact.md");
  const log = path.join(dir, "Compacts", "2026-09-14 " + stampLocal(FIXED) + " - save.md");
  assert.ok(fs.existsSync(latest), `latest written: ${ctx.notes.map((n) => n.message).join(" | ")}`);
  assert.ok(fs.existsSync(log), "log written");
  const text = fs.readFileSync(latest, "utf8");
  assert.equal(text, fs.readFileSync(log, "utf8"));
  assert.match(text, /^---\nkind: save\nsaved: 2026-09-14T05:06:07.000Z\nproject: "Pi Agent Kit"\n/);
  assert.match(text, /model: "pentest\/qwen3.8-27b"\ncontext_tokens: 51234\nnote: "halfway through tests"\n---/);
  assert.match(text, /The conversation was not compacted/);
  assert.match(text, /## Goal\nShip \/save\./);
  const [call] = calls;
  assert.ok(call, "the summarizer was called");
  assert.match(call.instructions, /check-in snapshot[\s\S]*Operator note: halfway through tests/);
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(pi.steers.length, 1, "queues one memory-update prompt for a vault project");
  const [steer] = pi.steers;
  assert.ok(steer, "a memory-update prompt was queued");
  assert.match(steer.message as string, /Current State\.md/);
  assert.equal(steer.opts, undefined, "idle agent gets a normal prompt");
});

const testFollowUpWhenBusyAndNoUpdateFlag = withVault(async (ws) => {
  const { pi } = setup();
  await pi.run(`--project Fabric`, fakeCtx(ws)).catch(() => {});
  assert.equal(pi.steers.length, 0, "unknown project writes nothing and prompts nothing");

  const vaultDir = process.env.PI_KIT_SAVE_VAULT;
  assert.ok(vaultDir, "withVault sets PI_KIT_SAVE_VAULT");
  fs.mkdirSync(path.join(vaultDir, "10_Projects", "Fabric"));
  await pi.run(`--project Fabric`, fakeCtx(ws, { idle: false }));
  assert.deepEqual(pi.steers[0]?.opts, { deliverAs: "followUp" }, "busy agent gets a follow-up, never an error");

  await pi.run(`--project Fabric --no-update`, fakeCtx(ws));
  assert.equal(pi.steers.length, 1, "--no-update skips the prompt");
});

const testUnknownProjectAndTraversalRejected = withVault(async (ws) => {
  const { pi } = setup();
  const ctx = fakeCtx(ws);
  await pi.run(`--project "Pi Agent"`, ctx);
  assert.match(lastNote(ctx.notes).message, /nothing written - project "Pi Agent" does not exist .*Close matches: Pi Agent Kit/);
  assert.throws(() => mod.resolveTarget(ws, "../../etc"), /invalid project name/);
});

const testPickerAndLocalFallback = withVault(async (ws) => {
  const { pi } = setup();
  let offered: string[] | undefined;
  const ctx = fakeCtx(ws, { select: async (_t, options) => { offered = options; return options[0]; } });
  await pi.run("", ctx);
  assert.deepEqual(offered?.slice(1), ["GitLab Migration", "Pi Agent Kit"], "picker lists vault projects");
  assert.ok(fs.existsSync(path.join(ws, ".pi", "snapshots", "Latest Compact.md")), "local choice writes to the workspace");
  assert.equal(pi.steers.length, 0, "no project -> no update prompt by default");
});

const testLocalDefaultWithoutVault = withoutVault(async (ws) => {
  const { pi } = setup();
  const ctx = fakeCtx(ws, { hasUI: false });
  await pi.run("--update", ctx);
  assert.ok(fs.existsSync(path.join(ws, ".pi", "snapshots", "Latest Compact.md")));
  assert.equal(pi.steers.length, 1, "--update forces the prompt");
});

const testSummarizerFailureWritesNothing = withoutVault(async (ws) => {
  const { pi } = setup({ fail: "no request auth for pentest" });
  const ctx = fakeCtx(ws);
  await pi.run("", ctx);
  assert.equal(fs.existsSync(path.join(ws, ".pi", "snapshots")), false);
  assert.match(lastNote(ctx.notes).message, /nothing written - no request auth/);
  assert.equal(lastNote(ctx.notes).level, "error");
});

const testRedactsSecrets = async () => {
  const text = mod.renderSnapshot(
    "token: glpat-ABCDEFGHIJKLMNOPQRST and AKIAABCDEFGHIJKLMNOP\npassword=hunter2hunter2\nkeep 10.10.0.13",
    { kind: "save", when: FIXED, cwd: "/w" },
  );
  assert.doesNotMatch(text, /glpat-|AKIAABCD|hunter2/);
  assert.match(text, /password=\[REDACTED\]/);
  assert.match(text, /keep 10\.10\.0\.13/, "normal detail survives");
};

// save's list reuses tool-capture's bearer, github_pat_ and URL-credential shapes: every
// sample tool-capture flags as one of those kinds must leave a save snapshot masked.
const testRedactsToolCaptureShapes = async () => {
  const capture = await loadModule<typeof ToolCaptureModule>("extensions/tool-capture/index.ts");
  const samples: Array<[kind: string, text: string, secret: string]> = [
    ["bearer", "Authorization: Bearer ya29.a0AfH6SMBsmokeSmokeSmoke", "ya29.a0AfH6SMBsmokeSmokeSmoke"],
    ["bearer", "authorization=token smokeTokenValue1234", "smokeTokenValue1234"],
    ["github_token", "github_" + "pat_11SMOKE0123456789_abcdefghijklmnopqrstuvwxyz", "github_pat_11SMOKE"],
    ["url_credentials", "postgres://admin:hunter2hunter2@db.example.invalid:5432/app", "hunter2hunter2"],
    ["url_credentials", "https://deploy:s3cr3tpass@git.example.invalid/repo.git", "s3cr3tpass"],
  ];
  for (const [kind, text, secret] of samples) {
    assert.ok(capture.scanSecrets(text, false).kinds.includes(kind), `tool-capture flags ${kind}: ${text}`);
    const out = mod.redact(text);
    assert.ok(!out.includes(secret), `save masks ${kind}: ${out}`);
    assert.match(out, /\[REDACTED\]/);
  }
  assert.match(mod.redact("Authorization: Bearer ya29.a0AfH6SMBsmokeSmokeSmoke"), /^Authorization: Bearer \[REDACTED\]$/, "header name survives");
  assert.match(mod.redact("postgres://admin:hunter2hunter2@db.example.invalid/app"), /db\.example\.invalid\/app$/, "host survives");
  // The URL-credential shape is the same linear one tool-capture uses: a long run of scheme
  // characters is not re-scanned from every word boundary.
  const started = performance.now();
  mod.redact("a.".repeat(40_000));
  assert.ok(performance.now() - started < 200, "redact stays linear on a long run of scheme characters");
};

const testCopiesCompactionSummaries = withVault(async (ws, vault) => {
  const { pi } = setup();
  const restore = setEnv("PI_KIT_SAVE_PROJECT", "GitLab Migration");
  try {
    const hook = pi.handlers.get("session_compact");
    await hook({ compactionEntry: { summary: "NATIVE_SUMMARY", details: { readFiles: [] } } }, fakeCtx(ws));
    const dir = path.join(vault, "10_Projects", "GitLab Migration");
    assert.match(fs.readFileSync(path.join(dir, "Latest Compact.md"), "utf8"), /kind: compact[\s\S]*Copied from a compaction summary[\s\S]*NATIVE_SUMMARY/);
    await hook({ compactionEntry: { summary: "COMPRESSED", details: { compressor: "pi-kit-compress" } } }, fakeCtx(ws));
    const logs = fs.readdirSync(path.join(dir, "Compacts")).sort();
    assert.deepEqual(logs.map((f) => f.replace(/^\S+ \d+ - /, "")), ["compact.md", "compress.md"]);
    assert.match(fs.readFileSync(path.join(dir, "Latest Compact.md"), "utf8"), /COMPRESSED/, "latest is the newest");

    const off = setEnv("PI_KIT_SAVE_ON_COMPACT", "0");
    try {
      await hook({ compactionEntry: { summary: "IGNORED" } }, fakeCtx(ws));
      assert.doesNotMatch(fs.readFileSync(path.join(dir, "Latest Compact.md"), "utf8"), /IGNORED/);
    } finally { off(); }
  } finally { restore(); }
});

const testInteractiveRunsInBackgroundHeadlessWaits = withoutVault(async (ws) => {
  // Assigned synchronously by the Promise executor below.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { pi } = setup({ gate });
  const latest = path.join(ws, ".pi", "snapshots", "Latest Compact.md");

  const ui = fakeCtx(ws);
  await pi.commands.get("save").handler("", ui);
  assert.equal(fs.existsSync(latest), false, "interactive handler returns before the summary finishes");
  assert.match(lastNote(ui.notes).message, /in the background/);

  const second = fakeCtx(ws);
  await pi.commands.get("save").handler("", second);
  assert.match(lastNote(second.notes).message, /a save is already running/, "no parallel saves");

  release();
  // This call can hit the running guard. run() still awaits the first background job.
  await pi.run("", fakeCtx(ws, { hasUI: false }));
  assert.ok(fs.existsSync(latest), "background job writes after the summary resolves");

  const { pi: headless } = setup();
  const ws2 = path.join(ws, "headless");
  await headless.commands.get("save").handler("", fakeCtx(ws2, { hasUI: false }));
  assert.ok(fs.existsSync(path.join(ws2, ".pi", "snapshots", "Latest Compact.md")), "headless handler waits for the write");
});

const testSameSecondDoesNotOverwriteLog = withoutVault(async (ws) => {
  const { pi } = setup();
  await pi.run("", fakeCtx(ws));
  await pi.run("", fakeCtx(ws));
  assert.equal(fs.readdirSync(path.join(ws, ".pi", "snapshots", "Compacts")).length, 2);
});

function stampLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const tests = {
  testParseArgs,
  testSaveToVaultProjectWithoutCompacting,
  testFollowUpWhenBusyAndNoUpdateFlag,
  testUnknownProjectAndTraversalRejected,
  testPickerAndLocalFallback,
  testLocalDefaultWithoutVault,
  testSummarizerFailureWritesNothing,
  testRedactsSecrets,
  testRedactsToolCaptureShapes,
  testCopiesCompactionSummaries,
  testInteractiveRunsInBackgroundHeadlessWaits,
  testSameSecondDoesNotOverwriteLog,
};
let failed = 0;
for (const [name, t] of Object.entries(tests)) {
  try {
    await t();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`save-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`save-smoke: ${total}/${total} passed`);
