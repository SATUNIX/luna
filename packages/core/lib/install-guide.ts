/**
 * The questions and checks of `install.ts --guided`, kept apart from the installer so they can be
 * tested without running an install. Everything that touches the machine (files, commands, the
 * environment, the terminal) is passed in.
 *
 * The guided run never starts on its own: only `--guided` asks anything, and every other run of
 * the installer stays non-interactive. Pinned by `tests/install-guided-smoke.ts`.
 */
import fs from "node:fs";
import { loadProfileDef, listProfiles } from "./profiles.ts";

/** Node's floor for Luna (package.json `engines`). */
export const MIN_NODE: readonly [number, number] = [24, 0];
/** How many invalid answers to one question are tolerated before the guided run gives up. */
export const MAX_ATTEMPTS = 3;

export interface Environment {
  node: string;
  nodeOk: boolean;
  git: string | null;
  pi: string | null;
  container: boolean;
  ci: boolean;
  tty: boolean;
  gitRepo: boolean;
  installedProfile: string | null;
}

export interface DetectDeps {
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  /** The first line of a command's stdout, or null when it is missing or fails. */
  run: (cmd: string, args: string[]) => string | null;
  tty: boolean;
  installedProfile: string | null;
}

/** True when `version` (with or without a leading v) is at least `min`. */
export function versionAtLeast(version: string, min: readonly [number, number]): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

export function detectEnvironment(d: DetectDeps): Environment {
  return {
    node: d.nodeVersion,
    nodeOk: versionAtLeast(d.nodeVersion, MIN_NODE),
    git: d.run("git", ["--version"]),
    pi: d.run("pi", ["--version"]),
    container: d.exists("/.dockerenv") || d.exists("/run/.containerenv") || Boolean(d.env.container),
    ci: Boolean(d.env.CI) && d.env.CI !== "false",
    tty: d.tty,
    gitRepo: d.run("git", ["rev-parse", "--is-inside-work-tree"]) === "true",
    installedProfile: d.installedProfile,
  };
}

export function formatEnvironment(e: Environment): string[] {
  const yes = (b: boolean): string => (b ? "yes" : "no");
  return [
    "[install] Detected:",
    `  node:         ${e.node}${e.nodeOk ? "" : ` (Luna needs ${MIN_NODE.join(".")} or newer)`}`,
    `  git:          ${e.git ?? "not found"}`,
    `  pi:           ${e.pi ?? "not found"}`,
    `  container:    ${yes(e.container)}`,
    `  CI:           ${yes(e.ci)}`,
    `  terminal:     ${yes(e.tty)}`,
    `  git repo:     ${yes(e.gitRepo)}`,
    `  installed:    ${e.installedProfile ?? "none"}`,
  ];
}

export interface ProfileChoice { name: string; summary: string }

/** The first sentence of a description (up to the first ". " or the end). */
function firstSentence(text: string): string {
  const i = text.indexOf(". ");
  return (i >= 0 ? text.slice(0, i + 1) : text).trim();
}

/** The shipped profiles, sorted by name, each with the first sentence of its description. */
export function profileChoices(dir?: string): ProfileChoice[] {
  return listProfiles(dir).map((name) => {
    const description = loadProfileDef(name, dir).description;
    return { name, summary: typeof description === "string" ? firstSentence(description) : "" };
  });
}

/** The profile already installed when it is still shipped, else balanced (else the first one). */
export function recommendProfile(installed: string | null, choices: readonly ProfileChoice[]): string {
  const names = choices.map((c) => c.name);
  if (installed !== null && names.includes(installed)) return installed;
  return names.includes("balanced") ? "balanced" : names[0] ?? "balanced";
}

/**
 * A profile from an answer: its number in the list or its exact name; empty gives `def`. Anything
 * else, including a retired profile name, gives null (typed names are never aliased; see
 * shared/profile-names.ts).
 */
export function parseChoice(answer: string, choices: readonly ProfileChoice[], def: string): string | null {
  const a = answer.trim();
  if (a === "") return def;
  if (/^\d+$/.test(a)) return choices[Number(a) - 1]?.name ?? null;
  return choices.some((c) => c.name === a) ? a : null;
}

export function parseScope(answer: string, def: "global" | "project"): "global" | "project" | null {
  const a = answer.trim().toLowerCase();
  if (a === "") return def;
  if (a === "global" || a === "g" || a === "1") return "global";
  if (a === "project" || a === "p" || a === "2") return "project";
  return null;
}

/** Yes or no; empty is yes (the prompt shows [Y/n]). */
export function parseConfirm(answer: string): boolean | null {
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return null;
}

/** One line per file that a run created, changed or removed, comparing byte snapshots. */
export function summarizeChanges(before: ReadonlyMap<string, Buffer | undefined>, after: ReadonlyMap<string, Buffer | undefined>): string[] {
  const out: string[] = [];
  for (const [file, now] of after) {
    const was = before.get(file);
    if (was === undefined && now !== undefined) out.push(`  created ${file}`);
    else if (was !== undefined && now === undefined) out.push(`  removed ${file}`);
    else if (was !== undefined && now !== undefined && !was.equals(now)) out.push(`  changed ${file}`);
  }
  return out;
}

/** The bytes of each file, or undefined for one that does not exist. */
export function snapshotBytes(files: readonly string[]): Map<string, Buffer | undefined> {
  const out = new Map<string, Buffer | undefined>();
  for (const file of files) {
    try {
      out.set(file, fs.readFileSync(file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") out.set(file, undefined);
      else throw error;
    }
  }
  return out;
}

export interface GuideIO {
  /** Print a prompt and read one answer line; null when input has ended. */
  ask: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}

export type GuideResult =
  | { kind: "proceed"; profile: string; scope: "global" | "project" }
  | { kind: "declined" }
  | { kind: "failed"; reason: string };

/** Ask until `parse` accepts an answer, at most MAX_ATTEMPTS times. */
async function askUntil<T>(io: GuideIO, prompt: string, parse: (a: string) => T | null, what: string): Promise<{ ok: T } | { error: string }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = await io.ask(prompt);
    if (answer === null) return { error: `input ended before the ${what} was chosen; nothing was changed` };
    const value = parse(answer);
    if (value !== null) return { ok: value };
    io.print(`[install] "${answer.trim()}" is not a valid ${what}${attempt < MAX_ATTEMPTS ? "; try again" : ""}`);
  }
  return { error: `no valid ${what} after ${MAX_ATTEMPTS} attempts; nothing was changed` };
}

/**
 * The guided questions: profile (numbered, with the recommended default), scope (unless the
 * caller fixed it with --scope), then a confirmation. Writes nothing.
 */
export async function runGuide(io: GuideIO, env: Environment, choices: readonly ProfileChoice[], fixedScope: "global" | "project" | null): Promise<GuideResult> {
  for (const line of formatEnvironment(env)) io.print(line);
  if (choices.length === 0) return { kind: "failed", reason: "no profiles are shipped with this copy of Luna" };
  const def = recommendProfile(env.installedProfile, choices);
  io.print("");
  io.print("[install] Profiles:");
  choices.forEach((c, i) => io.print(`  ${i + 1}. ${c.name}${c.name === def ? " (recommended)" : ""}${c.summary ? ` - ${c.summary}` : ""}`));
  const profile = await askUntil(io, `Profile [${def}]: `, (a) => parseChoice(a, choices, def), "profile");
  if ("error" in profile) return { kind: "failed", reason: profile.error };
  let scope: "global" | "project";
  if (fixedScope !== null) scope = fixedScope;
  else {
    const chosen = await askUntil(io, "Scope, global (all projects) or project (this directory) [global]: ", (a) => parseScope(a, "global"), "scope");
    if ("error" in chosen) return { kind: "failed", reason: chosen.error };
    scope = chosen.ok;
  }
  const confirm = await askUntil(io, `Install profile ${profile.ok} (${scope})? Proceed? [Y/n]: `, parseConfirm, "answer");
  if ("error" in confirm) return { kind: "failed", reason: confirm.error };
  return confirm.ok ? { kind: "proceed", profile: profile.ok, scope } : { kind: "declined" };
}

/** A GuideIO over a readable stream (stdin), reading one line per question. */
export function streamIO(input: NodeJS.ReadableStream, write: (text: string) => void): GuideIO & { close: () => void } {
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let buffer = "";
  let ended = false;
  const deliver = (): void => {
    while (waiting.length > 0 && (lines.length > 0 || ended)) waiting.shift()?.(lines.length > 0 ? lines.shift() ?? null : null);
  };
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, i).replace(/\r$/, ""));
      buffer = buffer.slice(i + 1);
    }
    deliver();
  };
  const onEnd = (): void => {
    if (buffer !== "") lines.push(buffer);
    buffer = "";
    ended = true;
    deliver();
  };
  input.on("data", onData);
  input.on("end", onEnd);
  return {
    ask: (prompt) => {
      write(prompt);
      return new Promise((resolve) => {
        waiting.push(resolve);
        deliver();
      });
    },
    print: (line) => write(`${line}\n`),
    close: () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.pause();
    },
  };
}
