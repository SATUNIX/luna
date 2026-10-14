// pairing.js — linking a phone: a one-time code from the operator, a request from the phone,
// and the operator's decision.
//
//   offer    created by `/remote pair` (or the CLI): a 50-bit code, 5 minutes, 5 wrong guesses,
//            single use, at most one open at a time. It belongs to the control connection
//            that made it and dies with it.
//   request  created when a phone presents the right code with a fresh public key and a
//            signature made with that key over the code, the certificate fingerprint it saw and
//            the key itself (proof of possession, and a check that no one re-encrypted the
//            connection in between). It waits for the operator: the code alone never links a
//            device. The phone polls it by a 128-bit id only it was told.
import crypto from "node:crypto";
import { CODE_RE, formatCode, formatDeviceId, newPairingCode, normalizeCode, randomSecret, safeEqual } from "./codes.js";
import { cleanDeviceName, parseDevicePublicKey } from "./devices.js";

export const OFFER_TTL_MS = 5 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const REQUEST_TTL_MS = 5 * 60_000;
const DECIDED_KEEP_MS = 10 * 60_000;

/** The exact bytes a phone signs when it asks to pair. */
export function pairProofPayload({ code, fingerprint, publicKey, name }) {
	return Buffer.from(["pirc-pair-v1", code, fingerprint, publicKey, name].join("\n"), "utf8");
}

export class PairingError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class Pairings {
	/**
	 * @param {{fingerprint:string, devices:import("./devices.js").DeviceRegistry, onAudit?:Function, now?:() => number}} opts
	 */
	constructor({ fingerprint, devices, onAudit = () => {}, now = () => Date.now() }) {
		this.fingerprint = fingerprint;
		this.devices = devices;
		this.onAudit = onAudit;
		this.now = now;
		this.offer = null;
		this.requests = new Map();
	}

	/** Open a new offer, replacing any previous one (its pending request is cancelled). */
	createOffer({ owner, ttlMs = OFFER_TTL_MS } = {}) {
		this.cancelOffer("replaced");
		const ttl = Math.max(30_000, Math.min(Number(ttlMs) || OFFER_TTL_MS, 15 * 60_000));
		this.offer = {
			id: crypto.randomBytes(8).toString("hex"),
			code: newPairingCode(),
			createdAt: this.now(),
			expiresAt: this.now() + ttl,
			attempts: 0,
			owner,
			state: "open",
		};
		this.onAudit({ event: "pair_offer", offer: this.offer.id });
		return this.offer;
	}

	/** Close the open offer and cancel a request that is still waiting on it. */
	cancelOffer(reason = "cancelled") {
		const offer = this.offer;
		if (!offer) return;
		this.offer = null;
		for (const request of this.requests.values()) {
			if (request.offerId === offer.id && request.state === "pending") this.settle(request, "cancelled", reason);
		}
		if (offer.owner && typeof offer.owner.onOfferClosed === "function") offer.owner.onOfferClosed(offer, reason);
	}

	/** Forget everything owned by a control connection that went away. */
	releaseOwner(owner) {
		if (this.offer && this.offer.owner === owner) this.cancelOffer("operator left");
		for (const request of this.requests.values()) {
			if (request.owner === owner && request.state === "pending") this.settle(request, "cancelled", "operator left");
		}
	}

	expire() {
		const now = this.now();
		if (this.offer && this.offer.state === "open" && now > this.offer.expiresAt) this.cancelOffer("expired");
		for (const [id, request] of this.requests) {
			if (request.state === "pending" && now > request.expiresAt) this.settle(request, "expired", "not decided in time");
			if (request.state !== "pending" && now - request.decidedAt > DECIDED_KEEP_MS) this.requests.delete(id);
		}
	}

	/**
	 * A phone presents a code. Wrong codes count against the offer; the fifth burns it.
	 * @returns the new pending request
	 */
	claim({ code, publicKey, name, proof, platform, address }) {
		this.expire();
		const offer = this.offer;
		if (!offer || offer.state !== "open") throw new PairingError(410, "no_offer", "no pairing code is active; run /remote pair on the computer");
		const typed = normalizeCode(code);
		if (!CODE_RE.test(typed) || !safeEqual(typed, offer.code)) {
			offer.attempts++;
			this.onAudit({ event: "pair_bad_code", offer: offer.id, address, attempts: offer.attempts });
			if (offer.attempts >= MAX_CODE_ATTEMPTS) {
				this.cancelOffer("too many wrong codes");
				throw new PairingError(410, "offer_burned", "too many wrong codes; start a new pairing on the computer");
			}
			throw new PairingError(403, "bad_code", "wrong pairing code");
		}

		let parsed;
		try {
			parsed = parseDevicePublicKey(publicKey);
		} catch (error) {
			throw new PairingError(400, "bad_key", error.message);
		}
		const deviceName = cleanDeviceName(name);
		let signature;
		try {
			signature = Buffer.from(String(proof ?? ""), "base64");
		} catch {
			signature = Buffer.alloc(0);
		}
		const payload = pairProofPayload({ code: typed, fingerprint: this.fingerprint, publicKey: String(publicKey), name: String(name ?? "") });
		let valid = false;
		try {
			valid = signature.length > 0 && crypto.verify("sha256", payload, parsed.key, signature);
		} catch {
			valid = false;
		}
		if (!valid) {
			// A correct code with a proof over a different certificate means the phone talked to
			// someone else's TLS endpoint: the code has leaked to a man in the middle. Burn it.
			this.onAudit({ event: "pair_bad_proof", offer: offer.id, address });
			this.cancelOffer("proof failed");
			throw new PairingError(403, "bad_proof", "the pairing proof does not match this host's certificate; pairing cancelled");
		}

		offer.state = "claimed";
		const request = {
			id: randomSecret(16),
			offerId: offer.id,
			owner: offer.owner,
			deviceId: parsed.id,
			name: deviceName,
			platform: String(platform || "android").slice(0, 20),
			publicKey: parsed.spki.toString("base64"),
			address: address || null,
			state: "pending",
			reason: null,
			createdAt: this.now(),
			expiresAt: this.now() + REQUEST_TTL_MS,
			decidedAt: 0,
			waiters: new Set(),
			alreadyLinked: Boolean(this.devices.get(parsed.id)),
		};
		this.requests.set(request.id, request);
		this.offer = null; // single use
		this.onAudit({ event: "pair_request", deviceId: parsed.id, name: deviceName, address });
		if (offer.owner && typeof offer.owner.onPairRequest === "function") offer.owner.onPairRequest(publicRequest(request));
		return request;
	}

	/** The operator's answer. Approving stores the device. */
	decide(requestId, approve, { owner } = {}) {
		const request = this.requests.get(String(requestId));
		if (!request) throw new PairingError(404, "unknown_request", "no such pairing request");
		if (owner && request.owner && owner !== request.owner) throw new PairingError(403, "not_owner", "this pairing belongs to another terminal");
		if (request.state !== "pending") return publicRequest(request);
		if (approve) {
			this.devices.add({ publicKey: request.publicKey, name: request.name, platform: request.platform, address: request.address });
			this.settle(request, "approved", null);
			this.onAudit({ event: "pair_approved", deviceId: request.deviceId, name: request.name });
		} else {
			this.settle(request, "rejected", "the operator rejected the link");
			this.onAudit({ event: "pair_rejected", deviceId: request.deviceId, name: request.name });
		}
		return publicRequest(request);
	}

	settle(request, state, reason) {
		request.state = state;
		request.reason = reason;
		request.decidedAt = this.now();
		for (const wake of request.waiters) wake();
		request.waiters.clear();
	}

	/** Long-poll a request's state for up to `waitMs`. */
	async poll(requestId, waitMs = 25_000) {
		this.expire();
		const request = this.requests.get(String(requestId));
		if (!request) return null;
		if (request.state === "pending" && waitMs > 0) {
			await new Promise((resolve) => {
				const timer = setTimeout(done, waitMs);
				function done() {
					clearTimeout(timer);
					request.waiters.delete(done);
					resolve();
				}
				request.waiters.add(done);
			});
			this.expire();
		}
		return publicRequest(request);
	}

	offerSummary() {
		this.expire();
		if (!this.offer) return null;
		return { id: this.offer.id, expiresAt: new Date(this.offer.expiresAt).toISOString(), attempts: this.offer.attempts };
	}
}

/** What may be shown about a request (no internal handles). */
export function publicRequest(request) {
	return {
		requestId: request.id,
		deviceId: request.deviceId,
		deviceIdDisplay: formatDeviceId(request.deviceId),
		name: request.name,
		platform: request.platform,
		address: request.address,
		state: request.state,
		reason: request.reason,
		alreadyLinked: request.alreadyLinked,
	};
}

export { formatCode };
