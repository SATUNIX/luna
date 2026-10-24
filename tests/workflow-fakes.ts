// Shared helper for the script-workflow smokes (workflow-hooks-smoke.ts, workflow-resume-smoke.ts,
// workflow-notify-smoke.ts): a stand-in for the pi child process the subagent runner spawns. Each
// child reads its task from stdin, asks `reply` what to do, and answers with pi's JSON-mode events
// (one assistant message, or a StructuredOutput tool call). Nothing is spawned.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";

export interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: (signal?: string) => boolean;
}

/** One launch as the fake saw it. */
export interface Spawned {
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  /** The prompt, without the runner's "Task: " prefix. */
  task: string;
  /** The appended system prompt file's text, read at spawn time. */
  system: string;
}

export interface FakeReply {
  text?: string;
  /** Submitted through StructuredOutput as {output: structured}. */
  structured?: Record<string, unknown>;
  /** Output tokens the assistant message reports (default 10). */
  output?: number;
  /** An assistant error: the child exits 1. */
  fail?: string;
  delayMs?: number;
  /** A file the child writes, relative to its cwd. */
  write?: { file: string; text: string };
}

export type FakeSpawn = (command: string, args: string[], options: { env?: Record<string, string | undefined>; cwd?: string | URL }) => FakeChild;

export function fakeSpawner(reply: (s: Spawned) => FakeReply): { spawn: FakeSpawn; seen: Spawned[]; maxLive: () => number } {
  const seen: Spawned[] = [];
  let live = 0;
  let maxLive = 0;
  let pid = 40000;
  const spawn: FakeSpawn = (_command, args, options) => {
    const child: FakeChild = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: ++pid, kill: (): boolean => { finish(143); return true; } });
    const at = args.indexOf("--append-system-prompt");
    const promptFile = at >= 0 ? args[at + 1] : undefined;
    const system = promptFile ? fs.readFileSync(promptFile, "utf8") : "";
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    let input = "";
    let closed = false;
    live++;
    maxLive = Math.max(maxLive, live);
    const finish = (code: number): void => {
      if (closed) return;
      closed = true;
      live--;
      setImmediate(() => child.emit("close", code));
    };
    child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString("utf8"); });
    child.stdin.on("end", () => {
      const s: Spawned = { args, env: options.env ?? {}, cwd, task: input.replace(/^Task: /, ""), system };
      seen.push(s);
      const r = reply(s);
      const send = (event: Record<string, unknown>): void => { child.stdout.write(`${JSON.stringify(event)}\n`); };
      setTimeout(() => {
        if (closed) return;
        if (r.write) fs.writeFileSync(path.join(cwd, r.write.file), r.write.text);
        if (r.structured) {
          send({ type: "tool_execution_start", toolName: "StructuredOutput", toolCallId: "c1", args: { output: r.structured } });
          send({ type: "tool_execution_end", toolName: "StructuredOutput", toolCallId: "c1", isError: false });
        }
        const usage = { input: 5, output: r.output ?? 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
        if (r.fail) {
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: r.fail, usage } });
          finish(1);
          return;
        }
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: r.text ?? "done" }], stopReason: "stop", usage } });
        finish(0);
      }, r.delayMs ?? 0);
    });
    child.stdin.resume();
    return child;
  };
  return { spawn, seen, maxLive: () => maxLive };
}
