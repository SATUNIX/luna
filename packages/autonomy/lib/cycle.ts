// One cycle's control loop. Everything that touches Docker, git, the clock or the manager model
// comes in through `rt` (the runtime), so the loop is tested offline with a fake runtime
// (tests/autonomy-smoke.ts) and driven for real by lib/engine.ts through the self-improve template.
//
// rt: {
//   now(), sleep(ms), tickMs,
//   startAgent({ attempt, onEvent }) -> { send(msg), stop(): Promise, exited: Promise<{code}> },
//   headSha(), reportExists(), meterUsd(), totalUsd(), stopRequested(),
//   manager(bundle) -> decision, extras() -> { gitLog, plan, handoff }, gates() -> ["green"|"red"...],
//   resetToLastGood(abandonedSha) -> Promise, publish() -> Promise, log(line),
//   uiPolicy? -> permissions.unattended: dialogs are then answered per the contract and a question ends the cycle as "blocked"
// }
import { type TriggerConfig, evaluate } from "./triggers.ts";
import { type Blocker, type RpcFrame, type UiRequest, type UiResponse, type UnattendedPolicy, uiResponse, activityLine, isGuardEscalation, operatorDecision } from "./rpc.ts";
import type { ManagerBundle, ManagerDecision } from "./manager.ts";

/** What the supervisor sends a worker session over RPC. */
export type AgentMessage = { type: "prompt" | "steer"; message: string } | UiResponse;

/** A running worker session (lib/runtime.ts startWorker). */
export interface CycleAgent {
  readonly name?: string;
  send(msg: AgentMessage): void;
  stop(): Promise<void>;
  /** Resolves when the session's process ends. */
  readonly exited: Promise<{ readonly code: number } | null | undefined>;
}

/** What extras() adds to the manager's bundle. */
export interface CycleExtras {
  gitLog?: string | null | undefined;
  plan?: string | null | undefined;
  handoff?: string | null | undefined;
}

/** The runtime one cycle runs against (see the header). */
export interface CycleRuntime {
  readonly tickMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  startAgent(o: { attempt: number; onEvent: (ev: RpcFrame) => void }): CycleAgent;
  headSha(): Promise<string>;
  reportExists(): Promise<boolean>;
  /** Host-only close-out from accepted commits; true only after a green gate. */
  salvageReport?(): Promise<boolean>;
  onAutoRestart?(used: number): void;
  meterUsd(): Promise<number>;
  totalUsd(): Promise<number>;
  stopRequested(): boolean;
  manager(bundle: ManagerBundle): Promise<ManagerDecision>;
  extras(): Promise<CycleExtras>;
  gates(): Promise<readonly string[]>;
  resetToLastGood(abandonedSha: string): Promise<void>;
  publish(): Promise<void>;
  log(line: string): void;
  /** permissions.unattended: dialogs are then answered per the contract and a question ends the cycle as "blocked". */
  readonly uiPolicy?: UnattendedPolicy | undefined;
  onAutoAnswer?: ((ev: UiRequest) => void) | undefined;
}

/** The part of the run configuration a cycle reads. */
export interface CycleConfig extends TriggerConfig {
  readonly run: string;
}

export interface RunCycleOptions {
  n: number;
  cfg: CycleConfig;
  rt: CycleRuntime;
  prompt: string;
  /** Prepended to the prompt of the first session (a resumed cycle). */
  restartBriefing?: string | undefined;
  /** Where the cycle's files go on the branch (default autonomy/cycles/<NN>). */
  cycleDir?: string | undefined;
  autoRestartsUsed?: number;
}

export type CycleOutcome = "completed" | "partial" | "reset" | "aborted" | "blocked";

/** One manager decision as the cycle records it. */
export type CycleDecision = ManagerDecision & { at: string; triggers: string[] };

export interface CycleResult {
  outcome: CycleOutcome;
  reason: string;
  attempts: number;
  decisions: CycleDecision[];
  costUsd: number;
  head: string;
  /** Set when the outcome is "blocked". */
  blocker?: Blocker;
}

const FOLLOW_UP = [
  "You stopped before the cycle was recorded. Continue from where you are: finish the remaining phases (verify, then record {{DIR}}/report.md, update BACKLOG.md and HANDOFF.md), commit and push.",
  "The cycle report {{DIR}}/report.md is still missing on the branch. Write it now with the honest outcome (partial is fine), update HANDOFF.md, commit and `git push origin HEAD`.",
];

export async function runCycle({ n, cfg, rt, prompt, restartBriefing, cycleDir, autoRestartsUsed = 0 }: RunCycleOptions): Promise<CycleResult> {
  const NN = String(n).padStart(2, "0");
  const DIR = cycleDir ?? `autonomy/cycles/${NN}`;
  const startMeter = await rt.meterUsd();
  const s = {
    startedAt: rt.now(), lastEventAt: rt.now(), lastCommitAt: null as number | null, costUsd: 0, extendedMinutes: 0,
    managerCalls: 0, exited: null as { readonly code: number } | null | undefined, redGatesInARow: consecutiveRed(await rt.gates()), guardEscalations: 0,
    softReviewed: false, handled: new Set<string>(),
  };
  const decisions: CycleDecision[] = [];
  const activity: string[] = [];
  let head = await rt.headSha();
  let attempt = 0;
  // Assigned by launch(), so declared wide: control flow would otherwise keep it at null.
  let agent = null as CycleAgent | null;
  let settled = false;
  let dead = false;
  let autoRestarts = autoRestartsUsed;
  let followUps = 0;
  let pendingTrigger: string | null = null;
  let blocker: Blocker | null = null;

  const onEvent = (ev: RpcFrame): void => {
    s.lastEventAt = rt.now();
    if (ev.type === "agent_start") settled = false;
    if (ev.type === "agent_settled") settled = true;
    if (ev.type === "extension_ui_request") {
      const req: Readonly<Record<string, unknown>> = ev; // a UiRequest: every field is pi's and unchecked
      if (rt.uiPolicy) {
        const d = operatorDecision(req, rt.uiPolicy);
        if (d.action === "reply") { if (d.reply) agent?.send(d.reply); rt.onAutoAnswer?.(req); }
        else if (d.action === "block" && !blocker) blocker = d.blocker;
      } else {
        const reply = uiResponse(req);
        if (reply) agent?.send(reply);
      }
    }
    if (isGuardEscalation(ev)) s.guardEscalations++;
    const line = activityLine({ ...ev, at: rt.now() });
    if (line) { activity.push(line); if (activity.length > 200) activity.shift(); }
  };

  const launch = (text: string): void => {
    attempt++;
    settled = false;
    s.exited = null;
    dead = false;
    s.lastEventAt = rt.now();
    followUps = 0;
    const started = rt.startAgent({ attempt, onEvent });
    agent = started;
    void started.exited.then((e) => { if (agent === started) { s.exited = e; dead = true; settled = true; } });
    started.send({ type: "prompt", message: text });
  };
  // A message from the "operator": steer a running agent, or prompt an idle one.
  const say = (message: string): void => agent?.send(settled ? { type: "prompt", message } : { type: "steer", message });

  const close = async (outcome: CycleOutcome, reason: string): Promise<CycleResult> => {
    await agent?.stop();
    await rt.publish();
    rt.log(`cycle ${NN} closed: ${outcome} (${reason})`);
    return { outcome, reason, attempts: attempt, decisions, costUsd: s.costUsd, head: await rt.headSha(), ...(blocker ? { blocker } : {}) };
  };

  launch(restartBriefing ? `${restartBriefing}\n\n${prompt}` : prompt);

  for (;;) {
    await rt.sleep(rt.tickMs);
    const now = rt.now();
    await rt.publish();
    const sha = await rt.headSha();
    if (sha !== head) { head = sha; s.lastCommitAt = now; }
    s.costUsd = (await rt.meterUsd()) - startMeter;

    if (rt.stopRequested() || (await rt.totalUsd()) >= cfg.budget.totalUsd) return close("aborted", "run stop (a control command, a signal or the total budget)");
    if (blocker) return close("blocked", "a question needs a person");

    // Hard bounds apply before either mechanical recovery or a judgement call.
    const { stop, triggers } = evaluate({ ...s, exited: null }, now, cfg);
    if (stop === "hard_limit" || stop === "cycle_budget_hard") return close("partial", stop);
    if (dead) {
      if (await rt.reportExists()) return close("completed", "report recorded");
      const salvaged = await rt.salvageReport?.();
      if (rt.stopRequested()) return close("aborted", "run stop during close-out");
      const afterGate = evaluate({ ...s, exited: null }, rt.now(), cfg).stop;
      if (afterGate === "hard_limit" || afterGate === "cycle_budget_hard") return close("partial", afterGate);
      if (salvaged) return close("completed", "host close-out after session exit");
      if (autoRestarts >= (cfg.limits.autoRestartsPerCycle ?? 3)) return close("partial", "auto_restarts_exhausted");
      autoRestarts++;
      rt.onAutoRestart?.(autoRestarts);
      rt.log(`cycle ${NN} automatic restart ${autoRestarts} after session exit (${s.exited?.code ?? "unknown"})`);
      await agent?.stop();
      launch(`The previous worker process exited. Re-read autonomy/HANDOFF.md, this cycle's files under ${DIR}/ and git status/log; continue the unfinished work, verify, record and push.\n\n${prompt}`);
      continue;
    }
    // The agent finished its turn: done if the report is on the branch, otherwise ask it to finish.
    if (settled && !dead && !pendingTrigger) {
      if (await rt.reportExists()) return close("completed", "report recorded");
      const followUp = FOLLOW_UP[followUps];
      if (followUp !== undefined) {
        followUps++;
        say(followUp.replaceAll("{{DIR}}", DIR));
        settled = false;
        continue;
      }
      pendingTrigger = "settled_without_report";
    }
    if (stop) return close("partial", stop);
    if (pendingTrigger && !s.handled.has(pendingTrigger)) triggers.push(pendingTrigger);
    if (!triggers.length) continue;
    if (s.managerCalls >= cfg.limits.managerCallsPerCycle) return close("partial", "manager_calls_exhausted");

    // Ask the manager once for everything that fired, then execute its single decision.
    s.managerCalls++;
    for (const t of triggers) s.handled.add(t);
    if (triggers.includes("soft_limit")) s.softReviewed = true;
    pendingTrigger = null;
    let d: ManagerDecision;
    try {
      d = await rt.manager({
        run: cfg.run, cycle: n, cycles: cfg.cycles, triggers, limits: cfg.limits, budget: cfg.budget,
        elapsedMinutes: (now - s.startedAt) / 60_000, extendedMinutes: s.extendedMinutes,
        costUsd: s.costUsd, totalCostUsd: await rt.totalUsd(), managerCalls: s.managerCalls - 1,
        previousDecisions: decisions, idleMinutes: (now - s.lastEventAt) / 60_000,
        sinceCommitMinutes: s.lastCommitAt ? (now - s.lastCommitAt) / 60_000 : null,
        gates: await rt.gates(), activity: activity.join("\n"), ...(await rt.extras()),
      });
    } catch (error) {
      // No usable decision: the least disruptive safe default, recorded like any other.
      const why = error instanceof Error ? error.message : String(error);
      d = { decision: "CONTINUE", reason: `manager unavailable (${why}); default`, extendMinutes: 15 };
    }
    decisions.push({ at: new Date(now).toISOString(), triggers, ...d });
    rt.log(`cycle ${NN} manager: ${d.decision} (${d.reason}) on ${triggers.join(",")}`);

    switch (d.decision) {
      case "CONTINUE":
        s.extendedMinutes += d.extendMinutes;
        break;
      case "NUDGE":
        if (s.exited) launch(`${d.message}\n\n${prompt}`);
        else say(d.message);
        break;
      case "RESTART_SESSION":
        await agent?.stop();
        launch(`${d.message}\n\n${prompt}`);
        break;
      case "NEW_CYCLE":
        return close("partial", `manager: ${d.reason}`);
      case "RESET_TO_LAST_GOOD":
        await agent?.stop();
        await rt.resetToLastGood(await rt.headSha());
        return close("reset", `manager: ${d.reason}`);
      case "ABORT_RUN":
        return close("aborted", `manager: ${d.reason}`);
    }
  }
}

function consecutiveRed(gates: readonly string[]): number {
  let n = 0;
  for (let i = gates.length - 1; i >= 0 && gates[i] === "red"; i--) n++;
  return n;
}
