// Generated from packages/web-ui/src/mobile/js/native.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
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
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isChannel(value) {
    return isRecord(value) && typeof value.postMessage === "function";
}
/** Each event's narrowing: null drops a message no listener could use. */
const EVENTS = {
    "stream.frame": (msg) => typeof msg.streamId === "string" && typeof msg.name === "string"
        ? { event: "stream.frame", streamId: msg.streamId, name: msg.name, data: msg.data }
        : null,
    "stream.state": (msg) => typeof msg.streamId === "string" && typeof msg.state === "string"
        ? { event: "stream.state", streamId: msg.streamId, state: msg.state, message: typeof msg.message === "string" ? msg.message : null }
        : null,
    deeplink: (msg) => ({ event: "deeplink", link: typeof msg.link === "string" ? msg.link : undefined }),
    resume: () => ({ event: "resume" }),
    pause: () => ({ event: "pause" }),
    back: () => ({ event: "back" }),
};
let channel = null;
let nextId = 1;
const pending = new Map();
const listeners = new Map();
function dispatch(raw) {
    let msg;
    try {
        msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    }
    catch {
        return;
    }
    if (!isRecord(msg))
        return;
    const entry = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (typeof msg.id === "number" && entry) {
        const { resolve, reject } = entry;
        pending.delete(msg.id);
        if (msg.ok)
            resolve(msg.result);
        else {
            const detail = isRecord(msg.error) ? msg.error : undefined;
            const message = typeof detail?.message === "string" ? detail.message : "";
            const error = Object.assign(new Error(message || "the app refused the request"), {
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
            }
            catch (error) {
                console.error(error);
            }
        }
    }
}
/** Connect to the app's channel (or a development stand-in). Returns false outside the app. */
export function attach(target = globalThis.piNative) {
    if (!isChannel(target))
        return false;
    channel = target;
    if (typeof channel.addEventListener === "function")
        channel.addEventListener("message", (event) => { dispatch(event.data); });
    else
        channel.onmessage = (event) => { dispatch(event.data); };
    return true;
}
export function call(method, params) {
    const target = channel;
    if (!target)
        return Promise.reject(new Error("not running inside the pi remote app"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage(JSON.stringify({ id, method, params: params ?? {} }));
    });
}
export function on(event, fn) {
    const narrow = EVENTS[event];
    const listener = (msg) => {
        const parsed = narrow(msg);
        if (parsed)
            fn(parsed);
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
export async function api(hostId, method, path, body) {
    const result = await call("api.request", { hostId, method, path, body });
    if (!isRecord(result))
        throw new Error("the app sent a malformed answer");
    if (typeof result.status === "number" && result.status >= 400) {
        const detail = isRecord(result.json) ? result.json.error : undefined;
        const error = Object.assign(new Error(typeof detail === "string" && detail ? detail : `request failed (${String(result.status)})`), { status: result.status });
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
        if (msg.streamId !== streamId)
            return;
        let data;
        try {
            data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
        }
        catch {
            return;
        }
        onFrame({ name: msg.name, data });
    });
    const offState = on("stream.state", (msg) => {
        if (msg.streamId !== streamId)
            return;
        onState(msg.state, msg.message);
    });
    const detach = () => {
        offFrame();
        offState();
    };
    call("api.stream", { hostId, path })
        .then((result) => {
        streamId = isRecord(result) && typeof result.streamId === "string" ? result.streamId : null;
        if (closed) {
            if (streamId)
                call("api.closeStream", { streamId }).catch(() => { });
            detach();
            return;
        }
        onState("open");
    })
        .catch((error) => {
        detach();
        if (!closed)
            onState("error", error instanceof Error ? error.message : String(error));
    });
    return {
        close() {
            if (closed)
                return;
            closed = true;
            if (streamId)
                call("api.closeStream", { streamId }).catch(() => { });
            detach();
        },
    };
}
