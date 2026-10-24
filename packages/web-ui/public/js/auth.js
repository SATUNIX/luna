// Generated from packages/web-ui/src/public/js/auth.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// auth.js — the console access token, held only by this tab.
//
// The operator opens `http://host:port/#token=<token>` once (the `/console` command prints
// and opens exactly that). A URL fragment is never sent to the server, never appears in a
// Referer header and is not written to any server log, so it is the safest way to hand a
// secret to a page. This module moves it into sessionStorage (per tab, cleared when the tab
// closes, not shared with other localhost ports) and removes it from the address bar at once.
// Every API call then presents it as an `Authorization: Bearer` header (see api.js / sse.js).
//
// It is deliberately not a cookie: cookies are not port-isolated and would ride along on
// requests from any other localhost origin. A header the page attaches itself cannot be
// attached by a foreign page. See server/security.ts for the full reasoning.
const STORAGE_KEY = "pi-console.token";
// Same shape the server accepts (server/security.ts TOKEN_RE): 32-256 URL-safe characters.
const TOKEN_RE = /^[A-Za-z0-9._~-]{32,256}$/;
let memoryToken = null; // used when sessionStorage is unavailable
export function isPlausibleToken(value) {
    return typeof value === "string" && TOKEN_RE.test(value);
}
/**
 * The token held for this tab, or null. Storage is read as untrusted: only a value of the token's
 * shape is returned (this module only ever stores such values).
 */
export function getToken() {
    if (memoryToken)
        return memoryToken;
    try {
        const stored = sessionStorage.getItem(STORAGE_KEY);
        return isPlausibleToken(stored) ? stored : null;
    }
    catch {
        return null;
    }
}
export function setToken(token) {
    memoryToken = token;
    try {
        sessionStorage.setItem(STORAGE_KEY, token);
    }
    catch {
        /* storage may be unavailable; the in-memory copy still works for this page load */
    }
}
export function clearToken() {
    memoryToken = null;
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    }
    catch {
        /* ignore */
    }
}
/**
 * Take `#token=...` from the address bar, keep it for this tab and strip it from the URL.
 * A fragment that is not ours is left alone. Returns the token when a valid one was found.
 */
export function consumeFragmentToken() {
    if (typeof location === "undefined")
        return null;
    const hash = location.hash || "";
    if (!hash)
        return null;
    let candidate;
    try {
        candidate = new URLSearchParams(hash.replace(/^#/, "")).get("token");
    }
    catch {
        return null;
    }
    if (candidate === null)
        return null;
    // Remove the fragment whether or not the token is usable: it must not linger in history.
    try {
        history.replaceState(null, "", location.pathname + location.search);
    }
    catch {
        /* ignore */
    }
    if (!isPlausibleToken(candidate))
        return null;
    setToken(candidate);
    return candidate;
}
/** Headers that authenticate a request, or {} when there is no token (auth off / not yet entered). */
export function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}
