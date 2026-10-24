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
//
// Everything the app sends is `unknown` here and narrowed before use; results are handed on as
// `unknown` for the caller to narrow.

/** A message from the app, as the channel delivers it (a MessageEvent from the real bridge). */
export interface NativeMessageEvent {
	readonly data: unknown;
}

export type NativeMessageHandler = (event: NativeMessageEvent) => void;

/**
 * The object the app injects as `piNative` (the JavaScript side of
 * WebViewCompat.addWebMessageListener, apps/android/.../MainActivity.kt), or a development
 * stand-in (mobile/dev/mock-native.ts). The app reads only strings (Bridge.onMessage) and
 * answers with strings (JavaScriptReplyProxy.postMessage).
 */
export interface NativeChannel {
	postMessage(message: string): void;
	addEventListener?(type: "message", listener: NativeMessageHandler): void;
	onmessage?: NativeMessageHandler | null;
}

declare global {
	// Injected by the app on its own origin only; absent in a plain browser. Narrowed by attach().
	var piNative: unknown;
}

type EmptyParams = Record<string, never>;

/** Every method the app answers (Bridge.handle), with the parameters it reads. */
export interface NativeParams {
	"app.info": EmptyParams;
	"app.setLock": { enabled: boolean };
	"app.setSecureScreen": { enabled: boolean };
	"app.haptic": { kind?: string };
	"app.openUrl": { url: string | null };
	"app.exit": EmptyParams;
	"hosts.list": EmptyParams;
	"hosts.probe": { hostId: string };
	"hosts.rename": { hostId: string; name: string };
	"hosts.remove": { hostId: string; unlinkRemote?: boolean };
	"pair.scan": EmptyParams;
	"pair.probe": { address: string; port: number };
	"pair.begin": { link: string } | { addresses: string[]; port: number; fingerprint: string; code: string };
	"pair.wait": { pairingId: string };
	"pair.cancel": { pairingId: string };
	"api.request": { hostId: string; method: string; path: string; body?: unknown };
	"api.stream": { hostId: string; path: string };
	"api.closeStream": { streamId: string };
}

export type NativeMethod = keyof NativeParams;

/** A refused request: `code` from the app (BridgeError), `status` from an HTTP error. */
export interface NativeError extends Error {
	code?: string | undefined;
	status?: number | undefined;
}

export interface StreamFrameEvent {
	event: "stream.frame";
	streamId: string;
	name: string;
	data: unknown;
}

export interface StreamStateEvent {
	event: "stream.state";
	streamId: string;
	/** "closed" or "error" from the app. */
	state: string;
	message: string | null;
}

export interface DeeplinkEvent {
	event: "deeplink";
	link: string | undefined;
}

/** The events the app sends unasked, by name. */
export interface NativeEvents {
	"stream.frame": StreamFrameEvent;
	"stream.state": StreamStateEvent;
	deeplink: DeeplinkEvent;
	resume: { event: "resume" };
	pause: { event: "pause" };
	back: { event: "back" };
}

export type NativeEventName = keyof NativeEvents;

/** One server-sent event of a stream, its data parsed. */
export interface StreamFrame {
	name: string;
	data: unknown;
}

/** `state` is "open", "closed" or "error". */
export type StreamStateHandler = (state: string, message?: string | null) => void;

export interface NativeStream {
	close(): void;
}

interface Pending {
	resolve: (result: unknown) => void;
	reject: (error: NativeError) => void;
}

type Message = Record<string, unknown>;

function isRecord(value: unknown): value is Message {
	return typeof value === "object" && value !== null;
}

function isChannel(value: unknown): value is NativeChannel {
	return isRecord(value) && typeof value.postMessage === "function";
}

/** Each event's narrowing: null drops a message no listener could use. */
const EVENTS: { [E in NativeEventName]: (msg: Message) => NativeEvents[E] | null } = {
	"stream.frame": (msg) =>
		typeof msg.streamId === "string" && typeof msg.name === "string"
			? { event: "stream.frame", streamId: msg.streamId, name: msg.name, data: msg.data }
			: null,
	"stream.state": (msg) =>
		typeof msg.streamId === "string" && typeof msg.state === "string"
			? { event: "stream.state", streamId: msg.streamId, state: msg.state, message: typeof msg.message === "string" ? msg.message : null }
			: null,
	deeplink: (msg) => ({ event: "deeplink", link: typeof msg.link === "string" ? msg.link : undefined }),
	resume: () => ({ event: "resume" }),
	pause: () => ({ event: "pause" }),
	back: () => ({ event: "back" }),
};

let channel: NativeChannel | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(msg: Message) => void>>();

function dispatch(raw: unknown): void {
	let msg: unknown;
	try {
		msg = typeof raw === "string" ? JSON.parse(raw) : raw;
	} catch {
		return;
	}
	if (!isRecord(msg)) return;
	const entry = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
	if (typeof msg.id === "number" && entry) {
		const { resolve, reject } = entry;
		pending.delete(msg.id);
		if (msg.ok) resolve(msg.result);
		else {
			const detail = isRecord(msg.error) ? msg.error : undefined;
			const message = typeof detail?.message === "string" ? detail.message : "";
			const error: NativeError = Object.assign(new Error(message || "the app refused the request"), {
				code: typeof detail?.code === "string" ? detail.code : undefined,
				status: typeof detail?.status === "number" ? detail.status : undefined,
			});
			reject(error);
		}
		return;
	}
	if (typeof msg.event === "string") {
		for (const fn of listeners.get(msg.event) ?? []) {
			try {
				fn(msg);
			} catch (error) {
				console.error(error);
			}
		}
	}
}

/** Connect to the app's channel (or a development stand-in). Returns false outside the app. */
export function attach(target: unknown = globalThis.piNative): boolean {
	if (!isChannel(target)) return false;
	channel = target;
	if (typeof channel.addEventListener === "function") channel.addEventListener("message", (event) => { dispatch(event.data); });
	else channel.onmessage = (event) => { dispatch(event.data); };
	return true;
}

export function call<M extends NativeMethod>(method: M, params?: NativeParams[M]): Promise<unknown> {
	const target = channel;
	if (!target) return Promise.reject(new Error("not running inside the pi remote app"));
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		target.postMessage(JSON.stringify({ id, method, params: params ?? {} }));
	});
}

export function on<E extends NativeEventName>(event: E, fn: (msg: NativeEvents[E]) => void): () => void {
	const narrow: (msg: Message) => NativeEvents[E] | null = EVENTS[event];
	const listener = (msg: Message): void => {
		const parsed = narrow(msg);
		if (parsed) fn(parsed);
	};
	let set = listeners.get(event);
	if (!set) {
		set = new Set();
		listeners.set(event, set);
	}
	set.add(listener);
	return () => listeners.get(event)?.delete(listener);
}

/** A JSON API call to a linked computer. Throws with `.status` on an HTTP error. */
export async function api(hostId: string, method: string, path: string, body?: unknown): Promise<unknown> {
	const result = await call("api.request", { hostId, method, path, body });
	if (!isRecord(result)) throw new Error("the app sent a malformed answer");
	if (typeof result.status === "number" && result.status >= 400) {
		const detail = isRecord(result.json) ? result.json.error : undefined;
		const error: NativeError = Object.assign(new Error(typeof detail === "string" && detail ? detail : `request failed (${String(result.status)})`), { status: result.status });
		throw error;
	}
	return result.json;
}

/**
 * A session's event stream. `onFrame({name, data})` gets each server-sent event (data parsed),
 * `onState(state, message)` gets "open", "closed" or "error". Returns {close()}.
 */
export function openStream(hostId: string, path: string, onFrame: (frame: StreamFrame) => void, onState: StreamStateHandler): NativeStream {
	let streamId: string | null = null;
	let closed = false;
	const offFrame = on("stream.frame", (msg) => {
		if (msg.streamId !== streamId) return;
		let data: unknown;
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
	const detach = (): void => {
		offFrame();
		offState();
	};
	call("api.stream", { hostId, path })
		.then((result) => {
			streamId = isRecord(result) && typeof result.streamId === "string" ? result.streamId : null;
			if (closed) {
				if (streamId) call("api.closeStream", { streamId }).catch(() => {});
				detach();
				return;
			}
			onState("open");
		})
		.catch((error: unknown) => {
			detach();
			if (!closed) onState("error", error instanceof Error ? error.message : String(error));
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
