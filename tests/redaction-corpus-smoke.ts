#!/usr/bin/env node
/**
 * Offline checks for the kit's one secret-redaction table (packages/core/shared/redact.ts) and
 * everything that stores text through it (docs/security.md, "Redaction"):
 *   1. every generated copy is byte-identical to the source (packages/core/gen-shared.ts);
 *   2. every redactor (the source, each copy, and the consumers memory-vault, /save, the firewall
 *      feedback log, the autonomy notebook, workflow run files, role-runner telemetry) leaves no
 *      secret from tests/fixtures/secret-corpus.json in its output, and keeps the key name or
 *      header the entry says must stay;
 *   3. text with no secret in it is left unchanged by the table, and a second pass changes nothing;
 *   4. adversarial 1 MB inputs (repeated rule prefixes with no closing part) finish well inside a
 *      linear-time budget, so stored text cannot stall a session.
 * The corpus values are synthetic and stored as parts the test joins, so no committed line holds a
 * whole token shape. No network, no model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateKitEnv, loadModule } from "../packages/core/eval/harness.ts";
import { checkSharedCopies, SHARED_COPIES } from "../packages/core/gen-shared.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import * as canonical from "../packages/core/shared/redact.ts";
import * as mem0Copy from "../packages/extensions/src/memory-mem0/shared/redact.ts";
import * as vaultCopy from "../packages/extensions/src/memory-vault/shared/redact.ts";
import * as saveCopy from "../packages/extensions/src/save/shared/redact.ts";
import * as firewallCopy from "../packages/extensions/src/tool-firewall/shared/redact.ts";
import * as subagentCopy from "../packages/extensions/third_party/subagent/shared/redact.ts";
import { redact as vaultRedact } from "../packages/extensions/src/memory-vault/vault.ts";
import { redact as saveRedact } from "../packages/extensions/src/save/index.ts";
import { redact as feedbackRedact } from "../packages/extensions/src/tool-firewall/feedback.ts";
import { redactText as workflowRedact } from "../packages/extensions/third_party/subagent/redact.ts";
import { redactSecrets as notebookRedact } from "../packages/autonomy/lib/notebook.ts";

const restoreEnv = isolateKitEnv();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`  OK: ${name}`);
}

interface Entry { id: string; text: string; secret: string; keep?: string }

function partsOf(value: unknown, where: string): string {
  assert.ok(Array.isArray(value) && value.every((p) => typeof p === "string"), `${where} must be a list of strings`);
  return value.join("");
}

function loadCorpus(): { entries: Entry[]; clean: string[] } {
  const raw = parseJson(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "secret-corpus.json"), "utf8"));
  assert.ok(isRecord(raw) && Array.isArray(raw.entries) && Array.isArray(raw.clean), "secret-corpus.json has entries and clean");
  const entries = raw.entries.map((e: unknown, i: number): Entry => {
    assert.ok(isRecord(e) && typeof e.id === "string", `entry ${i} has an id`);
    assert.equal(e.fixture, "synthetic", `${e.id} is marked synthetic`);
    const keep = e.keep;
    assert.ok(keep === undefined || typeof keep === "string", `${e.id} keep is a string`);
    return { id: e.id, text: partsOf(e.text, `${e.id}.text`), secret: partsOf(e.secret, `${e.id}.secret`), ...(keep === undefined ? {} : { keep }) };
  });
  const clean = raw.clean.map((c: unknown, i: number): string => {
    assert.ok(typeof c === "string", `clean ${i} is a string`);
    return c;
  });
  return { entries, clean };
}

const { entries, clean } = loadCorpus();

// The role-runner package is not part of the public export (internal/public-release/manifest.json),
// so its copy and its telemetry redactor are checked only where the package is present.
type Redactor = (text: string) => string;
const roleRunner: Array<readonly [string, Redactor]> = [];
if (fs.existsSync(path.join(ROOT, "packages", "role-runner", "src", "telemetry.ts"))) {
  const copy = await loadModule<{ redact: Redactor }>("packages/role-runner/src/shared/redact.ts");
  const telemetry = await loadModule<{ redact: Redactor }>("packages/role-runner/src/telemetry.ts");
  roleRunner.push(["role-runner copy", copy.redact], ["role-runner telemetry redact", telemetry.redact]);
}

const REDACTORS: ReadonlyArray<readonly [string, Redactor]> = [
  ["packages/core/shared/redact.ts", canonical.redact],
  ["memory-mem0 copy", mem0Copy.redact],
  ["memory-vault copy", vaultCopy.redact],
  ["save copy", saveCopy.redact],
  ["tool-firewall copy", firewallCopy.redact],
  ["subagent copy", subagentCopy.redact],
  ["memory-vault redact", vaultRedact],
  ["/save redact", saveRedact],
  ["firewall feedback redact", feedbackRedact],
  ["workflow redactText", (t) => workflowRedact(t).text],
  ["autonomy notebook redactSecrets", (t) => notebookRedact(t).text],
  ...roleRunner,
];

const tableNames = new Set(REDACTORS.filter(([name]) => name.endsWith(" copy") || name.startsWith("packages/core/")).map(([name]) => name));

console.log("[redaction-corpus-smoke] shared table, copies and consumers");

check("1. every generated copy of the shared helpers matches its source byte for byte", () => {
  assert.deepEqual(checkSharedCopies(ROOT), []);
  assert.ok((SHARED_COPIES["redact.ts"] ?? []).length >= 6, "redact.ts has its copies listed");
});

check(`2. ${REDACTORS.length} redactors x ${entries.length} corpus entries leak nothing and keep the key names`, () => {
  assert.ok(entries.length >= 30, "the corpus covers the rule table");
  const leaks: string[] = [];
  for (const [name, fn] of REDACTORS) {
    for (const e of entries) {
      assert.ok(e.text.includes(e.secret), `${e.id}: the secret is part of the text`);
      const out = fn(e.text);
      if (out.includes(e.secret)) leaks.push(`${name}: ${e.id}`);
      if (!out.includes(canonical.REDACTION_MARK) && !out.includes("[REDACTED")) leaks.push(`${name}: ${e.id} has no redaction mark`);
      // Consumers may add stricter rules of their own (workflow files also mask more of a URL), so
      // the kept-prefix check applies to the shared table and its copies.
      if (tableNames.has(name) && e.keep !== undefined && !out.includes(e.keep)) leaks.push(`${name}: ${e.id} lost "${e.keep}"`);
    }
  }
  assert.deepEqual(leaks, []);
});

check("2b. the table counts each corpus secret once, not once per overlapping rule", () => {
  for (const e of entries) {
    const { count } = canonical.redactSecrets(e.text);
    assert.equal(count, 1, `${e.id}: ${count} replacements`);
  }
});

check("3. text without a secret is unchanged, and redaction is idempotent", () => {
  for (const c of clean) {
    const r = canonical.redactSecrets(c);
    assert.equal(r.count, 0, `clean line changed: ${c}`);
    assert.equal(r.text, c);
  }
  for (const e of entries) {
    const once = canonical.redact(e.text);
    assert.equal(canonical.redactSecrets(once).count, 0, `${e.id}: a second pass found more`);
  }
});

check("4. adversarial 1 MB inputs finish inside a linear-time budget", () => {
  // Each input repeats a rule's opening with nothing that closes it. A backtracking rule takes
  // seconds to minutes on these; the linear table takes tens of milliseconds.
  const MB = 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length));
  const inputs: ReadonlyArray<readonly [string, string]> = [
    ["private-key headers, no END line", fill("-----BEGIN PRIV" + "ATE KEY-----\n")],
    ["curl -u without a password", fill("curl -u ")],
    ["mysql -p prefixes", fill("mysql x -")],
    ["url scheme and user, no @", fill("http://user:pass")],
    ["key names, no value", fill("api_key_secret_")],
    ["bearer words", fill("bearer ")],
    ["camel-case names", fill("aaaaToken")],
  ];
  // The private-key rule is the one that was quadratic, so it gets the tight budget the
  // roadmap sets (200 ms per MB); the rest are bounded scans with a larger constant.
  const budgetFor = (name: string): number => (name.startsWith("private-key") ? 200 : 1000);
  const slow: string[] = [];
  for (const [name, text] of inputs) {
    const BUDGET_MS = budgetFor(name);
    for (const [label, fn] of [["table", canonical.redact], ["workflow redactText", (t: string) => workflowRedact(t).text]] as const) {
      const started = performance.now();
      fn(text);
      const ms = performance.now() - started;
      if (ms > BUDGET_MS) slow.push(`${label}, ${name}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

restoreEnv();
console.log(`\n[redaction-corpus-smoke] all ${checks} checks passed`);
