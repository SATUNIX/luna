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
  "internal/scripts/**/*.ts",
];

/** A no-restricted-syntax setting at error level (typed, so a spread list still type-checks as a rule entry). */
function restrictedSyntax(selectors: ReadonlyArray<{ selector: string; message: string }>): ["error", ...Array<{ selector: string; message: string }>] {
  return ["error", ...selectors];
}

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
  {
    // docs/security-standard.md, "Cryptography": no algorithm with a known serious weakness, even
    // for a cache key or a file name, so no security decision can come to depend on one.
    selector: "CallExpression[callee.property.name=/^(createHash|createHmac)$/][arguments.0.value=/^(md4|md5|sha1|sha-1|ripemd160|rmd160)$/i]",
    message: "Weak hash algorithm: use sha256 (or sha512) instead of MD5, SHA-1 or RIPEMD-160.",
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

/**
 * Workspace writes go through the safe-write helper (docs/security.md, "Workspace file writes";
 * packages/core/shared/safe-fs.ts and its generated copies). A cloned repository may commit a
 * symlink anywhere under the workspace, and these APIs follow it. Applies to the extensions, which
 * run inside the operator's workspace; RAW_WRITE_ALLOWED lists the reviewed exceptions.
 */
const RAW_WRITES = [
  {
    selector: "CallExpression[callee.property.name=/^(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)$/]",
    message: "Write workspace state with writeFileSafe/appendFileSafe from ./shared/safe-fs.ts (no symlink followed), or add this file to RAW_WRITE_ALLOWED in eslint.config.ts with the reason its target is not repository content.",
  },
  {
    selector: "CallExpression[callee.name=/^(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)$/]",
    message: "Write workspace state with writeFileSafe/appendFileSafe from ./shared/safe-fs.ts (no symlink followed), or add this file to RAW_WRITE_ALLOWED in eslint.config.ts with the reason its target is not repository content.",
  },
  {
    selector: "CallExpression[callee.property.name='openSync'][arguments.1.type='Literal'][arguments.1.value=/^[wa]/]",
    message: "Open a file for writing with openFileExclusive/appendFileSafe from ./shared/safe-fs.ts, or add this file to RAW_WRITE_ALLOWED in eslint.config.ts with the reason.",
  },
];

/**
 * A regular expression compiled from text the program did not write (a skill trigger, a schema
 * pattern, a config value) can backtrack for seconds. Compile such text with compileCheckedRegex
 * (packages/core/shared/safe-regex.ts), or list the file in DYNAMIC_REGEXP_ALLOWED with the reason
 * its pattern is trusted or escaped. Applies everywhere except tests.
 */
const DYNAMIC_REGEXP = [
  {
    selector: "NewExpression[callee.name='RegExp'][arguments.0.type!='Literal']",
    message: "Do not compile a non-literal RegExp: use compileCheckedRegex (packages/core/shared/safe-regex.ts) or add this file to DYNAMIC_REGEXP_ALLOWED in eslint.config.ts with the reason the pattern is trusted.",
  },
  {
    selector: "CallExpression[callee.name='RegExp'][arguments.0.type!='Literal']",
    message: "Do not compile a non-literal RegExp: use compileCheckedRegex (packages/core/shared/safe-regex.ts) or add this file to DYNAMIC_REGEXP_ALLOWED in eslint.config.ts with the reason the pattern is trusted.",
  },
];

/**
 * Reviewed exceptions to RAW_WRITES: extension files whose raw writes do not land in repository
 * content. Each entry says why. A new entry is a reviewed change (CODEOWNERS covers this file).
 */
const RAW_WRITE_ALLOWED: Readonly<Record<string, string>> = {
  "packages/extensions/**/shared/safe-fs.ts": "the safe-write helper itself (generated copies of packages/core/shared/safe-fs.ts)",
  "packages/extensions/src/effort/index.ts": "the effort config in the agent directory, not the workspace",
  "packages/extensions/src/effort/ledger.ts": "the effort ledger, lock and breaker in the agent directory",
  "packages/extensions/src/effort/memento.ts": "the Memento opt-in file in the agent directory",
  "packages/extensions/src/kit-update/index.ts": "kit-update state in the agent directory",
  "packages/extensions/src/memory-local/index.ts": "memories.json under PI_KIT_MEMORY_DIR or the agent directory (workspace contributions use writeFileSafe)",
  "packages/extensions/src/memory-vault/vault.ts": "the operator's memory vault (PI_KIT_VAULT or ~/.pi/vault), outside any workspace",
  "packages/extensions/src/remote-control/host.ts": "the remote-control host log in the agent state directory",
  "packages/extensions/src/session-helpers/index.ts": "global pi and kit settings in the agent directory",
  "packages/extensions/src/session-helpers/profile-switch.ts": "profile snapshots and backups of agent-directory settings (restore temp files are created 0600 with O_EXCL)",
  "packages/extensions/src/tool-capture/store.ts": "the capture store under PI_KIT_CAPTURE_DIR or the agent directory, a credential-class path the firewall protects",
  "packages/extensions/src/tool-firewall/approvals.ts": "firewall approvals, lock and breaker in the agent directory",
  "packages/extensions/src/tool-firewall/config.ts": "the firewall config in the agent directory",
  "packages/extensions/src/tool-firewall/feedback.ts": "the firewall feedback log in the agent directory",
  "packages/extensions/src/tool-firewall/profile.ts": "judgements and the background profile in the agent directory",
  "packages/extensions/src/tool-firewall/security-level.ts": "the security-level file in the agent directory",
  "packages/extensions/src/tool-firewall/trajectory.ts": "per-session trajectory state in the agent directory",
  "packages/extensions/src/web-console/index.ts": "web-console token, pid and log files in the web-ui runtime directory under the agent directory",
  "packages/extensions/third_party/custom-footer/index.ts": "footer settings in the agent directory",
  "packages/extensions/third_party/handoff/index.ts": "HANDOFF.md in the workspace root, opened O_CREAT|O_EXCL or O_NOFOLLOW and fstat-checked before the write (writes through the descriptor)",
  "packages/extensions/third_party/subagent/wf-panel.ts": "saved workflow copies: prepareTarget lstat-checks the target inside the workspace and the write is exclusive (wx)",
  "packages/extensions/third_party/subagent/workflow-tools.ts": "the trusted-workflows digest file in the agent directory",
  "packages/extensions/third_party/trigger-compact/index.ts": "trigger-compact settings in the agent directory",
  "packages/extensions/src/human-console/console-auth.ts": "the console answer key in the agent directory: created exclusive (wx, 0600) in a 0700 directory and linked into place; a linked, foreign or open key path is refused when loaded",
  "packages/extensions/src/pentest-governance-domain/console-auth.ts": "byte-identical copy of the console answer-key module (see human-console/console-auth.ts)",
  "packages/extensions/src/tool-firewall/console-auth.ts": "byte-identical copy of the console answer-key module (see human-console/console-auth.ts)",
  // Known gap: the human-console request directory defaults to <workspace>/.pi/human-console and is
  // still written with raw APIs; it is still to move to the safe-write helper. Answers are signed
  // (console-auth.ts), so a planted answer file cannot approve, but a committed link can still
  // redirect where a request is written (docs/security.md, "Workspace file writes", Not covered).
  "packages/extensions/src/human-console/index.ts": "KNOWN GAP: human-console request, resolution and audit files (see the note above)",
  "packages/extensions/src/tool-firewall/index.ts": "KNOWN GAP: the human-console approval request it files (see the note above); the audit log and /auto state use the helper",
  "packages/extensions/src/pentest-governance-domain/index.ts": "KNOWN GAP: the human-console approval request it files (see the note above); the evidence ledger uses the helper",
};

/**
 * Reviewed exceptions to DYNAMIC_REGEXP: the pattern is escaped, built from constants, or comes
 * from an operator-controlled file rather than from a repository or a model.
 */
const DYNAMIC_REGEXP_ALLOWED: Readonly<Record<string, string>> = {
  "packages/core/shared/safe-regex.ts": "the vetted helper: compileCheckedRegex compiles only what patternProblem accepts",
  "packages/extensions/**/shared/safe-regex.ts": "generated copies of the vetted helper",
  "packages/autonomy/lib/glob.ts": "glob from the run contract, escaped character by character",
  "internal/scripts/gitlab-audit.ts": "the forbidden-variable pattern from the committed internal/scripts/gitlab-policy.json, a code-owned control file",
  "packages/core/check-mermaid.ts": "a fence of backticks or tildes read from repository docs, built from constants",
  "packages/core/eval/fixtures.ts": "eval fixture keys are constants",
  "packages/core/lib/guard.ts": "re-compiles a RegExp object the program wrote, without g/y",
  "packages/core/lib/profiles.ts": "frontmatter keys are constants",
  "packages/core/pack-check.ts": "package globs from package.json, escaped",
  "packages/core/release.ts": "the version string, escaped with escapeRegExp",
  "packages/core/verify.ts": "frontmatter keys are constants",
  "packages/extensions/src/autonomy-run/index.ts": "a digest already checked to be 64 hex characters",
  "packages/extensions/src/effort/policy.ts": "prompt markers are constants, escaped",
  "packages/extensions/src/kit-update/index.ts": "a branch name, escaped",
  "packages/extensions/src/pentest-governance-domain/index.ts": "YAML keys are constants",
  "packages/extensions/src/secret-guard/index.ts": "operator protected-path globs, escaped; and re-compiles the guard's own patterns",
  "packages/extensions/src/skill-router/match.ts": "phrase triggers are escaped; re: triggers go through compileCheckedRegex and a time limit",
  "packages/extensions/src/tool-firewall/classify.ts": "tool-name globs from the operator's firewall policy, escaped",
  "packages/extensions/src/tool-firewall/config.ts": "path globs from the operator's firewall config, escaped",
  "packages/extensions/src/tool-firewall/index.ts": "rule patterns from the firewall policy, an operator-controlled security_control file",
  "packages/extensions/src/tool-firewall/shell.ts": "a shell function name already matched as an identifier",
  "packages/extensions/src/tool-firewall/unattended.ts": "a git remote name, escaped",
  "packages/extensions/third_party/custom-footer/width.ts": "ANSI escape constants",
  "packages/extensions/third_party/protected-paths/index.ts": "git working-tree subcommand names, a constant alternation",
  "packages/extensions/third_party/subagent/redact.ts": "re-compiles the redaction table's own patterns with g",
  "packages/extensions/third_party/subagent/schema.ts": "result-schema patterns already accepted by patternProblem at launch, tested under a vm time limit",
  "packages/extensions/third_party/subagent/structured-output/check.ts": "compile check before patternProblem, never tested against text",
  "packages/role-runner/src/schema.ts": "byte-identical copy of the subagent schema validator (see above)",
  "packages/web-ui/src/public/js/markdown.ts": "markdown token patterns built from constants",
};

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
    // skill-router uses it the same way for project skills' `re:` triggers.
    files: ["packages/role-runner/src/schema.ts", "packages/extensions/third_party/subagent/schema.ts", "packages/extensions/src/skill-router/match.ts"],
    rules: { "no-restricted-imports": ["error", { paths: SECURITY_IMPORTS.paths.filter((p) => p.name !== "node:vm") }] },
  },
  {
    files: LINTED,
    ignores: ["tests/**"],
    rules: { "no-restricted-syntax": ["error", ...SECURITY_SYNTAX, ...UNTRUSTED_CASTS, ...DYNAMIC_REGEXP] },
  },
  {
    files: ["packages/extensions/src/**/*.ts", "packages/extensions/third_party/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...SECURITY_SYNTAX, ...UNTRUSTED_CASTS, ...DYNAMIC_REGEXP, ...RAW_WRITES] },
  },
  // One block per allowlisted file, with exactly the bans that still apply to it.
  ...[...new Set([...Object.keys(RAW_WRITE_ALLOWED), ...Object.keys(DYNAMIC_REGEXP_ALLOWED)])].map((file) => ({
    files: [file],
    rules: {
      "no-restricted-syntax": restrictedSyntax([
        ...SECURITY_SYNTAX,
        ...UNTRUSTED_CASTS,
        ...(Object.hasOwn(DYNAMIC_REGEXP_ALLOWED, file) ? [] : DYNAMIC_REGEXP),
        ...(file.startsWith("packages/extensions/") && !Object.hasOwn(RAW_WRITE_ALLOWED, file) ? RAW_WRITES : []),
      ]),
    },
  })),
);
