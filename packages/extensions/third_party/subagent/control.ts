/**
 * Workflow run control (E5 slice G4): pause, resume, stop and skip for a live run, through one API.
 *
 * Every live run has one RunControl:
 *   - an AbortController for the whole run (`signal`); `stop` aborts it, so the run ends
 *     `interrupted` and can be resumed later from its state.json;
 *   - a scheduler gate (`gate()`): the executor awaits it before it launches any agent, so a
 *     paused run launches no new agents. Agents already running keep running;
 *   - one child AbortController per running agent (`agent()`), linked to the run's signal; `skip`
 *     aborts those, and the executor records the skipped steps as `skipped`. What a skip of a
 *     required step does to the run depends on the run's format (docs/script-workflows.md).
 *
 * Who asks matters for one case: a pause the human console's safety stop sets (`origin: "safety"`,
 * after more than 10 distinct approvals in the run) is held for the operator. Only an operator
 * resume (the `/workflows resume` command, the /workflows panel or the console's own Yes) clears
 * it; the agent's `workflow_control` resume (`origin: "agent"`) is refused with a message.
 *
 * `pause`/`resume` changes are reported to listeners (the executor writes `paused` into
 * state.json and the run model). The `workflow_control` tool, the `/workflows` command and a
 * future panel all go through `controlRun`, so they behave the same.
 */

export const CONTROL_ACTIONS = ["pause", "resume", "stop", "skip"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const isControlAction = (value: string): value is ControlAction => CONTROL_ACTIONS.some((a) => a === value);

export interface AgentHandle {
  signal: AbortSignal;
  /** True once `skip` cut this agent off (and the run itself was not stopped). */
  skipped(): boolean;
  /** Who skipped it: a YAML run reads a skip of a required step by who asked. */
  skipOrigin(): ControlOrigin | undefined;
  /** Unregister the agent; call when it has finished. */
  done(): void;
}

/** Who asked for a control action: the operator (command, panel, console), the governed agent (the workflow_control tool), or the console's safety stop. */
export type ControlOrigin = "operator" | "agent" | "safety";

export interface ControlResult {
  ok: boolean;
  message: string;
}

type ControlListener = (paused: boolean) => void;

const SKIP_NOTE = "recorded as skipped. The run continues unless the step was required: a skipped required step can fail the run or leave it partial.";

export class RunControl {
  readonly runId: string;
  private readonly controller = new AbortController();
  private pausedFlag = false;
  private heldFlag = false;
  private waiters: Array<() => void> = [];
  private readonly agents = new Map<string, { controller: AbortController; skippedBy?: ControlOrigin | undefined; label: string; agentId?: string | undefined }>();
  private readonly listeners = new Set<ControlListener>();
  private agentSeq = 0;

  constructor(runId: string) {
    this.runId = runId;
    this.controller.signal.addEventListener("abort", () => this.release(), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** True while the run is paused by the console's safety stop, which only the operator can lift. */
  get held(): boolean {
    return this.heldFlag;
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  /** Labels of the agents running now. */
  running(): string[] {
    return [...this.agents.values()].map((a) => a.label);
  }

  /** Resolves at once unless the run is paused; then when it is resumed or stopped, or `signal` aborts. */
  gate(signal?: AbortSignal): Promise<void> {
    if (!this.pausedFlag || this.stopped || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const open = (): void => {
        signal?.removeEventListener("abort", open);
        resolve();
      };
      this.waiters.push(open);
      signal?.addEventListener("abort", open, { once: true });
    });
  }

  /**
   * Register an agent about to launch; its signal aborts on `stop` (the run), `skip`, or
   * `skipAgent(agentId)` when `agentId` (its run-model id) is given.
   */
  agent(label: string, agentId?: string): AgentHandle {
    const key = `${label}#${++this.agentSeq}`;
    const controller = new AbortController();
    const entry: { controller: AbortController; skippedBy?: ControlOrigin | undefined; label: string; agentId?: string | undefined } = { controller, label, agentId };
    const onRunAbort = () => controller.abort();
    if (this.stopped) controller.abort();
    else this.controller.signal.addEventListener("abort", onRunAbort, { once: true });
    this.agents.set(key, entry);
    return {
      signal: controller.signal,
      skipped: () => entry.skippedBy !== undefined && !this.stopped,
      skipOrigin: () => (this.stopped ? undefined : entry.skippedBy),
      done: () => {
        this.agents.delete(key);
        this.controller.signal.removeEventListener("abort", onRunAbort);
      },
    };
  }

  onChange(listener: ControlListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  act(action: ControlAction, origin: ControlOrigin = "operator"): ControlResult {
    const id = this.runId;
    if (this.stopped) return { ok: false, message: `Run ${id} is already stopping.` };
    switch (action) {
      case "pause": {
        if (origin === "safety") this.heldFlag = true;
        if (this.pausedFlag) return { ok: true, message: `Run ${id} is already paused.` };
        this.pausedFlag = true;
        this.notify();
        const busy = this.running();
        return { ok: true, message: `Paused ${id}: no new agents start until it is resumed.${busy.length ? ` Still running: ${busy.join(", ")}.` : ""}` };
      }
      case "resume": {
        if (!this.pausedFlag) return { ok: true, message: `Run ${id} is not paused.` };
        if (this.heldFlag && origin !== "operator") return { ok: false, message: `Run ${id} was paused by the operator's safety stop (too many distinct approvals); only the operator can resume it, with /workflows resume ${id} or from the console.` };
        this.heldFlag = false;
        this.pausedFlag = false;
        this.release();
        this.notify();
        return { ok: true, message: `Resumed ${id}.` };
      }
      case "stop": {
        this.controller.abort();
        return { ok: true, message: `Stopping ${id}: its running agents are stopped and the run ends interrupted (it can be resumed).` };
      }
      case "skip": {
        const cut: string[] = [];
        for (const entry of this.agents.values()) {
          if (entry.skippedBy) continue;
          entry.skippedBy = origin;
          entry.controller.abort();
          cut.push(entry.label);
        }
        return cut.length ? { ok: true, message: `Skipping ${cut.join(", ")} in ${id}: ${SKIP_NOTE}` } : { ok: false, message: `Run ${id} has no running agent to skip.` };
      }
    }
  }

  /** Skip one running agent by its run-model id (the /workflows panel's `k`); the others go on. */
  skipAgent(agentId: string): ControlResult {
    const id = this.runId;
    if (this.stopped) return { ok: false, message: `Run ${id} is already stopping.` };
    for (const entry of this.agents.values()) {
      if (entry.agentId !== agentId || entry.skippedBy) continue;
      entry.skippedBy = "operator";
      entry.controller.abort();
      return { ok: true, message: `Skipping ${agentId} in ${id}: ${SKIP_NOTE}` };
    }
    return { ok: false, message: `${agentId} is not running in ${id}; there is nothing to skip.` };
  }

  private release(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l(this.pausedFlag);
      } catch {
        /* a listener must never break a control action */
      }
    }
  }
}

/** The live runs of this process, by run id. */
export class ControlRegistry {
  private readonly runs = new Map<string, RunControl>();

  /** Open control for a starting run. A parent signal (Esc on the tool call) stops it too. */
  open(runId: string, parentSignal?: AbortSignal): { control: RunControl; close: () => void } {
    const control = new RunControl(runId);
    this.runs.set(runId, control);
    const onParentAbort = () => control.act("stop");
    if (parentSignal?.aborted) control.act("stop");
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    return {
      control,
      close: () => {
        parentSignal?.removeEventListener("abort", onParentAbort);
        if (this.runs.get(runId) === control) this.runs.delete(runId);
      },
    };
  }

  get(runId: string): RunControl | undefined {
    return this.runs.get(runId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  ids(): string[] {
    return [...this.runs.keys()];
  }
}

/** The process-wide registry that workflow_run, /workflows and workflow_control share. */
export const runControls = new ControlRegistry();

/** Skip one running agent of a live run, by its run-model id. */
export function skipRunAgent(runId: string, agentId: string, registry: ControlRegistry = runControls): ControlResult {
  const control = registry.get(runId);
  if (!control) return { ok: false, message: `No live run "${runId}" in this session.` };
  return control.skipAgent(agentId);
}

/**
 * Published for other extensions (the human console's run-scoped approval broker pauses a run that
 * has needed too many distinct approvals): `globalThis[Symbol.for("pi-kit.workflow-control")]`
 * = { control(runId, action) }, which acts on this process's live runs.
 */
export const WORKFLOW_CONTROL_KEY = Symbol.for("pi-kit.workflow-control");
// The console passes origin "safety" for its pause (held for the operator) and "operator" for the operator's Yes.
Reflect.set(globalThis, WORKFLOW_CONTROL_KEY, { control: (runId: string, action: string, origin?: unknown): ControlResult => controlRun(runId, action, runControls, origin === "safety" ? "safety" : "operator") });

/** The one entry point for a control action on a live run. `origin` defaults to the operator; the workflow_control tool passes "agent". */
export function controlRun(runId: string, action: string, registry: ControlRegistry = runControls, origin: ControlOrigin = "operator"): ControlResult {
  if (!isControlAction(action)) return { ok: false, message: `Unknown action "${action}". Use one of: ${CONTROL_ACTIONS.join(", ")}.` };
  const control = registry.get(runId);
  if (!control) {
    const live = registry.ids();
    return { ok: false, message: `No live run "${runId}" in this session.${live.length ? ` Live runs: ${live.join(", ")}.` : ""}${action === "resume" ? " To continue an interrupted run, use workflow_run {resume: \"<run-id>\"} or /workflows resume <run-id>." : ""}` };
  }
  return control.act(action, origin);
}
