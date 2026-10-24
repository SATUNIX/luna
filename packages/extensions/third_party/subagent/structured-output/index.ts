/**
 * Subagent — the child-only `StructuredOutput` tool.
 *
 * The host (runner.ts) loads this file into a child with `-e` only when the caller asked for a
 * result schema, and points PI_KIT_STRUCTURED_OUTPUT_SCHEMA at a 0600 copy of that schema. Outside
 * such a child (no PI_KIT_INTERNAL_CHILD=1, or no schema file) it registers nothing, so a root
 * session never has the tool.
 *
 * The child checks the arguments as the model wrote them (before pi coerces types) with the copied
 * validator, so the model sees the problems and can call again. The host does not rely on this
 * answer: it reads the same arguments from the child's event stream and validates them itself.
 */
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OUTPUT_FIELD, SCHEMA_ENV, STRUCTURED_TOOL, checkSchema, readStructured } from "./check.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadSchema(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  if (env.PI_KIT_INTERNAL_CHILD !== "1") return null;
  const file = env[SCHEMA_ENV];
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (checkSchema(parsed).length > 0) return null;
  return isRecord(parsed) ? parsed : null;
}

function problems(errors: string[]): string {
  const shown = errors.slice(0, 20).join("\n");
  return `${STRUCTURED_TOOL} rejected the result:\n${shown}${errors.length > 20 ? `\n(${errors.length - 20} more)` : ""}\nFix these and call ${STRUCTURED_TOOL} again with {"${OUTPUT_FIELD}": <the result>}.`;
}

export default function (pi: ExtensionAPI) {
  const schema = loadSchema(process.env);
  if (!schema) return;
  pi.registerTool({
    name: STRUCTURED_TOOL,
    label: "Structured output",
    description: `Return your final result. Call this exactly once, when the work is done, with {"${OUTPUT_FIELD}": <result>} where <result> matches the schema of the "${OUTPUT_FIELD}" parameter. A rejected call lists what to fix.`,
    promptSnippet: `Return the final result as {"${OUTPUT_FIELD}": ...} matching the given schema`,
    parameters: { type: "object", properties: { [OUTPUT_FIELD]: schema }, required: [OUTPUT_FIELD], additionalProperties: false },
    // The raw arguments, before pi's own coercion: these are what the host validates too.
    prepareArguments(args) {
      const read = readStructured(schema, args);
      if (!read.ok) throw new Error(problems(read.errors));
      return { [OUTPUT_FIELD]: read.value };
    },
    async execute(_id, params) {
      const read = readStructured(schema, params);
      if (!read.ok) return { content: [{ type: "text" as const, text: problems(read.errors) }], details: undefined, isError: true };
      return { content: [{ type: "text" as const, text: "Result accepted. Stop now." }], details: undefined, terminate: true };
    },
  });
}
