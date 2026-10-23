/**
 * The slash commands pi itself registers.
 *
 * pi does not export `BUILTIN_SLASH_COMMANDS` from its package root; the array lives in
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js`. The command
 * contract (`command-contract.ts`) needs the names to reject an extension command that would be
 * skipped for shadowing a built-in, so this module keeps a copy keyed to the pi version the
 * repository pins in `devDependencies`.
 *
 * `tests/command-contract-smoke.ts` re-reads the installed dist on every run and fails when the
 * names no longer match, which is the deliberate signal to update this copy after a pi upgrade.
 */

/** The pi version this list was copied from (`devDependencies` in the root package.json). */
export const PI_BUILTIN_TESTED_VERSION = "1.3.0";

/**
 * The 24 names in `BUILTIN_SLASH_COMMANDS` (dist/core/slash-commands.js), in pi's order.
 * Descriptions and argument hints are deliberately not copied: the contract only needs names.
 */
export const PI_BUILTIN_SLASH_COMMANDS: readonly string[] = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];

/**
 * Commands pi's always-loaded built-in extensions register, which are also built-in for the
 * shadowing rule: `/mcp` (dist/extensions/mcp/index.js) and `/llama` (dist/extensions/llama).
 */
export const PI_BUILTIN_EXTENSION_COMMANDS: readonly string[] = ["mcp", "llama"];

/** Every built-in command name, for the shadowing check. */
export function piBuiltinCommandNames(): string[] {
  return [...PI_BUILTIN_SLASH_COMMANDS, ...PI_BUILTIN_EXTENSION_COMMANDS];
}
