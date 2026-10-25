import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, generateSummary } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "./shared/redact.ts";
import { isInside, writeFileSafe } from "./shared/safe-fs.ts";

// Self-containment rule: import only node:* builtins, typebox, and pi peers.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.
//
// save adds /save: a check-in snapshot that does NOT compact the conversation.
// It runs pi's own compaction summarizer (generateSummary) over the current
// branch as a side call, then writes the result to disk:
//   <target>/Latest Compact.md                    overwritten on every save
//   <target>/Compacts/YYYY-MM-DD HHmmss - save.md one log file per save
// With a vault (PI_KIT_SAVE_VAULT, else the memory vault) and a project chosen, <target> is
// <vault>/10_Projects/<project> (or Projects/<project> in the memory vault), so another
// session can be told "read the latest compact in <project>". Without one, <target> is
// <cwd>/.pi/snapshots.
//
// After the write, /save can queue one follow-up prompt that asks the agent to
// update the project's Current State.md and memory. The snapshot file itself is
// written by this extension, not by the model, so it exists even when a weak
// model narrates a tool call it never made.
//
// It also copies every real compaction summary (/compact, auto, /compress) to
// the same place, so "Latest Compact.md" always holds the newest summary.

export const LATEST_FILE = "Latest Compact.md";
export const LOG_DIR = "Compacts";
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_TIMEOUT_MS = 180_000;

export const SAVE_INSTRUCTIONS = [
  "This summary is a check-in snapshot. It does not replace the conversation.",
  "A human reads it to check progress. Another agent reads it to continue the work.",
  "State the current goal in one sentence.",
  "State the step that is in progress now.",
  "State the exact next action.",
  "List open questions and blockers.",
  "Include the file paths, commands, hosts, branch names, and IDs that the next agent needs.",
  "Do not include secrets, keys, passwords, or tokens.",
].join("\n");

export type SnapshotKind = "save" | "compact" | "compress";

/** Where a snapshot goes. `root`, when set, is the trusted directory every write is checked from (the workspace). */
export type Target = { dir: string; project?: string; root?: string };

export type SaveDeps = {
  summarize: (ctx: ExtensionContext, instructions: string, signal: AbortSignal) => Promise<string>;
  now: () => Date;
  /** Receives each background save job. Tests use it to await the write. */
  onJob?: (job: Promise<void>) => void;
};

// --- argument parsing ---------------------------------------------------------

// `project` is explicitly undefined when `--project` ends the line with no name.
export type SaveArgs = { project?: string | undefined; update?: boolean; note: string };

/** Parse `/save [--project "Name"] [--update|--no-update] [note…]`. */
export function parseArgs(raw: string): SaveArgs {
  const tokens = [...(raw ?? "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  const out: SaveArgs = { note: "" };
  const note: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Every match fills one of the two groups, so a token is always a string.
    if (t === undefined) continue;
    if (t === "--no-update") out.update = false;
    else if (t === "--update") out.update = true;
    else if (t === "--project" || t === "-p") out.project = tokens[++i];
    else if (t.startsWith("--project=")) out.project = t.slice("--project=".length);
    else note.push(t);
  }
  out.note = note.join(" ").trim();
  return out;
}

// --- target resolution --------------------------------------------------------

// The vault: PI_KIT_SAVE_VAULT, else the memory vault (PI_KIT_VAULT or ~/.pi/vault) when it
// exists, so /save --project and the memory vault's per-project folders are one place. A
// PARA-style vault keeps projects in 10_Projects; the memory vault uses Projects.
export function vaultProjectsDir(): string | undefined {
  const explicit = process.env.PI_KIT_SAVE_VAULT?.trim();
  const memoryVault = process.env.PI_KIT_VAULT?.trim() || path.join(os.homedir(), ".pi", "vault");
  const vault = explicit || (fs.existsSync(path.join(memoryVault, "Projects")) ? memoryVault : undefined);
  if (!vault) return undefined;
  return fs.existsSync(path.join(vault, "Projects")) && !fs.existsSync(path.join(vault, "10_Projects")) ? path.join(vault, "Projects") : path.join(vault, "10_Projects");
}

export function listProjects(): string[] {
  const dir = vaultProjectsDir();
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Resolve where to write. A project must already exist in the vault: /save
 * never creates a project folder, because a vault project needs its index
 * notes first.
 */
export function resolveTarget(cwd: string, project?: string): Target {
  const projectsDir = vaultProjectsDir();
  if (project && projectsDir) {
    if (/[\\/]|^\.\.?$/.test(project)) throw new Error(`invalid project name "${project}"`);
    const known = listProjects();
    const match = known.find((p) => p.toLowerCase() === project.toLowerCase());
    if (!match) {
      const near = known.filter((p) => p.toLowerCase().includes(project.toLowerCase())).slice(0, 5);
      throw new Error(
        `project "${project}" does not exist in ${projectsDir}` + (near.length ? `. Close matches: ${near.join(", ")}` : ""),
      );
    }
    return { dir: path.join(projectsDir, match), project: match };
  }
  if (project && !projectsDir) throw new Error("--project needs PI_KIT_SAVE_VAULT to be set");
  const custom = process.env.PI_KIT_SAVE_DIR?.trim();
  const dir = custom ? path.resolve(cwd, custom) : path.join(cwd, ".pi", "snapshots");
  // A directory inside the workspace is written without following a committed symlink
  // (./shared/safe-fs.ts); one the operator pointed elsewhere is trusted.
  return isInside(cwd, dir) ? { dir, root: cwd } : { dir };
}

// --- document -----------------------------------------------------------------

// The vault must never hold a secret. The summarizer is told to omit them, but a model can still
// copy one from a tool result, so mask the kit's secret shapes (the canonical table,
// ./shared/redact.ts, which includes tool-capture's bearer, github_pat_ and URL-credential shapes;
// tests/save-smoke.ts and tests/redaction-corpus-smoke.ts).
export function redact(text: string): string {
  return redactSecrets(text).text;
}

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

function stamp(d: Date): { iso: string; file: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const file = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return { iso: d.toISOString(), file };
}

// metaFor fills every key; a value it could not find is undefined.
export type SnapshotMeta = {
  kind: SnapshotKind;
  when: Date;
  cwd: string;
  project?: string | undefined;
  sessionFile?: string | undefined;
  model?: string | undefined;
  contextTokens?: number | undefined;
  note?: string | undefined;
};

export function renderSnapshot(summary: string, meta: SnapshotMeta): string {
  const lines = ["---", `kind: ${meta.kind}`, `saved: ${meta.when.toISOString()}`];
  if (meta.project) lines.push(`project: ${yamlValue(meta.project)}`);
  lines.push(`cwd: ${yamlValue(meta.cwd)}`);
  lines.push(`session: ${yamlValue(meta.sessionFile ?? "ephemeral")}`);
  if (meta.model) lines.push(`model: ${yamlValue(meta.model)}`);
  if (typeof meta.contextTokens === "number") lines.push(`context_tokens: ${meta.contextTokens}`);
  if (meta.note) lines.push(`note: ${yamlValue(meta.note)}`);
  lines.push("---", "");
  const title = meta.project ? `Session snapshot: ${meta.project}` : "Session snapshot";
  lines.push(`# ${title} (${meta.when.toISOString().slice(0, 16).replace("T", " ")} UTC)`, "");
  lines.push(
    meta.kind === "save"
      ? "> Written by /save. The conversation was not compacted. This is a check-in snapshot for a human and for the next agent."
      : `> Copied from a ${meta.kind === "compress" ? "/compress" : "compaction"} summary. Pi replaced older messages in the session with this text.`,
    "",
  );
  if (meta.note) lines.push("## Operator note", "", meta.note, "");
  lines.push(summary.trim(), "");
  return redact(lines.join("\n"));
}

function writeAtomic(file: string, content: string, root: string | undefined): void {
  writeFileSafe(file, content, root === undefined ? {} : { root });
}

/** Write the latest file and one log file. Returns both paths. */
export function writeSnapshot(target: Target, content: string, kind: SnapshotKind, when: Date): { latest: string; log: string } {
  const latest = path.join(target.dir, LATEST_FILE);
  let log = path.join(target.dir, LOG_DIR, `${stamp(when).file} - ${kind}.md`);
  for (let n = 2; fs.existsSync(log); n++) log = path.join(target.dir, LOG_DIR, `${stamp(when).file} - ${kind} ${n}.md`);
  writeAtomic(log, content, target.root);
  writeAtomic(latest, content, target.root);
  return { latest, log };
}

export function updatePrompt(paths: { latest: string }, target: Target): string {
  const steps = [
    `/save wrote a session snapshot to "${paths.latest}". The conversation was not compacted.`,
    "Do these steps now:",
    `1. Read "${paths.latest}".`,
  ];
  if (target.project) {
    steps.push(
      `2. Update "${path.join(target.dir, "Current State.md")}". Add a dated entry at the top with the current goal, the work in progress, and the next action. Do not delete existing entries.`,
    );
  } else {
    steps.push("2. If this work has a project notes file for current state, update it with the current goal, the work in progress, and the next action.");
  }
  steps.push(
    "3. If a memory tool is available, save durable decisions and gotchas from this session. Do not save transcript noise.",
    "4. Do not change the snapshot file. Do not compact the conversation. Do not write secrets.",
    "5. Reply with the list of files you changed.",
  );
  return steps.join("\n");
}

// --- default summarizer (pi's own compaction prompt, no compaction) ----------

/** The model type pi's registry resolves request auth for (pi types ctx.model as Model<any>). */
type RegistryModel = Parameters<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>[0];

async function piSummarize(ctx: ExtensionContext, instructions: string, signal: AbortSignal): Promise<string> {
  const model: RegistryModel | undefined = ctx.model;
  if (!model) throw new Error("no model is selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`no request auth for ${model.provider}: ${auth.error}`);
  const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  if (!messages.length) throw new Error("the session has no messages to save");
  const reserve = Number(process.env.PI_KIT_SAVE_RESERVE_TOKENS) > 0 ? Number(process.env.PI_KIT_SAVE_RESERVE_TOKENS) : DEFAULT_RESERVE_TOKENS;
  // pi >=0.85 types provider headers as Record<string, string | null> (null = unset); the
  // summarizer takes plain string headers, so drop the unset entries.
  const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
  const summary = await generateSummary(messages, model, reserve, auth.apiKey, headers, signal, instructions);
  if (!summary.trim()) throw new Error("the model returned an empty summary");
  return summary;
}

const defaultDeps: SaveDeps = { summarize: piSummarize, now: () => new Date() };

// --- extension ----------------------------------------------------------------

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else if (level !== "info") console.warn(message);
}

function metaFor(ctx: ExtensionContext, kind: SnapshotKind, when: Date, target: Target, note?: string): SnapshotMeta {
  let sessionFile: string | undefined;
  try {
    sessionFile = ctx.sessionManager?.getSessionFile();
  } catch {
    sessionFile = undefined;
  }
  let contextTokens: number | undefined;
  try {
    contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
  } catch {
    contextTokens = undefined;
  }
  return {
    kind,
    when,
    cwd: ctx.cwd,
    project: target.project,
    sessionFile,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
    note,
  };
}

export function registerSave(pi: ExtensionAPI, deps: SaveDeps = defaultDeps): void {
  // The project chosen by the last /save in this session. Compaction copies go
  // to the same place. PI_KIT_SAVE_PROJECT is the default before any /save.
  let stickyProject: string | undefined;
  const currentProject = () => stickyProject ?? (process.env.PI_KIT_SAVE_PROJECT?.trim() || undefined);
  let running = false;

  pi.registerCommand("save", {
    description:
      'Write a check-in snapshot of this session to disk without compacting. Usage: /save [--project "Name"] [--no-update] [note]',
    handler: async (rawArgs: string, ctx: ExtensionContext) => {
      if (running) {
        notify(ctx, "save: a save is already running", "warning");
        return;
      }
      const fail = (err: unknown) =>
        notify(ctx, `save: nothing written - ${err instanceof Error ? err.message : String(err)}`, "error");

      let target: Target;
      let args: SaveArgs;
      try {
        args = parseArgs(rawArgs);
        let project = args.project ?? currentProject();
        if (!project && vaultProjectsDir() && ctx.hasUI) {
          const local = "(no vault project: write to this workspace)";
          const choice = await ctx.ui.select("Save the snapshot to which vault project?", [local, ...listProjects()]);
          if (choice === undefined) {
            notify(ctx, "save: cancelled");
            return;
          }
          project = choice === local ? undefined : choice;
        }
        target = resolveTarget(ctx.cwd, project);
        if (target.project) stickyProject = target.project;
      } catch (err) {
        fail(err);
        return;
      }

      running = true;
      const job = (async () => {
        try {
          const instructions = args.note ? `${SAVE_INSTRUCTIONS}\nOperator note: ${args.note}` : SAVE_INSTRUCTIONS;
          const timeoutMs = Number(process.env.PI_KIT_SAVE_TIMEOUT_MS) > 0 ? Number(process.env.PI_KIT_SAVE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error(`summary timed out after ${timeoutMs} ms`)), timeoutMs);
          let summary: string;
          try {
            summary = await deps.summarize(ctx, instructions, controller.signal);
          } finally {
            clearTimeout(timer);
          }

          const when = deps.now();
          const content = renderSnapshot(summary, metaFor(ctx, "save", when, target, args.note || undefined));
          const paths = writeSnapshot(target, content, "save", when);
          notify(ctx, `save: wrote ${paths.latest}\nlog: ${paths.log}`);

          const update = args.update ?? Boolean(target.project);
          if (update) {
            const prompt = updatePrompt(paths, target);
            if (ctx.isIdle()) pi.sendUserMessage(prompt);
            else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          }
        } catch (err) {
          fail(err);
        } finally {
          running = false;
        }
      })();

      // pi awaits command handlers. In interactive mode the summary call can take
      // minutes on a local model, so let it run in the background. Print and SDK
      // modes wait, or the process can exit before the write.
      deps.onJob?.(job);
      if (ctx.hasUI) {
        notify(ctx, `save: summarizing with ${ctx.model?.id ?? "the current model"} in the background. The conversation stays as it is.`);
      } else {
        await job;
      }
    },
  });

  pi.on("session_compact", async (event, ctx) => {
    if (process.env.PI_KIT_SAVE_ON_COMPACT === "0") return;
    try {
      const entry = event?.compactionEntry;
      if (typeof entry?.summary !== "string" || !entry.summary.trim()) return;
      const details = entry.details;
      const kind: SnapshotKind = typeof details === "object" && details !== null && "compressor" in details && details.compressor === "pi-kit-compress" ? "compress" : "compact";
      const target = resolveTarget(ctx.cwd, currentProject());
      const when = deps.now();
      writeSnapshot(target, renderSnapshot(entry.summary, metaFor(ctx, kind, when, target)), kind, when);
    } catch (err) {
      notify(ctx, `save: could not copy the compaction summary - ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  });
}

export default function (pi: ExtensionAPI) {
  registerSave(pi);
}
