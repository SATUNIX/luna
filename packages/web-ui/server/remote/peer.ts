// peer.ts — is the process at the other end of a loopback control connection a person's terminal?
//
// The control channel admits any process that presents the secret in control.json, and an agent's
// tool call runs as the same user. Approving a phone is the one control operation that must come
// from a person, so the host looks up the process that owns the peer socket and accepts the
// approval only from one that has a controlling terminal, is in that terminal's foreground process
// group, and reads its standard input from a terminal: an interactive `pi` or `pi-remote pair`.
// pi starts an agent's shell commands in their own session (no controlling terminal), and an RPC
// child (the web console, a subagent) reads its input from a pipe, so neither passes.
//
// What this does not stop: a same-user process that deliberately allocates its own pseudo-terminal
// and runs in its foreground. It is a check on how the request arrives, not a boundary between
// processes of one account; reading the control secret is the other gate (docs/remote-control.md).
//
// Linux reads /proc (net/tcp{,6}, <pid>/fd, <pid>/stat); macOS asks lsof and ps. Anything that cannot
// be determined is a refusal.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Why a connection is or is not a terminal, for the audit record and the refusal message. */
export type PeerVerdict = { readonly ok: true; readonly pid: number; readonly tty: string } | { readonly ok: false; readonly why: string; readonly pid: number | null };

/** What the judgement reads about a process. */
export interface ProcessTerminalFacts {
	/** The controlling terminal's device number (0: none), the process group and the terminal's foreground group. */
	readonly ttyNr: number;
	readonly pgrp: number;
	readonly tpgid: number;
	/** Where file descriptor 0 points, e.g. /dev/pts/3 or pipe:[123]. */
	readonly stdin: string | null;
}

const TTY_PATH = /^\/dev\/(?:pts\/\d+|tty[A-Za-z0-9]*|ttys\d+)$/;

/**
 * The fields of /proc/<pid>/stat this module reads. The command name (field 2) is in parentheses
 * and may itself hold spaces or parentheses, so the fields are counted from the last ")".
 */
export function parseProcStat(text: string): { pgrp: number; ttyNr: number; tpgid: number } | null {
	const close = text.lastIndexOf(")");
	if (close < 0) return null;
	const rest = text.slice(close + 1).trim().split(/\s+/);
	// rest[0] state, [1] ppid, [2] pgrp, [3] session, [4] tty_nr, [5] tpgid
	const [pgrp, ttyNr, tpgid] = [Number(rest[2]), Number(rest[4]), Number(rest[5])];
	return Number.isInteger(pgrp) && Number.isInteger(ttyNr) && Number.isInteger(tpgid) ? { pgrp, ttyNr, tpgid } : null;
}

/**
 * The inode of the socket whose local end is `localPort` and remote end `remotePort`, both on
 * loopback, from the text of /proc/net/tcp or /proc/net/tcp6. Ports are hexadecimal there.
 */
export function socketInode(table: string, localPort: number, remotePort: number): string | null {
	for (const line of table.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		const local = f[1]?.split(":");
		const remote = f[2]?.split(":");
		if (!local || !remote || local.length < 2 || remote.length < 2) continue;
		if (parseInt(local.at(-1) ?? "", 16) !== localPort || parseInt(remote.at(-1) ?? "", 16) !== remotePort) continue;
		const inode = f[9];
		if (inode && /^\d+$/.test(inode) && inode !== "0") return inode;
	}
	return null;
}

/** Is a process with these facts an interactive terminal's foreground process reading the terminal? */
export function judgeTerminal(facts: ProcessTerminalFacts): { ok: true; tty: string } | { ok: false; why: string } {
	if (facts.ttyNr === 0) return { ok: false, why: "it has no controlling terminal (an agent's shell command, a service or a detached process)" };
	if (facts.tpgid !== facts.pgrp) return { ok: false, why: "it is not in its terminal's foreground process group" };
	if (!facts.stdin || !TTY_PATH.test(facts.stdin)) return { ok: false, why: "its standard input is not a terminal (an RPC child or a script)" };
	return { ok: true, tty: facts.stdin };
}

function readLinux(pid: number): ProcessTerminalFacts | null {
	try {
		const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
		if (!stat) return null;
		let stdin: string | null = null;
		try {
			stdin = fs.readlinkSync(`/proc/${pid}/fd/0`);
		} catch {
			stdin = null;
		}
		return { ...stat, stdin };
	} catch {
		return null;
	}
}

function linuxPeerPid(peerPort: number, hostPort: number): number | null {
	let inode: string | null = null;
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		try {
			inode = socketInode(fs.readFileSync(table, "utf8"), peerPort, hostPort);
		} catch {
			inode = null;
		}
		if (inode) break;
	}
	if (!inode) return null;
	const target = `socket:[${inode}]`;
	for (const name of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		let fds: string[];
		try {
			fds = fs.readdirSync(`/proc/${name}/fd`);
		} catch {
			continue; // another user's process, or gone
		}
		for (const fd of fds) {
			try {
				if (fs.readlinkSync(`/proc/${name}/fd/${fd}`) === target) return Number(name);
			} catch {
				/* closed meanwhile */
			}
		}
	}
	return null;
}

const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });

function darwinPeerPid(peerPort: number): number | null {
	// Every process with a TCP socket on that port; the host is one, the peer the other.
	const out = run("lsof", ["-nP", `-iTCP@127.0.0.1:${peerPort}`, "-sTCP:ESTABLISHED", "-Fp"]);
	const pids = [...out.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1])).filter((p) => p !== process.pid);
	return pids.length === 1 ? (pids[0] ?? null) : null;
}

function readDarwin(pid: number): ProcessTerminalFacts | null {
	const ps = run("ps", ["-o", "tty=,stat=", "-p", String(pid)]).trim().split(/\s+/);
	const [tty, stat] = [ps[0] ?? "", ps[1] ?? ""];
	const stdinOut = run("lsof", ["-a", "-p", String(pid), "-d", "0", "-Fn"]);
	const stdin = /^n(.+)$/m.exec(stdinOut)?.[1] ?? null;
	// ps marks a process in its terminal's foreground group with "+"; "??" means no terminal.
	const hasTty = tty !== "" && tty !== "??";
	return { ttyNr: hasTty ? 1 : 0, pgrp: 1, tpgid: stat.includes("+") ? 1 : 0, stdin };
}

/**
 * Test hook: a set of pids to treat as interactive terminals. Only code inside the host process can
 * set it (the remote-host smokes preload it); production code never does, and the environment
 * cannot.
 */
const TEST_TERMINALS = Symbol.for("pi-kit.test.remote-terminal-pids");
function testTerminal(pid: number): boolean {
	const set: unknown = Reflect.get(globalThis, TEST_TERMINALS);
	return set instanceof Set && set.has(pid);
}

/**
 * Judge the process at the other end of a loopback connection from `peerPort` to this host's
 * `hostPort`.
 */
export function inspectPeer(peerPort: number | undefined, hostPort: number | undefined, platform: NodeJS.Platform = process.platform): PeerVerdict {
	if (!peerPort || !hostPort) return { ok: false, why: "the connection has no TCP ports", pid: null };
	let pid: number | null = null;
	try {
		if (platform === "linux") pid = linuxPeerPid(peerPort, hostPort);
		else if (platform === "darwin") pid = darwinPeerPid(peerPort);
		else return { ok: false, why: `this platform (${platform}) cannot tell which process made the connection`, pid: null };
		if (pid === null) return { ok: false, why: "the process that made the connection cannot be found", pid: null };
		if (testTerminal(pid)) return { ok: true, pid, tty: "test" };
		const facts = platform === "linux" ? readLinux(pid) : readDarwin(pid);
		if (!facts) return { ok: false, why: "the process that made the connection cannot be inspected", pid };
		const verdict = judgeTerminal(facts);
		return verdict.ok ? { ok: true, pid, tty: verdict.tty } : { ok: false, why: verdict.why, pid };
	} catch (error) {
		return { ok: false, why: `the connection's process cannot be determined (${error instanceof Error ? error.message : String(error)})`, pid };
	}
}
