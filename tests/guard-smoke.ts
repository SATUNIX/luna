// Smoke test: packages/core/lib/guard.ts, the dependency-free runtime validators the toolchain
// uses at every trust boundary. Checks acceptance, rejection with a precise path, prototype-key
// rejection, optional-key handling and that the inferred static types are the intended ones.
import assert from "node:assert/strict";
import {
  array, boolean, literal, matches, nullable, number, object, optional, parseJson, parseJsonAs, record, refine,
  safeParse, string, union, ValidationError, withDefault, type Infer,
} from "../packages/core/lib/guard.ts";

function rejects(run: () => unknown, path: string, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ValidationError, `expected ValidationError, got ${String(error)}`);
    assert.equal(error.path, path);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

// --- primitives
assert.equal(string().parse("x"), "x");
rejects(() => string().parse(1), "value", /expected string, got number/);
rejects(() => string({ maxLength: 2 }).parse("abc"), "value", /at most 2/);
const sticky = string({ pattern: /^a+$/g });
assert.equal(sticky.parse("aa"), "aa");
assert.equal(sticky.parse("aa"), "aa", "a /g pattern must not carry lastIndex between calls");
rejects(() => string({ pattern: /^[a-z]+$/ }).parse("A"), "value", /matching/);
assert.equal(number({ integer: true, min: 1 }).parse(3), 3);
rejects(() => number().parse(Number.NaN), "value", /finite number/);
rejects(() => number().parse(Infinity), "value");
rejects(() => number({ integer: true }).parse(1.5), "value", /integer/);
rejects(() => number({ max: 1 }).parse(2), "value", /<= 1/);
assert.equal(boolean().parse(false), false);
rejects(() => boolean().parse("false"), "value");

// --- literal: a closed set, nothing else
const verdict = literal("allow", "ask", "deny");
assert.equal(verdict.parse("ask"), "ask");
rejects(() => verdict.parse("ALLOW"), "value", /one of "allow", "ask", "deny"/);
rejects(() => verdict.parse(undefined), "value");
assert.equal(literal(null, 1).parse(null), null);

// --- object: exact keys out, optional keys absent rather than undefined
const Model = object({
  id: string({ minLength: 1 }),
  context: optional(number({ integer: true, min: 1 })),
  tags: withDefault(array(string()), []),
});
const parsedModel = Model.parse({ id: "m", extra: true });
assert.deepEqual(parsedModel, { id: "m", tags: [] });
assert.ok(!Object.hasOwn(parsedModel, "context"), "an absent optional key stays absent");
assert.ok(!Object.hasOwn(parsedModel, "extra"), "unknown keys are stripped by default");
assert.deepEqual(Model.parse({ id: "m", context: 8 }), { id: "m", context: 8, tags: [] });
rejects(() => Model.parse({ id: "" }), "value.id", /at least 1/);
rejects(() => Model.parse({ id: "m", context: "8" }), "value.context");
rejects(() => Model.parse(null), "value", /expected object, got null/);
rejects(() => Model.parse([]), "value", /got array/);
rejects(() => object({ a: string() }, { unknownKeys: "reject" }).parse({ a: "x", b: 1 }), "value", /unexpected key "b"/);

// --- nested paths name the exact element
const Config = object({ models: array(Model, { maxItems: 3 }) });
rejects(() => Config.parse({ models: [{ id: "a" }, { id: 7 }] }), "value.models[1].id");
rejects(() => Config.parse({ models: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] }), "value.models", /at most 3/);
rejects(() => Config.parse({ models: {} }), "value.models", /expected array of/);

// --- record: input-chosen keys, prototype keys refused, null prototype out
const Env = record(string(), { key: /^[A-Z_][A-Z0-9_]*$/ });
const env = Env.parse({ PI_HOME: "/tmp" });
assert.equal(env.PI_HOME, "/tmp");
assert.equal(Object.getPrototypeOf(env), null);
rejects(() => Env.parse(parseJson('{"__proto__": "x"}')), "value.__proto__", /reserved key/);
rejects(() => Env.parse({ lower: "x" }), "value.lower", /key does not match/);
rejects(() => record(number(), { maxKeys: 1 }).parse({ a: 1, b: 2 }), "value", /at most 1 keys/);
const probe: Record<string, unknown> = {};
assert.equal(probe.polluted, undefined, "nothing reached Object.prototype");

// --- union, nullable, refine
const Id = union(number({ integer: true }), string({ pattern: /^\d+$/ }));
assert.equal(Id.parse(4), 4);
assert.equal(Id.parse("4"), "4");
rejects(() => Id.parse("x"), "value", /integer \| string matching/);
assert.equal(nullable(string()).parse(null), null);
const Port = refine(number({ integer: true }), (n) => n > 0 && n < 65536, "a TCP port");
rejects(() => Port.parse(70000), "value", /a TCP port/);

// --- helpers
assert.equal(matches(verdict, "deny"), true);
assert.equal(matches(verdict, 1), false);
const bad = safeParse(Model, { id: 1 }, "model");
assert.ok(!bad.ok && bad.error.path === "model.id");
rejects(() => parseJsonAs(Model, "{not json", "file"), "file", /invalid JSON/);
assert.deepEqual(parseJsonAs(Model, '{"id":"z"}'), { id: "z", tags: [] });

// --- static types (checked by `npm run test:typecheck`)
type Model = Infer<typeof Model>;
const typed: Model = { id: "x", tags: [] };
const withContext: Model = { id: "x", context: 1, tags: ["a"] };
// An optional key is absent, never an explicit undefined (exactOptionalPropertyTypes), matching
// what parse returns.
// @ts-expect-error -- `context: undefined` is not a Model
const explicitUndefined: Model = { id: "x", context: undefined, tags: [] };
const v: "allow" | "ask" | "deny" = verdict.parse("allow");
assert.equal([typed, withContext, explicitUndefined, v].length, 4);

console.log("guard-smoke: ok");
