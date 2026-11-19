import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { openFileExclusive, writeFileSafe } from "./shared/safe-fs.ts";

// task-graph: a persistent DAG task board shared by the orchestrator and its implementer subagents.
// The planner emits tasks (with dependencies); implementers claim the next unblocked task and mark
// it done. Stored at .pi/task-graph.json so it survives subprocess boundaries and compaction.

// `impasse` (V5-21, after SOAR): the task cannot progress as it is; a subgoal under it (a task whose
// `parent` is its id) is the way out, and completing the last open subgoal returns it to pending.
type Status = "pending" | "in_progress" | "done" | "blocked" | "impasse";

interface Task {
  id: string;
  title: string;
  description?: string | undefined;
  dependsOn: string[];
  status: Status;
  notes?: string;
  createdAt: string;
  // When task_next claimed the task (renewed by task_update while in_progress). A claim older
  // than the lease is handed out again, so a crashed implementer cannot hold a task forever.
  claimedAt?: string | undefined;
  /** The task this one is a subgoal of: the goal stack is the chain of parents. */
  parent?: string | undefined;
  /** Why the task reached an impasse (a failed check, a stall), and when. */
  impasse?: { reason: string; at: string } | undefined;
}

interface Graph {
  tasks: Task[];
}

const VALID_STATUSES: Status[] = ["pending", "in_progress", "done", "blocked", "impasse"];

/** How deep subgoals may nest: a subgoal of a subgoal of a task, and no deeper. */
export const MAX_SUBGOAL_DEPTH = 2;
/** The most subgoals one graph may hold, so repeated failures cannot grow it without bound. */
export const MAX_SUBGOALS = 20;

// Claim lease: longer than a subagent's default 30-minute wall-clock bound, so a live implementer
// keeps its task. Read per call; 0 disables expiry.
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
function leaseMs(): number {
  const raw = process.env.PI_KIT_TASK_GRAPH_LEASE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_LEASE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LEASE_MS;
}

// Return expired in_progress claims to pending. A claim with no claimedAt (written by an older
// build) has no known age and is left alone; task_update can still return it to pending.
function reclaimExpired(g: Graph, now: number): string[] {
  const lease = leaseMs();
  if (lease <= 0) return [];
  const reclaimed: string[] = [];
  for (const t of g.tasks) {
    if (t.status !== "in_progress" || typeof t.claimedAt !== "string") continue;
    const at = Date.parse(t.claimedAt);
    if (Number.isNaN(at) || now - at > lease) {
      t.status = "pending";
      t.claimedAt = undefined;
      reclaimed.push(t.id);
    }
  }
  return reclaimed;
}

// Advisory lock for mutating task-graph operations. An O_EXCL lockfile gives cross-process
// mutual exclusion (parallel implementer subagents are separate processes), and a stale lock
// older than LOCK_STALE_MS is taken over so a crashed holder cannot wedge the graph forever.
const LOCK_STALE_MS = 60_000;

function withGraphLock<T>(cwd: string, operation: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  const lock = path.join(cwd, ".pi", "task-graph.lock");
  let fd: number | undefined;
  try {
    // Workspace state: the lock and the graph never go through a committed symlink
    // (./shared/safe-fs.ts).
    fd = openFileExclusive(lock, { root: cwd }) ?? undefined;
    if (fd === undefined) {
      try {
        if (Date.now() - fs.lstatSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch { /* fail closed below */ }
      fd = openFileExclusive(lock, { root: cwd }) ?? undefined;
      if (fd === undefined) return { ok: false, reason: "task-graph is busy or unreadable" };
    }
    try {
      return { ok: true, value: operation() };
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* release best effort */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  } catch {
    return { ok: false, reason: "task-graph is unavailable" };
  }
}

function graphPath(cwd: string): string {
  return path.join(cwd, ".pi", "task-graph.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStatus = (value: unknown): value is Status => VALID_STATUSES.some((s) => s === value);

function load(cwd: string): Graph {
  try {
    const g: unknown = JSON.parse(fs.readFileSync(graphPath(cwd), "utf8"));
    if (isRecord(g) && Array.isArray(g.tasks)) {
      // WU-2: a graph may be edited externally or persisted by an older build, so an
      // element may be a non-object or lack dependsOn. Validate on load and repair/drop
      // rather than crashing depStatus/isUnblocked (which read t.dependsOn).
      // ORC-10: each task is rebuilt from checked fields, never cast. An unknown status becomes
      // "blocked" (never claimed, never counted done), non-string dependencies are dropped, a
      // non-string title falls back to the id, and non-string optional text is left out.
      const tasks: Task[] = [];
      let dropped = 0;
      let repaired = 0;
      for (const raw of g.tasks) {
        if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
          dropped++;
          continue;
        }
        const deps: unknown[] = Array.isArray(raw.dependsOn) ? raw.dependsOn : [];
        const dependsOn = deps.filter((d): d is string => typeof d === "string");
        const status = isStatus(raw.status) ? raw.status : "blocked";
        const title = typeof raw.title === "string" ? raw.title : raw.id;
        const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
        if (!Array.isArray(raw.dependsOn) || dependsOn.length !== deps.length || status !== raw.status || title !== raw.title || createdAt !== raw.createdAt) repaired++;
        const task: Task = { id: raw.id, title, dependsOn, status, createdAt };
        if (typeof raw.description === "string") task.description = raw.description;
        if (typeof raw.notes === "string") task.notes = raw.notes;
        if (typeof raw.claimedAt === "string") task.claimedAt = raw.claimedAt;
        if (typeof raw.parent === "string") task.parent = raw.parent;
        if (isRecord(raw.impasse) && typeof raw.impasse.reason === "string" && typeof raw.impasse.at === "string") task.impasse = { reason: raw.impasse.reason, at: raw.impasse.at };
        tasks.push(task);
      }
      if (dropped > 0 || repaired > 0) {
        process.stderr.write(
          `[task-graph] load: dropped ${dropped} malformed task(s), repaired ${repaired} malformed task(s) in ${graphPath(cwd)}\n`,
        );
      }
      return { tasks };
    }
  } catch {
    /* fall through */
  }
  return { tasks: [] };
}

// Atomic write (temp file + rename): a reader that takes no lock (task_list) never observes a
// partially-written graph. Writers are serialized by withGraphLock above.
function save(cwd: string, g: Graph): void {
  writeFileSafe(graphPath(cwd), JSON.stringify(g, null, 2), { root: cwd });
}

function nextId(g: Graph): string {
  let n = g.tasks.length + 1;
  while (g.tasks.some((t) => t.id === `t${n}`)) n++;
  return `t${n}`;
}

// AG-03 fix: task_create previously accepted any depends_on list unchecked - a
// missing task ID or a task depending on itself both silently "succeeded", so the graph
// was not actually a DAG. Validate before insertion. The full cycle walk below is
// defense in depth: today's tool surface only lets depends_on reference already-created
// (i.e. earlier-created) task IDs, so a multi-task cycle isn't constructible through
// task_create/task_update alone - but this keeps the invariant real if a future
// dependsOn-editing capability is ever added, rather than relying on that structural
// accident.
function validateDependencies(g: Graph, taskId: string, dependsOn: string[]): string | null {
  for (const dep of dependsOn) {
    if (dep === taskId) return `depends_on cannot include the task's own id (${taskId})`;
    if (!g.tasks.some((t) => t.id === dep)) return `depends_on references unknown task '${dep}'`;
  }
  // Cycle check: would adding taskId -> dependsOn edges create a cycle reachable back to
  // taskId? Walk the dependency graph (including the new edges) from each declared dep.
  const adjacency = new Map<string, string[]>(g.tasks.map((t) => [t.id, t.dependsOn]));
  adjacency.set(taskId, dependsOn);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function hasCycleFrom(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of adjacency.get(id) ?? []) {
      if (hasCycleFrom(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (hasCycleFrom(taskId)) return `depends_on would create a dependency cycle involving ${taskId}`;
  return null;
}

function depStatus(g: Graph, t: Task): string {
  if (t.dependsOn.length === 0) return "";
  const parts = t.dependsOn.map((d) => {
    const dep = g.tasks.find((x) => x.id === d);
    return `${d}:${dep?.status ?? "missing"}`;
  });
  return ` (deps ${parts.join(", ")})`;
}

function isUnblocked(g: Graph, t: Task): boolean {
  return t.dependsOn.every((d) => g.tasks.find((x) => x.id === d)?.status === "done");
}

/** How many parents a task has (0 for a top-level task). A broken or cyclic chain stops counting. */
function depthOf(g: Graph, t: Task): number {
  let depth = 0;
  const seen = new Set<string>([t.id]);
  for (let p = t.parent; p !== undefined && !seen.has(p); depth++) {
    seen.add(p);
    p = g.tasks.find((x) => x.id === p)?.parent;
  }
  return depth;
}

const openSubgoals = (g: Graph, id: string): Task[] => g.tasks.filter((x) => x.parent === id && x.status !== "done");

/**
 * Put the claimed task (the most recently claimed in_progress one) at an impasse and add one
 * subgoal under it. Bounded: a task that already has an open subgoal gets no second one (repeated
 * failures of the same check change nothing), subgoals nest at most MAX_SUBGOAL_DEPTH deep, and a
 * graph holds at most MAX_SUBGOALS. Returns what happened, or null when no task is claimed.
 */
export function raiseImpasse(g: Graph, reason: string, now: Date): string | null {
  const claimed = g.tasks.filter((t) => t.status === "in_progress").sort((a, b) => (b.claimedAt ?? "").localeCompare(a.claimedAt ?? ""))[0];
  if (!claimed) return null;
  const clean = reason.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "no progress";
  if (openSubgoals(g, claimed.id).length > 0) return `${claimed.id} already has an open subgoal`;
  const depth = depthOf(g, claimed);
  if (depth >= MAX_SUBGOAL_DEPTH) return `${claimed.id} is a subgoal at the depth limit (${MAX_SUBGOAL_DEPTH}); no deeper subgoal`;
  if (g.tasks.filter((t) => t.parent !== undefined).length >= MAX_SUBGOALS) return `the graph holds ${MAX_SUBGOALS} subgoals; no more`;
  claimed.status = "impasse";
  claimed.claimedAt = undefined;
  claimed.impasse = { reason: clean, at: now.toISOString() };
  const sub: Task = {
    id: nextId(g),
    title: `Resolve the impasse in ${claimed.id}: ${clean}`,
    description: `Subgoal of ${claimed.id} (${claimed.title}). Find out why it is stuck and remove the cause; completing this task returns ${claimed.id} to pending.`,
    dependsOn: [],
    status: "pending",
    createdAt: now.toISOString(),
    parent: claimed.id,
  };
  g.tasks.push(sub);
  return `${claimed.id} is at an impasse (${clean}); subgoal ${sub.id} created`;
}

/** When `done` was a subgoal and its parent has no other open subgoal, the parent returns to pending. */
function resumeParent(g: Graph, done: Task): string {
  if (done.parent === undefined) return "";
  const parent = g.tasks.find((x) => x.id === done.parent);
  if (parent?.status !== "impasse" || openSubgoals(g, parent.id).length > 0) return "";
  parent.status = "pending";
  parent.impasse = undefined;
  return ` ${parent.id} is out of its impasse and pending again.`;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  // Impasses (V5-21): a failed verify check (verify-gate's `luna:attention` with kind "failed") or a
  // progress-guard stall (`pi-kit:stall-seen`) puts the claimed task at an impasse with one subgoal.
  // Only an existing graph with a claimed task changes; anything else is ignored.
  let cwd: string | undefined;
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
  const onImpasse = (reason: string): void => {
    const dir = cwd;
    if (dir === undefined || !fs.existsSync(graphPath(dir))) return;
    const result = withGraphLock(dir, () => {
      const g = load(dir);
      const outcome = raiseImpasse(g, reason, new Date());
      if (outcome?.includes("subgoal t")) save(dir, g);
      return outcome;
    });
    if (result.ok && result.value) pi.events?.emit("luna:impasse", { detail: result.value });
  };
  pi.events?.on("luna:attention", (data) => {
    const d = isRecord(data) ? data : {};
    if (d.kind === "failed" && d.active === undefined) onImpasse(typeof d.label === "string" ? d.label : "a check failed");
  });
  pi.events?.on("pi-kit:stall-seen", () => onImpasse("no progress (stall)"));

  pi.registerTool({
    name: "task_create",
    label: "Task: create",
    description: "Create a task in the shared task graph. Returns its id. Use depends_on to order work.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(Type.String({ description: "Task detail" })),
      depends_on: Type.Optional(Type.Array(Type.String(), { description: "IDs of prerequisite tasks" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const id = nextId(g);
        const dependsOn = params.depends_on ?? [];
        const error = validateDependencies(g, id, dependsOn);
        if (error) return text(`Cannot create task: ${error}`);
        const task: Task = {
          id,
          title: params.title,
          description: params.description,
          dependsOn,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        g.tasks.push(task);
        save(ctx.cwd, g);
        return text(`Created ${task.id}: ${task.title}${depStatus(g, task)}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Task: update",
    description: "Update a task's status (pending|in_progress|done|blocked|impasse) and/or notes.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      status: Type.Optional(Type.String({ description: "pending | in_progress | done | blocked | impasse" })),
      notes: Type.Optional(Type.String({ description: "Progress notes" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const t = g.tasks.find((x) => x.id === params.id);
        if (!t) return text(`No such task: ${params.id}`);
        // AG-03 fix: status was cast unchecked - task_update(id, "teleported") silently
        // persisted an invalid value the rest of the graph's logic (isUnblocked,
        // task_next, task_complete) does not understand.
        if (params.status !== undefined) {
          if (!VALID_STATUSES.includes(params.status as Status)) {
            return text(`Invalid status '${params.status}' — must be one of: ${VALID_STATUSES.join(", ")}`);
          }
          if (params.status === "done" && !isUnblocked(g, t)) {
            const unfinished = t.dependsOn.filter((d) => g.tasks.find((x) => x.id === d)?.status !== "done");
            return text(`Cannot complete ${t.id}: unfinished dependencies (${unfinished.join(", ")})`);
          }
          t.status = params.status as Status;
          if (t.status !== "in_progress") t.claimedAt = undefined;
        }
        if (params.notes !== undefined) t.notes = params.notes;
        // Any update of an in_progress task is a sign of life: it renews the claim's lease.
        if (t.status === "in_progress") t.claimedAt = new Date().toISOString();
        const resumed = t.status === "done" ? resumeParent(g, t) : "";
        save(ctx.cwd, g);
        return text(`Updated ${t.id}: ${t.status}${resumed}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "Task: list",
    description: "List tasks in the graph, optionally filtered by status.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const g = load(ctx.cwd);
      const tasks = params.status ? g.tasks.filter((t) => t.status === params.status) : g.tasks;
      if (tasks.length === 0) return text("(no tasks)");
      const lines = tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${depStatus(g, t)}${t.parent ? ` (subgoal of ${t.parent})` : ""}${t.status === "impasse" && t.impasse ? ` (impasse: ${t.impasse.reason})` : ""}`);
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "task_next",
    label: "Task: next",
    description: "Claim the next actionable task (pending, dependencies done; a subgoal of a task at an impasse first) and mark it in_progress, so a second call never returns the same one. A claim not renewed by task_update within the lease (PI_KIT_TASK_GRAPH_LEASE_MS, default 1 hour) returns to pending.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const now = Date.now();
        const reclaimed = reclaimExpired(g, now);
        const note = reclaimed.length > 0 ? `Reclaimed expired claim(s): ${reclaimed.join(", ")}\n` : "";
        // The goal stack: the deepest pending subgoal comes first, then tasks in order.
        const next = g.tasks.filter((t) => t.status === "pending" && isUnblocked(g, t)).sort((a, b) => depthOf(g, b) - depthOf(g, a))[0];
        if (!next) {
          if (reclaimed.length > 0) save(ctx.cwd, g);
          const remaining = g.tasks.filter((t) => t.status !== "done").length;
          return text(note + (remaining === 0 ? "All tasks done." : "No unblocked task (remaining tasks are waiting on dependencies)."));
        }
        // AG-03 fix: task_next previously only READ the next task without claiming it, so
        // two consecutive calls (e.g. two implementer subagents racing to pull work) both
        // received the same task. Mark it in_progress here, in the same load-modify-save
        // cycle, before returning it. The exclusive lock makes claim-vs-claim atomic across
        // processes, so two parallel implementers cannot both win the same task.
        next.status = "in_progress";
        next.claimedAt = new Date(now).toISOString();
        save(ctx.cwd, g);
        return text(`${note}Next: ${next.id} — ${next.title}${next.description ? `\n${next.description}` : ""}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_complete",
    label: "Task: complete",
    description: "Mark a task as done.",
    parameters: Type.Object({ id: Type.String({ description: "Task ID" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const g = load(ctx.cwd);
        const t = g.tasks.find((x) => x.id === params.id);
        if (!t) return text(`No such task: ${params.id}`);
        // AG-03 fix: completion previously ignored dependencies entirely - task_complete(t2)
        // succeeded even while t2 still depended on an unfinished t1.
        if (!isUnblocked(g, t)) {
          const unfinished = t.dependsOn.filter((d) => g.tasks.find((x) => x.id === d)?.status !== "done");
          return text(`Cannot complete ${t.id}: unfinished dependencies (${unfinished.join(", ")})`);
        }
        t.status = "done";
        t.claimedAt = undefined;
        const resumed = resumeParent(g, t);
        save(ctx.cwd, g);
        const left = g.tasks.filter((x) => x.status !== "done").length;
        return text(`Completed ${t.id}. ${left} task(s) remaining.${resumed}`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });

  pi.registerTool({
    name: "task_clear",
    label: "Task: clear",
    description: "Remove every task from the shared task graph, to start a new plan or mission in the same project.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = withGraphLock(ctx.cwd, () => {
        const count = load(ctx.cwd).tasks.length;
        save(ctx.cwd, { tasks: [] });
        return text(`Cleared ${count} task(s).`);
      });
      return result.ok ? result.value : text(`Cannot update task graph: ${result.reason}`);
    },
  });
}
