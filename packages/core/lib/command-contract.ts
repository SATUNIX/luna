/**
 * The slash-command contract, checked by `npm run verify`.
 *
 * Four failure modes, all of which existed before this check:
 *   1. two extensions register the same command name (pi silently renames one to `name:1`);
 *   2. an extension command has the same name as a prompt template (the command shadows the
 *      template, which then can never run) or as a pi built-in (pi skips the extension command);
 *   3. an extension's `registers.commands` manifest list disagrees with the
 *      `pi.registerCommand(...)` calls in its code, so the manifest lies about what ships.
 *
 * The name set is derived from the manifest (normalised to bare names) and cross-checked against
 * the code, so a drift is reported rather than masked. `piBuiltinCommandNames()` supplies the
 * built-in names this file compares against.
 */
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "./guard.ts";
import { FIRST_PARTY_DIR, THIRD_PARTY_DIR, PROMPTS_DIR } from "./paths.ts";
import { piBuiltinCommandNames } from "./pi-builtins.ts";

/** One extension's command declarations, from its manifest and from its code. */
export interface CommandSource {
  /** `first-party/<name>` or `third-party/<name>`. */
  label: string;
  /** Extension name from `extension.json`. */
  name: string;
  /** `registers.commands` from the manifest, with any leading "/" stripped. */
  manifestCommands: string[];
  /** `pi.registerCommand("<name>", ...)` names found in the extension's `.ts` files. */
  codeCommands: string[];
  /** `{ command, description }` for every command whose declaration carries a description. */
  aliasDescriptions: AliasDeclaration[];
}

/** A command's registered name paired with its description, for alias-target checking. */
export interface AliasDeclaration {
  command: string;
  description: string;
}

/** Everything the pure check needs: no filesystem access. */
export interface CommandContractInput {
  extensions: CommandSource[];
  /** Prompt template names (file basenames under packages/kit/prompts). */
  promptTemplates: string[];
  /** pi's own command names. */
  builtinCommands: string[];
}

export interface CommandContractProblem {
  code: "duplicate-command" | "shadows-prompt" | "shadows-builtin" | "manifest-drift" | "alias-target-missing";
  message: string;
}

/** A command name as written in a manifest or prompt template, with any leading "/" removed. */
export function bareCommandName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** The rule set, over plain data so it can be unit-tested without a checkout. */
export function commandContractProblems(input: CommandContractInput): CommandContractProblem[] {
  const problems: CommandContractProblem[] = [];
  const prompts = new Set(input.promptTemplates);
  const builtins = new Set(input.builtinCommands);

  // 3. Manifest vs code drift, reported per extension.
  for (const ext of input.extensions) {
    const declared = sortedUnique(ext.manifestCommands.map(bareCommandName));
    const registered = sortedUnique(ext.codeCommands.map(bareCommandName));
    const missing = registered.filter((n) => !declared.includes(n));
    const extra = declared.filter((n) => !registered.includes(n));
    if (missing.length || extra.length) {
      const parts: string[] = [];
      if (missing.length) parts.push(`code registers not declared in extension.json: ${missing.join(", ")}`);
      if (extra.length) parts.push(`extension.json declares not registered in code: ${extra.join(", ")}`);
      problems.push({ code: "manifest-drift", message: `${ext.label}: ${parts.join("; ")}` });
    }
  }

  // 1. A command name owned by two extensions.
  const owners = new Map<string, string[]>();
  for (const ext of input.extensions) {
    for (const raw of [...ext.manifestCommands, ...ext.codeCommands]) {
      const name = bareCommandName(raw);
      const list = owners.get(name) ?? [];
      list.push(ext.label);
      owners.set(name, list);
    }
  }
  for (const [name, list] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    const unique = sortedUnique(list);
    if (unique.length > 1) {
      problems.push({ code: "duplicate-command", message: `command "${name}" is registered by ${unique.length} extensions: ${unique.join(", ")}` });
    }
  }

  // 2. A command name equals a prompt template or a pi built-in.
  const commandNames = sortedUnique([...owners.keys()]);
  for (const name of commandNames) {
    if (prompts.has(name)) {
      problems.push({ code: "shadows-prompt", message: `command "${name}" shadows the "${name}" prompt template, which can then never run` });
    }
    if (builtins.has(name)) {
      problems.push({ code: "shadows-builtin", message: `command "${name}" shadows pi's built-in /${name}; pi skips an extension command with a built-in name` });
    }
  }

  // 4. An "Alias of /target" description names a command, prompt template or built-in that exists.
  const knownTargets = new Set<string>([...owners.keys(), ...input.promptTemplates, ...input.builtinCommands]);
  for (const ext of input.extensions) {
    for (const alias of ext.aliasDescriptions) {
      if (!alias.description.startsWith("Alias of /")) continue;
      const match = /^Alias of \/(\S+)/.exec(alias.description);
      const rawTarget = match?.[1];
      if (rawTarget === undefined) continue;
      const target = rawTarget.replace(/[.,]$/, "");
      if (!knownTargets.has(target)) {
        problems.push({
          code: "alias-target-missing",
          message: `${ext.label}: command "${alias.command}" says Alias of /${target}, but no command, prompt template or built-in named ${target} exists`,
        });
      }
    }
  }

  return problems;
}

/** Every `pi.registerCommand("<name>", ...)` in a source text, in order. */
export function registeredCommandsInSource(source: string): string[] {
  const out: string[] = [];
  // Strip comments so a commented-out registration is not read as real. `//` counts as a line
  // comment only at the start of a line or after whitespace, so "https://" inside a string is
  // left alone.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const re = /registerCommand\(\s*["']([^"']+)["']/g;
  let match = re.exec(code);
  while (match) {
    const name = match[1];
    if (name !== undefined) out.push(name);
    match = re.exec(code);
  }
  return out;
}

/** The first `description: "..."` (double-quoted or template literal) in a slice, if any. */
function firstDescriptionInSlice(slice: string): string | undefined {
  const re = /description:\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)')/;
  const match = re.exec(slice);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

/**
 * Every `pi.registerCommand("<name>", { description: "..." })` in a source text, as
 * `{ command, description }`. Comments are stripped first, and the declaration slice stops at the
 * first `handler:` or `getArgumentCompletions:` so a nested `description` inside a handler or a
 * completion item cannot be attributed to the command. A description literal that itself contains
 * `handler:` or `getArgumentCompletions:` would truncate the slice early; registrations use
 * those tokens only as object keys, so this is accepted rather than parsed structurally.
 */
export function aliasDeclarationsInSource(source: string): AliasDeclaration[] {
  const out: AliasDeclaration[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const re = /registerCommand\(\s*["']([^"']+)["']/g;
  let match = re.exec(code);
  while (match) {
    const name = match[1];
    const start = match.index;
    const next = code.indexOf("registerCommand(", start + 1);
    let slice = code.slice(start, next === -1 ? code.length : next);
    const boundary = ["handler:", "getArgumentCompletions:"]
      .map((marker) => slice.indexOf(marker))
      .filter((index) => index >= 0)
      .reduce((a, b) => Math.min(a, b), slice.length);
    slice = slice.slice(0, boundary);
    const description = firstDescriptionInSlice(slice);
    if (name !== undefined && description !== undefined) out.push({ command: name, description });
    match = re.exec(code);
  }
  return out;
}

/** Collect every `.ts` file under an extension directory as paths relative to it. */
function collectTsFiles(extDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), entryRel);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(entryRel);
    }
  };
  walk(extDir, "");
  return out.sort((a, b) => a.localeCompare(b));
}

/** Read every extension manifest and its code, for both avenues. */
export function readCommandSources(): CommandSource[] {
  const out: CommandSource[] = [];
  const avenues = [
    { dir: FIRST_PARTY_DIR, avenue: "first-party" },
    { dir: THIRD_PARTY_DIR, avenue: "third-party" },
  ];
  for (const { dir, avenue } of avenues) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith("_")) continue;
      const extDir = path.join(dir, entry);
      if (!fs.statSync(extDir).isDirectory()) continue;
      const metaPath = path.join(extDir, "extension.json");
      if (!fs.existsSync(metaPath)) continue;
      let meta: unknown;
      try {
        meta = parseJson(fs.readFileSync(metaPath, "utf8"));
      } catch {
        continue; // the schema pass in verify.ts reports the parse error
      }
      if (!isRecord(meta) || typeof meta.name !== "string") continue;
      const registers = isRecord(meta.registers) ? meta.registers : undefined;
      const manifestCommands = Array.isArray(registers?.commands)
        ? registers.commands.filter((c): c is string => typeof c === "string")
        : [];
      const codeCommands: string[] = [];
      const aliasDescriptions: AliasDeclaration[] = [];
      for (const tsFile of collectTsFiles(extDir)) {
        const source = fs.readFileSync(path.join(extDir, tsFile), "utf8");
        codeCommands.push(...registeredCommandsInSource(source));
        aliasDescriptions.push(...aliasDeclarationsInSource(source));
      }
      out.push({ label: `${avenue}/${entry}`, name: meta.name, manifestCommands, codeCommands, aliasDescriptions });
    }
  }
  return out;
}

/** Prompt template names: the `.md` basenames under packages/kit/prompts. */
export function readPromptTemplateNames(dir: string = PROMPTS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((f) => (f.endsWith(".md") ? [f.replace(/\.md$/, "")] : []))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Prompt templates without a one-line `description:` front-matter field. pi falls back to the
 * first line of the body, which is the heading, so an undescribed template shows as "# Code Plan"
 * in the `/` menu. APPEND_SYSTEM.md is a system-prompt addition, not a template.
 */
export function promptDescriptionProblems(dir: string = PROMPTS_DIR): string[] {
  const problems: string[] = [];
  for (const name of readPromptTemplateNames(dir)) {
    if (name === "APPEND_SYSTEM") continue;
    const front = fs.readFileSync(path.join(dir, `${name}.md`), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    if (description === "") problems.push(`prompt template ${name} has no description: front-matter line`);
    else if (description.length > 70) problems.push(`prompt template ${name} has a description over 70 characters`);
  }
  return problems;
}

/** Read the checkout and assemble the pure check's input. */
export function buildCommandContractInput(): CommandContractInput {
  return {
    extensions: readCommandSources(),
    promptTemplates: readPromptTemplateNames(),
    builtinCommands: piBuiltinCommandNames(),
  };
}
