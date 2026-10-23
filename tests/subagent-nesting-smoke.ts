#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
//
// Pins the subagent nesting/reliability contract:
//   1. Depth propagation: a child's env carries PI_KIT_SUBAGENT_DEPTH = parent + 1.
//   2. Nesting guard: at the configured limit the tool refuses to spawn, with a clear message.
//   3. Cancel: an aborted parent signal stops the child by default (Esc means stop);
//      PI_KIT_SUBAGENT_DETACH_SIGNAL=1 restores detach-on-cancel.
//   4. Spawn failure is reported as "Subagent launch failed: ..." instead of a bare exit code,
//      and is retried once (transient).
//   5. A failed result carries an actionable hint (abort -> background: true).
//   6. A transient failure (non-zero exit, no output) is retried and can then succeed.
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	loadModule,
	fakePi,
	isolateKitEnv,
	tmpWorkspace,
	rmWorkspace,
	setEnv,
	textOf,
} from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { ExtensionFactory } from "../packages/core/eval/harness.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

// The stand-in for a spawned pi child: only what runSingleAgent touches.
interface FakeChild extends EventEmitter {
	stdout: PassThrough;
	stderr: PassThrough;
	killed: boolean;
	kill: () => boolean;
}

// The spawn options runSingleAgent passes to its injected spawn function.
interface SpawnOptions {
	env: NodeJS.ProcessEnv;
}

type SpawnFn = (exe: string, args: string[], options: SpawnOptions) => FakeChild;

/**
 * The subagent module as this test drives it. runSingleAgent's real `spawnChild` parameter is
 * node's `spawn`; the runner only touches the FakeChild members above, so the test states the
 * injected spawn as SpawnFn.
 */
interface SubagentModule {
	default: ExtensionFactory;
	runSingleAgent(
		defaultCwd: string,
		agents: AgentConfig[],
		agentName: string,
		task: string,
		cwd: string | undefined,
		step: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((text: string) => void) | undefined,
		spawnChild: SpawnFn,
	): Promise<SingleResult>;
	isFailedResult(result: SingleResult): boolean;
	getResultOutput(result: SingleResult): string;
}

const restoreIsolation = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-subagent-nesting-");
try {
	const module = await loadModule<SubagentModule>("vendor/subagent/index.ts");
	const agents: AgentConfig[] = [
		{
			name: "scout",
			description: "fixture",
			tools: ["read"],
			systemPrompt: "",
			source: "user",
			filePath: "fixture",
		},
	];

	function fakeChild(onSpawn: (child: FakeChild, options: SpawnOptions) => void): SpawnFn {
		const child: FakeChild = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			killed: false,
			kill: (): boolean => {
				child.killed = true;
				queueMicrotask(() => child.emit("close", 0));
				return true;
			},
		});
		return (_exe, _args, options) => {
			queueMicrotask(() => onSpawn(child, options));
			return child;
		};
	}

	// 1. Child depth is parent + 1.
	{
		const restore = setEnv("PI_KIT_SUBAGENT_DEPTH", "1");
		try {
			let captured: SpawnOptions | undefined;
			const r = await module.runSingleAgent(
				ws,
				agents,
				"scout",
				"x",
				undefined,
				undefined,
				undefined,
				undefined,
				fakeChild((child, options) => {
					captured = options;
					child.emit("close", 0);
				}),
			);
			assert.equal(r.exitCode, 0);
			if (!captured) throw new Error("the fake spawn was never called");
			assert.equal(
				captured.env.PI_KIT_SUBAGENT_DEPTH,
				"2",
				"child must be one level deeper than the parent",
			);
			assert.equal(
				captured.env.PI_KIT_SUBAGENT_STATE_DIR,
				path.join(ws, ".pi", "subagent"),
				"children must inherit the top-level state dir so nested runs aggregate in one place",
			);
		} finally {
			restore();
		}
	}

	// 2. Nesting guard: depth == max means the tool refuses to spawn.
	{
		const restoreDepth = setEnv("PI_KIT_SUBAGENT_DEPTH", "2");
		const restoreMax = setEnv("PI_KIT_SUBAGENT_MAX_DEPTH", "2");
		try {
			const pi = fakePi();
			module.default(pi.api);
			const res = await pi.tools
				.get("subagent")
				.execute("nest", { agent: "scout", task: "x" }, undefined, undefined, {
					cwd: ws,
					hasUI: false,
					ui: {},
				});
			assert.equal(res.isError, true);
			assert.match(textOf(res), /nesting limit/i);
		} finally {
			restoreDepth();
			restoreMax();
		}
	}

	// 3. Kill-on-cancel is the DEFAULT: an already-aborted parent signal never launches a child.
	{
		const ac = new AbortController();
		ac.abort();
		const r = await module.runSingleAgent(
			ws,
			agents,
			"scout",
			"x",
			undefined,
			undefined,
			ac.signal,
			undefined,
			() => {
				throw new Error("must not spawn after the parent cancelled");
			},
		);
		assert.equal(r.stopReason, "aborted", "Esc must stop delegation by default");
	}

	// 3a. PI_KIT_SUBAGENT_DETACH_SIGNAL=1 restores detach-on-cancel.
	{
		const restore = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "1");
		try {
			const ac = new AbortController();
			ac.abort();
			const r = await module.runSingleAgent(
				ws,
				agents,
				"scout",
				"x",
				undefined,
				undefined,
				ac.signal,
				undefined,
				fakeChild((child) => child.emit("close", 0)),
			);
			assert.notEqual(r.stopReason, "aborted", "the opt-in keeps children running past a cancel");
		} finally {
			restore();
		}
	}

	// 3b. An explicit PI_KIT_SUBAGENT_DETACH_SIGNAL=0 also kills on cancel mid-run.
	{
		const restore = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "0");
		try {
			const ac = new AbortController();
			const r = await module.runSingleAgent(
				ws,
				agents,
				"scout",
				"cancel",
				undefined,
				undefined,
				ac.signal,
				undefined,
				fakeChild((child) => {
					queueMicrotask(() => ac.abort());
					child.kill = () => {
						queueMicrotask(() => child.emit("close", null));
						return true;
					};
				}),
			);
			assert.equal(
				r.stopReason,
				"aborted",
				"explicit opt-out must kill on parent cancel",
			);
		} finally {
			restore();
		}
	}

	// 4. Spawn failure surfaces the underlying error and is retried once (transient).
	{
		const restore = setEnv("PI_KIT_SUBAGENT_RETRY_BACKOFF_MS", "0");
		try {
			let calls = 0;
			const r = await module.runSingleAgent(
				ws,
				agents,
				"scout",
				"x",
				undefined,
				undefined,
				undefined,
				undefined,
				fakeChild((child) => {
					calls++;
					child.emit("error", new Error("spawn ENOENT"));
				}),
			);
			assert.equal(r.stopReason, "error");
			assert.match(r.errorMessage ?? "", /Subagent launch failed: .*ENOENT/);
			assert.equal(r.exitCode, 1);
			assert.equal(calls, 2, "a transient spawn failure must be retried once");
			assert.equal(r.attempts, 2);
		} finally {
			restore();
		}
	}

	// 6. A transient failure (non-zero exit, no output) is retried and can then succeed.
	{
		const restore = setEnv("PI_KIT_SUBAGENT_RETRY_BACKOFF_MS", "0");
		try {
			let calls = 0;
			const spawn = () => {
				calls++;
				const child: FakeChild = Object.assign(new EventEmitter(), {
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					kill: (): boolean => {
						queueMicrotask(() => child.emit("close", null));
						return true;
					},
				});
				if (calls === 1) {
					queueMicrotask(() => child.emit("close", 1));
				} else {
					queueMicrotask(() => {
						child.stdout.write(
							JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "recovered" }],
									stopReason: "end",
								},
							}) + "\n",
						);
						child.emit("close", 0);
					});
				}
				return child;
			};
			const r = await module.runSingleAgent(
				ws,
				agents,
				"scout",
				"retry-me",
				undefined,
				undefined,
				undefined,
				undefined,
				spawn,
			);
			assert.equal(calls, 2, "a transient failure must be retried once");
			assert.equal(r.attempts, 2);
			assert.equal(
				module.isFailedResult(r),
				false,
				"the retry must be able to succeed",
			);
			assert.equal(r.finalOutput, "recovered");
			assert.equal(r.exitCode, 0);
		} finally {
			restore();
		}
	}

	// 5. A failed result's output carries an actionable hint, not just the raw error.
	{
		const aborted: SingleResult = {
			agent: "scout",
			task: "x",
			exitCode: 1,
			messages: [],
			stderr: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
			},
			stopReason: "aborted",
			errorMessage: "Subagent was aborted",
		};
		assert.match(
			module.getResultOutput(aborted),
			/background: true/,
		);
	}

	console.log(
		"[subagent-nesting-smoke] depth propagation, nesting guard, detach, spawn-failure, retry and hint behavior verified",
	);
} finally {
	restoreIsolation();
	rmWorkspace(ws);
}
