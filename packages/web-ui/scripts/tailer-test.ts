// tailer-test.ts — proves the session tailer survives interleaved writes.
//
// The important case: a writer is interrupted mid-line, so a JSON entry arrives in two
// chunks. A naive tailer parses the fragment, fails, and loses the entry. This test writes
// a file in fragments and asserts every message still reaches subscribers.
//
// Usage: node scripts/tailer-test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "../../core/lib/guard.ts";
import { SessionTailer } from "../server/tailer.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-console-tailer-"));
const file = path.join(dir, "session.jsonl");

const session = {
	type: "session",
	version: 3,
	id: "tailer-test",
	timestamp: new Date().toISOString(),
	cwd: dir,
};
const msg = (role: string, text: string) => ({
	type: "message",
	id: `m-${role}-${Math.random().toString(16).slice(2, 8)}`,
	parentId: null,
	timestamp: new Date().toISOString(),
	message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
});

fs.writeFileSync(
	file,
	`${JSON.stringify(session)}\n${JSON.stringify(msg("user", "first message"))}\n`,
);

/** The first text block of an observed message event from the tailer, if `event` is one. */
function observedText(event: unknown): string | undefined {
	if (!isRecord(event) || event.type !== "observed") return undefined;
	const data = event.data;
	if (!isRecord(data) || data.type !== "observed_message" || !isRecord(data.message)) return undefined;
	const content = data.message.content;
	const first: unknown = Array.isArray(content) ? content[0] : undefined;
	return isRecord(first) && typeof first.text === "string" ? first.text : undefined;
}

const seen: string[] = [];
const tailer = new SessionTailer(file);
// Production order: acquireTailer() starts (priming history into the replay buffer), then the
// SSE handler subscribes — so a late viewer still receives the recent tail.
tailer.start();
tailer.subscribe((m: unknown) => {
	const text = observedText(m);
	if (text !== undefined) seen.push(text);
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Append a message in two fragments, with a poll boundary in between.
const split = JSON.stringify(
	msg("assistant", "second message split across polls"),
);
fs.appendFileSync(file, split.slice(0, Math.floor(split.length / 2)));
await wait(1200);
fs.appendFileSync(file, `${split.slice(Math.floor(split.length / 2))}\n`);

// And a normal append afterwards.
await wait(1200);
fs.appendFileSync(file, `${JSON.stringify(msg("user", "third message"))}\n`);
await wait(1200);

tailer.close();

let failures = 0;
const check = (label: string, cond: boolean): void => {
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
};

console.log("pi-console tailer test");
check("replayed pre-existing message", seen.includes("first message"));
check(
	"recovered the split (fragmented) message",
	seen.includes("second message split across polls"),
);
check("read the message after it", seen.includes("third message"));
check("no duplicate messages", new Set(seen).size === seen.length);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`tailer test: ${failures} failed`);
process.exit(failures ? 1 : 0);
