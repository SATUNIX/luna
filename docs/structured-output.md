# Structured Output

A subagent run can be given a **result schema**. The child then returns its result through a
`StructuredOutput` tool call instead of free text, and the parent (the host) checks that result
itself before using it.

This is a runner capability: code that calls the subagent extension's `runAgent` passes
`schema`. [Script workflows](script-workflows.md) use it for `agent(..., { schema })`; the
`subagent` tool, `/workflow` and YAML workflows do not expose it.

## What a schema may contain

The schema is checked before any child starts. A schema that fails the check makes `runAgent`
reject with a `StructuredSchemaError` that lists every problem; nothing is launched or charged.

- The root must be an object schema: `"type": "object"`. A union such as `["object", "null"]` is
  refused.
- Every name in `required` must be a key of `properties` at the same level.
- Only these keywords may appear, at any depth: `$schema`, `title`, `description`, `type`,
  `const`, `enum`, `required`, `properties`, `additionalProperties`, `items`, `minItems`,
  `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`. Anything else
  (`oneOf`, `anyOf`, `$ref`, `format`, ...) is refused, because the validator would not check it.
- Values must be well formed: `type` names a JSON type, the length and range keywords are
  finite numbers, `pattern` compiles as a regular expression both with and without the `u` flag
  (pi validates tool arguments with it), and `properties` is an object.
- A schema-valued `additionalProperties` needs `properties` at the same level, because the
  validator applies it only there; `true` and `false` are accepted anywhere.
- The check runs on the schema's JSON form, which is what the child reads from its schema file.
- Nesting deeper than 32 levels and schemas whose JSON is longer than 64 KiB are refused.

## Pattern limits

The host tests every `pattern` against text the child model wrote, in the root pi process, so
patterns are limited:

- At check time, a `pattern` longer than 256 characters is refused, and so is one with a
  backreference (`\1` ... `\9`, `\k<name>`) or with a repeating quantifier (`*`, `+`, `{n,}`, or
  `{n,m}` with m > 1) on a group that contains a quantifier or an alternation at any depth, such
  as `(a+)+`, `(a|b)*` or `(-[a-z]+)*`. The check is syntactic and conservative: it also refuses
  some harmless patterns. Use a character class (`[ab]+`) or an optional group
  (`[a-z]+(-[a-z]+)?`) instead. `?` and `{0,1}` on such a group are allowed.
- At check time, a `pattern` with more than 16 choice points is refused. A choice point is a
  quantifier whose minimum and maximum differ (`?`, `*`, `+`, `{n,}`, `{n,m}` with n < m) or a
  `|`; fixed counts such as `{4}` are not counted. This cap bounds compile time. V8 compiles a
  pattern the first time it is used, the time limit below cannot interrupt that, and compile time
  grows exponentially with a run of optional atoms ahead of literals: `a?` 50 times then `a` 50
  times compiles in about 5 s on node 26. For a long list of fixed alternatives, use `enum`.
- When validating, a string longer than 65536 characters (UTF-16 code units) under a `pattern`
  fails without the pattern being run.
- Matching runs under a `node:vm` time limit of 100 ms per test, and all pattern tests of one
  validation share 1 s. A test that is cut off fails validation ("took too long to test"). This
  is the backstop for patterns the check allows but that are slow to match, such as `a*a*a*$`.
  The limit covers matching only, not compilation, which the check-time caps bound.

The limits on strings and matching time are in the validator (`packages/role-runner/src/schema.ts`
and its copy), so role-runner result schemas get them too; the check-time caps apply to subagent
result schemas. `tests/workflow-structured-smoke.ts` (check 1b) pins each limit, including that
the slow-to-compile `a?` run is refused at check time.

## How a run works

1. The host writes the schema to `result-schema.json` (mode 0600) in the run's temporary
   directory and names it in `PI_KIT_STRUCTURED_OUTPUT_SCHEMA` for the child. The file is
   removed when the attempt ends. A run without a schema removes an inherited
   `PI_KIT_STRUCTURED_OUTPUT_SCHEMA` from its child's environment, so a structured child's own
   children do not get the tool.
2. The child is launched as usual through delegation-guard, with one addition: `-e` loads
   `third_party/subagent/structured-output/index.ts`. When the role has an explicit tool list,
   `StructuredOutput` is added to `--tools`. This happens after the launch has been charged, so
   the extra tool does not change which budget the launch counts against. The role's system
   prompt gains one paragraph telling the child to return its result through the tool.
3. Inside the child the tool exists only when `PI_KIT_INTERNAL_CHILD=1` and the schema file can
   be read and passes the same check. A root session never has it. Its arguments are
   `{"output": <result>}`. The result is wrapped because the tool firewall reads top-level
   fields such as `command` and `path` as actions, and a result field with one of those names
   must stay data.
4. The child checks the arguments as the model wrote them, before pi coerces any types, with a
   copy of the role-runner validator (`third_party/subagent/schema.ts`). A rejected call is an
   error result that lists the problems, so the model can call again. An accepted call ends the
   child's turn.
5. The host does not trust the child's answer. From the child's JSON event stream it takes the
   arguments of `tool_execution_start` for `StructuredOutput` and keeps them only when the
   matching `tool_execution_end` reports `isError: false`. It validates the last such call
   again with its own copy of the validator, and only a value that passes becomes
   `result.structured`.
6. If the child finished normally but no call passed, the host launches it **once more**. The
   retry is charged against the effort budget like any launch, and its task says what was wrong.
   If the retry also fails, `result.structured` is `null` and `result.structuredErrors` says why.
   A child that failed (error exit, timeout, stream cap, abort, stop or a refused launch) is not
   retried for its result. Its `structured` is `null` too.

The tool firewall allows `StructuredOutput` (`risk_class: "verdict"`) in both policy copies,
`packages/extensions/src/tool-firewall/default-policy.json` and
`packages/core/policies/default.json`.

## Tests

- `tests/workflow-structured-smoke.ts` (`npm run smoke:workflow-structured`) covers the schema
  checks, the pattern limits, that the validator copy is byte-identical to `packages/role-runner/src/schema.ts`,
  when the child-only tool registers, the raw and executed argument checks, the host's own
  validation, the single charged retry, and `null` after it.
- `tests/tool-firewall-smoke.ts` checks that `StructuredOutput` is allowed headlessly and that a
  result with `command` and `path` fields is not read as a command or a credential read.
