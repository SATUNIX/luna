#!/usr/bin/env node
// Offline regression smoke for web-ui static file streaming (finding F2).
// Verifies that an async read-stream error is turned into a 500 (before headers)
// or an aborted response (after piping), instead of an uncaught exception.
//
// NOTE: this must NOT import server.ts — that module starts a listener.
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter, once } from "node:events";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.resolve(HERE, "../packages/web-ui/server/server.ts");

let failed = false;

async function check(name: string, fn: () => unknown): Promise<void> {
	try {
		await fn();
		console.log(`  ok - ${name}`);
	} catch (error) {
		failed = true;
		console.error(`  not ok - ${name}`);
		console.error(error instanceof Error && error.stack ? error.stack : error);
	}
}

/** Minimal fake response built on a Writable. */
class FakeRes extends Writable {
	// Assigned in the constructor; `declare` keeps the emitted class unchanged.
	declare statusCode: number;
	declare headers: Record<string, string | number> | null;
	declare body: string;
	declare destroyedFlag: boolean;

	constructor() {
		super();
		this.statusCode = 0;
		this.headers = null;
		this.body = "";
		this.destroyedFlag = false;
	}
	writeHead(status: number, headers?: Record<string, string | number>): void {
		this.statusCode = status;
		this.headers = headers ?? null;
	}
	override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
		this.body += chunk.toString();
		cb();
	}
	override destroy(): this {
		this.destroyedFlag = true;
		return super.destroy();
	}
}

/** A Readable that pushes "hello" on its first read (and optionally ends). */
function helloStream({ end = false }: { end?: boolean } = {}): Readable {
	let sent = false;
	return new Readable({
		read() {
			if (sent) return;
			sent = true;
			this.push("hello");
			if (end) this.push(null);
		},
	});
}

try {
	const { sendFile } = await import(
		"../packages/web-ui/server/send-file.ts"
	);

	// (a) open failure before headers: 500 + JSON body, no exception.
	await check("open failure yields 500 read failed", async () => {
		const res = new FakeRes();
		const emitter = new EventEmitter();
		// Test doubles stand in for fs.ReadStream: sendFile only uses once()/pipe() on it.
		const factory = () => emitter as fs.ReadStream;
		assert.doesNotThrow(() => sendFile(res, "/x.css", { size: 5 }, factory));
		assert.doesNotThrow(() =>
			emitter.emit("error", new Error("boom")),
		);
		assert.equal(res.statusCode, 500);
		assert.ok(
			res.body.includes("read failed"),
			`body should mention read failed, got ${JSON.stringify(res.body)}`,
		);
	});

	// (b) success: open -> 200 + body streamed through.
	await check("success yields 200 and streamed body", async () => {
		const res = new FakeRes();
		const stream = helloStream({ end: true });
		const done = once(res, "finish");
		sendFile(res, "/a.css", { size: 5 }, () => stream as fs.ReadStream);
		stream.emit("open");
		await done;
		assert.equal(res.statusCode, 200);
		assert.equal(res.headers?.["Content-Type"], "text/css; charset=utf-8");
		assert.equal(res.headers?.["Content-Length"], 5);
		assert.equal(res.body, "hello");
	});

	// (c) error after piping has begun aborts the response.
	await check("mid-stream error aborts the response", async () => {
		const res = new FakeRes();
		const stream = helloStream({ end: false });
		sendFile(res, "/a.css", { size: 5 }, () => stream as fs.ReadStream);
		stream.emit("open");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(res.body, "hello", "first chunk should have been written");
		assert.doesNotThrow(() =>
			stream.emit("error", new Error("mid-stream boom")),
		);
		assert.equal(res.destroyedFlag, true);
	});

	// (d) wiring guard: a revert of server.ts to the raw pipe must be caught.
	await check("server.ts imports ./send-file.ts", async () => {
		const text = fs.readFileSync(SERVER_JS, "utf8");
		assert.ok(
			text.includes('"./send-file.ts"'),
			"server.ts must import ./send-file.ts",
		);
		assert.ok(
			!text.includes("createReadStream"),
			"server.ts must not create the read stream directly",
		);
	});
} finally {
	void 0;
}

if (failed) {
	console.error("web-ui-static smoke: FAIL");
	process.exit(1);
}
console.log("web-ui-static smoke: OK");
