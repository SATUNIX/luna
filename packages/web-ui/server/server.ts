// server.ts — pi-console entrypoint: HTTP server, static files, API delegation.
//
// Access control lives in security.ts and is applied to every request here, before routing:
// Host allowlist, Origin / Fetch-Metadata check, bearer token, JSON content type. The token is
// per start (or operator supplied) and is never written to the log or to a query string.
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { PUBLIC_DIR, TOKEN_FILE, ensureRuntimeDir } from "./config.ts";
import { handleApi, closeAllStreams } from "./routes.ts";
import { killAll } from "./spawn.ts";
import { sendFile } from "./send-file.ts";
import { closeAllTailers } from "./tailer.ts";
import {
	type ConsolePolicy,
	PolicyError,
	applySecurityHeaders,
	buildAuthorities,
	constantTimeEqual,
	evaluateRequest,
	isLoopbackHost,
	normalizeHost,
	resolvePolicy,
} from "./security.ts";

/** Extract the pathname from req.url without constructing a URL object. */
function pathnameOf(req: http.IncomingMessage): string {
	const raw = req.url || "/";
	const q = raw.indexOf("?");
	return q === -1 ? raw : raw.slice(0, q);
}

/** Extract the raw query string (including the leading "?") from req.url. */
function searchOf(req: http.IncomingMessage): string {
	const raw = req.url || "/";
	const qi = raw.indexOf("?");
	return qi === -1 ? "" : raw.slice(qi);
}

function sendError(
	res: http.ServerResponse,
	status: number,
	message: string,
	extraHeaders: Record<string, string> = {},
): void {
	const payload = JSON.stringify({ error: message });
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

/** Serve a file from public/, refusing anything that escapes the directory. */
function serveStatic(res: http.ServerResponse, pathname: string): void {
	let decoded: string;
	try {
		decoded = pathname === "/" ? "index.html" : decodeURIComponent(pathname);
	} catch {
		// Malformed percent-encoding must not throw out of the request handler.
		sendError(res, 400, "bad request");
		return;
	}
	if (decoded.includes("\0")) {
		sendError(res, 400, "bad request");
		return;
	}
	const rel = decoded.replace(/^\/+/, "");
	// Static assets are the UI's own files; nothing under a dot-directory belongs there.
	if (rel.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
		sendError(res, 404, "not found");
		return;
	}
	const resolved = path.resolve(PUBLIC_DIR, rel);
	const root = path.resolve(PUBLIC_DIR);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		sendError(res, 403, "forbidden");
		return;
	}
	// The request only selects an entry in the table of the UI's own files (below); the path that reaches the file
	// system is the one the directory listing produced, never one built from the request.
	const known = publicFile(path.relative(root, resolved).split(path.sep).join("/"));
	if (!known) {
		sendError(res, 404, "not found");
		return;
	}
	fs.stat(known, (err, stat) => {
		if (err || !stat.isFile()) {
			sendError(res, 404, "not found");
			return;
		}
		// `known` comes from the listing of public/ above, never from the request path.
		sendFile(res, known, stat); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
	});
}

// The regular files under public/ (no symlinks, no dot-entries), keyed by their path relative to it. Listed on first use and
// again, at most once a second, when a request names a file that is not in the table.
let publicIndex: Map<string, string> | null = null;
let publicIndexedAt = 0;
function listPublicFiles(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string, prefix: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const abs = path.join(dir, entry.name);
			const key = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(abs, key);
			else if (entry.isFile()) files.set(key, abs);
		}
	};
	try {
		walk(root, "");
	} catch {
		/* no public directory: nothing is served */
	}
	return files;
}
function publicFile(key: string): string | undefined {
	if (publicIndex?.has(key)) return publicIndex.get(key);
	const now = Date.now();
	if (!publicIndex || now - publicIndexedAt > 1000) {
		publicIndex = listPublicFiles(path.resolve(PUBLIC_DIR));
		publicIndexedAt = now;
	}
	return publicIndex.get(key);
}

// Minimal stdout/stderr loggers: stderr only for errors and denials, so write directly.
const out = (line: string): boolean => process.stdout.write(`${line}\n`);
const err = (line: string): boolean => process.stderr.write(`${line}\n`);

/** An error's message for the log. */
function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

// ------------------------------------------------------------------- policy ---
function loadPolicy(): ConsolePolicy {
	try {
		return resolvePolicy(process.env);
	} catch (error) {
		if (error instanceof PolicyError) {
			err(`pi-console: refusing to start: ${error.message}`);
			process.exit(2);
		}
		throw error;
	}
}
const policy = loadPolicy();

// Filled in once the socket is bound (the port may be ephemeral). Empty means fail closed.
let authorities: ReadonlySet<string> = new Set();

// ------------------------------------------------------------------ logging ---
// Denied requests are logged (method, path, status, reason, peer) so an operator can see
// probing. Only the path is logged, never the query string, headers or any credential.
// Set PI_CONSOLE_ACCESS_LOG=1 to log every request the same way.
const LOG_ALL = process.env.PI_CONSOLE_ACCESS_LOG === "1";
const DENY_LOG_LIMIT = 30; // lines per window; the rest are counted, not written
const DENY_LOG_WINDOW_MS = 10_000;
let denyWindowStart = 0;
let denyWindowCount = 0;
let denySuppressed = 0;

function safePath(pathname: string): string {
	let text = pathname;
	// A client that put the token in the URL path must not get it copied into the log.
	if (policy.token) text = text.split(policy.token).join("[redacted]");
	return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
}

function logRequest(
	req: http.IncomingMessage,
	pathname: string,
	status: number,
	reason: string | null,
): void {
	const line = `pi-console: ${req.method} ${safePath(pathname)} -> ${status}${reason ? ` (${reason})` : ""} from ${req.socket.remoteAddress || "?"}`;
	if (LOG_ALL && !reason) {
		out(line);
		return;
	}
	if (!reason) return;
	const now = Date.now();
	if (now - denyWindowStart > DENY_LOG_WINDOW_MS) {
		if (denySuppressed > 0) err(`pi-console: ${denySuppressed} further denied request(s) not logged`);
		denyWindowStart = now;
		denyWindowCount = 0;
		denySuppressed = 0;
	}
	if (denyWindowCount++ < DENY_LOG_LIMIT) err(line);
	else denySuppressed++;
}

// ------------------------------------------------------------------- server ---
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const pathname = pathnameOf(req);
	const search = searchOf(req);
	const isApi = pathname.startsWith("/api/");
	applySecurityHeaders(res, { api: isApi });
	let denied = false;
	if (LOG_ALL) {
		res.on("finish", () => {
			if (!denied) logRequest(req, pathname, res.statusCode, null);
		});
	}

	if (!(req.url || "").startsWith("/")) {
		// Absolute-form or asterisk targets are not something this server serves.
		denied = true;
		logRequest(req, pathname, 400, "bad request target");
		sendError(res, 400, "bad request");
		return;
	}

	const verdict = evaluateRequest(req, { pathname, authorities, policy });
	if (!verdict.ok) {
		denied = true;
		logRequest(req, pathname, verdict.status, verdict.code);
		sendError(res, verdict.status, verdict.message, verdict.headers);
		return;
	}

	try {
		const handled = await handleApi(
			req,
			res,
			{ pathname, search },
			{ authMode: policy.auth },
		);
		if (handled) return;
	} catch (error) {
		err(`pi-console: request failed: ${describeError(error)}`);
		sendError(res, 500, "internal error (see the console log)");
		return;
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		sendError(res, 405, "method not allowed", { Allow: "GET, HEAD" });
		return;
	}
	try {
		serveStatic(res, pathname);
	} catch (error) {
		// Defence in depth: a static-serving failure must never take the process down.
		err(`pi-console: static file failed: ${describeError(error)}`);
		if (!res.headersSent) {
			sendError(res, 500, "internal error (see the console log)");
		}
	}
}

// A rejection from handleRequest stays unhandled, exactly as it was from an async listener.
const server = http.createServer((req, res) => void handleRequest(req, res));

// Slow or stalled request bodies must not hold sockets open indefinitely.
server.requestTimeout = 60_000;
server.headersTimeout = 30_000;

server.on("error", (error) => {
	err(`pi-console: server error: ${describeError(error)}`);
	process.exit(1);
});

ensureRuntimeDir();

/** True when the token file on disk is the one this process wrote (so it may remove it). */
let wroteTokenFile = false;

function writeTokenFile(token: string): void {
	// Remove first and create exclusively with 0600 so a pre-planted file or symlink is not
	// followed and the file is never group/world readable, even for an instant.
	fs.rmSync(TOKEN_FILE, { force: true });
	fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600, flag: "wx" });
	wroteTokenFile = true;
}

function removeTokenFile(): void {
	if (!wroteTokenFile || policy.token === null) return;
	try {
		if (constantTimeEqual(fs.readFileSync(TOKEN_FILE, "utf8").trim(), policy.token)) {
			fs.rmSync(TOKEN_FILE, { force: true });
		}
	} catch {
		/* already gone */
	}
}

function urlHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

server.listen(policy.port, policy.host, () => {
	const address = server.address();
	const bound = address && typeof address === "object" ? address : null;
	const port = bound ? bound.port : policy.port;

	// Belt and braces: whatever the host name resolved to, a default (non-remote) start must
	// have ended up on a loopback interface. An address that is not an IP socket's is refused too.
	if (!policy.allowRemote && !isLoopbackHost(bound?.address)) {
		err(`pi-console: refusing to run: bound to non-loopback address ${String(bound?.address)}`);
		server.close();
		process.exit(2);
	}

	authorities = buildAuthorities(policy, port);
	const scheme = "http" + "://";
	const base = `${scheme}${urlHost(policy.host === "0.0.0.0" || policy.host === "::" ? "127.0.0.1" : normalizeHost(policy.host))}:${port}`;
	out(`pi-console listening on ${scheme}${urlHost(policy.host)}:${port}`);

	for (const warning of policy.warnings) err(`pi-console: WARNING: ${warning}`);

	if (policy.auth === "off") {
		err("pi-console: !!!!!!!! AUTHENTICATION IS OFF (PI_CONSOLE_AUTH=off) !!!!!!!!");
		err("pi-console: anything that can reach this port can run shell commands as you. Development only.");
	} else if (policy.tokenSource === "generated") {
		// A generated token has to reach the operator without landing in a shared log: show it
		// only on an interactive terminal; otherwise leave it in an owner-only file.
		if (process.stdout.isTTY) {
			out(`pi-console: open ${base}/#token=${policy.token}`);
		} else {
			try {
				writeTokenFile(policy.token);
				out(`pi-console: access token written to ${TOKEN_FILE} (owner-only); it is not logged`);
			} catch (error) {
				const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
				err(`pi-console: could not write the token file (${code}); set PI_CONSOLE_TOKEN instead`);
				process.exit(2);
			}
		}
	} else {
		out(`pi-console: access token required (from ${policy.tokenSource === "env" ? "PI_CONSOLE_TOKEN" : "PI_CONSOLE_TOKEN_FILE"})`);
	}
});

// -------------------------------------------------------------- shutdown ---
let shuttingDown = false;

async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	out("pi-console shutting down, stopping pi children...");
	// Last resort: never hang on a stuck child or connection.
	setTimeout(() => process.exit(0), 6000).unref();
	try {
		server.close(); // stop accepting; open connections are closed below
		closeAllStreams(); // end SSE responses (releases their tailer subscriptions and heartbeats)
		closeAllTailers(); // stop the session-file poll timers
		await killAll(); // SIGTERM, then SIGKILL for any pi child that ignores it
		server.closeAllConnections();
	} catch (error) {
		err(`pi-console: error during shutdown: ${describeError(error)}`);
	} finally {
		removeTokenFile();
		process.exit(0);
	}
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
