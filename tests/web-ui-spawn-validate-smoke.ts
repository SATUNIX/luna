#!/usr/bin/env node
// Console spawn inputs (validate.ts): what a token holder (a browser on the console, or a linked
// phone through the remote host) may ask a new pi session to start with. A resumed session file
// reaches pi's argv as the value of --session, so only a .jsonl file inside the sessions directory
// is accepted; a value that looks like an option, a relative path, a file elsewhere (directly or
// through a symbolic link) or a directory is refused. Offline; a temporary directory only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError, sanitizeSpawnConfig, sessionFileToResume } from "../packages/web-ui/server/validate.ts";

let checks = 0;
const ok = (label: string): void => {
	checks++;
	console.log(`  ok ${checks} - ${label}`);
};
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-validate-")));
try {
	const sessions = path.join(root, "sessions");
	const project = path.join(sessions, "--work--");
	fs.mkdirSync(project, { recursive: true });
	const good = path.join(project, "2026-01-01_abc.jsonl");
	fs.writeFileSync(good, "{}\n");
	const outside = path.join(root, "elsewhere.jsonl");
	fs.writeFileSync(outside, "{}\n");
	const linked = path.join(project, "linked.jsonl");
	fs.symlinkSync(outside, linked);
	const dirJsonl = path.join(project, "dir.jsonl");
	fs.mkdirSync(dirJsonl);

	const refused = (value: unknown, why: RegExp, label: string, sessionsDir: string | null = sessions) => {
		assert.throws(() => sessionFileToResume(value, sessionsDir ?? undefined), (e: unknown) => e instanceof HttpError && e.statusCode === 400 && why.test(e.message), label);
	};
	assert.equal(sessionFileToResume(good, sessions), good, "a session file pi wrote under the sessions directory");
	refused("--approve", /looks like an option/, "an option-shaped value");
	refused("-x.jsonl", /looks like an option/, "a short option-shaped value");
	refused("work/2026.jsonl", /absolute path/, "a relative path");
	refused(path.join(project, "notes.txt"), /\.jsonl session/, "not a session file");
	refused(outside, /not in the sessions directory/, "a file outside the sessions directory");
	refused(linked, /not in the sessions directory/, "a symbolic link inside it pointing outside");
	refused(path.join(project, "..", "..", "elsewhere.jsonl"), /not in the sessions directory/, "a path that climbs out");
	refused(path.join(project, "missing.jsonl"), /does not exist/, "a file that does not exist");
	refused(dirJsonl, /not a regular file/, "a directory named like a session");
	refused(`${good}\0`, /invalid session file/, "a NUL byte");
	refused(["a"], /invalid session file/, "not a string");
	refused(good, /no sessions directory/, "no sessions directory to check against", null);
	ok("sessionFileToResume: only a .jsonl regular file inside the sessions directory; option-shaped, relative, outside, linked-out, missing and directory values are refused");

	const config = sanitizeSpawnConfig({ cwd: root, resumeSessionFile: good }, { defaultCwd: root, sessionsDir: sessions });
	assert.equal(config.resumeSessionFile, good);
	assert.throws(() => sanitizeSpawnConfig({ cwd: root, resumeSessionFile: outside }, { defaultCwd: root, sessionsDir: sessions }), HttpError);
	assert.throws(() => sanitizeSpawnConfig({ cwd: root, resumeSessionFile: good }, { defaultCwd: root }), HttpError, "a caller that names no sessions directory cannot resume");
	assert.equal(sanitizeSpawnConfig({ cwd: root }, { defaultCwd: root, sessionsDir: sessions }).resumeSessionFile, undefined, "a new session needs none");
	assert.throws(() => sanitizeSpawnConfig({ cwd: "relative/dir" }, { defaultCwd: root }), HttpError, "cwd stays absolute");
	ok("sanitizeSpawnConfig: a resume target goes through sessionFileToResume; a new session is unaffected");
	console.log(`web-ui-spawn-validate smoke: OK (${checks} checks)`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
