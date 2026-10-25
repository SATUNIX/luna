#!/usr/bin/env node
/**
 * AG-04 regression coverage: verification must fail closed. Fully offline — no
 * live pi, no network (the verify subprocess this exercises is `node -e "process.exit(N)"`,
 * matching the existing eval fixture's own deterministic stand-in for a broken tsc).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	loadModule,
	fakePi,
	tmpWorkspace,
	rmWorkspace,
	setEnv,
	ROOT,
	type ExtensionFactory,
} from "../packages/core/eval/harness.ts";
import { boolean, isRecord, number, object, parseJson, parseJsonAs, record, string, type Infer } from "../packages/core/lib/guard.ts";
import type * as Orchestrator from "../packages/extensions/src/orchestrator/index.ts";
import type * as VerifyGate from "../packages/extensions/src/verify-gate/index.ts";
import type * as Conductor from "../packages/extensions/src/conductor/index.ts";
import { spawn } from "node:child_process";

// The extension is called with the harness's fake pi API, not pi's ExtensionAPI, so its default export is the harness's factory type.
type VerifyGateModule = Omit<typeof VerifyGate, "default"> & { default: ExtensionFactory };

/** .pi/verdicts.json as verify-gate writes it: the fields these checks read. */
const VerdictBoard = object({
	generation: number(),
	verdicts: record(object({ pass: boolean(), summary: string() })),
});
type VerdictBoard = Infer<typeof VerdictBoard>;
const readBoard = (file: string): VerdictBoard =>
	parseJsonAs(VerdictBoard, fs.readFileSync(file, "utf8"), "verdicts.json");
/** The board's verdict for `key`, asserting one was recorded. */
const verdictOf = (board: VerdictBoard, key: string): VerdictBoard["verdicts"][string] => {
	const verdict = board.verdicts[key];
	assert.ok(verdict, `a ${key} verdict was recorded`);
	return verdict;
};

// 1. A project with no "verify" script must NOT silently record a PASS verdict
// (previously `npm run verify --if-present` exited 0 with nothing checked).
async function testMissingScriptDoesNotRecordPass(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-noscript-");
	fs.writeFileSync(
		path.join(ws, "package.json"),
		JSON.stringify({ name: "no-verify-script" }),
	);
	try {
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.commands
			.get("verify")
			.handler("", { cwd: ws, ui: { setStatus() {}, notify() {} } });

		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(
			verdictOf(board, "verify").pass,
			false,
			"an absent verify script must not be recorded as a pass",
		);
		assert.match(verdictOf(board, "verify").summary, /no.*verify.*script/i);
	} finally {
		rmWorkspace(ws);
	}
}

// Same repro against the review's own literal target package (infra/memory-mcp, which
// genuinely has no "verify" script in this repo).
async function testRealPackageWithoutVerifyScript(): Promise<void> {
	const pkgPath = path.join(
		ROOT,
		"packages",
		"container",
		"mcp-servers",
		"memory-mcp",
		"package.json",
	);
	const pkg = parseJson(fs.readFileSync(pkgPath, "utf8"));
	assert.ok(isRecord(pkg), "the manifest is a JSON object");
	const scripts = pkg.scripts;
	assert.ok(
		!(isRecord(scripts) && scripts.verify),
		"precondition: infra/memory-mcp must have no verify script for this repro to be meaningful",
	);

	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-realnoscript-");
	fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify(pkg));
	try {
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.commands
			.get("verify")
			.handler("", { cwd: ws, ui: { setStatus() {}, notify() {} } });
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(
			verdictOf(board, "verify").pass,
			false,
			"infra/memory-mcp's own manifest must not report a false pass",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 2. missionCompleteBlocked must fail closed on missing / malformed / empty boards.
async function testMissionCompleteBlockedFailsClosed(): Promise<void> {
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-failclosed-");
	try {
		// Missing file entirely.
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"a missing board must block completion",
		);

		// Malformed JSON.
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), "{not valid json");
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"malformed JSON must block completion",
		);

		// Valid JSON, wrong shape.
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({ notVerdicts: true }),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"a schema-invalid board must block completion",
		);

		// Empty verdicts object.
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({ verdicts: {} }),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"an empty board must block completion",
		);
		for (const verdicts of [
			{ verify: {} },
			{ verify: { pass: "true" } },
			[{ pass: true }],
		]) {
			fs.writeFileSync(
				path.join(ws, ".pi", "verdicts.json"),
				JSON.stringify({ verdicts }),
			);
			assert.equal(
				orch.missionCompleteBlocked(ws).blocked,
				true,
				"malformed verdicts cannot stand in for a boolean PASS",
			);
		}

		// Stale PASS: a real, parseable timestamp far in the past.
		const staleAt = new Date(
			Date.now() - 30 * 24 * 60 * 60 * 1000,
		).toISOString();
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({
				verdicts: { verify: { pass: true, summary: "ok", at: staleAt } },
			}),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"a stale (30-day-old) PASS verdict must not satisfy completion",
		);

		// A fresh PASS must still satisfy completion.
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({
				verdicts: {
					verify: { pass: true, summary: "ok", at: new Date().toISOString() },
				},
			}),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			false,
			"a fresh PASS verdict must satisfy completion",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// A hand-constructed PASS cannot establish freshness without a parseable timestamp.
async function testUnparseableTimestampBlocksCompletion(): Promise<void> {
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-badts-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({
				verdicts: { verify: { pass: true, summary: "ok", at: "t" } },
			}),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"an unparseable timestamp must block completion until re-verification",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 3. The async turn_end race: a pending-verification marker must block completion even
// though the board itself is absent/stale while the child process is still running.
async function testPendingVerificationBlocksCompletion(): Promise<void> {
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-pending-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, ".pi", "verify-pending.json"),
			JSON.stringify({ startedAt: new Date().toISOString() }),
		);
		const result = orch.missionCompleteBlocked(ws);
		assert.equal(
			result.blocked,
			true,
			"an in-flight verify run must block completion, not race a stale/absent board read",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 4. Verdict writes are atomic and generation-tracked.
async function testVerdictWritesAreAtomicAndGenerationTracked(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-generation-");
	try {
		vg.recordVerifyVerdict(ws, "verify", true, "first");
		const boardFile = path.join(ws, ".pi", "verdicts.json");
		const after1 = readBoard(boardFile);
		assert.equal(after1.generation, 1, "first write must set generation to 1");

		vg.recordVerifyVerdict(ws, "verify", true, "second");
		const after2 = readBoard(boardFile);
		assert.equal(
			after2.generation,
			2,
			"generation must increment monotonically on each write",
		);

		// No leftover temp file from the atomic write.
		const leftovers = fs
			.readdirSync(path.join(ws, ".pi"))
			.filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(
			leftovers,
			[],
			"atomic write must not leave a temp file behind",
		);

		// A generation that is not a number (a hand-edited board) restarts at 1 instead of
		// being string-concatenated ("7" + 1 === "71").
		fs.writeFileSync(boardFile, JSON.stringify({ verdicts: {}, generation: "7" }));
		vg.recordVerifyVerdict(ws, "verify", true, "third");
		assert.equal(
			readBoard(boardFile).generation,
			1,
			"a non-numeric generation must restart at 1, not concatenate",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 5. Board writes take the shared O_EXCL lock: a held lock fails closed (no clobber),
// and a >60 s stale lock is taken over.
async function testBoardLockFailsClosedOnHeldLock(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardlock-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		const lock = path.join(ws, ".pi", "verdicts.lock");
		fs.writeFileSync(lock, "");
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => errors.push(args.join(" "));
		try {
			vg.recordVerifyVerdict(ws, "verify", true, "must not be written");
		} finally {
			console.error = originalError;
		}
		const boardFile = path.join(ws, ".pi", "verdicts.json");
		assert.equal(
			fs.existsSync(boardFile),
			false,
			"a held board lock must fail closed, not clobber the board",
		);
		assert.ok(
			errors.some((line) => /failed to record verdict/i.test(line)),
			"a blocked write must still be reported via console.error",
		);
		assert.ok(
			fs.existsSync(lock),
			"verify-gate must not remove a lock it did not acquire",
		);
	} finally {
		rmWorkspace(ws);
	}
}

async function testBoardLockStaleTakeover(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardlock-stale-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		const lock = path.join(ws, ".pi", "verdicts.lock");
		fs.writeFileSync(lock, "");
		const stale = new Date(Date.now() - 120_000);
		fs.utimesSync(lock, stale, stale);
		vg.recordVerifyVerdict(ws, "verify", true, "stale takeover");
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(
			verdictOf(board, "verify").pass,
			true,
			"a >60 s stale lock must be taken over, not block writes forever",
		);
		assert.equal(
			fs.existsSync(lock),
			false,
			"an acquired lock must be released after the write",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 6. Two writers (fresh module instances, same cwd) each read-modify-write: both verdicts
// must survive because each mutation re-reads under the lock.
async function testConcurrentWritersDoNotClobberEachOther(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const vg2 = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardmerge-");
	try {
		vg.recordVerifyVerdict(ws, "validator:a", true, "first writer");
		vg2.recordVerifyVerdict(ws, "validator:b", true, "second writer");
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(
			verdictOf(board, "validator:a").pass,
			true,
			"first writer's verdict must survive the second write",
		);
		assert.equal(
			verdictOf(board, "validator:b").pass,
			true,
			"second writer's verdict must be recorded too",
		);
		assert.equal(
			board.generation,
			2,
			"each locked write must increment the generation",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 7. The automatic turn_end path must honor PI_KIT_VERIFY_CMD without a package.json
// "verify" script (Area 3 F6), and clear its pending marker.
async function testAutomaticPathHonorsVerifyCmdOverride(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-autocmd-");
	const restoreOnTurn = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
	const restoreCmd = setEnv("PI_KIT_VERIFY_CMD", 'node -e "process.exit(0)"');
	try {
		fs.writeFileSync(
			path.join(ws, "package.json"),
			JSON.stringify({ name: "no-verify-script" }),
		);
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.handlers.get("tool_result")({ isError: false, toolName: "write" });
		await pi.handlers.get("turn_end")(
			{ message: { role: "assistant", stopReason: "stop" } },
			{ cwd: ws, ui: { setStatus() {}, notify() {} } },
		);
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(
			verdictOf(board, "verify").pass,
			true,
			"automatic turn_end must run PI_KIT_VERIFY_CMD even without a verify script",
		);
		assert.match(verdictOf(board, "verify").summary, /configured check/i);
		assert.equal(
			fs.existsSync(path.join(ws, ".pi", "verify-pending.json")),
			false,
			"the pending marker must be cleared",
		);
		assert.deepEqual(
			fs.readdirSync(path.join(ws, ".pi", "verify-pending")),
			[],
			"the run's own pending marker must be cleared",
		);
	} finally {
		restoreCmd();
		restoreOnTurn();
		rmWorkspace(ws);
	}
}

// 8. A board with a null verdicts field must not swallow the write: `typeof null` is
// "object", so the guard must reject it and fall back to an initialised board.
async function testNullVerdictsBoardStillRecords(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-nullboard-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({ verdicts: null }),
		);
		vg.recordVerifyVerdict(ws, "verify", true, "null board");
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(
			verdictOf(board, "verify").pass,
			true,
			"a null verdicts field must not swallow a PASS verdict",
		);
		assert.equal(
			verdictOf(board, "verify").summary,
			"null board",
			"the repaired board must carry the recorded summary",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// REL-5 (c): each verify run owns its pending marker. When two runs overlap, the first to
// finish must not clear the marker the second still needs, so completion stays blocked in
// orchestrator and conductor until both are done.
async function testOverlappingRunsKeepPendingMarker(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const conductor = await loadModule<Pick<typeof Conductor, "verifierBoardBlocked">>("extensions/conductor/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-pending-overlap-");
	const restoreCmd = setEnv("PI_KIT_VERIFY_CMD", 'node -e "process.exit(0)"');
	const restoreReview = setEnv("PI_KIT_VERIFY_REVIEW", undefined);
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	try {
		const slow = vg.runVerification(ws, {
			focus: "overlap",
			runner: async () => { await gate; return { ok: false, reason: "released" }; },
		});
		await vg.runVerification(ws, {}); // no model, no runner: finishes without a review
		assert.equal(vg.isVerifyPendingActive(ws), true, "the second run's marker must survive the first run finishing");
		assert.equal(orch.missionCompleteBlocked(ws).failing[0], "verify (in progress)", "orchestrator must still see the run in flight");
		assert.equal(conductor.verifierBoardBlocked(ws).failing[0], "verify (in progress)", "conductor must still see the run in flight");
		release();
		await slow;
		assert.equal(vg.isVerifyPendingActive(ws), false, "each run removes its own marker when it finishes");
		const left = fs.existsSync(path.join(ws, ".pi", "verify-pending")) ? fs.readdirSync(path.join(ws, ".pi", "verify-pending")) : [];
		assert.deepEqual(left, [], "no per-run marker is left behind");
	} finally {
		release();
		restoreCmd();
		restoreReview();
		rmWorkspace(ws);
	}
}

// REL-6 (lock half): a writer that holds the board lock briefly must not cost a FAIL
// verdict. The write is retried until the lock frees, and a write that still cannot get the
// lock is returned to the caller and shown in the verification report.
async function testBusyLockIsRetriedAndLostWriteIsReported(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardlock-retry-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		assert.equal(vg.recordVerifyVerdict(ws, "verify", true, "earlier pass"), null, "a free board records the verdict");
		const lock = path.join(ws, ".pi", "verdicts.lock");
		// Another process takes the lock and releases it 150 ms later, while this process is
		// blocked in the retry loop.
		const holder = spawn(process.execPath, ["-e", `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lock)},"");setTimeout(()=>fs.rmSync(${JSON.stringify(lock)},{force:true}),150);`], { stdio: "ignore" });
		const exited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
		for (let i = 0; i < 200 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 5));
		assert.ok(fs.existsSync(lock), "the holder took the lock");
		assert.equal(vg.recordVerifyVerdict(ws, "verify", false, "broken"), null, "the FAIL is written once the lock frees");
		await exited;
		assert.equal(verdictOf(readBoard(path.join(ws, ".pi", "verdicts.json")), "verify").pass, false, "the FAIL replaced the earlier PASS");

		// A lock that never frees: the lost FAIL is returned and named in the report.
		fs.writeFileSync(lock, "");
		const originalError = console.error;
		console.error = () => {};
		let lost: string | null;
		let report: VerifyGate.VerificationReport;
		const restoreCmd = setEnv("PI_KIT_VERIFY_CMD", 'node -e "process.exit(1)"');
		try {
			lost = vg.recordVerifyVerdict(ws, "verify", false, "still broken");
			report = await vg.runVerification(ws, {});
		} finally {
			console.error = originalError;
			restoreCmd();
		}
		assert.match(lost ?? "", /failed to record verdict for 'verify' \(FAIL\)/, "a lost FAIL write is returned to the caller");
		assert.ok(report.boardErrors.some((e) => /'verify' \(FAIL\)/.test(e)), "the report lists the lost FAIL write");
		assert.match(report.text, /## Verifier board NOT updated/, "the report text says the board was not updated");

		// The extension surfaces the same lost write: /verify in its result notification, the
		// automatic turn_end check as an error notification.
		const notices: Array<[string, string]> = [];
		const ui = { setStatus() {}, notify(message: string, level: string) { notices.push([message, level]); } };
		const restoreOnTurn = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
		const restoreFail = setEnv("PI_KIT_VERIFY_CMD", 'node -e "process.exit(1)"');
		console.error = () => {};
		try {
			const pi = fakePi();
			vg.default(pi.api);
			await pi.handlers.get("session_start")({}, { cwd: ws });
			await pi.commands.get("verify").handler("", { cwd: ws, hasUI: false, ui });
			await pi.handlers.get("tool_result")({ isError: false, toolName: "write" });
			await pi.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, { cwd: ws, ui });
		} finally {
			console.error = originalError;
			restoreFail();
			restoreOnTurn();
		}
		assert.ok(notices.some(([m]) => /verifier board NOT updated: .*'verify' \(FAIL\)/.test(m)), "/verify names the lost FAIL write");
		assert.ok(notices.some(([m, level]) => level === "error" && /^verify: failed to record verdict for 'verify' \(FAIL\)/.test(m)), "turn_end reports the lost FAIL write as an error");
	} finally {
		rmWorkspace(ws);
	}
}

// REL-6 (staleness half): a verify/review PASS recorded before a successful write or edit
// no longer lets the mission complete; the edit marks both verdicts stale (pass false).
async function testEditAfterPassBlocksCompletion(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-edit-after-pass-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		vg.recordVerifyVerdict(ws, "verify", true, "checks passed");
		vg.recordVerifyVerdict(ws, "review", true, "review passed");
		assert.equal(orch.missionCompleteBlocked(ws).blocked, false, "a fresh verify+review PASS allows completion");
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.handlers.get("tool_result")({ isError: true, toolName: "edit" }, { cwd: ws });
		assert.equal(orch.missionCompleteBlocked(ws).blocked, false, "a failed edit leaves the verdicts current");
		await pi.handlers.get("tool_result")({ isError: false, toolName: "write" }, { cwd: ws });
		const result = orch.missionCompleteBlocked(ws);
		assert.equal(result.blocked, true, "an edit after the PASS must block completion");
		assert.deepEqual(result.failing.sort(), ["review", "verify"], "both recorded verdicts are stale");
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(verdictOf(board, "verify").pass, false);
		assert.match(verdictOf(board, "review").summary, /^stale:/);
		vg.recordVerifyVerdict(ws, "verify", true, "re-verified");
		vg.recordVerifyVerdict(ws, "review", true, "re-reviewed");
		assert.equal(orch.missionCompleteBlocked(ws).blocked, false, "verification running again clears the block");
	} finally {
		rmWorkspace(ws);
	}
}

// REL-6 (staleness half): an edit made while a verification is running leaves a stale FAIL,
// not the PASS the run computed from the workspace as it was before the edit.
async function testEditDuringVerificationIsStale(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-edit-during-verify-");
	const restoreCmd = setEnv("PI_KIT_VERIFY_CMD", 'node -e "process.exit(0)"');
	const passOutput = "## Criteria\n- PASS | the work is done | checked\n\n## Verdict\nPASS\n";
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		// No edit during the run: both PASS verdicts are recorded and completion is allowed.
		let edits = 0;
		const clean = await vg.runVerification(ws, {
			focus: "finish the work",
			editCount: () => edits,
			runner: async () => ({ ok: true, output: passOutput }),
		});
		assert.equal(clean.pass, true, "a run with no edit passes");
		assert.equal(clean.stale, false);
		assert.equal(orch.missionCompleteBlocked(ws).blocked, false, "a clean run allows completion");

		// An edit while the reviewer runs: the review PASS is recorded as a stale FAIL.
		const raced = await vg.runVerification(ws, {
			focus: "finish the work",
			editCount: () => edits,
			runner: async () => {
				edits++;
				return { ok: true, output: passOutput };
			},
		});
		assert.equal(raced.pass, false, "a run with an edit in progress does not pass");
		assert.equal(raced.stale, true);
		assert.match(raced.text, /## Stale/, "the report says the run went stale");
		const board = readBoard(path.join(ws, ".pi", "verdicts.json"));
		assert.equal(verdictOf(board, "review").pass, false, "the review PASS was not recorded");
		assert.match(verdictOf(board, "review").summary, /^stale:/);
		assert.equal(orch.missionCompleteBlocked(ws).blocked, true, "completion stays blocked");
	} finally {
		restoreCmd();
		rmWorkspace(ws);
	}

	// The automatic turn_end check: a write while the check command runs leaves a stale FAIL.
	const ws2 = tmpWorkspace("pi-kit-eval-edit-during-autocheck-");
	const restoreOnTurn = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
	const restoreSlow = setEnv("PI_KIT_VERIFY_CMD", 'node -e "setTimeout(() => process.exit(0), 400)"');
	try {
		const pi = fakePi();
		vg.default(pi.api);
		const ui = { setStatus() {}, notify() {} };
		await pi.handlers.get("session_start")({}, { cwd: ws2 });
		await pi.handlers.get("tool_result")({ isError: false, toolName: "edit" }, { cwd: ws2, ui });
		const check = pi.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, { cwd: ws2, ui });
		await new Promise((r) => setTimeout(r, 100));
		await pi.handlers.get("tool_result")({ isError: false, toolName: "write" }, { cwd: ws2, ui });
		await check;
		const verdict = verdictOf(readBoard(path.join(ws2, ".pi", "verdicts.json")), "verify");
		assert.equal(verdict.pass, false, "a check that passed while a write landed is not recorded as a PASS");
		assert.match(verdict.summary, /^stale:/);
	} finally {
		restoreSlow();
		restoreOnTurn();
		rmWorkspace(ws2);
	}
}

// Known limitation (REL-6): only `write` and `edit` tool results count as edits. A `bash`
// tool result (sed -i, git checkout, a formatter) leaves a recorded PASS as it was.
async function testBashResultIsNotTreatedAsAnEdit(): Promise<void> {
	const vg = await loadModule<VerifyGateModule>("extensions/verify-gate/index.ts");
	const orch = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-bash-not-edit-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		vg.recordVerifyVerdict(ws, "verify", true, "checks passed");
		vg.recordVerifyVerdict(ws, "review", true, "review passed");
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.handlers.get("tool_result")({ isError: false, toolName: "bash" }, { cwd: ws });
		assert.equal(orch.missionCompleteBlocked(ws).blocked, false, "a bash result does not mark the verdicts stale (known limitation)");
	} finally {
		rmWorkspace(ws);
	}
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [
	[
		"an edit made while verification runs leaves a stale FAIL",
		testEditDuringVerificationIsStale,
	],
	[
		"a bash tool result is not treated as an edit (known limitation)",
		testBashResultIsNotTreatedAsAnEdit,
	],
	[
		"an edit after a verify/review PASS blocks completion until re-verified",
		testEditAfterPassBlocksCompletion,
	],
	[
		"overlapping verify runs keep the pending marker until both finish",
		testOverlappingRunsKeepPendingMarker,
	],
	[
		"a briefly held board lock is retried; a lost FAIL write is reported",
		testBusyLockIsRetriedAndLostWriteIsReported,
	],
	[
		"a held board lock fails closed; a stale lock is taken over",
		testBoardLockFailsClosedOnHeldLock,
	],
	[
		"a >60 s stale board lock is taken over (no permanent block)",
		testBoardLockStaleTakeover,
	],
	[
		"concurrent writers do not clobber each other's verdicts",
		testConcurrentWritersDoNotClobberEachOther,
	],
	[
		"automatic turn_end honors PI_KIT_VERIFY_CMD without a verify script",
		testAutomaticPathHonorsVerifyCmdOverride,
	],
	[
		"missing verify script does not record a false pass",
		testMissingScriptDoesNotRecordPass,
	],
	[
		"infra/memory-mcp (no verify script) does not record a false pass",
		testRealPackageWithoutVerifyScript,
	],
	[
		"missionCompleteBlocked fails closed on missing/malformed/empty/stale boards",
		testMissionCompleteBlockedFailsClosed,
	],
	[
		"an unparseable timestamp blocks completion",
		testUnparseableTimestampBlocksCompletion,
	],
	[
		"a pending verify run blocks completion (async race fix)",
		testPendingVerificationBlocksCompletion,
	],
	[
		"verdict writes are atomic and generation-tracked",
		testVerdictWritesAreAtomicAndGenerationTracked,
	],
	[
		"a null verdicts field does not swallow the verdict write",
		testNullVerdictsBoardStillRecords,
	],
];

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  OK: ${name}`);
	} catch (error) {
		failed++;
		console.error(`  FAIL: ${name}`);
		console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
	}
}

if (failed > 0) {
	console.error(`\n[verify-failclosed-smoke] ${failed}/${tests.length} FAILED`);
	process.exit(1);
}
console.log(`\n[verify-failclosed-smoke] all ${tests.length} checks passed`);
