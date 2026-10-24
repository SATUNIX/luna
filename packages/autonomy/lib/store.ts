// The run's persistent record: state.json (only the supervisor that holds the run lock writes
// it), the append-only supervisor log and the control inbox other commands use to talk to a
// running supervisor (pause, cancel, steer, answer, reconfigure). Files are written atomically.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { appendJsonl, readJson, writeJsonAtomic } from "./fsutil.ts";
import { isStoredContract, type RunContract } from "./contract.ts";
import { isPlainObject } from "./fsutil.ts";
import { type RunState, STATE_SCHEMA_VERSION, type TransitionInfo, isRunState, transition } from "./lifecycle.ts";
import { type RunPaths, runPaths, stateHome } from "./paths.ts";

export const CONTROL_KINDS = ["pause", "unpause", "cancel", "steer", "answer", "reconfigure"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
const isControlKind = (v: unknown): v is ControlKind => (CONTROL_KINDS as readonly unknown[]).includes(v);

/** A pending control message as read from the inbox. The payload is the sender's: readers check what they use. */
export interface ControlMessage {
  [key: string]: unknown;
  /** The file name in control/ (pass it to ack). */
  name: string;
  kind: ControlKind;
  payload?: unknown;
  at?: unknown;
}

/** One run in a state home, as `list` shows it. A v0 directory's fields are whatever it recorded. */
export interface RunSummary {
  run: string;
  template: unknown;
  status: unknown;
  updatedAt: unknown;
  outcome: unknown;
  legacy?: true;
}

export interface RunStoreOptions {
  home?: string | undefined;
  now?: () => Date;
}

export class RunStore {
  readonly run: string;
  readonly home: string;
  readonly now: () => Date;
  readonly p: RunPaths;
  private seq = 0;

  constructor(run: string, { home = stateHome(), now = () => new Date() }: RunStoreOptions = {}) {
    this.run = run;
    this.home = home;
    this.now = now;
    this.p = runPaths(run, home);
  }

  exists(): boolean { return fs.existsSync(this.p.state); }

  /** state.json without the schemaVersion check, for telling a v0 directory from a current one. */
  readStateRaw(): unknown { return readJson(this.p.state, null); }

  /**
   * state.json, or null when the run has none. Only the supervisor holding the run lock writes it,
   * so it is checked for its version and basic shape, not field by field.
   */
  readState(): RunState | null {
    const s = readJson(this.p.state, null);
    if (!s) return null;
    const version = isPlainObject(s) ? s.schemaVersion : undefined;
    if (version !== STATE_SCHEMA_VERSION) throw new Error(`state.json of run ${this.run} has schemaVersion ${String(version)}; this supervisor reads ${STATE_SCHEMA_VERSION}`);
    if (!isRunState(s)) throw new Error(`state.json of run ${this.run} is not a run state`);
    return s;
  }

  writeState(state: RunState): RunState { writeJsonAtomic(this.p.state, state); return state; }

  /** Read, transform with `fn(state) -> state`, write. */
  update(fn: (state: RunState) => RunState): RunState {
    const current = this.readState();
    if (!current) throw new Error(`run ${this.run} has no state.json at ${this.p.state}`);
    return this.writeState(fn(current));
  }

  transition(to: string, info: TransitionInfo = {}): RunState {
    return this.update((s) => transition(s, to, { at: this.now().toISOString(), ...info }));
  }

  readContract(): RunContract | null {
    const c = readJson(this.p.contract, null);
    return isStoredContract(c) ? c : null;
  }

  log(line: string): string {
    const out = `${this.now().toISOString()} ${line}`;
    try { fs.mkdirSync(this.p.root, { recursive: true }); fs.appendFileSync(this.p.log, `${out}\n`); } catch { /* the log is best effort */ }
    return out;
  }

  event(step: number, event: Record<string, unknown>): void {
    appendJsonl(path.join(this.p.steps, String(step).padStart(2, "0"), "events.jsonl"), { at: this.now().toISOString(), ...event });
  }

  // --- control inbox ----------------------------------------------------------------------
  enqueue(kind: string, payload: Record<string, unknown> = {}): string {
    if (!isControlKind(kind)) throw new Error(`unknown control message ${kind}`);
    // Time first, then a per-process counter, so messages from one process keep their order even within a millisecond.
    const name = `${this.now().toISOString().replace(/[:.]/g, "-")}-${String((this.seq += 1)).padStart(6, "0")}-${randomBytes(3).toString("hex")}-${kind}.json`;
    writeJsonAtomic(path.join(this.p.control, name), { kind, payload, at: this.now().toISOString() });
    return name;
  }

  /** Pending control messages, oldest first. */
  pending(): ControlMessage[] {
    let names: string[];
    try { names = fs.readdirSync(this.p.control).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
    return names.flatMap((name): ControlMessage[] => {
      const msg = readJson(path.join(this.p.control, name), null);
      return isPlainObject(msg) && isControlKind(msg.kind) ? [{ name, ...msg, kind: msg.kind }] : [];
    });
  }

  ack(name: string): void {
    const done = path.join(this.p.control, "done");
    fs.mkdirSync(done, { recursive: true });
    try { fs.renameSync(path.join(this.p.control, name), path.join(done, name)); } catch { /* already handled */ }
  }
}

/** The runs under a state home, newest first, with just enough to list them. */
export function listRuns(home: string = stateHome()): RunSummary[] {
  let names: string[];
  try { names = fs.readdirSync(home); } catch { return []; }
  return names.flatMap((run): RunSummary[] => {
    const s = readJson(runPaths(run, home).state, null);
    // A directory written by the previous (v0) supervisor has no schemaVersion; it is listed, but it cannot be driven.
    return isPlainObject(s) ? [{ run, template: s.template ?? "self-improve", status: s.status, updatedAt: s.updatedAt ?? s.startedAt, outcome: s.outcome, ...(s.schemaVersion === undefined ? { legacy: true as const } : {}) }] : [];
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

