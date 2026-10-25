/**
 * Subagent — structured output contract, shared by the host (runner.ts) and the child extension
 * (./index.ts), which are the same extension's two sides.
 *
 * A result schema is checked before any child is launched (`checkSchema`): the root must be an
 * object schema, every `required` name must be one of its `properties`, and only the keywords the
 * copied validator (../schema.ts) understands may appear anywhere. A schema that fails here is the
 * caller's error; the launch never happens.
 *
 * The host tests each "pattern" against text the child model wrote, in the root pi process, so a
 * pattern that can backtrack exponentially, or whose compilation is slow, is refused here (see
 * patternProblem); ../schema.ts adds a subject-length cap and a time limit on matching. That time
 * limit does not cover compilation: V8 compiles a pattern on its first use, and that cannot be
 * interrupted, so the compile cost is bounded only by the caps checked here.
 */
import { validateSchema } from "../schema.ts";
import { MAX_PATTERN_CHOICES, MAX_PATTERN_LENGTH, patternProblem } from "../shared/safe-regex.ts";

/** The child-only tool that carries a structured result. */
export const STRUCTURED_TOOL = "StructuredOutput";
/** Environment variable naming the schema file a child loads (set by the host, read by the child). */
export const SCHEMA_ENV = "PI_KIT_STRUCTURED_OUTPUT_SCHEMA";
/**
 * The tool's arguments wrap the result in this one field. The firewall reads `command`, `path`
 * and similar top-level fields of a tool call as actions, so a result that happens to have such a
 * field must not sit at the top level, where it would be classified as a shell command or a read.
 */
export const OUTPUT_FIELD = "output";

/** The keywords ../schema.ts validates; anything else is refused before launch. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
]);

const TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_DEPTH = 32;
const MAX_SCHEMA_BYTES = 64 * 1024;
// The pattern check is shared with skill-router (packages/core/shared/safe-regex.ts).
export { MAX_PATTERN_CHOICES, MAX_PATTERN_LENGTH, patternProblem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkNode(node: unknown, path: string, depth: number, errors: string[]): void {
  if (node === true || node === false) return;
  if (!isRecord(node)) {
    errors.push(`${path}: a schema must be an object or a boolean`);
    return;
  }
  if (depth > MAX_DEPTH) {
    errors.push(`${path}: nested deeper than ${MAX_DEPTH} levels`);
    return;
  }
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) errors.push(`${path}: unsupported keyword "${keyword}"`);
  }
  if ("type" in node) {
    const types: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
    if (types.length === 0 || !types.every((t) => typeof t === "string" && TYPES.has(t))) errors.push(`${path}: "type" must be one of ${[...TYPES].join(", ")} or a list of them`);
  }
  if ("enum" in node && !Array.isArray(node.enum)) errors.push(`${path}: "enum" must be a list`);
  for (const key of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]) {
    if (key in node && !Number.isFinite(node[key])) errors.push(`${path}: "${key}" must be a finite number`);
  }
  if ("pattern" in node) {
    if (typeof node.pattern !== "string") errors.push(`${path}: "pattern" must be a string`);
    else {
      // pi validates tool arguments with the "u" flag and the copied validator without it; the
      // pattern must compile both ways or every call (or the host's re-check) would fail.
      let compiles = true;
      try {
        new RegExp(node.pattern);
        new RegExp(node.pattern, "u");
      } catch {
        compiles = false;
        errors.push(`${path}: "pattern" is not a valid regular expression`);
      }
      const problem = compiles ? patternProblem(node.pattern) : null;
      if (problem) errors.push(`${path}: "pattern" is refused: ${problem}`);
    }
  }
  let names: string[] = [];
  if ("properties" in node) {
    const properties = node.properties;
    if (!isRecord(properties)) errors.push(`${path}: "properties" must be an object`);
    else {
      names = Object.keys(properties);
      for (const name of names) checkNode(properties[name], `${path}/properties/${name}`, depth + 1, errors);
    }
  }
  if ("required" in node) {
    const required = node.required;
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) errors.push(`${path}: "required" must be a list of property names`);
    else {
      for (const name of required) if (!names.includes(name)) errors.push(`${path}: required property "${name}" is not in "properties"`);
    }
  }
  // The copied validator applies a schema-valued additionalProperties only next to "properties";
  // without it the value would go unchecked, so it is refused.
  if ("additionalProperties" in node && typeof node.additionalProperties !== "boolean" && !("properties" in node)) {
    errors.push(`${path}: a schema-valued "additionalProperties" needs "properties" next to it`);
  }
  if ("additionalProperties" in node) checkNode(node.additionalProperties, `${path}/additionalProperties`, depth + 1, errors);
  if ("items" in node) checkNode(node.items, `${path}/items`, depth + 1, errors);
}

/** Problems with a result schema, or [] when it can be used. */
export function checkSchema(input: unknown): string[] {
  if (!isRecord(input)) return ["$: the schema must be a JSON object"];
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return ["$: the schema must be plain JSON"];
  }
  if (text.length > MAX_SCHEMA_BYTES) return [`$: the schema is larger than ${MAX_SCHEMA_BYTES} bytes`];
  // Check exactly what the child will read from the schema file, not the in-process value.
  const schema: unknown = JSON.parse(text);
  if (!isRecord(schema)) return ["$: the schema must be a JSON object"];
  const errors: string[] = [];
  if (schema.type !== "object") errors.push('$: the root must have "type": "object"');
  checkNode(schema, "$", 0, errors);
  return errors;
}

/** An Error for a schema that failed checkSchema: the launch is refused and the caller sees why. */
export class StructuredSchemaError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid result schema: ${problems.join("; ")}`);
    this.name = "StructuredSchemaError";
    this.problems = problems;
  }
}

/**
 * The value inside a StructuredOutput call's arguments, checked against the schema with the copied
 * validator. `args` is whatever the child's event stream carried; nothing about it is assumed.
 */
export function readStructured(schema: unknown, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (!isRecord(args) || !Object.hasOwn(args, OUTPUT_FIELD)) return { ok: false, errors: [`$: the call has no "${OUTPUT_FIELD}" field`] };
  const extra = Object.keys(args).filter((k) => k !== OUTPUT_FIELD);
  if (extra.length > 0) return { ok: false, errors: [`$: unexpected field${extra.length === 1 ? "" : "s"} ${extra.map((k) => `"${k}"`).join(", ")} next to "${OUTPUT_FIELD}"`] };
  const value = args[OUTPUT_FIELD];
  const errors = validateSchema(schema, value).map((e) => e.replace(/^\$/, `$/${OUTPUT_FIELD}`));
  if (errors.length > 0) return { ok: false, errors };
  if (!isRecord(value)) return { ok: false, errors: [`$/${OUTPUT_FIELD}: must be an object`] };
  return { ok: true, value };
}
