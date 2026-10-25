import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionId, todoFilePath, readTodos as readTodoFile } from "./todo-read.ts";
import { openFileExclusive, writeFileSafe } from "./shared/safe-fs.ts";

// verifier-board: the definition-of-done gate. Checks, reviewers, and validators record
// verdicts here. The orchestrator flow must not report a mission complete until the board
// passes. Latest verdict per source wins. Stored at .pi/verdicts.json.
//
// The board is not tied to any test runner. A verdict can come from a check command, from
// verify-gate's independent completion reviewer ("review"), from a conductor validator, or
// from any reviewer subagent. The status view also shows what "done" means for this work:
// the goal, the todo list, the task graph, and the latest verification report.

interface Verdict {
  pass: boolean;
  summary: string;
  at: string;
  evidence?: string;
}
// The board is read back from disk, so each verdict stays `unknown` until the code reading it
// checks its shape: a corrupt entry is simply not a pass.
interface Board {
  verdicts: Record<string, unknown>;
  generation?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Kept in parity with orchestrator's own copy (self-containment forbids importing it) —
// AG-04: a verdict older than this is no longer trusted as proof of a current-state
// pass. Missing, malformed and future timestamps cannot establish freshness either.
const VERDICT_MAX_AGE_MS = Number(process.env.PI_KIT_VERDICT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;

// Shared completion contract: tests/verifier-board-trust-smoke.ts pins all local readers.
function isStale(at: unknown): boolean {
  if (typeof at !== "string") return true;
  const parsed = Date.parse(at);
  const now = Date.now();
  return Number.isNaN(parsed) || parsed > now || now - parsed > VERDICT_MAX_AGE_MS;
}

function boardPath(cwd: string): string {
  return path.join(cwd, ".pi", "verdicts.json");
}

function load(cwd: string): Board {
  try {
    const b: unknown = JSON.parse(fs.readFileSync(boardPath(cwd), "utf8"));
    if (isRecord(b) && isRecord(b.verdicts) && !Array.isArray(b.verdicts)) {
      return typeof b.generation === "number" ? { verdicts: b.verdicts, generation: b.generation } : { verdicts: b.verdicts };
    }
  } catch {
    /* fall through */
  }
  return { verdicts: {} };
}

// Atomic write: temp file + rename, so a concurrent reader (e.g. orchestrator's
// missionCompleteBlocked) never observes a partially-written board.
function save(cwd: string, b: Board): void {
  // Monotonic generation counter (AG-04: "atomically persist verdict generations").
  b.generation = (b.generation ?? 0) + 1;
  // Workspace state: never written through a committed symlink (./shared/safe-fs.ts).
  writeFileSafe(boardPath(cwd), JSON.stringify(b, null, 2), { root: cwd });
}

// Cross-process advisory lock around board mutations (O_EXCL lockfile + stale takeover, the
// same pattern task-graph uses). Without it two writers can both read the board, apply their
// own verdict, and write back, silently dropping the other's verdict. Lock name is shared
// with conductor's validator so both writers serialize on .pi/verdicts.lock.
const LOCK_STALE_MS = 60_000;
function withBoardLock<T>(cwd: string, operation: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  const lock = path.join(cwd, ".pi", "verdicts.lock");
  let fd: number | undefined;
  try {
    fd = openFileExclusive(lock, { root: cwd }) ?? undefined;
    if (fd === undefined) {
      try { if (Date.now() - fs.lstatSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch { /* fail closed below */ }
      fd = openFileExclusive(lock, { root: cwd }) ?? undefined;
      if (fd === undefined) return { ok: false, reason: "verifier board is busy or unreadable" };
    }
    try { return { ok: true, value: operation() }; } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* release best effort */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  } catch { return { ok: false, reason: "verifier board is unavailable" }; }
}

// Definition-of-done predicate shared by every completion gate: the board is complete only
// when every recorded source passes and is fresh, AND at least one trusted, independent
// (non-model) source is present and passing. An untrusted-only board therefore can never
// satisfy completion, no matter how many self-recorded PASSes it holds (WU-1).
export function isBoardComplete(b: Board): boolean {
  const sources = Object.keys(b.verdicts);
  if (sources.length === 0) return false;
  let trustedPassing = false;
  for (const s of sources) {
    const v = b.verdicts[s];
    if (!isRecord(v) || v.pass !== true || isStale(v.at)) return false;
    if (isTrustedVerdictSource(s)) trustedPassing = true;
  }
  return trustedPassing;
}

export function summarize(b: Board): { overall: boolean; lines: string[] } {
  const sources = Object.keys(b.verdicts);
  if (sources.length === 0) return { overall: false, lines: ["(no verdicts recorded yet)"] };
  const lines = sources.map((s) => {
    const v = b.verdicts[s];
    if (!isRecord(v)) return `- ${s}: FAIL — (malformed verdict)`;
    const stale = v.pass && isStale(v.at);
    const label = stale ? "STALE (re-verify)" : v.pass ? "PASS" : "FAIL";
    return `- ${s}: ${label} — ${String(v.summary)}`;
  });
  return { overall: isBoardComplete(b), lines };
}

// --- definition-of-done context (read-only views of other extensions' files) ---

function goal(cwd: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".pi", "GOAL.yaml"), "utf8");
    return (raw.match(/^goal:\s*(.*)$/m)?.[1] ?? raw).trim() || undefined;
  } catch {
    return undefined;
  }
}

// This session's todo list (per-session file; see vendor/todo/todo-file.ts).
function todos(cwd: string, sessionId?: string): { open: string[]; total: number } {
  try {
    const items = readTodoFile(todoFilePath(cwd, sessionId)).todos;
    return { open: items.filter((t) => t.state !== "done").map((t) => `#${t.id} ${t.text.trim()}${t.state === "active" ? " (in progress)" : ""}`), total: items.length };
  } catch {
    return { open: [], total: 0 };
  }
}

function tasks(cwd: string): { open: string[]; total: number } {
  try {
    const g: unknown = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "task-graph.json"), "utf8"));
    const list: unknown[] = isRecord(g) && Array.isArray(g.tasks) ? g.tasks : [];
    const open = list.filter((t) => !isRecord(t) || t.status !== "done").map((t) => {
      // Reading a field of a null entry threw here before, which leaves the task line out; keep that.
      if (t === null) throw new TypeError("null task-graph entry");
      const task: Record<string, unknown> = isRecord(t) ? t : {};
      return `${String(task.id)} [${String(task.status)}] ${String(task.title)}`;
    });
    return { open, total: list.length };
  } catch {
    return { open: [], total: 0 };
  }
}

function reportHead(cwd: string): string | undefined {
  try {
    const file = path.join(cwd, ".pi", "verify-report.md");
    const text = fs.readFileSync(file, "utf8");
    const when = text.match(/^- When: (.+)$/m)?.[1];
    const result = text.match(/^- Result: \*\*(\w+)\*\*$/m)?.[1];
    return `${file}${result ? ` (${result}${when ? `, ${when}` : ""})` : ""}`;
  } catch {
    return undefined;
  }
}

export function statusText(cwd: string, sessionId?: string): { overall: boolean; text: string } {
  const { overall, lines } = summarize(load(cwd));
  const out = [`Definition-of-done: ${overall ? "PASS — mission may complete" : "FAIL — do not finish yet"}`, ...lines];
  const g = goal(cwd);
  const t = todos(cwd, sessionId);
  const k = tasks(cwd);
  const report = reportHead(cwd);
  const context: string[] = [];
  if (g) context.push(`- Goal: ${g}`);
  if (t.total) context.push(`- Todos: ${t.total - t.open.length}/${t.total} done${t.open.length ? `. Open: ${t.open.slice(0, 8).join("; ")}` : ""}`);
  if (k.total) context.push(`- Tasks: ${k.total - k.open.length}/${k.total} done${k.open.length ? `. Open: ${k.open.slice(0, 8).join("; ")}` : ""}`);
  if (report) context.push(`- Latest verification report: ${report}`);
  if (context.length) out.push("", "What done means here:", ...context);
  if (!overall) {
    out.push("", "Next: finish the open work, then run verify_completion (operator: /verify) for an independent review. Do not record a PASS for your own work.");
  }
  return { overall, text: out.join("\n") };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

// Sources that represent an independent, non-model check: verify-gate writes
// `verify`/`review` directly (runVerification/recordVerifyVerdict) and conductor
// validators write `validator:<id>` in their own process. These are never written
// through the model-callable `record_verdict` tool, so a model must not be able to
// forge a passing verdict by naming its own write "review", "verify", or
// "validator:*". Non-trusted sources (tests, lint, manual-check, ...) still work.
const TRUSTED_SOURCE_PATTERNS: RegExp[] = [/^verify$/i, /^review$/i, /^validator:/i];

/** True when a verdict source is reserved for independent (non-model) writers. */
export function isTrustedVerdictSource(source: unknown): boolean {
  const s = typeof source === "string" ? source.trim() : "";
  return s.length > 0 && TRUSTED_SOURCE_PATTERNS.some((p) => p.test(s));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "record_verdict",
    label: "Verdict: record",
    description:
      "Record a verdict from a check, reviewer, or validator. Use it only for a result that another check or reviewer produced, not to grade your own work. The mission is not done until all verdicts pass.",
    parameters: Type.Object({
      source: Type.String({ description: "Who or what produced this verdict, e.g. 'reviewer', 'tests', 'lint', 'manual-check'" }),
      pass: Type.Boolean({ description: "Did this check pass?" }),
      summary: Type.String({ description: "One-line result, or what must be fixed if it failed" }),
      evidence: Type.Optional(Type.String({ description: "Where the result came from: a command and its exit code, a file path, or a report path" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (isTrustedVerdictSource(params.source)) {
        return text(
          `Refused '${params.source.trim()}': that source is reserved for independent checks (verify-gate / conductor validators) and cannot be set through record_verdict. Record the result under a non-trusted source name, e.g. 'reviewer', 'tests', or 'manual-check'.`,
        );
      }
      const locked = withBoardLock(ctx.cwd, () => {
        const b = load(ctx.cwd);
        const verdict: Verdict = {
          pass: params.pass,
          summary: params.summary,
          at: new Date().toISOString(),
          ...(params.evidence ? { evidence: params.evidence.slice(0, 500) } : {}),
        };
        b.verdicts[params.source] = verdict;
        save(ctx.cwd, b);
        return b;
      });
      if (!locked.ok) return text(`Refused: ${locked.reason}. Retry once the board is free.`);
      const { overall } = summarize(locked.value);
      return text(`Recorded ${params.source}: ${params.pass ? "PASS" : "FAIL"}. Board overall: ${overall ? "PASS" : "FAIL"}.`);
    },
  });

  pi.registerTool({
    name: "verdict_status",
    label: "Verdict: status",
    description:
      "Report the definition-of-done board: each recorded verdict, the goal, the todo and task progress, the latest verification report, and whether the mission may be considered complete.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return text(statusText(ctx.cwd, resolveSessionId(ctx.sessionManager)).text);
    },
  });

  pi.registerCommand("verdicts", {
    description: "Show the verifier board and what done means here. /verdicts clear resets the board.",
    handler: async (args, ctx) => {
      if ((args ?? "").trim() === "clear") {
        const locked = withBoardLock(ctx.cwd, () => {
          const current = load(ctx.cwd);
          const cleared: Board = { verdicts: {}, ...(current.generation !== undefined ? { generation: current.generation } : {}) };
          save(ctx.cwd, cleared);
          return cleared;
        });
        if (!locked.ok) { ctx.ui.notify(`verdicts: clear refused — ${locked.reason}.`, "error"); return; }
        ctx.ui.notify("verdicts: board cleared. Run /verify to check the work again.", "info");
        return;
      }
      const { overall, text: body } = statusText(ctx.cwd, resolveSessionId(ctx.sessionManager));
      ctx.ui.notify(`verdicts: ${overall ? "PASS" : "FAIL"}\n${body}`, overall ? "info" : "warning");
    },
  });
}
