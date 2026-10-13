// auth.js — how a linked phone proves itself on every connection, and the tokens it then uses.
//
//   1. POST /v1/auth/challenge {deviceId}       -> a single-use 32-byte nonce, valid 60 s
//   2. the phone signs  pirc-auth-v1 | deviceId | nonce | certificate fingerprint | server id
//      with its Keystore key. The fingerprint is the one the phone saw in the TLS handshake, so a
//      signature relayed through someone else's TLS endpoint does not verify (channel binding).
//   3. POST /v1/auth/token {deviceId, nonce, signature} -> a 256-bit bearer token, 1 hour
//
// Tokens live only in memory and only as SHA-256 digests: a restart signs every phone out,
// and the phone signs back in without the operator. Revoking a device drops its tokens and
// closes its event streams at once.
import crypto from "node:crypto";
import { randomSecret, sha256 } from "./codes.js";

export const CHALLENGE_TTL_MS = 60_000;
export const DEFAULT_TOKEN_TTL_MS = 60 * 60_000;
const MAX_CHALLENGES = 2000;

export function authPayload({ deviceId, nonce, fingerprint, serverId }) {
	return Buffer.from(["pirc-auth-v1", deviceId, nonce, fingerprint, serverId].join("\n"), "utf8");
}

export class Authenticator {
	constructor({ devices, fingerprint, serverId, tokenTtlMs = DEFAULT_TOKEN_TTL_MS, now = () => Date.now() }) {
		this.devices = devices;
		this.fingerprint = fingerprint;
		this.serverId = serverId;
		this.tokenTtlMs = tokenTtlMs;
		this.now = now;
		this.challenges = new Map(); // nonce -> {deviceId, expiresAt}
		this.tokens = new Map(); // sha256(token) -> {deviceId, expiresAt}
		this.revokeListeners = new Set();
	}

	purge() {
		const now = this.now();
		for (const [nonce, c] of this.challenges) if (c.expiresAt < now) this.challenges.delete(nonce);
		for (const [digest, t] of this.tokens) if (t.expiresAt < now) this.tokens.delete(digest);
	}

	/** A nonce for `deviceId`. Unknown ids get one too, so the answer does not reveal who is linked. */
	challenge(deviceId) {
		this.purge();
		if (this.challenges.size >= MAX_CHALLENGES) {
			const oldest = this.challenges.keys().next().value;
			this.challenges.delete(oldest);
		}
		const nonce = randomSecret(32);
		this.challenges.set(nonce, { deviceId: String(deviceId), expiresAt: this.now() + CHALLENGE_TTL_MS });
		return { nonce, expiresInSec: CHALLENGE_TTL_MS / 1000 };
	}

	/**
	 * Check a signed challenge and issue a token.
	 * @returns {{token:string, expiresInSec:number, device:object}|{error:string}}
	 */
	exchange({ deviceId, nonce, signature }) {
		this.purge();
		const id = String(deviceId ?? "");
		const entry = this.challenges.get(String(nonce ?? ""));
		if (!entry) return { error: "unknown or expired challenge" };
		this.challenges.delete(String(nonce)); // single use, whatever the outcome
		if (entry.deviceId !== id) return { error: "challenge was issued to another device" };
		const device = this.devices.get(id);
		const key = this.devices.publicKey(id);
		if (!device || !key) return { error: "device is not linked" };
		let sig;
		try {
			sig = Buffer.from(String(signature ?? ""), "base64");
		} catch {
			return { error: "malformed signature" };
		}
		const payload = authPayload({ deviceId: id, nonce: String(nonce), fingerprint: this.fingerprint, serverId: this.serverId });
		let valid = false;
		try {
			valid = sig.length > 0 && crypto.verify("sha256", payload, key, sig);
		} catch {
			valid = false;
		}
		if (!valid) return { error: "signature does not verify" };
		const token = randomSecret(32);
		this.tokens.set(sha256(token), { deviceId: id, expiresAt: this.now() + this.tokenTtlMs });
		return { token, expiresInSec: Math.round(this.tokenTtlMs / 1000), device };
	}

	/** The linked device behind a bearer token, or null. */
	verify(token) {
		if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
		const entry = this.tokens.get(sha256(token));
		if (!entry) return null;
		if (entry.expiresAt < this.now()) {
			this.tokens.delete(sha256(token));
			return null;
		}
		const device = this.devices.get(entry.deviceId);
		if (!device) {
			this.tokens.delete(sha256(token));
			return null;
		}
		return device;
	}

	revokeDevice(deviceId) {
		for (const [digest, t] of this.tokens) if (t.deviceId === deviceId) this.tokens.delete(digest);
		for (const fn of this.revokeListeners) {
			try {
				fn(deviceId);
			} catch {
				/* a listener failing must not stop the revocation */
			}
		}
	}

	onRevoke(fn) {
		this.revokeListeners.add(fn);
		return () => this.revokeListeners.delete(fn);
	}

	activeDeviceIds() {
		this.purge();
		return new Set([...this.tokens.values()].map((t) => t.deviceId));
	}
}

/**
 * Per-address limits for the endpoints that answer without a token. Counting is a sliding
 * window of request times; addresses with repeated authentication failures are blocked for a while.
 */
export class RateLimiter {
	constructor({ perMinute = 60, failureLimit = 10, failureWindowMs = 10 * 60_000, blockMs = 15 * 60_000, now = () => Date.now() } = {}) {
		Object.assign(this, { perMinute, failureLimit, failureWindowMs, blockMs, now });
		this.hits = new Map();
		this.failures = new Map();
		this.blocked = new Map();
	}

	/** True when `address` may make another open request now. */
	allow(address) {
		const now = this.now();
		const until = this.blocked.get(address);
		if (until && until > now) return false;
		if (until) this.blocked.delete(address);
		const recent = (this.hits.get(address) || []).filter((t) => now - t < 60_000);
		if (recent.length >= this.perMinute) {
			this.hits.set(address, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(address, recent);
		if (this.hits.size > 5000) this.hits.delete(this.hits.keys().next().value);
		return true;
	}

	/** Count a failed pairing or authentication; returns true when the address is now blocked. */
	fail(address) {
		const now = this.now();
		const recent = (this.failures.get(address) || []).filter((t) => now - t < this.failureWindowMs);
		recent.push(now);
		this.failures.set(address, recent);
		if (recent.length >= this.failureLimit) {
			this.blocked.set(address, now + this.blockMs);
			this.failures.delete(address);
			return true;
		}
		return false;
	}

	isBlocked(address) {
		const until = this.blocked.get(address);
		return Boolean(until && until > this.now());
	}
}
