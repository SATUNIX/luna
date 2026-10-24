#!/usr/bin/env node
// pi-autonomy: the operator's CLI for bounded autonomous runs (docs/autonomy.md).
//
//   pi-autonomy templates                       what kinds of run exist
//   pi-autonomy init --template <id> [--out run.json] [flags]   write a run contract (prompts on a terminal, flags otherwise)
//   pi-autonomy plan --config run.json [--authorise --by <name>]   validate, show the resolved boundary and its digest
//   pi-autonomy start --config run.json [--yes] [--detach]        confirm the boundary, then run
//   pi-autonomy status [--run <id>]  pause|resume|steer|cancel --run <id>   manage a run
//   pi-autonomy promote --run <id>              carry out an approval-gated promotion
//   pi-autonomy export --run <id> [--out dir]   results, evidence, usage, decisions and the work
//   pi-autonomy boundary --config run.json [--probe]   the boundary alone, or the live container probe
//   pi-autonomy reconfigure --run <id> [flags]  the only way effort or budgets change for an existing run
//
// Every command accepts --json and then prints exactly one JSON object ({ ok: true, ... } or
// { ok: false, error, code }). Exit codes: 0 ok; 1 error; 2 usage or invalid contract; 3 refused
// (authorisation, duplicate, lock, illegal state); a foreground `start`/`resume` ends with 0
// succeeded, 10 failed, 11 cancelled, 12 budget_exhausted, 13 parked (blocked, paused, signalled).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { authorisationStatus, boundaryDigest, decideStart, renderBoundary } from "./lib/boundary.ts";
import { num, parseArgs } from "./lib/cli-args.ts";
import { type Budget, formatProblems, resolveContract, type RunContract, type TemplateId } from "./lib/contract.ts";
import { type EffortApi, effortApi } from "./lib/effort.ts";
import { randomSuffix } from "./lib/fsutil.ts";
import { type BoundaryReport, Engine, type Runtime, promoteRun } from "./lib/engine.ts";
import { exportRun } from "./lib/export.ts";
import { HostRepo } from "./lib/hostrepo.ts";
import { type LimitsSnapshot, type RunAuthorisation, type RunState, isTerminal, resumeAction, transition } from "./lib/lifecycle.ts";
import { HIDDEN_CHARS, readNotebook, redactSecrets, renderNotebook } from "./lib/notebook.ts";
import { stateHome } from "./lib/paths.ts";
import { planReconfigure } from "./lib/reconfigure.ts";
import { createRun } from "./lib/rundir.ts";
import { type RunLock, type RunLockOptions, createRunLock } from "./lib/runlock.ts";
import { type RunConfig, runtimeConfig } from "./lib/runcfg.ts";
import { RunStore, listRuns } from "./lib/store.ts";
import { describeTemplates, TEMPLATES } from "./lib/templates/index.ts";
import { DockerRuntime } from "./lib/runtime.ts";
import { array, boolean, isRecord, object, parseJson, parseJsonAs, string, unknownValue } from "../core/lib/guard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The error classes a command fails with; each maps to an exit code (EXIT) and is the JSON `code`. */
export type CliCode = "usage" | "invalid" | "refused" | "error";

export class CliError extends Error {
  readonly cliCode: CliCode;
  /** Extra fields for the --json error object. */
  readonly extra: Record<string, unknown>;
  constructor(code: CliCode, message: string, extra: Record<string, unknown> = {}) { super(message); this.cliCode = code; this.extra = extra; }
}
const EXIT: Record<CliCode, number> = { usage: 2, invalid: 2, refused: 3, error: 1 };

/** A runtime as the engine drives it (lib/runtime.ts DockerRuntime; the fake runtime in the offline tests). */
export type CliRuntime = Runtime;

/** Where output goes: process.stdout / process.stderr, or a capture in tests. */
export interface Writer { write(text: string): unknown }

export interface RuntimeFactoryOptions { contract: RunContract; cfg: RunConfig; store: RunStore; env: NodeJS.ProcessEnv }

/** Everything a command touches outside its arguments; main() takes overrides of any of it (tests). */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  /** The state home runs live under. */
  home: string;
  stdin: NodeJS.ReadableStream;
  stdout: Writer;
  stderr: Writer;
  /** Both stdin and stdout are a terminal: a person is present to confirm. */
  isTTY: boolean;
  pid: number;
  /** The effort API (tests inject one); core's when undefined. */
  effort: EffortApi | null | undefined;
  now: () => Date;
  /** Install SIGINT/SIGTERM handlers while supervising. */
  signals: boolean;
  lockOptions: Omit<Partial<RunLockOptions>, "file" | "pid">;
  runtimeFactory: (o: RuntimeFactoryOptions) => CliRuntime;
  /** Ask a yes/no question on the terminal. */
  confirm: (question: string) => Promise<boolean>;
  /** Ask for a line on the terminal; an empty answer is `def`. */
  ask: (question: string, def?: string) => Promise<string>;
  /** Start a detached supervisor for the run; returns its pid. */
  spawnSupervisor: (run: string, store: RunStore) => number | undefined;
}

/**
 * planReconfigure resolves the changed limits through the contract resolver, so a plan that is ok
 * carries a complete budget; this checks that instead of assuming it (nothing is changed otherwise).
 */
function completeBudget(b: Budget | Budget<undefined>): Budget {
  const { totalUsd, perStepUsd, maxSteps, maxMinutes } = b;
  if (totalUsd === undefined || perStepUsd === undefined || maxSteps === undefined || maxMinutes === undefined) throw new CliError("error", "reconfigure produced an incomplete budget; nothing was changed");
  return { ...b, totalUsd, perStepUsd, maxSteps, maxMinutes };
}
const limitsSnapshot = ({ effort, budget, recovery }: { effort: LimitsSnapshot["effort"]; budget: Budget | Budget<undefined>; recovery: LimitsSnapshot["recovery"] }): LimitsSnapshot => ({ effort, budget: completeBudget(budget), recovery });

/** What a command returns: the --json fields, the text for a terminal, and the exit code (0 when absent). */
interface CommandResult { data: Record<string, unknown>; text: string; exit?: number }
type Command = (argv: string[], deps: CliDeps) => Promise<CommandResult>;

/** A thrown value's `code` and `message`, whatever was thrown. */
const codeOf = (e: unknown): unknown => (isRecord(e) ? e.code : undefined);
const messageOf = (e: unknown): unknown => (isRecord(e) ? e.message : undefined);

/** authorisationStatus's report, or the authorisation `plan --authorise` just recorded. */
type AuthorisationView = ReturnType<typeof authorisationStatus>;

const isTemplateId = (id: unknown): id is TemplateId => typeof id === "string" && Object.hasOwn(TEMPLATES, id);

/** A stream's isTTY: Node's types say boolean, but it is absent (not false) on a pipe or file. */
const tty = (stream: { isTTY?: boolean }): boolean => stream.isTTY === true;

export function defaultDeps(): CliDeps {
  const isTTY = tty(process.stdin) && tty(process.stdout);
  return {
    env: process.env, home: stateHome(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, isTTY, pid: process.pid,
    effort: undefined, now: () => new Date(), signals: true, lockOptions: {},
    runtimeFactory: ({ contract, cfg, store, env }) => new DockerRuntime({ contract, cfg, store, env }),
    confirm: async (question: string, { stdin = process.stdin, stdout = process.stdout }: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {}) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try { return /^y(es)?$/i.test((await rl.question(`${question} [yes/no] `)).trim()); } finally { rl.close(); }
    },
    ask: async (question: string, def = "") => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { const a = (await rl.question(def ? `${question} [${def}] ` : `${question} `)).trim(); return a || def; } finally { rl.close(); }
    },
    /** Start `cli.ts supervise --run <id>` detached, logging to the run's supervisor.log. */
    spawnSupervisor: (run: string, store: RunStore) => {
      fs.mkdirSync(store.p.root, { recursive: true });
      const fd = fs.openSync(store.p.log, "a");
      const child = spawn(process.execPath, [path.join(HERE, "cli.ts"), "supervise", "--run", run], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      return child.pid;
    },
  };
}

// --- helpers -----------------------------------------------------------------------------------------
function loadConfig(file: string | undefined, deps: CliDeps, { checkFs = true }: { checkFs?: boolean } = {}) {
  if (!file) throw new CliError("usage", "--config <run.json> is required (create one with `pi-autonomy init`)");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new CliError("invalid", `cannot read ${file}: ${String(codeOf(e) ?? messageOf(e))}`); }
  let raw: unknown;
  try { raw = parseJson(text); } catch (e) { throw new CliError("invalid", `${file} is not valid JSON: ${String(messageOf(e))}`); }
  const r = resolveContract(raw, { baseDir: path.dirname(path.resolve(file)), effort: deps.effort, checkFs });
  return { ...r, raw, file: path.resolve(file) };
}

const effortFor = (deps: CliDeps): EffortApi | null => effortApi(deps.effort);

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/; // the contract's own rule (lib/contract.ts): a run id names branches, containers and a directory

function openStore(run: string | undefined, deps: CliDeps): RunStore {
  if (!run) throw new CliError("usage", "--run <id> is required (list runs with `pi-autonomy status`)");
  if (!RUN_ID.test(run)) throw new CliError("usage", `--run ${JSON.stringify(run.slice(0, 60))} is not a run id (3-41 characters: lowercase letters, digits and -); \`pi-autonomy status\` lists them`);
  const store = new RunStore(run, { home: deps.home, now: deps.now });
  if (!store.exists()) throw new CliError("refused", `no run ${run} under ${deps.home}`);
  const raw = store.readStateRaw();
  if (!isRecord(raw) || raw.schemaVersion === undefined) throw new CliError("refused", `run ${run} was written by the previous supervisor (the v0 format) and cannot be driven by this one. Its work is intact in ${store.p.root} (remote.git and mirror.git hold the branches and tags). Start a new run with \`pi-autonomy init --template self-improve\`, or export what you need with git.`);
  return store;
}

const lockFor = (store: RunStore, deps: CliDeps): RunLock => createRunLock({ file: store.p.lock, pid: deps.pid, ...deps.lockOptions });

function liveSupervisor(store: RunStore, deps: CliDeps) {
  const seen = lockFor(store, deps).inspect();
  return seen && seen.state !== "stale" ? seen : null;
}

/** Run `fn` holding the run lock, for commands that change state while no supervisor is running. */
async function offline<T>(store: RunStore, deps: CliDeps, fn: () => Promise<T>): Promise<T> {
  const lock = lockFor(store, deps);
  const got = lock.acquire();
  if (!got.acquired) throw new CliError("refused", got.reason);
  try { return await fn(); } finally { lock.release(); }
}

/** state.json of a run openStore found; a run without one cannot be driven. */
function readState(store: RunStore): RunState {
  const state = store.readState();
  if (!state) throw new CliError("error", `run ${store.run} has no state.json`);
  return state;
}

function loadRun(store: RunStore): { state: RunState; contract: RunContract; cfg: RunConfig } {
  const state = readState(store);
  const contract = store.readContract();
  if (!contract) throw new CliError("error", `run ${store.run} has no contract.json`);
  return { state, contract, cfg: runtimeConfig(contract) };
}

async function cleanupOrphans(store: RunStore, deps: CliDeps, { contract, cfg }: { contract: RunContract; cfg: RunConfig }): Promise<unknown> {
  try { return await deps.runtimeFactory({ contract, cfg, store, env: deps.env }).cleanupOrphans(); } catch { return []; }
}

/** state.json is not checked field by field (lib/store.ts), so a figure from it is converted, not assumed. */
const usd = (n: unknown): string => `$${Number(n).toFixed(2)}`;

/** The most of a rotation's problems the status shows. */
const ROTATION_PROBLEMS_SHOWN = 3;

/**
 * Generations (Memento mode) for `status`: the current generation of the contract's maximum, why the
 * last one rotated, and the latest notebook as the next worker's briefing renders it. Null when the
 * contract does not enable generations. state.json is not checked field by field, so its figures are
 * converted, not assumed. notebook.json was redacted when each generation was appended; the rendered
 * text is redacted again here, so a secret-shaped value never reaches the terminal from this file.
 */
function generationsReport(store: RunStore, state: RunState, contract: RunContract) {
  const g = contract.generations;
  if (!g?.enabled) return null;
  // Read as unknown: state.json's generations record is not validated (lib/store.ts).
  const gs: unknown = state.generations;
  const history = isRecord(gs) ? gs.history : undefined;
  const last: unknown = Array.isArray(history) ? history.at(-1) : undefined;
  const current = isRecord(gs) ? gs.current : undefined;
  // state.json fields can quote worker text: every control and format character is dropped (newline and tab become a space) before redaction.
  const text = (v: unknown): string => redactSecrets((typeof v === "string" ? v : String(v)).replace(HIDDEN_CHARS, (ch) => (ch === "\n" || ch === "\t" ? " " : ""))).text;
  const problems = isRecord(last) ? last.problems : undefined;
  // The Memento decision (engine.ts mementoDecision), once the first step made it: the contract's maxGenerations capped to the allowance.
  const m: unknown = state.memento;
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const allowed = isRecord(m) ? count(m.maxGenerations) : null;
  const memento = isRecord(m) && allowed !== null ? { requested: count(m.requested) ?? g.maxGenerations, allowance: count(m.allowance) ?? 0, maxGenerations: allowed, reason: text(m.reason) } : null;
  let notebook: { generation: number; at: string; text: string; redactions: number } | null = null;
  let notebookError: string | null = null;
  try {
    const entry = readNotebook(store.p.notebook).at(-1);
    if (entry) {
      const shown = redactSecrets(renderNotebook(entry));
      notebook = { generation: entry.generation, at: entry.at, text: shown.text, redactions: entry.report.redactions + shown.count };
    }
  } catch (e) { notebookError = String(messageOf(e)); }
  return {
    current: typeof current === "number" && Number.isInteger(current) && current > 0 ? current : 0,
    max: memento ? Math.min(memento.maxGenerations, g.maxGenerations) : g.maxGenerations,
    memento,
    iterationMinutes: g.iterationMinutes, iterationUsd: g.iterationUsd,
    lastRotation: isRecord(last) ? { generation: Number(last.generation), at: text(last.at), box: text(last.box), action: text(last.action), notebook: last.notebook === true, reset: last.reset === true, problems: Array.isArray(problems) ? problems.slice(0, ROTATION_PROBLEMS_SHOWN).map(text) : [] } : null,
    notebook, notebookError,
  };
}

/** One line for the last rotation: which box ended which generation, the recovery decision, and the notebook's fate. */
function rotationText(r: NonNullable<NonNullable<ReturnType<typeof generationsReport>>["lastRotation"]>): string {
  const box = r.box === "usd" ? "its dollar box ran out" : r.box === "minutes" ? "its time box ran out" : `box ${r.box}`;
  const nb = r.notebook ? "notebook appended" : `no usable notebook${r.problems.length ? ` (${r.problems.join("; ")})` : ""}`;
  return `generation ${r.generation} ended at ${r.at}: ${box}; recovery ${r.action}; ${nb}${r.reset ? "; the next generation started from the accepted head" : ""}`;
}

function statusReport(store: RunStore, deps: CliDeps) {
  const { state, contract } = loadRun(store);
  const lock = lockFor(store, deps).inspect();
  const latest = state.acceptance.latest;
  return {
    run: state.run, template: state.template, status: state.status, phase: state.phase, outcome: state.outcome, blocker: state.blocker,
    supervisor: lock ? { state: lock.state, why: lock.why, pid: lock.holder?.pid ?? null, host: lock.holder?.host ?? null, heartbeatAt: lock.holder?.heartbeatAt ?? null } : null,
    step: state.step, usage: state.usage, limits: state.limits, effort: state.effort,
    tasks: state.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, checks: t.checks })),
    acceptance: latest ? { step: latest.step, sha: latest.sha, allRequiredPass: latest.allRequiredPass, results: latest.results.map((r) => ({ id: r.id, required: r.required, pass: r.pass })) } : null,
    review: state.acceptance.review,
    recovery: { stalls: state.recovery.stalls, softNudgesUsed: state.recovery.softNudgesUsed, hardRestartsUsed: state.recovery.hardRestartsUsed, totals: state.recovery.totals, violations: state.recovery.violations },
    worker: state.worker, promotion: { status: state.promotion.status, error: state.promotion.error ?? null, targets: state.promotion.targets ?? [] },
    questions: state.pendingQuestions ?? [], ui: state.ui ?? null, reconfigurations: state.reconfigurations.length,
    generations: generationsReport(store, state, contract),
    selfImprove: state.selfImprove ? { cycles: state.selfImprove.history.length, merged: state.selfImprove.merged, current: state.selfImprove.current?.n ?? null } : null,
    history: state.history.slice(-8), boundaryDigest: state.boundaryDigest, authorisation: state.authorisation,
    paths: { root: store.p.root, log: store.p.log, results: store.p.results }, title: contract.objective.title,
  };
}

type StatusReport = ReturnType<typeof statusReport>;

function statusText(s: StatusReport): string {
  const lines = [`run ${s.run} (${s.template}): ${s.status}${s.outcome ? ` [${s.outcome.reason}]` : ""}${s.phase ? `, phase ${s.phase}` : ""}`, `  ${s.title}`];
  lines.push(`  supervisor: ${s.supervisor ? `${s.supervisor.state} (${s.supervisor.why})` : "none"}`);
  lines.push(`  step ${s.step}; spent ${usd(s.usage.usd)} of ${usd(s.limits.budget.totalUsd)}, ${s.usage.steps}/${s.limits.budget.maxSteps} steps, ${Math.round(s.usage.minutes)}/${s.limits.budget.maxMinutes} min; effort ${s.effort.tier} (cap ${s.effort.cap})`);
  if (s.blocker) lines.push(`  BLOCKED (${s.blocker.kind}): ${s.blocker.question}${s.blocker.options?.length ? ` [${s.blocker.options.join(" | ")}]` : ""}\n  answer with: pi-autonomy resume --run ${s.run} --answer "..."`);
  if (s.tasks.length) { lines.push("  task board (from trusted results):"); for (const t of s.tasks) lines.push(`    [${t.status}] ${t.id}: ${t.title}`); }
  if (s.acceptance) lines.push(`  acceptance @ step ${s.acceptance.step}: ${s.acceptance.results.map((r) => `${r.id} ${r.pass ? "PASS" : "FAIL"}`).join(", ")}${s.acceptance.allRequiredPass ? " (all required pass)" : ""}`);
  if (s.review?.status && s.review.status !== "skipped") lines.push(`  review: ${s.review.status}${s.review.reason ? ` - ${s.review.reason}` : ""}`);
  lines.push(`  recovery: ${s.recovery.softNudgesUsed} nudge(s), ${s.recovery.hardRestartsUsed} restart(s) this episode; totals ${s.recovery.totals.softNudges}/${s.recovery.totals.hardRestarts}`);
  if (s.generations) {
    const g = s.generations;
    if (g.memento && g.max <= 1) lines.push(`  generations (Memento mode): a single generation, not ${g.memento.requested}; the Memento allowance is ${g.memento.allowance} (${g.memento.reason})`);
    else lines.push(`  generations (Memento mode): ${g.current ? `generation ${g.current}/${g.max}` : `not started (up to ${g.max})`}; box ${g.iterationMinutes} min${g.iterationUsd !== null ? ` or ${usd(g.iterationUsd)}` : ""}${g.memento && g.max < g.memento.requested ? `; capped from ${g.memento.requested} by the Memento allowance (${g.memento.reason})` : ""}`);
    lines.push(`  last rotation: ${g.lastRotation ? rotationText(g.lastRotation) : "none yet"}`);
    if (g.notebookError) lines.push(`  notebook: unreadable (${g.notebookError})`);
    else if (g.notebook) lines.push(`  latest notebook (redacted; the next worker's briefing shows the same):`, ...g.notebook.text.split("\n").map((l) => `    ${l}`));
  }
  if (s.selfImprove) lines.push(`  cycles: ${s.selfImprove.cycles} done, ${s.selfImprove.merged} merged${s.selfImprove.current ? `, cycle ${s.selfImprove.current} in progress` : ""}`);
  if (s.promotion.status !== "none") lines.push(`  promotion: ${s.promotion.status}${s.promotion.error ? ` (${s.promotion.error})` : ""}${s.promotion.status === "awaiting_approval" ? `; approve with: pi-autonomy promote --run ${s.run}` : ""}`);
  lines.push(`  logs: ${s.paths.log}`);
  return lines.join("\n");
}

const EXIT_FOR_STATUS: Partial<Record<string, number>> = { succeeded: 0, failed: 10, cancelled: 11, budget_exhausted: 12 };
const exitFor = (status: string): number => (Object.hasOwn(EXIT_FOR_STATUS, status) ? EXIT_FOR_STATUS[status] : undefined) ?? 13;

/** A template by id; describeTemplates() only lists ids TEMPLATES has. */
function templateOf(id: unknown): (typeof TEMPLATES)[TemplateId] {
  if (!isTemplateId(id)) throw new CliError("error", `unknown template ${String(id)}`);
  return TEMPLATES[id];
}

/** A service as `init --service name=image@port` declares it. */
interface ServiceDraft {
  name: string;
  image: string;
  port: number;
  workspaceMounts: Array<{ source: string; target: string }>;
  health: { path: string };
}

/** The contract document `init` writes: unvalidated until resolveContract reads it back. */
interface InitDraft {
  schemaVersion: 1;
  run: string;
  template: TemplateId;
  objective: { title: string | undefined; spec?: string; specFile?: string; backlog?: Array<{ id: string; title: string }> };
  inputs: { repository?: { path: string; ref: string } | { url: string; ref: string } | null };
  acceptance: { checks: Array<Record<string, unknown>>; review: boolean };
  permissions: {
    network: { egress?: Array<{ host: string; ports: number[] }>; services?: unknown[]; serviceImages?: string[] };
    unattended: { authorised?: boolean; autoApprove?: boolean };
    writeAreas?: string[];
    credentials?: { names: string[] };
  };
  budget?: Record<string, number>;
  promotion: { policy: string; destinations?: Array<Record<string, string | undefined>> };
  effort?: string;
  model?: Record<string, string>;
  providerSettings?: Record<string, string>;
  templateOptions?: { integration: { branch: string; review: boolean } };
  runtime?: Record<string, string>;
}

/** The part of examples/deploy.json `init --template deploy` copies when no --service is given. */
const DeployExampleSchema = object({ permissions: object({ network: object({ services: array(unknownValue()), serviceImages: array(string()) }) }) });
const NamedSchema = object({ name: string() });

/** The part of a run's boundary.json (the last live probe) the text of `boundary --run` reads; --json prints the file whole. */
const ProbeSummarySchema = object({ at: string(), checks: array(object({ ok: boolean() })) });

// --- commands -----------------------------------------------------------------------------------------
const commands: Record<string, Command> = {
  async templates(argv) {
    parseArgs(argv, { flags: ["json"] });
    const templates = describeTemplates().map((d) => ({ ...d, defaults: templateOf(d.id).defaults() }));
    return { data: { templates }, text: templates.map((t) => `${t.id.padEnd(13)} ${t.finite ? "finite" : "cycling"}  ${t.title}\n${" ".repeat(22)}${t.summary}\n${" ".repeat(22)}needs: ${t.requires.join("; ")}\n${" ".repeat(22)}try:   pi-autonomy init --template ${t.id}`).join("\n\n") };
  },

  async init(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["template", "out", "run", "title", "spec", "spec-file", "repo", "repo-url", "ref", "budget-usd", "step-usd", "max-steps", "max-minutes", "effort", "model", "manager-model", "review-model", "provider", "upstream", "key-env", "promotion", "promotion-repo", "promotion-url", "promotion-branch", "integration-branch", "engine", "image"], lists: ["check", "backlog", "egress", "write-area", "service", "mount", "health", "credential"], flags: ["json", "force", "unattended", "attended", "no-review", "yes"] });
    const interactive = deps.isTTY && !opts.json && !opts.yes;
    let template = opts.template;
    if (!template && interactive) template = await deps.ask(`Template (${Object.keys(TEMPLATES).join(", ")})`, "implement");
    if (!isTemplateId(template)) throw new CliError("usage", `--template must be one of ${Object.keys(TEMPLATES).join(", ")} (see \`pi-autonomy templates\`)`);
    const ask = async <D extends string | undefined>(q: string, given: string | undefined, def: D): Promise<string | D> => given ?? (interactive ? await deps.ask(q, def) : def);
    const stamp = deps.now().toISOString().slice(0, 10).replace(/-/g, "");
    const run = await ask("Run id", opts.run, `${template === "self-improve" ? "improve" : template}-${stamp}-${randomSuffix(4)}`);
    const title = await ask("Title", opts.title, template === "self-improve" ? "Improve the repository in reviewed cycles" : undefined);
    const rawBudget: Record<string, number> = {};
    const raw: InitDraft = { schemaVersion: 1, run, template, objective: { title }, inputs: {}, acceptance: { checks: [], review: !opts["no-review"] }, permissions: { network: {}, unattended: {} }, budget: rawBudget, promotion: { policy: opts.promotion ?? (template === "self-improve" ? "local-branch" : "none") } };
    const spec = opts.spec;
    if (opts["spec-file"]) raw.objective.specFile = opts["spec-file"];
    else if (spec !== undefined) raw.objective.spec = spec;
    else if (interactive && template !== "self-improve") raw.objective.spec = await deps.ask("Specification (one line, or use --spec-file)", "");
    const repoPath = await ask("Repository path (blank for an empty start)", opts.repo, "");
    if (repoPath) raw.inputs.repository = { path: repoPath, ref: opts.ref ?? "main" };
    else if (opts["repo-url"]) raw.inputs.repository = { url: opts["repo-url"], ref: opts.ref ?? "main" };
    else raw.inputs.repository = null;
    for (const c of opts.check ?? []) {
      const i = c.indexOf("=");
      if (i < 1) throw new CliError("usage", `--check needs id=command (got ${JSON.stringify(c)})`);
      const cmd = c.slice(i + 1).trim();
      raw.acceptance.checks.push({ id: c.slice(0, i), run: cmd.startsWith("[") ? parseJson(cmd) : cmd, timeoutMinutes: 15, required: true });
    }
    if (!raw.acceptance.checks.length && interactive) {
      for (;;) { const c = await deps.ask("Acceptance check as id=command (blank to finish)", ""); if (!c) break; const i = c.indexOf("="); if (i > 0) raw.acceptance.checks.push({ id: c.slice(0, i), run: c.slice(i + 1).trim(), timeoutMinutes: 15, required: true }); }
    }
    const backlog = (opts.backlog ?? []).map((b, i) => { const [id = "", ...t] = b.includes(":") ? b.split(":") : [`T${i + 1}`, b]; return { id: id.trim(), title: t.join(":").trim() }; });
    if (backlog.length) raw.objective.backlog = backlog;
    // Unattended operation is the point of a run, and it is opt-in: written explicitly so the boundary shows it.
    const unattended = opts.attended ? false : opts.unattended ?? (interactive ? /^y/i.test(await deps.ask("Run without approval prompts inside the zone? (y/n)", "y")) : false);
    raw.permissions.unattended = { authorised: unattended, autoApprove: unattended };
    const egress = opts.egress ?? [];
    raw.permissions.network.egress = egress.map((e) => { const [host = "", ...ports] = e.split(":"); return { host, ports: ports.length ? ports.map(Number) : [443] }; });
    if (opts["write-area"]) raw.permissions.writeAreas = opts["write-area"];
    if (opts.credential?.length) raw.permissions.credentials = { names: opts.credential };
    const services = (opts.service ?? []).map((s): ServiceDraft => {
      const m = s.match(/^([^=]+)=(.+)@(\d+)$/);
      if (!m) throw new CliError("usage", `--service needs name=image@port (got ${JSON.stringify(s)})`);
      const [, name = "", image = "", port = ""] = m;
      return { name, image, port: Number(port), workspaceMounts: [], health: { path: "/" } };
    });
    for (const mo of opts.mount ?? []) { const m = mo.match(/^([^=]+)=([^:]+):(\/.+)$/); const svc = services.find((s) => s.name === m?.[1]); if (!m || !svc) throw new CliError("usage", `--mount needs name=source:/target for a declared --service (got ${JSON.stringify(mo)})`); const [, , source = "", target = ""] = m; svc.workspaceMounts.push({ source, target }); }
    for (const h of opts.health ?? []) { const m = h.match(/^([^=]+)=(\/.*)$/); const svc = services.find((s) => s.name === m?.[1]); if (!m || !svc) throw new CliError("usage", `--health needs name=/path for a declared --service`); svc.health = { path: m[2] ?? "" }; }
    if (services.length) { raw.permissions.network.services = services; raw.permissions.network.serviceImages = [...new Set(services.map((s) => s.image))]; }
    else if (template === "deploy") {
      const ex = parseJsonAs(DeployExampleSchema, fs.readFileSync(path.join(HERE, "examples", "deploy.json"), "utf8"), "examples/deploy.json");
      raw.permissions.network.services = ex.permissions.network.services; raw.permissions.network.serviceImages = ex.permissions.network.serviceImages;
      if (!raw.acceptance.checks.some((c) => c.type === "service-health")) raw.acceptance.checks.push({ id: "service-up", type: "service-health", service: NamedSchema.parse(ex.permissions.network.services[0], "examples/deploy.json.permissions.network.services[0]").name, path: "/", expectStatus: 200, required: true });
    }
    const budget = { totalUsd: num(opts["budget-usd"], "budget-usd"), perStepUsd: num(opts["step-usd"], "step-usd"), maxSteps: num(opts["max-steps"], "max-steps"), maxMinutes: num(opts["max-minutes"], "max-minutes") };
    for (const [k, v] of Object.entries(budget)) if (v !== undefined) rawBudget[k] = v;
    if (!Object.keys(rawBudget).length) delete raw.budget;
    if (opts.effort) raw.effort = opts.effort;
    if (opts.model || opts.provider || opts["manager-model"] || opts["review-model"]) raw.model = { ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.model ? { worker: opts.model } : {}), ...(opts["manager-model"] ? { manager: opts["manager-model"] } : {}), ...(opts["review-model"] ? { review: opts["review-model"] } : {}) };
    if (opts.upstream || opts["key-env"]) raw.providerSettings = { ...(opts.upstream ? { upstream: opts.upstream } : {}), ...(opts["key-env"] ? { apiKeyEnv: opts["key-env"] } : {}) };
    if (raw.promotion.policy === "local-branch") raw.promotion.destinations = [{ kind: "local-branch", ...(opts["promotion-repo"] ? { repo: opts["promotion-repo"] } : {}), branch: opts["promotion-branch"] ?? opts["integration-branch"] ?? (template === "self-improve" ? "pi-autonomy/integration" : `pi/${run}`) }];
    if (raw.promotion.policy === "push") raw.promotion.destinations = [{ kind: "git-remote", url: opts["promotion-url"], branch: opts["promotion-branch"] ?? `pi/${run}` }];
    if (template === "self-improve") raw.templateOptions = { integration: { branch: opts["integration-branch"] ?? "pi-autonomy/integration", review: !opts["no-review"] } };
    if (opts.engine || opts.image) raw.runtime = { ...(opts.engine ? { engine: opts.engine } : {}), ...(opts.image ? { image: opts.image } : {}) };
    const out = path.resolve(opts.out ?? "run.json");
    const r = resolveContract(raw, { baseDir: path.dirname(out), effort: deps.effort, checkFs: false });
    if (!r.ok && !opts.force) throw new CliError("invalid", `the contract is not valid yet:\n${formatProblems(r.problems)}\nFix the flags (or pass --force to write it anyway and edit it by hand).`, { problems: r.problems });
    // "wx" creates the file only if it does not exist, in one step: no window between checking and writing.
    try { fs.writeFileSync(out, `${JSON.stringify(raw, null, 2)}\n`, { flag: opts.force ? "w" : "wx" }); } catch (e) { if (codeOf(e) === "EEXIST") throw new CliError("refused", `${out} exists; pass --force to overwrite it`); throw e; }
    return { data: { path: out, run, template, valid: r.ok, problems: r.problems, contract: raw, next: [`pi-autonomy plan --config ${out}`, `pi-autonomy start --config ${out}`] }, text: `wrote ${out}${r.problems.length ? `\n${formatProblems(r.problems)}` : ""}\nnext: pi-autonomy plan --config ${out}   (shows exactly what the run may touch, and its digest)` };
  },

  async plan(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["config", "by", "digest"], flags: ["json", "authorise", "authorize", "yes"] });
    const cfg = loadConfig(opts.config, deps);
    const authorise = opts.authorise || opts.authorize;
    if (!cfg.contract) throw new CliError("invalid", formatProblems(cfg.problems), { problems: cfg.problems });
    const b = renderBoundary(cfg.contract, { effort: effortFor(deps) });
    // --digest <hex>: authorise only the boundary the caller was shown. Without it, whatever the file holds at this moment is authorised.
    if (opts.digest !== undefined && authorise && opts.digest !== b.digest) throw new CliError("refused", `the boundary changed since it was shown to you (shown ${opts.digest.slice(0, 12)}, now ${b.digest.slice(0, 12)}): nothing was authorised. Run \`plan\` again and read it.`, { shown: opts.digest, digest: b.digest });
    let authorisation: AuthorisationView = authorisationStatus(cfg.contract, b.digest);
    let wrote: string | undefined;
    if (authorise) {
      if (!cfg.ok) throw new CliError("invalid", `cannot authorise an invalid contract:\n${formatProblems(cfg.problems)}`, { problems: cfg.problems });
      if (cfg.legacy) throw new CliError("refused", "a deprecated v0 config cannot carry an authorisation; write a schemaVersion 1 contract first (`init`)");
      const by = opts.by ?? os.userInfo().username;
      const ok = deps.isTTY && !opts.json ? await deps.confirm(`${b.text}\n\nAuthorise this boundary (digest ${b.digest.slice(0, 12)}) as ${by}?`) : Boolean(opts.yes);
      if (!ok) throw new CliError("refused", opts.yes === undefined && !deps.isTTY ? "no terminal to confirm on: pass --yes after showing the boundary to the person who owns it" : "not authorised");
      const raw = parseJson(fs.readFileSync(cfg.file, "utf8"));
      if (!isRecord(raw)) throw new CliError("error", `${cfg.file} is no longer a JSON object; nothing was authorised`);
      const at = deps.now().toISOString();
      raw.authorisation = { boundaryDigest: b.digest, by, at };
      fs.writeFileSync(cfg.file, `${JSON.stringify(raw, null, 2)}\n`);
      authorisation = { status: "authorised", by, at };
      wrote = cfg.file;
    }
    const data = { ok: cfg.ok, run: cfg.contract.run, template: cfg.contract.template, legacy: cfg.legacy, problems: cfg.problems, digest: b.digest, boundary: b.json.boundary, invariants: b.json.invariants, authorisation, effort: cfg.contract.effort, ...(wrote !== undefined ? { wrote } : {}) };
    const text = [cfg.problems.length ? `${formatProblems(cfg.problems)}\n` : "", b.text, "", `authorisation: ${authorisation.status}${authorisation.status === "authorised" ? ` by ${String(authorisation.by)} at ${String(authorisation.at)}` : authorisation.status === "mismatch" ? " (the contract changed since it was authorised)" : ""}`, cfg.ok ? "" : "The contract has errors; fix them before starting."].filter((x) => x !== "").join("\n");
    return { data, text };
  },

  async boundary(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["config", "run"], flags: ["json", "probe"] });
    if (opts.run) {
      const store = openStore(opts.run, deps);
      const { state, contract } = loadRun(store);
      const effective = { ...contract, effort: state.effort, budget: state.limits.budget, recovery: state.limits.recovery };
      const b = renderBoundary(effective, { effort: effortFor(deps) });
      const probe = parseJson(fs.existsSync(store.p.boundary) ? fs.readFileSync(store.p.boundary, "utf8") : "null");
      const last = probe ? ProbeSummarySchema.parse(probe, "boundary.json") : null;
      return { data: { run: state.run, digest: b.digest, authorisedDigest: state.boundaryDigest, matchesAuthorisation: b.digest === state.boundaryDigest, boundary: b.json.boundary, invariants: b.json.invariants, lastProbe: probe }, text: `${b.text}\n\n${state.boundaryDigest === b.digest ? "matches the authorised boundary" : `differs from the authorised boundary ${state.boundaryDigest.slice(0, 12)} (effort or limits were reconfigured)`}${last ? `\nlast probe: ${last.checks.filter((c) => c.ok).length}/${last.checks.length} passed at ${last.at}` : ""}` };
    }
    const cfg = loadConfig(opts.config, deps);
    if (!cfg.ok) throw new CliError("invalid", formatProblems(cfg.problems), { problems: cfg.problems });
    const b = renderBoundary(cfg.contract, { effort: effortFor(deps) });
    if (!opts.probe) return { data: { digest: b.digest, boundary: b.json.boundary, invariants: b.json.invariants, problems: cfg.problems }, text: b.text };
    const report = await probeOnly(cfg.contract, deps);
    return { data: { digest: b.digest, probe: report, pass: report.pass }, text: `${report.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`).join("\n")}\nboundary ${report.pass ? "verified" : "NOT verified"} (${report.checks.filter((c) => c.ok).length}/${report.checks.length})`, exit: report.pass ? 0 : 3 };
  },

  async start(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["config", "by"], flags: ["json", "yes", "detach"] });
    const cfg = loadConfig(opts.config, deps);
    if (!cfg.ok) throw new CliError("invalid", `the contract has errors:\n${formatProblems(cfg.problems)}`, { problems: cfg.problems });
    if (cfg.legacy) deps.stderr.write("warning: deprecated v0 config mapped onto the self-improve template; write a schemaVersion 1 contract (`pi-autonomy init`)\n");
    const b = renderBoundary(cfg.contract, { effort: effortFor(deps) });
    const decision = decideStart({ contract: cfg.contract, digest: b.digest, yes: Boolean(opts.yes), isTTY: deps.isTTY && !opts.json });
    if (decision.action === "refuse") throw new CliError("refused", decision.message, { refusal: decision.code, digest: b.digest });
    if (!opts.json) deps.stdout.write(`${b.text}\n\n`);
    let authorisation: RunAuthorisation;
    if (decision.action === "confirm") {
      const ok = await deps.confirm(`Authorise this boundary (digest ${b.digest.slice(0, 12)}) and start run ${cfg.contract.run}?`);
      if (!ok) throw new CliError("refused", "not authorised; nothing was started");
      authorisation = { boundaryDigest: b.digest, by: opts.by ?? os.userInfo().username, at: deps.now().toISOString(), via: "interactive" };
    } else if (decision.authorisation.via === "tty-yes") authorisation = { ...decision.authorisation, by: opts.by ?? os.userInfo().username, at: deps.now().toISOString() };
    else authorisation = decision.authorisation;
    let store: RunStore;
    try { store = createRun({ contract: cfg.contract, authorisation, home: deps.home, now: deps.now, boundaryEffort: effortFor(deps) }); } catch (e) { throw new CliError("refused", String(messageOf(e))); }
    if (opts.detach) {
      const pid = deps.spawnSupervisor(cfg.contract.run, store);
      return { data: { run: cfg.contract.run, started: true, detached: true, pid, digest: b.digest, authorisation, root: store.p.root, log: store.p.log }, text: `run ${cfg.contract.run} started (supervisor pid ${pid}); follow it with: pi-autonomy status --run ${cfg.contract.run}` };
    }
    const state = await supervise(store, deps);
    return { data: { run: cfg.contract.run, started: true, detached: false, status: state.status, outcome: state.outcome, root: store.p.root }, text: `run ${state.run}: ${state.status}${state.outcome ? ` (${state.outcome.reason})` : ""}\nresults: pi-autonomy export --run ${state.run}`, exit: exitFor(state.status) };
  },

  /** Internal: become the supervisor of an existing run (used by --detach and by resume). */
  async supervise(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const state = await supervise(store, deps);
    return { data: { run: state.run, status: state.status, outcome: state.outcome }, text: `run ${state.run}: ${state.status}`, exit: exitFor(state.status) };
  },

  async status(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run"], flags: ["json"] });
    if (!opts.run) {
      const runs = listRuns(deps.home);
      return { data: { runs, home: deps.home }, text: runs.length ? runs.map((r) => `${r.run.padEnd(28)} ${String(r.template).padEnd(12)} ${String(r.status)}${isRecord(r.outcome) && typeof r.outcome.reason === "string" && r.outcome.reason ? ` [${r.outcome.reason}]` : ""}${r.legacy ? " (written by the v0 supervisor; read-only)" : ""}`).join("\n") : `no runs under ${deps.home}` };
    }
    const report = statusReport(openStore(opts.run, deps), deps);
    return { data: report, text: statusText(report) };
  },

  async pause(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "reason"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const state = readState(store);
    if (isTerminal(state.status) || state.status === "budget_exhausted") throw new CliError("refused", `run ${state.run} is ${state.status}; nothing to pause`);
    if (state.status === "paused") return { data: { run: state.run, status: "paused", already: true }, text: "already paused" };
    if (liveSupervisor(store, deps)) { store.enqueue("pause", { reason: opts.reason ?? "operator" }); return { data: { run: state.run, delivered: "supervisor", note: "the supervisor pauses at its next tick" }, text: "pause sent to the running supervisor; it stops the worker and parks the run at its next tick" }; }
    const ctx = loadRun(store);
    await offline(store, deps, async () => { await cleanupOrphans(store, deps, ctx); store.transition("paused", { reason: opts.reason ?? "operator", by: "operator" }); });
    return { data: { run: state.run, status: "paused", delivered: "state" }, text: "no supervisor was running; the run is paused. `resume` continues it." };
  },

  async resume(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "answer"], flags: ["json", "approve", "deny", "detach"] });
    const store = openStore(opts.run, deps);
    const state = readState(store);
    const action = resumeAction(state, { answer: opts.answer, approve: opts.approve ?? false, deny: opts.deny ?? false });
    if (state.status === "succeeded" && !["pending", "awaiting_approval"].includes(state.promotion.status)) throw new CliError("refused", action.message);
    if (!action.ok && state.status !== "succeeded") throw new CliError("refused", action.message, { state: state.status });
    const live = liveSupervisor(store, deps);
    const deliver = () => {
      if (state.status === "paused") store.enqueue("unpause", {});
      if (state.status === "blocked") store.enqueue("answer", { text: opts.answer ?? "", approve: Boolean(opts.approve), deny: Boolean(opts.deny) });
    };
    if (live) { deliver(); return { data: { run: state.run, delivered: "supervisor", status: state.status }, text: `sent to the running supervisor (${live.why})` }; }
    deliver();
    if (opts.detach) { const pid = deps.spawnSupervisor(state.run, store); return { data: { run: state.run, resumed: true, detached: true, pid }, text: `run ${state.run} resumed (supervisor pid ${pid})` }; }
    const after = await supervise(store, deps);
    return { data: { run: after.run, resumed: true, status: after.status, outcome: after.outcome }, text: `run ${after.run}: ${after.status}${after.outcome ? ` (${after.outcome.reason})` : ""}`, exit: exitFor(after.status) };
  },

  async steer(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "message"], flags: ["json"] });
    const message = opts.message;
    if (!message?.trim()) throw new CliError("usage", "--message <text> is required");
    const store = openStore(opts.run, deps);
    const state = readState(store);
    if (isTerminal(state.status)) throw new CliError("refused", `run ${state.run} is ${state.status}`);
    if (liveSupervisor(store, deps)) { store.enqueue("steer", { message }); return { data: { run: state.run, delivered: "supervisor" }, text: "steering sent to the running supervisor" }; }
    await offline(store, deps, async () => { store.update((s) => { s.steers = [...(s.steers ?? []), { at: deps.now().toISOString(), message: message.slice(0, 2000) }].slice(-50); return s; }); });
    return { data: { run: state.run, delivered: "state" }, text: "no supervisor is running; the message is recorded and reaches the worker when the run resumes" };
  },

  async cancel(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "reason"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const state = readState(store);
    if (isTerminal(state.status)) throw new CliError("refused", `run ${state.run} is already ${state.status}`);
    if (liveSupervisor(store, deps)) { store.enqueue("cancel", { reason: opts.reason ?? "operator" }); return { data: { run: state.run, delivered: "supervisor" }, text: "cancel sent to the running supervisor; it stops the worker, keeps the work and ends the run as cancelled" }; }
    const ctx = loadRun(store);
    await offline(store, deps, async () => { await cleanupOrphans(store, deps, ctx); store.transition("cancelled", { reason: "operator", detail: opts.reason ?? "operator", by: "operator" }); });
    return { data: { run: state.run, status: "cancelled", delivered: "state" }, text: "no supervisor was running; the run is cancelled" };
  },

  async promote(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run"], flags: ["json", "yes"] });
    const store = openStore(opts.run, deps);
    const { state, contract, cfg } = loadRun(store);
    if (state.status !== "succeeded") throw new CliError("refused", `only a succeeded run is promoted (this one is ${state.status})`);
    if (liveSupervisor(store, deps)) throw new CliError("refused", "a supervisor still owns this run; wait for it to finish");
    const repo = new HostRepo({ gitDir: store.p.mirror, cfg }).open();
    const sha = cfg.integrationBranch && repo.git()(["rev-parse", "--verify", "--quiet", `refs/heads/${cfg.integrationBranch}`], { allowFail: true }) ? repo.git()(["rev-parse", `refs/heads/${cfg.integrationBranch}`]) : repo.head();
    const template = TEMPLATES[contract.template];
    const targets = template.promotion.targets(contract, cfg, sha);
    if (!targets.length) return { data: { run: state.run, status: "none", targets: [] }, text: "this run's promotion policy is none: nothing to promote. Use `export` to take the results out." };
    const approved = contract.promotion.requiresOperatorApproval ? (deps.isTTY && !opts.json ? await deps.confirm(`Promote ${sha.slice(0, 12)}:\n${targets.map((t) => `  - ${t.description}`).join("\n")}\nApprove?`) : Boolean(opts.yes)) : true;
    if (!approved) throw new CliError("refused", contract.promotion.requiresOperatorApproval ? `this promotion needs your approval: ${targets.map((t) => t.description).join("; ")}. Re-run with --yes, or from a terminal.` : "not approved");
    // No worker runtime is needed (or started) to promote a finished run: promoteRun works on the mirror and state.json.
    const r = await offline(store, deps, async () => promoteRun({ contract, cfg, store, repo, template, state, now: () => Date.now(), log: (line) => { store.log(line); }, sha, approved: true }));
    if (r.status === "failed") throw new CliError("error", `promotion failed: ${r.error}`, { targets: r.targets.map((t) => t.description) });
    return { data: { run: state.run, status: r.status, sha, targets: r.targets.map((t) => t.description), done: r.done }, text: `promotion ${r.status}: ${r.targets.map((t) => t.description).join("; ")}` };
  },

  async export(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "out"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const { state, contract, cfg } = loadRun(store);
    const repo = new HostRepo({ gitDir: store.p.mirror, cfg });
    if (fs.existsSync(store.p.mirror)) repo.open();
    const out = path.resolve(opts.out ?? path.join(store.p.results, deps.now().toISOString().replace(/[:.]/g, "-")));
    let result: ReturnType<typeof exportRun<RunState>>;
    try { result = exportRun({ store, repo, contract, state, out, now: deps.now }); } catch (e) { throw new CliError("refused", String(messageOf(e))); }
    const m = result.manifest;
    return { data: { run: state.run, out: result.dir, status: m.status, outcome: m.outcome, head: m.head, files: m.files.map((f) => f.path), missing: m.missing, manifest: path.join(result.dir, "manifest.json") }, text: `exported ${m.files.length} file(s) for ${state.run} (${m.status}) to ${result.dir}${m.missing.length ? `\nnot available: ${m.missing.join(", ")}` : ""}` };
  },

  async reconfigure(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "effort", "effort-cap", "budget-usd", "step-usd", "max-steps", "max-minutes", "soft-nudges", "hard-restarts", "max-attempts", "reason"], flags: ["json", "yes"] });
    const store = openStore(opts.run, deps);
    const { state, contract } = loadRun(store);
    if (isTerminal(state.status)) throw new CliError("refused", `run ${state.run} is ${state.status}; reconfigure only changes runs that can still continue`);
    const changes: { effort?: { tier?: string; cap?: string }; budget?: Record<string, number>; recovery?: Record<string, number> } = {};
    if (opts.effort || opts["effort-cap"]) changes.effort = { ...(opts.effort ? { tier: opts.effort } : {}), ...(opts["effort-cap"] ? { cap: opts["effort-cap"] } : {}) };
    const budget = { totalUsd: num(opts["budget-usd"], "budget-usd"), perStepUsd: num(opts["step-usd"], "step-usd"), maxSteps: num(opts["max-steps"], "max-steps"), maxMinutes: num(opts["max-minutes"], "max-minutes") };
    for (const [k, v] of Object.entries(budget)) if (v !== undefined) (changes.budget ??= {})[k] = v;
    const recovery = { softNudges: num(opts["soft-nudges"], "soft-nudges"), hardRestarts: num(opts["hard-restarts"], "hard-restarts"), maxAttemptsPerStep: num(opts["max-attempts"], "max-attempts") };
    for (const [k, v] of Object.entries(recovery)) if (v !== undefined) (changes.recovery ??= {})[k] = v;
    const plan = planReconfigure({ contract, state, changes, effort: effortFor(deps) });
    if (!plan.ok) throw new CliError("invalid", plan.problems.join("\n"), { problems: plan.problems });
    const before = limitsSnapshot(plan.before), after = limitsSnapshot(plan.after);
    const limits = { budget: completeBudget(plan.next.limits.budget), recovery: plan.next.limits.recovery };
    const summary = JSON.stringify({ before: plan.before, after: plan.after }, null, 2);
    const ok = deps.isTTY && !opts.json ? await deps.confirm(`Change this run's limits?\n${summary}\nThis is logged in the run's state.`) : Boolean(opts.yes);
    if (!ok) throw new CliError("refused", `reconfigure changes the run's effort or budgets, so it needs your confirmation: re-run with --yes (from a terminal it asks).\n${summary}`);
    if (liveSupervisor(store, deps)) { store.enqueue("reconfigure", { changes, by: "operator", reason: opts.reason }); return { data: { run: state.run, delivered: "supervisor", before: plan.before, after: plan.after }, text: "sent to the running supervisor; it applies the change at its next tick and logs it" }; }
    await offline(store, deps, async () => {
      store.update((s) => {
        s.reconfigurations = [...s.reconfigurations, { at: deps.now().toISOString(), by: "operator", before, after, reason: opts.reason ?? null }].slice(-200);
        s.effort = plan.next.effort; s.limits = limits;
        return s.status === "budget_exhausted" ? transition(s, "paused", { reason: "limits raised", by: "reconfigure", at: deps.now().toISOString() }) : s;
      });
    });
    const now = readState(store);
    return { data: { run: state.run, delivered: "state", status: now.status, before: plan.before, after: plan.after }, text: `reconfigured (${Object.keys(changes).join(", ")}); the run is ${now.status}${now.status === "paused" ? ". Continue it with: pi-autonomy resume --run " + state.run : ""}` };
  },
};

// --- supervising a run ----------------------------------------------------------------------------------
/** Take the run lock, build the runtime and drive the engine until the run ends or parks. */
export async function supervise(store: RunStore, deps: CliDeps, { runtime }: { runtime?: CliRuntime } = {}): Promise<RunState> {
  const { state, contract, cfg } = loadRun(store);
  const lock = lockFor(store, deps);
  const got = lock.acquire();
  if (!got.acquired) throw new CliError("refused", got.reason);
  if (isTerminal(state.status) && !(state.status === "succeeded" && ["pending", "awaiting_approval"].includes(state.promotion.status))) { lock.release(); throw new CliError("refused", resumeAction(state).message); }
  const rt = runtime ?? deps.runtimeFactory({ contract, cfg, store, env: deps.env });
  const engine = new Engine({ contract, cfg, store, rt, template: TEMPLATES[contract.template], lock, effortApi: effortFor(deps), deps: { exportRun: ({ engine: e, out }: { engine: Engine; out: string }) => exportRun({ store, repo: rt.repo, contract, state: e.state, out }) } });
  const onSignal = () => { engine.signalled = true; };
  if (deps.signals) { process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); }
  try {
    const takeover = ["running", "recovering"].includes(state.status) || Boolean(got.tookOver);
    if (state.status === "succeeded") { rt.repo.open?.(); engine.state = state; await engine.promote({ sha: rt.repo.head(), approved: false }); lock.release(); return readState(store); }
    return await engine.run({ takeover });
  } finally {
    if (deps.signals) { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
  }
}

/** The live container probe, standalone (`boundary --probe`): networks, relay, proxy, services and the probe, then teardown. */
async function probeOnly(contract: RunContract, deps: CliDeps): Promise<BoundaryReport> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-probe-"));
  const probeContract = { ...contract, run: `probe-${randomSuffix(6)}` };
  try {
    const store = createRun({ contract: probeContract, authorisation: { boundaryDigest: boundaryDigest(probeContract), by: "probe", at: deps.now().toISOString(), via: "probe" }, home, now: deps.now, boundaryEffort: effortFor(deps) });
    const cfg = runtimeConfig(probeContract);
    const rt = deps.runtimeFactory({ contract: probeContract, cfg, store, env: deps.env });
    await rt.preflight(probeContract);
    fs.mkdirSync(store.p.remote, { recursive: true });
    spawnSync("git", ["init", "--quiet", "--bare", store.p.remote]);
    for (const name of Object.keys(cfg.references ?? {})) fs.mkdirSync(path.join(store.p.references, name), { recursive: true });
    let report: BoundaryReport | null | undefined;
    try { report = await rt.bringUp({ contract: probeContract, cfg, state: readState(store), log: (l: string) => deps.stderr.write(`${l}\n`) }); } finally { await rt.tearDown(); }
    if (!report) throw new CliError("error", "the boundary probe produced no report; the boundary is NOT verified");
    return report;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// --- entry ---------------------------------------------------------------------------------------------------
const USAGE = `usage: pi-autonomy <command> [options]   (add --json to any command)
  templates                              what kinds of run exist
  init --template <id> [--out run.json]  write a run contract (prompts on a terminal; flags otherwise)
  plan --config run.json [--authorise --by <name> --yes]   validate; show the resolved boundary and its digest
  start --config run.json [--yes] [--detach]               confirm the boundary, then run
  status [--run <id>]                    one run, or all runs
  pause | steer --message <text> | cancel --run <id>
  resume --run <id> [--answer <text> | --approve | --deny]
  promote --run <id> [--yes]             carry out an approval-gated promotion
  export --run <id> [--out <dir>]        results, evidence, usage, decisions, the work
  boundary --config run.json [--probe] | --run <id>
  reconfigure --run <id> [--effort E4 --effort-cap E4 --budget-usd n --step-usd n --max-steps n --max-minutes n --soft-nudges n --hard-restarts n --max-attempts n] [--yes]`;

/**
 * Run one command. Returns the exit code; writes to deps.stdout / deps.stderr.
 * @param argv the command and its arguments (untrusted: every command validates its own)
 * @param overrides dependency overrides (tests)
 */
export async function main(argv: readonly string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  const [cmd, ...rest] = argv;
  const json = rest.includes("--json");
  const emit = (obj: Record<string, unknown>): unknown => deps.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { deps.stdout.write(`${USAGE}\n`); return cmd ? 0 : 2; }
  const command = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (!command) { const msg = `unknown command ${cmd}`; if (json) emit({ ok: false, error: msg, code: "usage" }); else deps.stderr.write(`${msg}\n${USAGE}\n`); return EXIT.usage; }
  try {
    const r = await command(rest, deps);
    if (json) emit({ ok: true, command: cmd, ...r.data });
    else if (r.text) deps.stdout.write(`${r.text}\n`);
    return r.exit ?? 0;
  } catch (e) {
    if (isRecord(e) && e.simulateKill) throw e; // tests only: the fake runtime's stand-in for the process being killed is not a command error
    const code: CliCode = e instanceof CliError ? e.cliCode : codeOf(e) === "usage" ? "usage" : codeOf(e) === "lock_lost" ? "refused" : "error";
    const extra = isRecord(e) && isRecord(e.extra) ? e.extra : {};
    if (json) emit({ ok: false, command: cmd, error: messageOf(e), code, ...extra });
    else deps.stderr.write(`[pi-autonomy] ${String(messageOf(e))}\n`);
    return EXIT[code];
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
