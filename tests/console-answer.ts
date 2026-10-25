// console-answer.ts — answer a human-console request the way the console does, for the smoke tests
// that play the operator at a headless broker. The answer is signed with the console key of the
// test's PI_CODING_AGENT_DIR over the request's exact pending bytes (human-console/console-auth.ts);
// an unsigned answer is refused by every requester (tests/human-console-auth-smoke.ts).
import fs from "node:fs";
import path from "node:path";
import { loadConsoleKey, requestDigest, signedAnswer } from "../packages/extensions/src/human-console/console-auth.ts";

export interface ConsoleDecision {
  approved: boolean;
  answer?: string | null;
  note?: string | null;
}

/**
 * Create the console answer key as the interactive console does when its session starts: only the
 * console creates it, and a requester that finds none files nothing (console-auth.ts).
 */
export function startConsole(): void {
  const key = loadConsoleKey({ create: true });
  if (!key.ok) throw new Error(`console key unusable in the test: ${key.why}`);
}

/** The resolved/<id>.json text for a request whose pending file held `pendingBytes`. */
export function signedAnswerText(pendingBytes: string | Buffer, id: string, decision: ConsoleDecision): string {
  const key = loadConsoleKey({ create: true });
  if (!key.ok) throw new Error(`console key unusable in the test: ${key.why}`);
  return JSON.stringify(signedAnswer(key.key, { id, requestDigest: requestDigest(pendingBytes), approved: decision.approved, answer: decision.answer ?? null, note: decision.note ?? null }));
}

/** Answer the pending request `id` in `consoleDir` (its pending file must still be there). */
export function answerPending(consoleDir: string, id: string, decision: ConsoleDecision): void {
  const bytes = fs.readFileSync(path.join(consoleDir, "pending", `${id}.json`));
  fs.mkdirSync(path.join(consoleDir, "resolved"), { recursive: true });
  fs.writeFileSync(path.join(consoleDir, "resolved", `${id}.json`), signedAnswerText(bytes, id, decision));
}
