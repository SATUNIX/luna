import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { loadExtension, loadModule, fakePi, textOf, tmpWorkspace, rmWorkspace, setEnv } from '../packages/core/eval/harness.ts';
import { object, parseJsonAs, string } from '../packages/core/lib/guard.ts';
import type * as AutonomousLoop from '../packages/extensions/src/autonomous-loop/index.ts';

type EventBus = ReturnType<typeof createEventBus>;
type FakePiApi = ReturnType<typeof fakePi>['api'];
/** The fake pi api plus the shared cross-extension event bus the real host injects. */
type FakePiApiWithEvents = FakePiApi & { events?: EventBus };
/** autonomous-loop as this smoke loads it: the extension is registered on the harness's fake pi. */
type AutonomousLoopView = Omit<typeof AutonomousLoop, 'default'> & { default: (api: FakePiApiWithEvents) => void };
function attachEvents(api: FakePiApiWithEvents, bus: EventBus): void {
  api.events = bus;
}

const ws = tmpWorkspace('pi-liveness-containment-');
const restore = setEnv('PI_KIT_LOOP_MAX', 'invalid');
const restoreMode = setEnv('PI_KIT_GUARD_MODE', 'suggest');
try {
  const loopModule = await loadModule<AutonomousLoopView>('extensions/autonomous-loop/index.ts');
  for (const value of ['NaN', 'Infinity', '-1', '0', '', '2x', '1.5', '1001']) assert.equal(loopModule.iterationLimit(value), 20);
  assert.equal(loopModule.iterationLimit('3'), 3);
  const events = createEventBus();
  const context = (id: string) => ({ cwd: ws, hasUI: false, sessionManager: { getSessionId: () => id }, ui: { notify() {}, setStatus() {} } });
  const ctx = context('owner-A');
  const loop = fakePi(); attachEvents(loop.api, events); loopModule.default(loop.api);
  await loop.handlers.get('session_start')({}, ctx);
  await loop.commands.get('loop').handler('finish synthetic task', ctx);
  for (let i = 0; i < 30; i++) await loop.handlers.get('agent_end')({}, ctx);
  assert.equal(loop.steers.length, 20, 'malformed configuration retains finite bound');

  await loop.commands.get('loop').handler('second synthetic task', ctx);
  const other = fakePi(); attachEvents(other.api, events); loopModule.default(other.api);
  await other.handlers.get('session_start')({}, context('owner-B'));
  assert.ok(fs.existsSync(path.join(ws, '.pi/autonomous-loop.armed.json')), 'child startup cannot delete parent arm marker');
  events.emit('pi-kit:recovery-blocked', { cwd: ws, sessionId: 'owner-B' });
  await loop.handlers.get('agent_end')({}, ctx);
  assert.equal(loop.steers.length, 21, 'foreign session cannot disarm parent');

  const recovery = fakePi(); attachEvents(recovery.api, events);
  (await loadExtension('extensions/recovery-orchestrator/index.ts'))(recovery.api);
  await recovery.handlers.get('session_start')({}, ctx);
  for (let i = 0; i < 3; i++) await recovery.commands.get('recover').handler('same-task', ctx);
  await loop.handlers.get('agent_end')({}, ctx);
  assert.equal(loop.steers.length, 21, 'recovery cap disarms same-session automatic loop before more starts');
  const blocked = parseJsonAs(object({ state: string(), sessionId: string() }), fs.readFileSync(path.join(ws, '.pi/recovery/blocked-owner-A.json'), 'utf8'));
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.sessionId, 'owner-A');

  // REL-1: an operator abort (Esc) or a provider error ends the loop instead of re-queueing
  // "Continue". The last assistant message's stopReason is what agent_end reports.
  const notes: string[] = [];
  const endCtx = { ...context('owner-C'), ui: { notify: (m: string) => notes.push(m), setStatus() {} } };
  const assistantEnd = (stopReason: string, errorMessage?: string) => ({ type: 'agent_end', messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) },
  ] });
  for (const [reason, detail] of [['aborted', undefined], ['error', '401 invalid key']] as const) {
    const run = fakePi(); attachEvents(run.api, events); loopModule.default(run.api);
    await run.handlers.get('session_start')({}, endCtx);
    await run.commands.get('loop').handler(`${reason} task`, endCtx);
    await run.handlers.get('agent_end')(assistantEnd(reason, detail), endCtx);
    assert.equal(run.steers.length, 0, `${reason} turn: no Continue is queued`);
    await run.handlers.get('agent_end')(assistantEnd('stop'), endCtx);
    assert.equal(run.steers.length, 0, `${reason} turn: the loop is disarmed`);
    assert.ok(!fs.existsSync(path.join(ws, '.pi/autonomous-loop.armed.json')), `${reason} turn: arm marker removed`);
    if (detail) assert.ok(notes.some((m) => m.includes(detail)), 'the provider error is shown to the operator');
  }
  const normal = fakePi(); attachEvents(normal.api, events); loopModule.default(normal.api);
  await normal.handlers.get('session_start')({}, endCtx);
  await normal.commands.get('loop').handler('normal task', endCtx);
  await normal.handlers.get('agent_end')(assistantEnd('stop'), endCtx);
  assert.equal(normal.steers.length, 1, 'a normally finished turn still queues Continue');

  // REL-2: the model ends the loop with the loop_complete tool; the steer names that tool, not
  // the operator-only /loop stop command.
  const steer = fs.readFileSync(path.join(ws, '.pi/ctx-contributions/sessions/owner-C/autonomous-loop.json'), 'utf8');
  assert.match(steer, /loop_complete/, 'the steer names the loop_complete tool');
  assert.doesNotMatch(steer, /\/loop stop/, 'the steer does not tell the model to run an operator command');
  const complete = normal.tools.get('loop_complete');
  const done = await complete.execute('call-1', { reason: 'all tests pass' }, null, undefined, endCtx);
  assert.match(textOf(done), /all tests pass/);
  await normal.handlers.get('agent_end')(assistantEnd('stop'), endCtx);
  assert.equal(normal.steers.length, 1, 'after loop_complete no further Continue is queued');
  assert.ok(!fs.existsSync(path.join(ws, '.pi/autonomous-loop.armed.json')), 'loop_complete removes the arm marker');
  const idle = await complete.execute('call-2', { reason: 'again' }, null, undefined, endCtx);
  assert.match(textOf(idle), /no autonomous loop/i, 'loop_complete with no armed loop says so');

  const researchWs = path.join(ws, 'research'); fs.mkdirSync(researchWs);
  const researchCtx = { ...ctx, cwd: researchWs };
  const guard = fakePi();
  // Read-only session: no write-capable tool active, so "reads since last edit" is not a
  // stall and must never auto-escalate even after many reads.
  guard.api.getActiveTools = () => ['read', 'grep', 'find', 'ls'];
  (await loadExtension('extensions/progress-guard/index.ts'))(guard.api);
  await guard.handlers.get('session_start')({}, researchCtx);
  for (let i = 0; i < 20; i++) {
    await guard.handlers.get('tool_call')({ toolName: 'read', input: { path: `fact-${i}.md` } }, researchCtx);
    await guard.handlers.get('turn_end')({}, researchCtx);
  }
  assert.ok(!fs.existsSync(path.join(researchWs, '.pi/recovery/sessions/owner-A/escalation.json')), 'a read-only session cannot trip the reads-since-edit stall');
  assert.ok(!fs.existsSync(path.join(researchWs, '.pi/ctx-contributions/progress-guard.json')));

  // Write-capable session, suggest mode: a recurring stall must now inject the review/delegate
  // checkpoint AND write the recovery marker on its own — the automatic replacement for the
  // manual /reflect, no mode switch required.
  const workWs = path.join(ws, 'work'); fs.mkdirSync(workWs);
  const workCtx = { ...ctx, cwd: workWs };
  const guard2 = fakePi(); // getActiveTools includes write/edit -> write-capable
  (await loadExtension('extensions/progress-guard/index.ts'))(guard2.api);
  await guard2.handlers.get('session_start')({}, workCtx);
  for (let i = 0; i < 12; i++) {
    await guard2.handlers.get('tool_call')({ toolName: 'read', input: { path: `src/file${i}.ts` } }, workCtx);
    await guard2.handlers.get('turn_end')({}, workCtx);
  }
  assert.ok(fs.existsSync(path.join(workWs, '.pi/recovery/sessions/owner-A/escalation.json')), 'a recurring stall must auto-escalate even in suggest mode');
  assert.ok(fs.existsSync(path.join(workWs, '.pi/ctx-contributions/sessions/owner-A/progress-guard.json')), 'the review/delegate checkpoint must be injected automatically');
  assert.ok(!fs.existsSync(path.join(workWs, '.pi/ctx-contributions/progress-guard.json')), 'a session-id contribution must not land in the legacy flat directory');
  console.log('PASS liveness containment: finite limits, abort/error disarm, loop_complete tool, per-instance ownership, same-session recovery disarm, durable blocker, read-only stall suppression, automatic suggest-mode escalation');
} finally { restore(); restoreMode(); rmWorkspace(ws); }
