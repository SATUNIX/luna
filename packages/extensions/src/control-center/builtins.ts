/**
 * pi's own command names, for the All commands page.
 *
 * `pi.getCommands()` returns extension, prompt and skill commands but not built-ins, and
 * `BUILTIN_SLASH_COMMANDS` is not exported from the package root. This copy is keyed to the pi
 * version the kit pins; `tests/control-center-smoke.ts` checks it against
 * `packages/core/lib/pi-builtins.ts`, which is itself checked against the installed pi dist.
 *
 * Self-containment rule: this is plain data, no imports.
 */

/** The 24 names in pi's `BUILTIN_SLASH_COMMANDS`. */
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

/** Commands pi's always-loaded built-in extensions register. */
export const PI_BUILTIN_EXTENSION_COMMANDS: readonly string[] = ["mcp", "llama"];

/** Every built-in command name. */
export function builtinCommandNames(): string[] {
  return [...PI_BUILTIN_SLASH_COMMANDS, ...PI_BUILTIN_EXTENSION_COMMANDS];
}
