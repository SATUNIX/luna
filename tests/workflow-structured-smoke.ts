#!/usr/bin/env node
// Inert Node fixture only: never starts Pi; fake children replay pi's JSON event lines.
//
// Structured results for subagent runs (third_party/subagent/structured-output/):
//   1. the schema is checked before launch: the root must be an object schema, `required` must name
//      properties, and only the keywords the copied validator supports may appear (anywhere);
//      runAgent rejects an invalid schema before any child is spawned or charged.
//   1b. a pattern that can backtrack exponentially is refused at check time (a repeating quantifier
//      on a group with a quantifier or alternation, a backreference, more than 256 characters);
//      the host's re-check fails a string over 64 KiB without testing it and cuts off a slow test.
//   2. sub/schema.ts is a byte-identical copy of packages/role-runner/src/schema.ts.
//   3. the child-only extension registers StructuredOutput only with PI_KIT_INTERNAL_CHILD=1 and a
//      schema file; it checks the raw arguments (prepareArguments) and the executed ones, and ends
//      the child's turn on success.
//   4. the host launches the child with the extension (-e), adds the tool to an explicit --tools
//      list, writes the schema to a 0600 file named by PI_KIT_STRUCTURED_OUTPUT_SCHEMA, and takes the
//      value from the child's event stream only after validating it again itself.
//   5. a child that reports success with an invalid value, a call the child itself failed, a call
//      that never finished, or no call at all is not accepted: one more (charged) launch, then null.
//   6. a failed child is not retried for its structured result; the result is still null. A run
//      without a schema loads no extension and drops an inherited PI_KIT_STRUCTURED_OUTPUT_SCHEMA.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fakePi, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace, type FakeTool } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type { RunAgentOptions } from "../packages/extensions/third_party/subagent/runner.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";
import type * as CheckModule from "../packages/extensions/third_party/subagent/structured-output/check.ts";
import type * as SchemaModule from "../packages/extensions/third_party/subagent/schema.ts";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: () => boolean;
}
type FakeSpawn = (cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => FakeChild;
interface RunnerView {
  runAgent(options: Omit<RunAgentOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<SingleResult>;
}

const DELEGATION_KEY = Symbol.for("pi-kit.delegation");
const delegation = await installDelegation();
process.on("exit", () => delegation.cleanup());

// Count every launch the delegation guard is asked to prepare (each one is a charged reservation).
let prepared = 0;
{
  const registry: unknown = Reflect.get(globalThis, DELEGATION_KEY);
  const prepare: unknown = typeof registry === "object" && registry !== null ? Reflect.get(registry, "prepareChild") : undefined;
  if (typeof prepare !== "function") throw new Error("the delegation registry is not installed");
  Reflect.set(globalThis, DELEGATION_KEY, {
    version: 1,
    requiredForChild: () => [],
    prepareChild: (request: unknown): unknown => {
      prepared++;
      return Reflect.apply(prepare, registry, [request]);
    },
  });
}

const ws = tmpWorkspace("pi-kit-structured-");
const restores = [setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "state")), setEnv("PI_KIT_STRUCTURED_OUTPUT_SCHEMA", undefined), setEnv("PI_KIT_INTERNAL_CHILD", undefined)];
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const schema = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["pass", "fail"] }, score: { type: "integer", minimum: 0, maximum: 10 }, command: { type: "string" } },
  required: ["verdict", "score"],
  additionalProperties: false,
};

try {
  const check = await loadModule<typeof CheckModule>("vendor/subagent/structured-output/check.ts");
  const { validateSchema } = await loadModule<typeof SchemaModule>("vendor/subagent/schema.ts");
  const runner = await loadModule<RunnerView>("vendor/subagent/runner.ts");
  const scout: AgentConfig = { name: "scout", description: "fixture", tools: ["read", "grep"], systemPrompt: "", source: "user", filePath: "fixture" };
  const agents: AgentConfig[] = [scout];

  // 1. Pre-launch schema checks.
  {
    assert.deepEqual(check.checkSchema(schema), []);
    const bad: Array<[unknown, RegExp]> = [
      [[], /must be a JSON object/],
      [{ type: "array", items: { type: "string" } }, /root must have "type": "object"/],
      [{ type: ["object", "null"], properties: {} }, /root must have "type": "object"/],
      [{ properties: { a: { type: "string" } } }, /root must have "type": "object"/],
      [{ type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] }, /required property "b" is not in "properties"/],
      [{ type: "object", required: ["a"] }, /required property "a" is not in "properties"/],
      [{ type: "object", properties: { a: { oneOf: [{ type: "string" }] } } }, /\$\/properties\/a: unsupported keyword "oneOf"/],
      [{ type: "object", properties: { a: { type: "array", items: { $ref: "#/x" } } } }, /items: unsupported keyword "\$ref"/],
      [{ type: "object", properties: { a: { type: "strng" } } }, /"type" must be one of/],
      [{ type: "object", properties: { a: { type: "string", pattern: "(" } } }, /not a valid regular expression/],
      [{ type: "object", properties: { a: { type: "string", maxLength: "3" } } }, /"maxLength" must be a finite number/],
      [{ type: "object", properties: [] }, /"properties" must be an object/],
      [{ type: "object", additionalProperties: { anyOf: [] } }, /additionalProperties: unsupported keyword "anyOf"/],
      // The copied validator ignores a schema-valued additionalProperties without "properties".
      [{ type: "object", additionalProperties: { type: "integer" } }, /schema-valued "additionalProperties" needs "properties"/],
      // pi compiles patterns with the "u" flag; "\\_" is an invalid escape there.
      [{ type: "object", properties: { a: { type: "string", pattern: "^\\_$" } } }, /not a valid regular expression/],
      // NaN and Infinity would reach the child's schema file as null.
      [{ type: "object", properties: { a: { type: "number", minimum: Number.NaN } } }, /"minimum" must be a finite number/],
      [{ type: "object", properties: { a: { type: "number", maximum: Number.POSITIVE_INFINITY } } }, /"maximum" must be a finite number/],
    ];
    for (const [s, re] of bad) assert.match(check.checkSchema(s).join("\n"), re, JSON.stringify(s));
    // Next to "properties", a schema-valued additionalProperties is accepted and enforced.
    const extraInts = { type: "object", properties: {}, additionalProperties: { type: "integer" } };
    assert.deepEqual(check.checkSchema(extraInts), []);
    assert.equal(check.readStructured(extraInts, { output: { a: 7 } }).ok, true);
    assert.equal(check.readStructured(extraInts, { output: { a: "7" } }).ok, false, "a string where the schema requires an integer is refused");
    // Every keyword the checker accepts is one the copied validator validates (none is reported unsupported).
    for (const keyword of check.SUPPORTED_KEYWORDS) {
      assert.ok(!validateSchema({ [keyword]: keyword === "type" ? "object" : undefined }, {}).some((e) => e.includes("unsupported")), keyword);
    }
    let spawned = 0;
    const before = prepared;
    await assert.rejects(
      runner.runAgent({ defaultCwd: ws, agents, agentName: "scout", task: "t", schema: { type: "object", properties: {}, required: ["x"] }, spawnChild: () => { spawned++; throw new Error("must not spawn"); } }),
      (error: unknown) => error instanceof Error && error.name === "StructuredSchemaError" && /required property "x"/.test(error.message),
    );
    assert.equal(spawned, 0, "no child is spawned for an invalid schema");
    assert.equal(prepared, before, "an invalid schema is never charged");
    ok("schemas are checked before launch (object root, required within properties, supported keywords only); runAgent rejects an invalid one without a launch");
  }

  // 1b. Patterns cannot stall the root process.
  {
    const withPattern = (pattern: string): unknown => ({ type: "object", properties: { a: { type: "string", pattern } }, required: ["a"] });
    const refused: Array<[string, RegExp]> = [
      ["^(a+)+$", /\$\/properties\/a: "pattern" is refused: a repeated group contains a quantifier or an alternation/],
      ["^(a|a)*$", /repeated group contains a quantifier or an alternation/],
      ["^(?:x*y?){2,}$", /repeated group contains a quantifier or an alternation/],
      ["^((ab)+c)*$", /repeated group contains a quantifier or an alternation/],
      ["^(a)\\1$", /backreferences are not allowed/],
      ["^(?<n>a)\\k<n>$", /backreferences are not allowed/],
      [`^${"a".repeat(check.MAX_PATTERN_LENGTH)}$`, /longer than 256 characters/],
    ];
    for (const [pattern, re] of refused) assert.match(check.checkSchema(withPattern(pattern)).join("\n"), re, pattern);
    assert.equal(check.MAX_PATTERN_LENGTH, 256);
    for (const pattern of ["^[a-z]+(?:-[a-z]+)?$", "^\\d{4}-\\d{2}-\\d{2}$", "^(ab){2,}$", "^(a+)?$", "^[(+)|]+$", "^(?:yes|no)$", "^\\u{1F600}+$"]) {
      assert.deepEqual(check.checkSchema(withPattern(pattern)), [], pattern);
    }
    // Compile time: V8 compiles a pattern on its first test, outside the vm time limit, and a run of
    // optional atoms ahead of literals is exponential to compile ('a?'x50 + 'a'x50 took ~5 s).
    assert.equal(check.MAX_PATTERN_CHOICES, 16);
    const slowCompile: string[] = ["a?".repeat(50) + "a".repeat(50), "(?:a|)".repeat(36) + "a".repeat(36), "a{0,3}".repeat(17), "x|".repeat(17) + "x"];
    for (const pattern of slowCompile) assert.match(check.checkSchema(withPattern(pattern)).join("\n"), /more than 16 quantifiers and alternatives/, pattern);
    // Exactly 16 choice points pass, fixed counts are not choices, and the slowest shapes at the cap compile fast.
    const atCap: string[] = ["a?".repeat(16) + "a".repeat(200), "[ab]{0,3}".repeat(16) + "a".repeat(100), "(?:a|)".repeat(16) + "a".repeat(100), "x|".repeat(16) + "x", "\\d{4}".repeat(30)];
    for (const [n, pattern] of atCap.entries()) {
      assert.deepEqual(check.checkSchema(withPattern(pattern)), [], pattern);
      // A fresh source each run: V8 caches compiled patterns by source.
      const fresh = `${pattern}z${n}${Date.now()}`;
      const compileStart = Date.now();
      new RegExp(fresh).test("b");
      assert.ok(Date.now() - compileStart < 500, `compiling ${pattern} at the cap stays fast`);
    }
    const date = withPattern("^\\d{4}-\\d{2}-\\d{2}$");
    assert.equal(check.readStructured(date, { output: { a: "2026-10-23" } }).ok, true, "a normal pattern still matches");
    const miss = check.readStructured(date, { output: { a: "23/10/2026" } });
    assert.ok(!miss.ok && /does not match pattern/.test(miss.errors.join("\n")), "a normal pattern still refuses a mismatch");
    // A string over 64 KiB is refused without running the pattern.
    const { MAX_PATTERN_SUBJECT, PATTERN_TEST_MS, PATTERN_BUDGET_MS } = await loadModule<typeof SchemaModule>("vendor/subagent/schema.ts");
    assert.equal(MAX_PATTERN_SUBJECT, 64 * 1024);
    let started = Date.now();
    const long = check.readStructured(withPattern("^[a-z]+x"), { output: { a: "a".repeat(MAX_PATTERN_SUBJECT + 1) } });
    assert.ok(!long.ok && /\$\/output\/a: longer than 65536 characters, too long to test against pattern/.test(long.errors.join("\n")), JSON.stringify(long));
    assert.ok(Date.now() - started < 50, "an over-long value is refused quickly");
    assert.equal(check.readStructured(withPattern("^a+$"), { output: { a: "a".repeat(MAX_PATTERN_SUBJECT) } }).ok, true, "a value at the cap is still tested");
    // Backstop: a pattern the syntactic check allows but that is polynomial (a*a*a*$) is cut off.
    const cubic = { type: "object", properties: { a: { type: "string", pattern: "a*a*a*$" } } };
    assert.deepEqual(check.checkSchema(cubic), []);
    started = Date.now();
    const slow = validateSchema(cubic, { a: `${"a".repeat(4096)}!` });
    assert.deepEqual(slow, ["$/a: pattern a*a*a*$ took too long to test"]);
    assert.ok(Date.now() - started < PATTERN_TEST_MS * 5, "one slow test is cut off near PATTERN_TEST_MS");
    started = Date.now();
    const many = validateSchema({ type: "array", items: { type: "string", pattern: "a*a*a*$" } }, Array.from({ length: 30 }, () => `${"a".repeat(4096)}!`));
    assert.equal(many.length, 30);
    assert.ok(Date.now() - started < PATTERN_BUDGET_MS * 2, "all pattern tests of one validation share PATTERN_BUDGET_MS");
    ok("patterns: exponential shapes, backreferences, >16 choice points (slow to compile) and >256 characters refused before launch; >64 KiB values refused untested; slow tests cut off (100 ms each, 1 s per validation)");
  }

  // 2. The validator copy matches its source. role-runner is private, so the public export has
  // only the copy and the check runs in the private tree.
  {
    const sourceUrl = new URL("../packages/role-runner/src/schema.ts", import.meta.url);
    if (fs.existsSync(sourceUrl)) {
      const copy = fs.readFileSync(new URL("../packages/extensions/third_party/subagent/schema.ts", import.meta.url), "utf8");
      const source = fs.readFileSync(sourceUrl, "utf8");
      assert.equal(copy, source, "third_party/subagent/schema.ts must stay a byte-identical copy of packages/role-runner/src/schema.ts");
      ok("third_party/subagent/schema.ts is byte-identical to packages/role-runner/src/schema.ts");
    } else {
      ok("schema copy check skipped: packages/role-runner is not in this tree (public export)");
    }
  }

  // 3. The child-only extension.
  {
    const factory = await loadExtension<(api: unknown) => void>("vendor/subagent/structured-output/index.ts");
    const schemaFile = path.join(ws, "schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const load = (child: string | undefined, file: string | undefined): FakeTool | undefined => {
      const r = [setEnv("PI_KIT_INTERNAL_CHILD", child), setEnv("PI_KIT_STRUCTURED_OUTPUT_SCHEMA", file)];
      try {
        const pi = fakePi();
        factory(pi.api);
        assert.ok(pi.tools.size <= 1);
        return pi.tools.has("StructuredOutput") ? pi.tools.get("StructuredOutput") : undefined;
      } finally {
        for (const restore of r.reverse()) restore();
      }
    };
    assert.equal(load(undefined, schemaFile), undefined, "a root session never gets the tool");
    assert.equal(load("1", undefined), undefined, "a child without a schema file does not get it");
    const badFile = path.join(ws, "bad-schema.json");
    fs.writeFileSync(badFile, JSON.stringify({ type: "object", properties: { a: { oneOf: [] } } }));
    assert.equal(load("1", badFile), undefined, "a schema that fails the check registers nothing");
    const tool = load("1", schemaFile);
    assert.ok(tool, "a child with a schema file gets StructuredOutput");
    assert.deepEqual(tool.parameters, { type: "object", properties: { output: schema }, required: ["output"], additionalProperties: false });
    const prepare = tool.prepareArguments;
    assert.ok(prepare, "raw arguments are checked before pi coerces them");
    assert.throws(() => prepare({ output: { verdict: "pass", score: "7" } }), /\$\/output\/score: expected type "integer"/);
    assert.throws(() => prepare({ verdict: "pass", score: 7 }), /no "output" field/);
    assert.throws(() => prepare({ output: { verdict: "pass", score: 7 }, extra: 1 }), /unexpected field "extra"/);
    assert.deepEqual(prepare({ output: { verdict: "pass", score: 7 } }), { output: { verdict: "pass", score: 7 } });
    const good = await tool.execute("id", { output: { verdict: "pass", score: 7 } }, undefined, undefined, {});
    assert.equal(good.terminate, true, "an accepted result ends the child's turn");
    assert.notEqual(good.isError, true);
    const rejected = await tool.execute("id", { output: { verdict: "maybe", score: 7 } }, undefined, undefined, {});
    assert.equal(rejected.isError, true);
    ok("StructuredOutput registers only in a child with a valid schema file; it rejects bad raw and executed arguments and ends the turn on success");
  }

  // 4-6. The host side, with fake children replaying pi's event lines.
  type Script = (attempt: number, stdin: string) => { lines: object[]; code?: number };
  const runStructured = async (script: Script, opts: { tools?: string[] } = {}) => {
    const seen: Array<{ args: string[]; schemaText: string | null; schemaMode: number | null; envFile: string | undefined; stdin: string }> = [];
    const keepalive = setInterval(() => {}, 1000);
    // A fresh request scope, so the per-request scout budget never decides these cases.
    await delegation.newTurn();
    const startPrepared = prepared;
    const spawn: FakeSpawn = (_cmd, args, spawnOpts) => {
      const envFile = spawnOpts.env?.PI_KIT_STRUCTURED_OUTPUT_SCHEMA;
      const entry = { args, schemaText: envFile ? fs.readFileSync(envFile, "utf8") : null, schemaMode: envFile ? fs.statSync(envFile).mode & 0o777 : null, envFile, stdin: "" };
      seen.push(entry);
      const child: FakeChild = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: (): boolean => true });
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (d: string) => (entry.stdin += d));
      child.stdin.on("end", () => {
        const { lines, code = 0 } = script(seen.length, entry.stdin);
        for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
        child.emit("close", code);
      });
      return child;
    };
    try {
      const agentList: AgentConfig[] = opts.tools ? [{ ...scout, tools: opts.tools }] : agents;
      const result = await runner.runAgent({ defaultCwd: ws, agents: agentList, agentName: "scout", task: "judge it", schema, spawnChild: spawn });
      return { result, seen, charged: prepared - startPrepared };
    } finally {
      clearInterval(keepalive);
    }
  };
  const final = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } };
  const call = (id: string, args: unknown, isError: boolean | null): object[] => [
    { type: "tool_execution_start", toolCallId: id, toolName: "StructuredOutput", args },
    ...(isError === null ? [] : [{ type: "tool_execution_end", toolCallId: id, toolName: "StructuredOutput", result: {}, isError }]),
  ];
  const valid = { verdict: "fail", score: 3, command: "rm -rf /" };

  // 4. Accepted on the first attempt.
  {
    const { result, seen, charged } = await runStructured(() => ({ lines: [...call("c1", { output: { verdict: "pass", score: 1 } }, true), ...call("c2", { output: valid }, false), final] }));
    assert.deepEqual(result.structured, valid);
    assert.equal(result.structuredErrors, undefined);
    assert.equal(result.attempts, 1);
    assert.equal(charged, 1);
    const [first] = seen;
    assert.ok(first);
    const ext = first.args[first.args.lastIndexOf("-e") + 1] ?? "";
    assert.ok(ext.endsWith(path.join("subagent", "structured-output", "index.ts")), `the child loads the structured-output extension (${ext})`);
    assert.equal(first.args[first.args.indexOf("--tools") + 1], "read,grep,StructuredOutput", "the tool joins an explicit allowlist");
    assert.deepEqual(JSON.parse(first.schemaText ?? "null"), schema, "the child's schema file holds the caller's schema");
    assert.equal(first.schemaMode, 0o600);
    assert.ok(first.envFile && !fs.existsSync(first.envFile), "the schema file is removed after the attempt");
    ok("the host loads the child-only extension, adds the tool to --tools, passes a 0600 schema file and takes the value it validated itself");
  }

  // 5. A child's success claim with an invalid value, a call it failed, an unfinished call, or no call: one retry, then null.
  {
    const cases: Array<[string, object[]]> = [
      ["success claim with an invalid value", [...call("a", { output: { verdict: "maybe", score: 3 } }, false), final]],
      ["success claim without the output wrapper", [...call("a", valid, false), final]],
      ["a call the child failed", [...call("a", { output: valid }, true), final]],
      ["a call that never finished", [...call("a", { output: valid }, null), final]],
      ["no call at all", [final]],
      ["another tool's success with the right arguments", [{ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { output: valid } }, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: {}, isError: false }, final]],
    ];
    for (const [label, lines] of cases) {
      const twice = await runStructured(() => ({ lines }));
      assert.equal(twice.result.structured, null, label);
      assert.ok((twice.result.structuredErrors ?? []).length > 0, `${label}: errors say why`);
      assert.equal(twice.seen.length, 2, `${label}: exactly one retry`);
      assert.equal(twice.charged, 2, `${label}: the retry is charged`);
      assert.equal(twice.result.attempts, 2);
      assert.match(twice.seen[1]?.stdin ?? "", /did not return a valid result through StructuredOutput/, `${label}: the retry is told why`);
    }
    const recovered = await runStructured((attempt) => ({ lines: attempt === 1 ? [...call("a", { output: { verdict: "pass" } }, false), final] : [...call("b", { output: valid }, false), final] }));
    assert.deepEqual(recovered.result.structured, valid);
    assert.match(recovered.seen[1]?.stdin ?? "", /missing required property "score"/);
    assert.equal(recovered.charged, 2);
    ok("an invalid, failed, unfinished or missing StructuredOutput call is not accepted: one charged retry with the reasons, then null");
  }

  // 6. A failed child is not retried for structure; no tool allowlist means no --tools edit.
  {
    const failed = await runStructured(() => ({ lines: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error", errorMessage: "provider down" } }], code: 1 }));
    assert.equal(failed.result.structured, null);
    assert.ok(failed.seen.length >= 1);
    assert.ok(failed.seen.every((s) => !/did not return a valid result/.test(s.stdin)), "a failed child gets no structured retry");
    const open = await runStructured(() => ({ lines: [...call("a", { output: valid }, false), final] }), { tools: [] });
    assert.deepEqual(open.result.structured, valid);
    assert.equal(open.seen[0]?.args.includes("--tools"), false);
    // A run without a schema never passes an inherited schema file on (a structured child's own children).
    const inherited = path.join(ws, "inherited.json");
    fs.writeFileSync(inherited, JSON.stringify(schema));
    const restoreInherited = setEnv("PI_KIT_STRUCTURED_OUTPUT_SCHEMA", inherited);
    try {
      await delegation.newTurn();
      let childEnv: Record<string, string | undefined> | undefined;
      let childArgs: string[] = [];
      const plain = await runner.runAgent({
        defaultCwd: ws, agents, agentName: "scout", task: "t",
        spawnChild: (_cmd, args, spawnOpts) => {
          childEnv = spawnOpts.env;
          childArgs = args;
          const child: FakeChild = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: (): boolean => true });
          child.stdin.on("end", () => { child.stdout.write(`${JSON.stringify(final)}\n`); child.emit("close", 0); });
          child.stdin.resume();
          return child;
        },
      });
      assert.equal(plain.structured, undefined, "a run without a schema has no structured field");
      assert.ok(childEnv && !("PI_KIT_STRUCTURED_OUTPUT_SCHEMA" in childEnv), "the inherited schema variable is removed");
      assert.ok(!childArgs.some((a) => a.includes("structured-output")), "the extension is not loaded without a schema");
    } finally {
      restoreInherited();
    }
    ok("a failed child is not retried for its structured result and still ends with null; without a tool list --tools is not added; a run without a schema drops an inherited schema variable");
  }

  console.log(`\nworkflow-structured-smoke: ${checks} checks passed`);
} finally {
  for (const restore of restores.reverse()) restore();
  rmWorkspace(ws);
}
