#!/usr/bin/env node
// Literal-only `meta` parser for workflow scripts (packages/extensions/third_party/subagent/wf-meta.ts,
// docs/workflows.md "Script workflows").
//   1. accepted literals: quotes, templates without ${}, escapes, numbers, booleans, null, nesting,
//      comments, trailing commas, quoted keys, `;` or a new line after the literal.
//   2. refused: variables, calls, spreads, computed/shorthand keys, methods, interpolation, holes,
//      duplicate and prototype keys, regexes, an expression continuing after the literal, deep nesting.
//   3. the shape: name (pattern) and description required; whenToUse, phases[].title/detail/model checked.
//   4. the meta in the sandbox's own self-test script parses.
import assert from "node:assert/strict";
import { parseScriptMeta, validateMeta } from "../packages/extensions/third_party/subagent/wf-meta.ts";
import { EVIL_SUITE } from "../packages/extensions/third_party/subagent/wf-sandbox.ts";

let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const good = (src: string) => {
  const r = parseScriptMeta(src);
  assert.equal(r.error, undefined, `should parse: ${src}\n${r.error ?? ""}`);
  assert.ok(r.meta);
  return r.meta;
};
const bad = (src: string, why: RegExp) => {
  const r = parseScriptMeta(src);
  assert.equal(r.meta, undefined, `should be refused: ${src}`);
  assert.match(r.error, why, src);
};

// 1. Accepted literals.
{
  const m = good(`// leading comment
/* block */
export const meta = {
  name: 'find-flaky-tests',
  "description": "Find flaky tests and propose fixes", // one-line
  whenToUse: \`multi
line\`,
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries', },
    { 'title': "Fix", model: "openai/gpt-5", },
  ],
  extra: { n: -1.5e3, h: 0x1F, sep: 1_000, t: true, f: false, z: null, list: [1, [2, [3]]] },
}
phase('Scan')
`);
  assert.deepEqual(m, {
    name: "find-flaky-tests",
    description: "Find flaky tests and propose fixes",
    whenToUse: "multi\nline",
    phases: [
      { title: "Scan", detail: "grep test logs for retries", model: undefined },
      { title: "Fix", detail: undefined, model: "openai/gpt-5" },
    ],
  });
  const esc = good(`export const meta = { name: "x", description: "a\\tb\\n\\u0041\\u{1F600}\\x41\\'\\"\\\\" };`);
  assert.equal(esc.description, "a\tb\nA\u{1F600}A'\"\\");
  good(`${String.fromCharCode(0xfeff)}export const meta = {name:"x",description:"d"};agent("go")`);
  good(`export const meta = {name:"x",description:"d"}\nconst y = 1`);
  good(`export const meta = {name:"x",description:"d"}`);
  ok("pure literals parse: quotes, templates, escapes, numbers, comments, trailing commas, quoted keys");
}

// 2. Refused.
{
  const head = (body: string) => `export const meta = { name: "x", description: "d", ${body} }`;
  bad(head("v: someVar"), /not a literal/);
  bad(head("v: f()"), /not a literal/);
  bad(head("v: process.env.HOME"), /not a literal/);
  bad(head("...other"), /spread/);
  bad(head("v: [...xs]"), /spread/);
  bad(head("[k]: 1"), /computed/);
  bad(`export const meta = { name, description: "d" }`, /key: value/);
  bad(head("m() { return 1 }"), /key: value/);
  bad(head("get g() { return 1 }"), /key: value/);
  bad(head("v: `a ${'${'}b}`"), /interpolation/);
  bad(head("v: [1,,2]"), /holes/);
  bad(`export const meta = { name: "x", name: "y", description: "d" }`, /duplicate/);
  bad(head("__proto__: {}"), /not allowed/);
  bad(head('"constructor": 1'), /not allowed/);
  bad(head("v: /re/"), /pure literal/);
  bad(head("v: 1 + 2"), /expected/);
  bad(head("v: 012"), /octal/);
  bad(head("v: '\\1'"), /octal/);
  bad(head("v: 'open"), /unterminated/);
  bad(head("v: 1e999"), /bad number/);
  bad(head("v: 12abc"), /bad number/);
  bad(`export const meta = {name:"x",description:"d"}.name`, /must end/);
  bad(`export const meta = {name:"x",description:"d"} || evil()`, /must end/);
  bad(`export const meta = {name:"x",description:"d"}\n(evil)()`, /must end/);
  bad(`export const meta = {name:"x",description:"d"}\n[0]`, /must end/);
  bad(`export const meta = {name:"x",description:"d"}, other = 1`, /must end/);
  bad(`export const meta = {name:"x",description:"d"} in obj`, /must end/);
  bad(`export const meta = ${"[".repeat(40)}${"]".repeat(40)}`, /too deeply/);
  bad(head(`v: "${"a".repeat(5000)}"`), /longer than/);
  bad(`const x = 1\nexport const meta = {name:"x",description:"d"}`, /must begin/);
  bad(`export let meta = {name:"x",description:"d"}`, /must begin/);
  bad(`agent("go")`, /must begin/);
  bad(`export const meta = {name:"x",description:"d"`, /expected|end of meta/);
  bad(`export const meta = /* open`, /unterminated comment/);
  ok("variables, calls, spreads, computed/shorthand keys, methods, interpolation and trailing expressions are refused");
}

// 3. Shape.
{
  bad(`export const meta = { description: "d" }`, /meta\.name is required/);
  bad(`export const meta = { name: "x" }`, /meta\.description is required/);
  bad(`export const meta = { name: "x", description: "  " }`, /must not be empty/);
  bad(`export const meta = { name: "Bad Name", description: "d" }`, /must match/);
  bad(`export const meta = { name: 1, description: "d" }`, /must be a string/);
  bad(`export const meta = { name: "x", description: "d", whenToUse: 3 }`, /whenToUse must be a string/);
  bad(`export const meta = { name: "x", description: "d", phases: {} }`, /phases must be an array/);
  bad(`export const meta = { name: "x", description: "d", phases: ["Scan"] }`, /phases\[0\] must be an object/);
  bad(`export const meta = { name: "x", description: "d", phases: [{ detail: "d" }] }`, /phases\[0\]\.title is required/);
  bad(`export const meta = { name: "x", description: "d", phases: [{ title: "t", model: 5 }] }`, /phases\[0\]\.model must be a string/);
  bad(`export const meta = []`, /must be an object/);
  assert.throws(() => validateMeta("x"), /must be an object/);
  assert.deepEqual(good(`export const meta = { name: "x", description: "d" }`).phases, []);
  ok("name and description are required; whenToUse and phases are type-checked");
}

// 4. The sandbox self-test script's meta.
{
  assert.equal(good(EVIL_SUITE).name, "sandbox-self-test");
  ok("the sandbox self-test script's meta parses");
}

console.log(`workflow-meta-smoke: ${checks} checks passed`);
