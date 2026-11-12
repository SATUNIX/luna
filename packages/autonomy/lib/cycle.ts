// One cycle's control loop. Everything that touches Docker, git, the clock or the manager model
// comes in through `rt` (the runtime), so the loop is tested offline with a fake runtime
// (tests/autonomy-smoke.ts) and driven for real by lib/engine.ts through the self-improve template.
//
// rt: {
//   now(), sleep(ms), tickMs,
//   startAgent({ attempt, onEvent, say }) -> { send(msg), stop(): Promise, exited: Promise<{code}> },
//   headSha(), reportExists(), reportGaps?(), meterUsd(), totalUsd(), stopRequested(),
//   manager(bundle) -> decision, extras() -> { gitLog, plan, handoff }, gates() -> ["green"|"red"...],
//   resetToLastGood(abandonedSha) -> Promise, publish() -> Promise, log(line),
//   uiPolicy? -> permissions.unattended: dialogs are then answered per the contract and a question ends the cycle as "blocked"
// }
import type { BookkeepingPaths } from "./bookkeeping.ts";
import { type TriggerConfig, evaluate, managerCallsExhausted } from "./triggers.ts";
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
  handoffPath?: string;
  gitLog?: string | null | undefined;
  plan?: string | null | undefined;
  handoff?: string | null | undefined;
}

/** The runtime one cycle runs against (see the header). */
export interface CycleRuntime {
  readonly tickMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** `say` delivers an operator message to this session (a steer while busy, a prompt when settled). */
  startAgent(o: { attempt: number; onEvent: (ev: RpcFrame) => void; say: (message: string) => void }): CycleAgent;
  headSha(): Promise<string>;
  reportExists(): Promise<boolean>;
  /**
   * Commits since the cycle start that change more than records and that no `Item:` line of
   * report.md names (lib/ledger.ts uncoveredCommits). Asked once the report exists, so a stale
   * report is fixed while the session is still alive.
   */
  reportGaps?(): Promise<readonly string[]>;
  /**
   * The size of the diff `mergeDecision` would judge for the current head, measured while the
   * worker is still alive. `head` is the head the measurement was taken on; `characters` is the
   * exact measured count when known and `null` when the read overflowed before its length could
   * be counted; `overBudget` is true when the diff exceeds `budget`. The cycle steers an over-budget
   * worker before it closes and refuses a head that is still over budget after that steer; the merge
   * decision remains the fail-closed backstop.
   */
  diffBudget?(): Promise<{ head: string; characters: number | null; budget: number; overBudget: boolean; detail?: string }>;
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
  bookkeeping?: BookkeepingPaths;
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

/** Guard notices closer together than this are one episode (a stall makes several in seconds). */
export const GUARD_EPISODE_MS = 120_000;
/** After the manager cap is reached, a live worker gets one wrap-up steer and this long to record. */
export const WRAP_UP_MS = 15 * 60_000;

const FOLLOW_UP = [
  "You stopped before the cycle was recorded. Continue from where you are: finish the remaining phases (verify, then record {{DIR}}/report.md, {{BOOKKEEPING}}), commit and push.",
  "The cycle report {{DIR}}/report.md is still missing on the branch. Write it now with the honest outcome (partial is fine), update {{HANDOFF}}, commit and `git push origin HEAD`.",
];

export async function runCycle({ n, cfg, rt, prompt, restartBriefing, cycleDir, autoRestartsUsed = 0, bookkeeping }: RunCycleOptions): Promise<CycleResult> {
  const NN = String(n).padStart(2, "0");
  const DIR = cycleDir ?? `autonomy/cycles/${NN}`;
  const handoff = bookkeeping?.handoff ?? "autonomy/HANDOFF.md";
  const record = bookkeeping && bookkeeping.proposals !== "autonomy/BACKLOG.md" ? `write each proposal to a new file at ${bookkeeping.proposals} and update ${handoff}` : "update BACKLOG.md and HANDOFF.md";
  const startMeter = await rt.meterUsd();
  const s = {
    startedAt: rt.now(), lastEventAt: rt.now(), lastCommitAt: null as number | null, costUsd: 0, extendedMinutes: 0,
    managerCalls: 0, managerCallsTotal: 0, exited: null as { readonly code: number } | null | undefined, redGatesInARow: consecutiveRed(await rt.gates()), guardEscalations: 0,
    guardBaseline: 0, lastGuardAt: null as number | null, softReviewed: false, handled: new Set<string>(),
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
  let gapsChecked = false;
  const budgetWarnedHeads = new Set<string>();
  let wrapUpAt: number | null = null;

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
    // Count guard episodes, not notices: one stall emits several notices within seconds.
    if (isGuardEscalation(ev)) {
      const at = rt.now();
      if (s.lastGuardAt === null || at - s.lastGuardAt >= GUARD_EPISODE_MS) { s.guardEscalations++; s.lastGuardAt = at; }
    }
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
    // An operator steer from outside the loop (engine.steer) starts a turn like any other message.
    const started = rt.startAgent({ attempt, onEvent, say: (message) => { say(message); settled = false; } });
    agent = started;
    void started.exited.then((e) => { if (agent === started) { s.exited = e; dead = true; settled = true; } });
    started.send({ type: "prompt", message: text });
  };
  // A message from the "operator": steer a running agent, or prompt an idle one.
  const say = (message: string): void => agent?.send(settled ? { type: "prompt", message } : { type: "steer", message });
  // A report that leaves committed work unnamed gets one follow-up while the session is alive.
  const reportStale = async (): Promise<boolean> => {
    if (gapsChecked || !rt.reportGaps) return false;
    gapsChecked = true;
    const gaps = await rt.reportGaps();
    if (!gaps.length) return false;
    rt.log(`cycle ${NN} report.md names no Item for ${gaps.length} commit(s); one follow-up sent`);
    say(`Commits ${gaps.slice(0, 20).join(", ")} are not in any \`Item:\` line of ${DIR}/report.md. Add each to the item it belongs to (\`Item: <title> - <commit shas> - <test that proves it>\`) or revert it, then commit and \`git push origin HEAD\`.`);
    settled = false;
    return true;
  };
  // A diff already over the merge review's budget is steered while the session is alive, once per
  // measured head: the worker can split before the cycle closes. A head that is still over budget
  // after that steer is refused by this cycle itself, which closes "partial" with the measured
  // number; the merge decision remains the fail-closed backstop. Carried-over work stays on the
  // attempts branch.
  const budgetStale = async (): Promise<{ steered: boolean; refused?: string }> => {
    if (!rt.diffBudget) return { steered: false };
    const b = await rt.diffBudget();
    if (!b.overBudget) return { steered: false };
    const measured = b.characters === null
      ? `more than the merge review's budget of ${String(b.budget)} characters`
      : `${String(b.characters)} characters, over the merge review's budget of ${String(b.budget)} characters`;
    if (budgetWarnedHeads.has(b.head)) return { steered: false, refused: `refused_budget: the diff this cycle would submit is ${measured}` };
    budgetWarnedHeads.add(b.head);
    rt.log(`cycle ${NN} pre-report diff budget: ${measured}${b.detail ? ` (${b.detail})` : ""}`);
    say(`The diff this cycle would submit is ${measured}. Land only the current item's work in this cycle: move the rest of the carried-over work off this branch (it stays on attempts/${cfg.run}/cycle-${NN}), then commit and \`git push origin HEAD\`.`);
    settled = false;
    return { steered: true };
  };
  // The same measured wording as budgetStale, for a session that died after committing: a dead
  // agent cannot act on a steer, so the report it left is refused against its own diff instead.
  // It never steers, never remembers a warned head and never calls say(); the merge decision
  // remains the fail-closed backstop.
  const budgetRefusal = async (): Promise<string | undefined> => {
    if (!rt.diffBudget) return undefined;
    const b = await rt.diffBudget();
    if (!b.overBudget) return undefined;
    const measured = b.characters === null
      ? `more than the merge review's budget of ${String(b.budget)} characters`
      : `${String(b.characters)} characters, over the merge review's budget of ${String(b.budget)} characters`;
    return `refused_budget: the diff this cycle would submit is ${measured}`;
  };

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
    if (sha !== head) { head = sha; s.lastCommitAt = now; s.guardBaseline = s.guardEscalations; }
    s.costUsd = (await rt.meterUsd()) - startMeter;

    if (rt.stopRequested() || (await rt.totalUsd()) >= cfg.budget.totalUsd) return close("aborted", "run stop (a control command, a signal or the total budget)");
    if (blocker) return close("blocked", "a question needs a person");

    // Hard bounds apply before either mechanical recovery or a judgement call.
    const { stop, triggers } = evaluate({ ...s, exited: null }, now, cfg);
    if (stop === "hard_limit" || stop === "cycle_budget_hard") return close("partial", stop);
    if (dead) {
      if (await rt.reportExists()) {
        const refused = await budgetRefusal();
        if (refused !== undefined) return close("partial", refused);
        return close("completed", "report recorded");
      }
      const salvaged = await rt.salvageReport?.();
      if (rt.stopRequested()) return close("aborted", "run stop during close-out");
      const afterGate = evaluate({ ...s, exited: null }, rt.now(), cfg).stop;
      if (afterGate === "hard_limit" || afterGate === "cycle_budget_hard") return close("partial", afterGate);
      if (salvaged) {
        const refused = await budgetRefusal();
        if (refused !== undefined) return close("partial", refused);
        return close("completed", "host close-out after session exit");
      }
      if (autoRestarts >= (cfg.limits.autoRestartsPerCycle ?? 3)) return close("partial", "auto_restarts_exhausted");
      autoRestarts++;
      rt.onAutoRestart?.(autoRestarts);
      rt.log(`cycle ${NN} automatic restart ${autoRestarts} after session exit (${s.exited?.code ?? "unknown"})`);
      await agent?.stop();
      launch(`The previous worker process exited. Re-read ${handoff}, this cycle's files under ${DIR}/ and git status/log; continue the unfinished work, verify, record and push.\n\n${prompt}`);
      continue;
    }
    // The agent finished its turn: done if the report is on the branch, otherwise ask it to finish.
    if (settled && !dead && !pendingTrigger) {
      if (await rt.reportExists()) {
        const budget = await budgetStale();
        if (budget.refused !== undefined) return close("partial", budget.refused);
        if (budget.steered) continue;
        if (await reportStale()) continue;
        return close("completed", "report recorded");
      }
      const followUp = FOLLOW_UP[followUps];
      if (followUp !== undefined) {
        followUps++;
        say(followUp.replaceAll("{{DIR}}", DIR).replaceAll("{{HANDOFF}}", bookkeeping?.handoff ?? "HANDOFF.md").replaceAll("{{BOOKKEEPING}}", record));
        settled = false;
        continue;
      }
      pendingTrigger = "settled_without_report";
    }
    if (pendingTrigger && !s.handled.has(pendingTrigger)) triggers.push(pendingTrigger);
    if (stop === "manager_calls_exhausted" || (triggers.length && managerCallsExhausted(s, cfg.limits))) {
      // A live worker is told to wrap up and given one grace window to record its committed work.
      if (wrapUpAt === null && !dead && agent) {
        wrapUpAt = now;
        rt.log(`cycle ${NN} manager calls exhausted; wrap-up steer sent`);
        say(`Stop new work now. Commit what works, write ${DIR}/report.md and ${DIR}/verify.md describing exactly the committed diff, and \`git push origin HEAD\` within 15 minutes.`);
        settled = false;
        continue;
      }
      if (wrapUpAt !== null && !dead && now - wrapUpAt < WRAP_UP_MS) continue;
      return close("partial", "manager_calls_exhausted");
    }
    if (stop) return close("partial", stop);
    if (!triggers.length) continue;

    // Ask the manager once for everything that fired, then execute its single decision.
    s.managerCallsTotal++;
    for (const t of triggers) s.handled.add(t);
    if (triggers.includes("soft_limit")) s.softReviewed = true;
    pendingTrigger = null;
    let d: ManagerDecision;
    let fallback = false;
    try {
      d = await rt.manager({
        run: cfg.run, cycle: n, cycles: cfg.cycles, triggers, limits: cfg.limits, budget: cfg.budget,
        elapsedMinutes: (now - s.startedAt) / 60_000, extendedMinutes: s.extendedMinutes,
        costUsd: s.costUsd, totalCostUsd: await rt.totalUsd(), managerCalls: s.managerCallsTotal - 1,
        previousDecisions: decisions, idleMinutes: (now - s.lastEventAt) / 60_000,
        sinceCommitMinutes: s.lastCommitAt ? (now - s.lastCommitAt) / 60_000 : null,
        gates: await rt.gates(), activity: activity.join("\n"), ...(await rt.extras()),
      });
    } catch (error) {
      // No usable decision: the least disruptive safe default, recorded like any other.
      const why = error instanceof Error ? error.message : String(error);
      d = { decision: "CONTINUE", reason: `manager unavailable (${why}); default`, extendMinutes: 15 };
      fallback = true;
    }
    // Only an intervention spends the per-cycle cap (lib/triggers.ts managerCallsExhausted).
    if (d.decision !== "CONTINUE" && !fallback) s.managerCalls++;
    if (triggers.some((t) => t.startsWith("guard_escalations:"))) s.guardBaseline = s.guardEscalations;
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
