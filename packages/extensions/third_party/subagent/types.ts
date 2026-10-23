/**
 * Subagent — shared types.
 *
 * Dependency-free (type-only imports) so every other module can use these without creating
 * an import cycle. `AgentConfig` is re-exported here as the single import point for callers.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { AgentConfig } from "./agents.ts";

export type { AgentConfig };

export interface MsgPart {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface Msg {
  role: string;
  // Always a part list on assistant messages; pi's custom messages may carry a plain string.
  content?: MsgPart[] | string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Msg[];
  stderr: string;
  usage: UsageStats;
  model?: string | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  step?: number | undefined;
  logPath?: string | undefined;
  // The run id (the log filename stem). Surfaced so the TUI, subagent_status, and the
  // operator can reference a live run without re-deriving it from the log path.
  runId?: string | undefined;
  // True when the parent stopped waiting on a detached run; the child keeps working and
  // its outcome arrives later via onSettled.
  detached?: boolean | undefined;
  // How many attempts were made (1 unless a transient failure was retried).
  attempts?: number | undefined;
  // The child's final assistant text, kept unbounded so chain mode and success output get
  // the full deliverable even though the stored message list is bounded for memory.
  finalOutput?: string | undefined;
  // Only for a run started with a result schema: the StructuredOutput value the host validated
  // itself, or null when no attempt produced a valid one (structuredErrors says why).
  structured?: Record<string, unknown> | null | undefined;
  structuredErrors?: string[] | undefined;
  // Set when delegation-guard refused the launch: its denial code (for example "concurrency").
  deniedCode?: string | undefined;
}

// Why a child was force-killed by the parent. "signal" is a genuine operator/parent abort;
// the other two are internal limits and must not masquerade as an abort in the report.
export type KillReason = "signal" | "stream-cap" | "timeout" | "wall-clock" | "stopped";

export interface RunLog {
  id: string;
  logPath: string;
  write(line: string): void;
  attachPid(pid?: number): void;
  close(status: string, detail?: Record<string, unknown>): void;
}

// The one spawn signature the runner calls. Not `typeof spawn`: no function short of spawn itself
// can satisfy all its overloads, so a test's stand-in child could only be passed with a cast.
export type SpawnChild = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

// A child currently running under this pi process, with a handle that terminates it.
export interface LiveChild {
  id: string;
  agent: string;
  pid?: number | undefined;
  startedAt: number;
  cwd: string;
  logPath: string;
  terminate(): void;
}

export interface NativeSettings {
  warnings?: { subagentInheritModel?: boolean };
}

// Minimal view of the tool-execution context we rely on, so handlers avoid `any` casts and
// stay honest about the (small) surface this extension actually depends on.
export interface ToolContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    confirm?(title: string, message: string): Promise<boolean>;
    select?(title: string, options: string[]): Promise<string | undefined>;
    notify?(message: string, level?: string): void;
    // Footer/status-bar text. The subagent tool uses this to show a live run summary
    // (agent, elapsed, last action, run id) for human oversight and debugging.
    setStatus?(key: string, text: string | undefined): void;
  };
  model?: { provider?: string; id?: string } | undefined;
  // Present on the real pi tool context; optional here so the eval harness (fakePi) and
  // older contexts keep working.
  signal?: AbortSignal | undefined;
  abort?(): void;
}

// Liveness snapshot emitted on a heartbeat and on each child event, so the parent can
// render progress and, at the end, log the bounded cost of the run.
export interface RunProgress {
  agent: string;
  runId: string;
  elapsedMs: number;
  idleMs: number;
  turns: number;
  lastTool?: string;
  stdoutBytes: number;
  stderrBytes: number;
}
