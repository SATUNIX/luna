#!/usr/bin/env node
// An open overlay owns input: an approval raised while an overlay is open waits for it to close.
//
// The bug (board V-02): pi's `ctx.ui.select()` pushes a dialog and calls `tui.setFocus()`, taking
// focus from an open `ctx.ui.custom` overlay. Keys typed into the box then answer the approval, and
// Enter picks "Allow once". These cases hold the hub (and the workflow panel) open through a fake
// `ui.custom`, fire a `vendor_pending` approval and prove the firewall neither prompts nor settles
// until the box closes; an abort while held blocks as aborted without ever prompting, the prompt
// timeout starts only when the card is shown, a page move keeps the hold, and the headless path is
// untouched. A child's brokered approval waits too: the human console leaves the pending file alone
// while input is held, the requester's own deadline still fails closed, and an answer that needs no
// prompt (a run grant or a sticky deny) still goes through. A session's own `ask_human` waits the same
// way, and a deferred request's card shows only the time its requester has left.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { startConsole } from "./console-answer.ts";
import type * as HubModule from "../packages/extensions/src/control-center/hub.ts";
import type * as ModelModule from "../packages/extensions/src/control-center/model.ts";
import type * as HumanConsole from "../packages/extensions/src/human-console/index.ts";
import type * as ValuesModule from "../packages/extensions/src/control-center/values.ts";
import type * as PanelModule from "../packages/extensions/third_party/subagent/wf-panel.ts";

type FakePi = ReturnType<typeof fakePi>;
/** What the firewall's tool_call handler returns when it blocks a call. */
interface GateDecision {
  block: boolean;
  reason: string;
}
/** A component a fake `ui.custom` hands back so the test can type into the box. */
interface OverlayComponent {
  handleInput(data: string): void;
}
/** One open `ui.custom`: its component, and the `done` callback that closes it. */
interface Overlay {
  component: OverlayComponent;
  done(result: unknown): void;
}
/** The subset of a pi context the hub and the panel read, with a scriptable `custom`. */
interface OverlayCtx {
  mode: string;
  hasUI: boolean;
  cwd: string;
  signal?: AbortSignal;
  sessionManager?: { getSessionId(): string };
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    select?(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
    confirm?(title: string, message: string, opts?: unknown): Promise<boolean | undefined>;
    custom(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
      options?: unknown,
    ): Promise<unknown>;
  };
}
/** wf-panel's openWorkflowPanel, retyped for this test's narrow context. */
type PanelView = Omit<typeof PanelModule, "openWorkflowPanel"> & {
  openWorkflowPanel(ctx: OverlayCtx, runId?: string): Promise<void>;
};

const ws = tmpWorkspace("pi-kit-overlay-queue-");
const agentDir = path.join(ws, "agent");
const policyFile = path.join(ws, "policy.json");
fs.writeFileSync(policyFile, JSON.stringify({ defaults: { unknown: "ask" }, tools: { vendor_pending: { decision: "ask" } } }));
const restores = [
  isolateKitEnv(),
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_FIREWALL_POLICY", policyFile),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl")),
  setEnv("PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS", "60000"),
  setEnv("PI_KIT_INTERNAL_CHILD", undefined),
];
fs.mkdirSync(path.join(agentDir, "pi-kit"), { recursive: true });
// Manual mode keeps the auto-mode judge out of these cases; `learn: false` keeps the distiller away.
fs.writeFileSync(path.join(agentDir, "pi-kit", "firewall.json"), JSON.stringify({ policy: "coding", learn: false, knownHosts: [], source: "user", mode: "manual" }));
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(5);
}

/** The firewall, registered, with the auto-mode judge stubbed (manual mode is set above). */
async function firewall(): Promise<FakePi> {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  register(pi.api, { complete: async () => '{"verdict":"allow","reason":"fine"}' });
  await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
  return pi;
}

/**
 * A TUI context whose `ui.custom` stays open until the test closes it, and whose prompts are
 * recorded. Every call is kept so a case can navigate the hub to a second page.
 */
function overlayUi(id = "overlay-queue"): {
  ctx: OverlayCtx;
  selects: string[];
  notices: string[];
  opened: Overlay[];
  component: () => OverlayComponent | undefined;
  close: () => void;
  choose: (result: unknown) => void;
} {
  const selects: string[] = [];
  const notices: string[] = [];
  const opened: Overlay[] = [];
  const fakeTheme = { fg: (_colour: string, text: string): string => text, bold: (text: string): string => text };
  const ctx: OverlayCtx = {
    mode: "tui",
    hasUI: true,
    cwd: ws,
    sessionManager: { getSessionId: () => id },
    ui: {
      notify: (message: string): void => {
        notices.push(message);
      },
      select: async (title: string): Promise<string | undefined> => {
        selects.push(title);
        return "Deny";
      },
      custom: (factory): Promise<unknown> =>
        new Promise<unknown>((resolve) => {
          const component = factory({ requestRender: () => {} }, fakeTheme, {}, (result: unknown) => resolve(result)) as OverlayComponent;
          opened.push({ component, done: (result: unknown) => resolve(result) });
        }),
    },
  };
  return {
    ctx,
    selects,
    notices,
    opened,
    component: () => opened[opened.length - 1]?.component,
    close: () => opened[opened.length - 1]?.done(undefined),
    choose: (result: unknown) => opened[opened.length - 1]?.done(result),
  };
}

/** Build hub deps over a test context, the way control-center-smoke does. */
async function hubDeps(ctx: OverlayCtx): Promise<HubModule.HubDeps> {
  initTheme(); // the hub's SettingsList theme
  const modelMod = await loadModule<typeof ModelModule>("extensions/control-center/model.ts");
  const values: ValuesModule.HubValues = { securityMissing: true };
  return {
    ctx: ctx as unknown as HubModule.HubDeps["ctx"],
    model: modelMod.buildModel({ values, commands: [], controls: [] }),
    values,
    commands: [],
    sendCommand: () => {},
    prefill: () => {},
    confirm: async () => false,
    write: () => {},
    notify: () => {},
    doctor: () => [],
    allCommands: () => [],
    isChild: false,
  };
}

try {
  const pi = await firewall();
  const hub = await loadModule<typeof HubModule>("extensions/control-center/hub.ts");
  const fire = (ctx: OverlayCtx) => pi.handlers.get("tool_call")({ toolName: "vendor_pending", input: {} }, ctx) as Promise<GateDecision | undefined>;

  // 1. An open hub owns the keyboard: keys typed into the box cannot answer the approval. The card
  //    is shown once, after the box closes, and "Deny" blocks.
  {
    const view = overlayUi();
    const hubRun = hub.openHub(await hubDeps(view.ctx));
    await until(() => view.component() !== undefined);
    assert.ok(view.component(), "the hub opened a custom component");
    assert.equal(view.selects.length, 0, "no card before the approval");

    const pending = fire(view.ctx);
    const outcome = await Promise.race([pending.then(() => "settled" as const), sleep(100).then(() => "waiting" as const)]);
    view.component()?.handleInput("a");
    view.component()?.handleInput("b");
    view.component()?.handleInput("1");
    await sleep(100);
    assert.equal(view.selects.length, 0, "the firewall prompted while the hub overlay was open");
    assert.equal(outcome, "waiting", "the approval settled while the hub overlay was open");
    assert.equal(view.notices.filter((n) => /waiting/i.test(n)).length, 1, "exactly one waiting notice");

    view.close();
    await hubRun;
    const result = await pending;
    assert.equal(result?.block, true, "Deny blocks the call");
    assert.equal(view.selects.length, 1, "the card is shown once, after the box closes");
    assert.match(view.selects[0] ?? "", /vendor_pending/);
    assert.match(result?.reason ?? "", /operator declined/);
    ok("an open hub holds the approval: no prompt, one notice, then the card after the box closes and Deny blocks");
  }

  // 2. Aborting while the box is held blocks as aborted; select is never called.
  {
    const view = overlayUi("overlay-queue-abort");
    const controller = new AbortController();
    const heldCtx: OverlayCtx = { ...view.ctx, signal: controller.signal };
    const hubRun = hub.openHub(await hubDeps(heldCtx));
    await until(() => view.component() !== undefined);
    const pending = fire(heldCtx);
    await sleep(100);
    assert.equal(view.selects.length, 0, "the firewall prompted while the hub overlay was open");
    controller.abort();
    const result = await pending;
    assert.equal(result?.block, true, "aborting while held blocks the call");
    assert.match(result?.reason ?? "", /cancelled|cancelled|aborted/i);
    assert.equal(view.selects.length, 0, "select is never called when the request is aborted while held");
    view.close();
    await hubRun;
    ok("aborting the signal while the box is held blocks as aborted and never calls select");
  }

  // 3. With no overlay open, the card is shown at once.
  {
    const view = overlayUi("overlay-queue-free");
    const result = await fire(view.ctx);
    assert.equal(result?.block, true);
    assert.equal(view.selects.length, 1, "with no overlay the card is shown at once");
    assert.equal(view.notices.length, 0, "no waiting notice when nothing holds input");
    ok("with no overlay the card is shown at once");
  }

  // 4. The shared contract: release is idempotent, holds nest, and a waiter resolves on release or abort.
  const owner = await import("../packages/core/shared/input-owner.ts");
  {
    assert.equal(owner.inputHeld(), undefined, "nothing holds input at rest");
    const release = owner.holdInput("the test box");
    assert.equal(owner.inputHeld(), "the test box");
    const waiting = owner.whenInputFree();
    let resolved: string | undefined;
    void waiting.then((r) => {
      resolved = r;
    });
    await sleep(20);
    assert.equal(resolved, undefined, "a waiter stays pending while input is held");
    release();
    assert.equal(await waiting, "free", "releasing input frees the waiter");
    release();
    assert.equal(owner.inputHeld(), undefined, "release is idempotent");

    const outer = owner.holdInput("outer");
    const inner = owner.holdInput("inner");
    assert.equal(owner.inputHeld(), "inner", "the most recent hold names the owner");
    outer();
    assert.equal(owner.inputHeld(), "inner", "a remaining hold keeps input held");
    inner();
    assert.equal(owner.inputHeld(), undefined);

    const controller = new AbortController();
    const held = owner.holdInput("the test box");
    const aborted = owner.whenInputFree(controller.signal);
    controller.abort();
    assert.equal(await aborted, "aborted", "aborting the signal frees a waiter as aborted");
    assert.equal(await owner.whenInputFree(controller.signal), "aborted", "an already-aborted signal is aborted");
    held();
    assert.equal(await owner.whenInputFree(new AbortController().signal), "free", "with nothing held a waiter resolves free");
    ok("the shared contract: idempotent release, nested holds, free/aborted waiters");
  }

  // 5. A throwing overlay releases input (openHub's finally path).
  {
    const throwing: OverlayCtx = {
      mode: "tui",
      hasUI: true,
      cwd: ws,
      ui: {
        notify: () => {},
        custom: async () => {
          throw new Error("overlay failed");
        },
      },
    };
    await assert.rejects(hub.openHub(await hubDeps(throwing)));
    assert.equal(owner.inputHeld(), undefined, "a throwing overlay releases input");
    ok("a throwing overlay releases input");
  }

  // 6. The workflow panel holds input while it is open and releases it when it closes.
  {
    const panel = await loadModule<PanelView>("vendor/subagent/wf-panel.ts");
    const view = overlayUi("overlay-queue-panel");
    const panelRun = panel.openWorkflowPanel(view.ctx);
    await until(() => view.component() !== undefined);
    assert.ok(view.component(), "the panel opened a custom component");
    assert.ok(owner.inputHeld(), "the panel holds input while it is open");
    view.close();
    await panelRun;
    assert.equal(owner.inputHeld(), undefined, "the panel releases input when it closes");
    ok("the workflow panel holds input while open and releases it on close");
  }

  // 7. The prompt timeout starts when the card is shown: holding input longer than it must not
  //    time the approval out.
  {
    const view = overlayUi("overlay-queue-timeout");
    const restoreTimeout = setEnv("PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS", "30");
    const hold = owner.holdInput("a text box");
    const pending = fire(view.ctx);
    await sleep(100); // four times the prompt timeout, all of it while the box is held
    assert.equal(view.selects.length, 0, "no prompt while the box is held");
    hold();
    const result = await pending;
    assert.equal(view.selects.length, 1, "the card is shown once, after the hold, and answered");
    assert.equal(result?.block, true, '"Deny" blocks the call');
    assert.doesNotMatch(result?.reason ?? "", /none arrived within|not answered/, "the prompt timeout must start when the card is shown, not while input is held");
    restoreTimeout();
    ok("the prompt timeout starts when the card is shown, not while an overlay holds input");
  }

  // 8. Closing the hub with Esc releases input (not the test's own `done` call).
  {
    const view = overlayUi("overlay-queue-esc");
    const hubRun = hub.openHub(await hubDeps(view.ctx));
    await until(() => view.component() !== undefined);
    assert.equal(owner.inputHeld(), "the kit hub", "the hub holds input while it is open");
    view.component()?.handleInput("\u001b");
    await hubRun;
    assert.equal(owner.inputHeld(), undefined, "Esc releases the hold");
    ok("closing the hub with Esc releases input");
  }

  // 9. The hold spans hub page navigation: moving to a submenu opens a new page while input is still
  //    held, so the approval still cannot prompt until the hub exits.
  {
    const view = overlayUi("overlay-queue-nav");
    const hubRun = hub.openHub(await hubDeps(view.ctx), "main");
    await until(() => view.component() !== undefined);
    const pending = fire(view.ctx);
    await sleep(100);
    assert.equal(view.selects.length, 0, "the firewall prompted while the hub overlay was open");

    view.choose({ id: "page.work" }); // open the Work submenu row (a new page)
    await until(() => view.opened.length >= 2);
    assert.equal(view.opened.length, 2, "the hub opened the submenu page");
    assert.equal(owner.inputHeld(), "the kit hub", "the hold survives the page move");
    assert.equal(view.selects.length, 0, "the firewall prompted on the next page");

    view.close();
    await hubRun;
    const result = await pending;
    assert.equal(view.selects.length, 1, "the card is shown once, after the hub exits");
    assert.equal(result?.block, true, "Deny blocks the call");
    assert.equal(owner.inputHeld(), undefined, "the hub releases input when it exits");
    ok("the hold spans hub page navigation: no prompt on the next page, then the card after exit");
  }

  // 10. A `confirm`-only UI waits the same way as `select`.
  {
    const notices: string[] = [];
    const confirms: string[] = [];
    const confirmCtx: OverlayCtx = {
      mode: "tui",
      hasUI: true,
      cwd: ws,
      sessionManager: { getSessionId: () => "overlay-queue-confirm" },
      ui: {
        notify: (message: string): void => {
          notices.push(message);
        },
        confirm: async (title: string): Promise<boolean | undefined> => {
          confirms.push(title);
          return false;
        },
        custom: async () => undefined,
      },
    };
    const hold = owner.holdInput("a text box");
    const pending = fire(confirmCtx);
    await sleep(100);
    assert.equal(confirms.length, 0, "confirm was called while input was held");
    assert.equal(notices.filter((n) => /waiting/i.test(n)).length, 1, "exactly one waiting notice");
    hold();
    const result = await pending;
    assert.equal(confirms.length, 1, "confirm is called once, after the hold");
    assert.equal(result?.block, true, "a declined confirm blocks the call");
    ok("a confirm-only UI waits for the overlay to close, like select");
  }

  // 11. Headless (hasUI false) is unchanged: it goes straight to the broker path and never waits for
  //     an overlay.
  {
    const notices: string[] = [];
    const headless: OverlayCtx = {
      mode: "json",
      hasUI: false,
      cwd: ws,
      sessionManager: { getSessionId: () => "overlay-queue-headless" },
      ui: {
        notify: (message: string): void => {
          notices.push(message);
        },
        custom: async () => undefined,
      },
    };
    const hold = owner.holdInput("a text box");
    const result = await fire(headless);
    assert.equal(result?.block, true, "a headless request blocks when no console answers");
    assert.match(result?.reason ?? "", /needs operator approval/, "the headless path reaches the broker refusal, not the prompt");
    assert.equal(notices.filter((n) => /waiting/i.test(n)).length, 0, "no waiting notice on the headless path");
    assert.equal(owner.inputHeld(), "a text box", "the headless path did not wait for the overlay");
    hold();
    ok("a headless request under a hold goes straight to the broker path without waiting");
  }

  // 12-15. A child agent's approval reaches this session as a file in the human console, not through
  //         the firewall's card, so the console's watcher has to honour the hold as well. It polls at
  //         1 Hz, so each wait below spans at least two polls.
  {
    const consoleDir = path.join(ws, "console");
    const restoreConsole = setEnv("PI_KIT_HUMAN_CONSOLE_DIR", consoleDir);
    startConsole();
    const humanConsole = await loadExtension("extensions/human-console/index.ts");
    const { brokerRequest } = await loadModule<typeof HumanConsole>("extensions/human-console/index.ts");
    const hpi = fakePi();
    humanConsole(hpi.api);
    const selects: string[] = [];
    // The next answer a card gives; undefined leaves the case's card dismissed.
    let pick: string | undefined;
    // Set for a case that needs a card nobody answers, so only its timeout can close it.
    let unanswered = false;
    const consoleCtx = {
      cwd: ws,
      hasUI: true,
      ui: {
        select: async (title: string): Promise<string | undefined> => {
          selects.push(title);
          return unanswered ? new Promise<undefined>(() => {}) : pick;
        },
      },
    };
    const pendingFile = (id: string): string => path.join(consoleDir, "pending", `${id}.json`);
    const resolvedFile = (id: string): string => path.join(consoleDir, "resolved", `${id}.json`);
    const runRequest = (id: string, hash: string, timeoutMs: number): Record<string, unknown> => ({
      id,
      kind: "approval",
      title: "Approve tool call?",
      body: `child request ${id}`,
      riskClass: "medium",
      workflowRun: "wf-overlay-queue",
      actionHash: hash.repeat(64),
      createdAt: new Date().toISOString(),
      timeoutMs,
    });
    await hpi.handlers.get("session_start")({}, consoleCtx);
    try {
      // 12. Held: no card, and the pending file stays where it was. Released: one card, which answers.
      {
        pick = "Allow once";
        const hold = owner.holdInput("the workflow panel");
        const request = brokerRequest(ws, { id: "held-child", kind: "approval", title: "Approve tool call?", body: "child request", choices: ["Allow once", "Deny"], timeoutMs: 30000 });
        await sleep(2300);
        assert.equal(selects.length, 0, "a child's approval was shown while input was held");
        assert.ok(fs.existsSync(pendingFile("held-child")), "the held request keeps its pending file");
        hold();
        const outcome = await Promise.race([request, sleep(4000).then(() => null)]);
        assert.equal(selects.length, 1, "the held approval is shown once after the hold is released");
        assert.equal(outcome?.approved, true, "the answer given after the hold reaches the requester");
        ok("a child's approval waits while an overlay holds input and is shown once after it closes");
      }

      // 13. A workflow run's approval is held the same way, and takes no prompt slot while it waits.
      {
        selects.length = 0;
        pick = "Allow once";
        const hold = owner.holdInput("the workflow panel");
        const request = brokerRequest(ws, runRequest("held-run", "a", 30000));
        await sleep(2300);
        assert.equal(selects.length, 0, "a workflow run's approval was shown while input was held");
        assert.ok(fs.existsSync(pendingFile("held-run")), "the held run request keeps its pending file");
        hold();
        const outcome = await Promise.race([request, sleep(4000).then(() => null)]);
        assert.equal(selects.length, 1, "the held run approval is shown once after the hold is released");
        assert.equal(outcome?.approved, true, "the run answer given after the hold reaches the requester");
        ok("a workflow run's approval waits under a hold and is shown once after it closes");
      }

      // 14. A run request held past its deadline fails closed at the requester and never reads as
      //     approved. The console neither shows it nor writes an answer, then or after the release.
      //     The second request lost its requester, so its pending file outlives the deadline and
      //     the console drops it; an expired request needs no card, so that does not wait.
      {
        selects.length = 0;
        pick = "Allow once";
        const hold = owner.holdInput("the workflow panel");
        const expiring = await brokerRequest(ws, runRequest("expired-run", "b", 300));
        assert.deepEqual(expiring, { resolved: false, approved: false, answer: null, timedOut: true }, "a held request expires as a refusal");
        fs.mkdirSync(path.dirname(pendingFile("orphan-run")), { recursive: true });
        fs.writeFileSync(pendingFile("orphan-run"), JSON.stringify(runRequest("orphan-run", "c", 1)));
        await until(() => !fs.existsSync(pendingFile("orphan-run")), 3000);
        assert.equal(fs.existsSync(pendingFile("orphan-run")), false, "an expired orphan is dropped");
        hold();
        await sleep(1200);
        assert.equal(fs.existsSync(resolvedFile("orphan-run")), false, "an expired orphan gets no answer");
        assert.equal(fs.existsSync(resolvedFile("expired-run")), false, "an expired request leaves no answer");
        assert.equal(selects.length, 0, "an expired request is never shown");
        ok("a run request held past its deadline fails closed and is never shown or answered");
      }

      // 15. An answer that needs no prompt is not held. A run grant must keep working while the
      //     operator watches the run in the workflow panel, or every granted repeat would stall to
      //     its deadline and be refused.
      {
        selects.length = 0;
        pick = "Allow this exact action for the rest of this run";
        assert.equal((await brokerRequest(ws, runRequest("grant-first", "d", 30000))).approved, true, "the first request takes the run grant");
        assert.equal(selects.length, 1, "the first request is asked");
        const hold = owner.holdInput("the workflow panel");
        const repeat = await Promise.race([brokerRequest(ws, runRequest("grant-repeat", "d", 30000)), sleep(4000).then(() => null)]);
        assert.equal(repeat?.approved, true, "a run grant answers under a hold");
        assert.equal(selects.length, 1, "a run grant asks nobody");
        hold();
        ok("a run grant still answers while input is held, without a prompt");
      }

      // 16-17. A session's own `ask_human` is a card too: under a hold it would take focus from the
      //         box and Enter would hand the agent the first option as the human's answer.
      const askHuman = async (signal?: AbortSignal): Promise<string> => {
        const result = await hpi.tools.get("ask_human").execute("ask", { question: "Deploy now?", options: ["Yes, deploy", "No"] }, signal, undefined, consoleCtx);
        const first = result.content[0];
        return first?.type === "text" ? first.text : "";
      };
      {
        selects.length = 0;
        pick = "No";
        const hold = owner.holdInput("the workflow panel");
        const asked = askHuman();
        const outcome = await Promise.race([asked.then(() => "settled" as const), sleep(100).then(() => "waiting" as const)]);
        assert.equal(selects.length, 0, "ask_human prompted while input was held");
        assert.equal(outcome, "waiting", "ask_human settled while input was held");
        hold();
        const answer = await asked;
        assert.equal(selects.length, 1, "the question is shown once, after the hold is released");
        assert.match(answer, /Human answer: No/);
        ok("ask_human waits while an overlay holds input and asks once after it closes");
      }
      {
        selects.length = 0;
        const controller = new AbortController();
        const hold = owner.holdInput("the workflow panel");
        const asked = askHuman(controller.signal);
        await sleep(100);
        controller.abort();
        const answer = await asked;
        assert.equal(selects.length, 0, "an aborted ask_human is never shown");
        assert.match(answer, /No human answered in time/);
        hold();
        await sleep(50);
        assert.equal(selects.length, 0, "an aborted ask_human stays unshown after the release");
        ok("aborting ask_human under a hold answers nothing and never calls select");
      }

      // 18. A non-run request whose deadline passes behind the box is dropped there. Nobody is
      //     waiting for it, so it needs no card, then or after the release.
      {
        selects.length = 0;
        pick = "Allow once";
        const hold = owner.holdInput("the workflow panel");
        fs.writeFileSync(pendingFile("held-expired"), JSON.stringify({ id: "held-expired", kind: "approval", title: "Approve tool call?", choices: ["Allow once", "Deny"], createdAt: new Date().toISOString(), timeoutMs: 1200 }));
        await until(() => !fs.existsSync(pendingFile("held-expired")), 3500);
        assert.equal(fs.existsSync(pendingFile("held-expired")), false, "an expired request is dropped while input is held");
        hold();
        await sleep(1200);
        assert.equal(selects.length, 0, "a request held past its deadline is never shown");
        assert.equal(fs.existsSync(resolvedFile("held-expired")), false, "a request held past its deadline leaves no answer");
        ok("a non-run request held past its deadline is dropped, never shown and never answered");
      }

      // 19. A card shown after a hold runs for the time left, not the full timeout: past the
      //     deadline the requester has gone, and an answer would be discarded.
      {
        selects.length = 0;
        unanswered = true;
        const hold = owner.holdInput("the workflow panel");
        fs.writeFileSync(pendingFile("held-late"), JSON.stringify({ id: "held-late", kind: "approval", title: "Approve tool call?", choices: ["Allow once", "Deny"], createdAt: new Date().toISOString(), timeoutMs: 2600 }));
        await sleep(1300);
        hold();
        await until(() => selects.length === 1, 1500);
        assert.equal(selects.length, 1, "the card is shown once the hold is released, inside the deadline");
        await until(() => !fs.existsSync(pendingFile("held-late")), 2000);
        unanswered = false;
        assert.equal(fs.existsSync(pendingFile("held-late")), false, "the card ends at the request's deadline, not a full timeout after it opened");
        assert.equal(fs.existsSync(resolvedFile("held-late")), false, "a card that outlives nobody leaves no answer");
        ok("a card shown after a hold is bounded by the time left, not the full timeout");
      }
    } finally {
      await hpi.handlers.get("session_shutdown")({}, consoleCtx);
      restoreConsole();
    }
  }

  console.log(`[firewall-overlay-queue-smoke] all ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
