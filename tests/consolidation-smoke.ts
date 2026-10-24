import assert from 'node:assert/strict';
import { normalizeAuthority, resolvePolicy } from '../packages/web-ui/server/security.ts';
import { loadModule, isolateKitEnv } from '../packages/core/eval/harness.ts';
import type * as Orchestrator from '../packages/extensions/src/orchestrator/index.ts';
const restore = isolateKitEnv();
try {
 for (const value of ['[:::]','[abc]','[a:b:c]','[::1]junk','[::1]:abc','[::1','example.invalid:65536','example.invalid:0']) {
  assert.equal(normalizeAuthority(value),null,`invalid authority ${value}`);
  assert.throws(()=>resolvePolicy({PI_CONSOLE_HOST:'0.0.0.0',PI_CONSOLE_ALLOW_REMOTE:'1',PI_CONSOLE_ALLOWED_HOSTS:value,PI_CONSOLE_TOKEN:'a'.repeat(64)}),/host|Host|port/);
 }
 for (const value of ['[::1]','[::1]:8123','[2001:db8::1]:443','example.invalid:443']) assert.equal(normalizeAuthority(value),value);
 const mod = await loadModule<typeof Orchestrator>('extensions/orchestrator/index.ts');
 const text = mod.directive(5);
 assert.ok(text.length <= mod.DIRECTIVE_BUDGET_TOKENS*4,'complete directive fits contribution budget');
 assert.match(text,/effort budget/);
 assert.match(text,/verify_completion/);
 assert.match(text,/untrusted/);
 assert.doesNotMatch(text,/workflowScript|subagents_enable/,'directive uses retained guarded provider');
 console.log('consolidation: console edge cases and budgeted trusted-verifier orchestration passed');
} finally {restore();}
