// Lint configuration: type-aware typescript-eslint over the TypeScript the repository has
// migrated. See internal/docs/typescript-quality-plan.md for the standard and the roll-out.
//
// ESLint loads this file through Node's own type stripping, which is why `npm run test:lint`
// passes `--flag unstable_native_nodejs_ts_config` (no jiti dependency needed).
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

/** Source the lint gate covers. It grows stage by stage until it is every source file. */
const LINTED = [
  "eslint.config.ts",
  "packages/extensions/src/**/*.ts",
  "packages/extensions/third_party/**/*.ts",
  "packages/core/**/*.ts",
  "packages/autonomy/**/*.ts",
  "packages/web-ui/server/**/*.ts",
  "packages/web-ui/*.ts",
  "packages/web-ui/scripts/*.ts",
  "packages/web-ui/src/**/*.ts",
  "packages/container/mcp-servers/**/*.ts",
  "packages/role-runner/**/*.ts",
  "tests/**/*.ts",
  "internal/public-release/**/*.ts",
];

/**
 * Security bans that apply to every linted file. Each is something a reviewer would reject on
 * sight; enforcing them here means they are not left to memory.
 */
const SECURITY_SYNTAX = [
  {
    selector: "Property[key.name='shell'][value.value=true]",
    message: "Do not spawn through a shell: pass an argument array to spawn/execFile instead.",
  },
  {
    selector: "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
    message: "Build DOM with text nodes; HTML string sinks are banned.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/][callee.object.name=/^(document|el|element|node)$/]",
    message: "Build DOM with text nodes; HTML string sinks are banned.",
  },
];

/**
 * Untrusted data is `unknown` (CONTRIBUTING.md, "TypeScript standard"): the result of JSON.parse
 * or of an awaited `.json()` is never asserted to a shape. Annotate it `unknown` and check it
 * (packages/core/lib/guard.ts, or isRecord/typeof inside an extension). Only `as unknown` and a
 * JSON.stringify round trip of the program's own value pass. This catches the direct form only;
 * a cast of a value first bound to a variable is left to review. Tests are not covered.
 */
const UNTRUSTED_CASTS = [
  {
    selector: "TSAsExpression[expression.type='CallExpression'][expression.callee.object.name='JSON'][expression.callee.property.name='parse']:not([typeAnnotation.type='TSUnknownKeyword']):not([expression.arguments.0.callee.object.name='JSON'][expression.arguments.0.callee.property.name='stringify'])",
    message: "Do not cast JSON.parse output: bind it as unknown and check it (packages/core/lib/guard.ts or isRecord/typeof).",
  },
  {
    selector: "TSAsExpression[expression.type='AwaitExpression'][expression.argument.callee.property.name='json']:not([typeAnnotation.type='TSUnknownKeyword'])",
    message: "Do not cast a .json() body: bind it as unknown and check it with a schema (packages/core/lib/guard.ts).",
  },
];

const SECURITY_IMPORTS = {
  paths: [
    { name: "node:child_process", importNames: ["exec", "execSync"], message: "Use spawn/execFile with an argument array; exec runs a shell." },
    { name: "child_process", message: "Import node:child_process (and never exec/execSync)." },
    { name: "node:vm", message: "vm is not a security boundary; do not run untrusted code with it." },
  ],
};

export default defineConfig(
  globalIgnores(["**/node_modules/", "site/", "dist/", "**/dist/", "public-build/", "packages/extensions/src/_template/", "packages/autonomy/examples/",
    // Browser JavaScript generated from packages/web-ui/src by build:web (ADR 0002): the sources are linted.
    "packages/web-ui/public/js/", "packages/web-ui/mobile/js/", "packages/web-ui/mobile/dev/",
    // Script workflows are async function bodies (top-level return after `export const meta`), which no
    // ESLint source type parses; tests/workflow-builtin-smoke.ts runs each one in the sandbox instead.
    "packages/kit/workflows/*.js"]),
  {
    files: LINTED,
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Assertions: `as` only, never on object literals (use a typed binding or `satisfies`).
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "as", objectLiteralTypeAssertions: "never" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      // Only where `??` and `||` agree (object operands). On strings and numbers `||` also replaces
      // "" and 0, so a mechanical swap would change behaviour.
      "@typescript-eslint/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true, number: true, boolean: true, bigint: true } }],
      // Defensive checks on values from pi, the filesystem and the network are intentional: the
      // static types describe one pi version's happy path, and the kit supports a range of them.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      // pi requires Promise-returning command handlers and tool executors, and `async` is the
      // clearest way to satisfy that. The real promise hazards stay covered by no-floating-promises,
      // no-misused-promises, await-thenable and return-await.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      // Numbers and booleans in template literals are routine and safe; objects and nullish are not.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": ["error", ...SECURITY_SYNTAX],
      "no-restricted-imports": ["error", SECURITY_IMPORTS],
    },
  },
  {
    // The result-schema validator and its byte-identical subagent copy use node:vm only for its
    // timeout: it runs the fixed script "re.test(s)" on an author's pattern, never untrusted code.
    files: ["packages/role-runner/src/schema.ts", "packages/extensions/third_party/subagent/schema.ts"],
    rules: { "no-restricted-imports": ["error", { paths: SECURITY_IMPORTS.paths.filter((p) => p.name !== "node:vm") }] },
  },
  {
    files: LINTED,
    ignores: ["tests/**"],
    rules: { "no-restricted-syntax": ["error", ...SECURITY_SYNTAX, ...UNTRUSTED_CASTS] },
  },
);
