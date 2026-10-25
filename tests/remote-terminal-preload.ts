// remote-terminal-preload.ts — loaded into a test remote host with `node --import` (see
// remote-test-harness.ts and remote-control-extension-smoke.ts). The host accepts a phone approval
// only from an interactive terminal (packages/web-ui/server/remote/peer.ts); a smoke test is not
// one, so it names the pids to treat as the operator's terminal in PI_REMOTE_TEST_TERMINAL_PIDS.
// The host finds the connection's process for real; only the terminal judgement is replaced, and
// only for those pids. Production code never reads that variable: this file is the only reader.
const pids = (process.env.PI_REMOTE_TEST_TERMINAL_PIDS ?? "")
	.split(",")
	.map((p) => Number(p.trim()))
	.filter((p) => Number.isInteger(p) && p > 0);
Reflect.set(globalThis, Symbol.for("pi-kit.test.remote-terminal-pids"), new Set(pids));
