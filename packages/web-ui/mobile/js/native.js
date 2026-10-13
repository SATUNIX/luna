// native.js — the page's only way out: messages to the pi remote Android app.
//
// The page never opens a network connection itself (its CSP forbids it). Every request to a
// computer goes through the app, which holds the phone's keys in the Android Keystore, pins
// each computer's certificate, signs in and keeps the short-lived token. The app exposes one
// object, `piNative`, to this page's origin only (WebViewCompat.addWebMessageListener).
//
//   page -> app   {"id": 7, "method": "api.request", "params": {...}}
//   app -> page   {"id": 7, "ok": true, "result": {...}}   or   {"id": 7, "ok": false, "error": {...}}
//   app -> page   {"event": "stream.frame", "streamId": "s1", "name": "event", "data": "<json>"}
//                 {"event": "stream.state", "streamId": "s1", "state": "closed", "message": "..."}
//                 {"event": "deeplink", "link": "pirc://pair?..."}   {"event": "resume"}   {"event": "pause"}
//                 {"event": "back"}   (the system back gesture; the page answers app.exit at its first screen)

let channel = null;
let nextId = 1;
const pending = new Map();
const listeners = new Map();

function dispatch(raw) {
	let msg;
	try {
		msg = typeof raw === "string" ? JSON.parse(raw) : raw;
	} catch {
		return;
	}
	if (!msg || typeof msg !== "object") return;
	if (msg.id !== undefined && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.ok) resolve(msg.result);
		else {
			const error = new Error((msg.error && msg.error.message) || "the app refused the request");
			error.code = msg.error && msg.error.code;
			error.status = msg.error && msg.error.status;
			reject(error);
		}
		return;
	}
	if (typeof msg.event === "string") {
		for (const fn of listeners.get(msg.event) || []) {
			try {
				fn(msg);
			} catch (error) {
				console.error(error);
			}
		}
	}
}

/** Connect to the app's channel (or a development stand-in). Returns false outside the app. */
export function attach(target = globalThis.piNative) {
	if (!target || typeof target.postMessage !== "function") return false;
	channel = target;
	if (typeof channel.addEventListener === "function") channel.addEventListener("message", (event) => dispatch(event.data));
	else channel.onmessage = (event) => dispatch(event.data);
	return true;
}

export function call(method, params = {}) {
	if (!channel) return Promise.reject(new Error("not running inside the pi remote app"));
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		channel.postMessage(JSON.stringify({ id, method, params }));
	});
}

export function on(event, fn) {
	if (!listeners.has(event)) listeners.set(event, new Set());
	listeners.get(event).add(fn);
	return () => listeners.get(event).delete(fn);
}

/** A JSON API call to a linked computer. Throws with `.status` on an HTTP error. */
export async function api(hostId, method, path, body) {
	const result = await call("api.request", { hostId, method, path, body });
	if (result.status >= 400) {
		const error = new Error((result.json && result.json.error) || `request failed (${result.status})`);
		error.status = result.status;
		throw error;
	}
	return result.json;
}

/**
 * A session's event stream. `onFrame({name, data})` gets each server-sent event (data parsed),
 * `onState(state, message)` gets "open", "closed" or "error". Returns {close()}.
 */
export function openStream(hostId, path, onFrame, onState) {
	let streamId = null;
	let closed = false;
	const offFrame = on("stream.frame", (msg) => {
		if (msg.streamId !== streamId) return;
		let data = null;
		try {
			data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
		} catch {
			return;
		}
		onFrame({ name: msg.name, data });
	});
	const offState = on("stream.state", (msg) => {
		if (msg.streamId !== streamId) return;
		onState(msg.state, msg.message);
	});
	const detach = () => {
		offFrame();
		offState();
	};
	call("api.stream", { hostId, path })
		.then((result) => {
			streamId = result.streamId;
			if (closed) {
				call("api.closeStream", { streamId }).catch(() => {});
				detach();
				return;
			}
			onState("open");
		})
		.catch((error) => {
			detach();
			if (!closed) onState("error", error.message);
		});
	return {
		close() {
			if (closed) return;
			closed = true;
			if (streamId) call("api.closeStream", { streamId }).catch(() => {});
			detach();
		},
	};
}
