// pairing.ts — linking a phone: a one-time code from the operator, a request from the phone,
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
import { CODE_RE, formatCode, formatDeviceId, newPairingCode, normalizeCode, randomSecret, safeEqual } from "./codes.ts";
import { type DevicePublicKey, type DeviceRegistry, cleanDeviceName, parseDevicePublicKey } from "./devices.ts";

export const OFFER_TTL_MS = 5 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const REQUEST_TTL_MS = 5 * 60_000;
const DECIDED_KEEP_MS = 10 * 60_000;

/** The fields a phone signs when it asks to pair. */
export interface PairProofFields {
	readonly code: string;
	readonly fingerprint: string;
	readonly publicKey: string;
	readonly name: string;
}

/** The exact bytes a phone signs when it asks to pair. */
export function pairProofPayload({ code, fingerprint, publicKey, name }: PairProofFields): Buffer {
	return Buffer.from(["pirc-pair-v1", code, fingerprint, publicKey, name].join("\n"), "utf8");
}

/**
 * The platform a phone claims: shown to the operator in the terminal while they decide, so it is
 * printable, trimmed and bounded like a device name. Absent or empty is "android".
 */
export function cleanPlatform(value: unknown): string {
	const text = (typeof value === "string" ? value : "")
		// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 20);
	return text || "android";
}

/** Why a pairing step was refused; `code` is the machine-readable reason a phone sees. */
export type PairingErrorCode = "no_offer" | "offer_burned" | "bad_code" | "bad_key" | "bad_proof" | "unknown_request" | "not_owner";

export class PairingError extends Error {
	readonly status: number;
	readonly code: PairingErrorCode;
	constructor(status: number, code: PairingErrorCode, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export type PairRequestState = "pending" | "approved" | "rejected" | "cancelled" | "expired";

/** What may be shown about a request (no internal handles). */
export interface PublicPairRequest {
	requestId: string;
	deviceId: string;
	deviceIdDisplay: string;
	name: string;
	platform: string;
	address: string | null;
	state: PairRequestState;
	reason: string | null;
	alreadyLinked: boolean;
}

/**
 * Whoever opened an offer (an admin control connection). Compared by identity only; it is told
 * about requests on its offer and about the offer closing.
 */
export interface PairingOwner {
	onPairRequest?: ((request: PublicPairRequest) => void) | undefined;
	onOfferClosed?: ((offer: PairOffer, reason: string) => void) | undefined;
}

export interface PairOffer {
	readonly id: string;
	readonly code: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	attempts: number;
	readonly owner: PairingOwner | null;
	state: "open" | "claimed";
}

export interface PairRequest {
	readonly id: string;
	readonly offerId: string;
	readonly owner: PairingOwner | null;
	readonly deviceId: string;
	readonly name: string;
	readonly platform: string;
	/** Canonical SPKI DER, base64. */
	readonly publicKey: string;
	readonly address: string | null;
	state: PairRequestState;
	reason: string | null;
	readonly createdAt: number;
	readonly expiresAt: number;
	decidedAt: number;
	readonly waiters: Set<() => void>;
	readonly alreadyLinked: boolean;
}

/**
 * A phone's pairing request as POST /v1/pair carries it. `code` and `publicKey` may be anything
 * (normalizeCode and parseDevicePublicKey refuse what is not a string); the other fields are
 * strings or absent: the route refuses any other type, because the proof covers their exact text.
 */
export interface PairClaim {
	readonly code: unknown;
	readonly publicKey: unknown;
	readonly name?: string | undefined;
	readonly proof?: string | undefined;
	readonly platform?: string | undefined;
	readonly address: string;
}

export interface CreateOfferOptions {
	readonly owner?: PairingOwner | null | undefined;
	readonly ttlMs?: number | undefined;
}

export interface DecideOptions {
	readonly owner?: PairingOwner | null | undefined;
}

/** What Pairings needs from the device registry (DeviceRegistry provides it). */
export type PairingDevices = Pick<DeviceRegistry, "get" | "add">;

export type PairingAudit = (record: Readonly<Record<string, unknown>>) => void;

export interface PairingsOptions {
	readonly fingerprint: string;
	readonly devices: PairingDevices;
	readonly onAudit?: PairingAudit;
	readonly now?: () => number;
}

export class Pairings {
	readonly fingerprint: string;
	readonly devices: PairingDevices;
	readonly onAudit: PairingAudit;
	readonly now: () => number;
	offer: PairOffer | null = null;
	readonly requests = new Map<string, PairRequest>();

	constructor({ fingerprint, devices, onAudit = () => {}, now = () => Date.now() }: PairingsOptions) {
		this.fingerprint = fingerprint;
		this.devices = devices;
		this.onAudit = onAudit;
		this.now = now;
	}

	/** Open a new offer, replacing any previous one (its pending request is cancelled). */
	createOffer({ owner, ttlMs = OFFER_TTL_MS }: CreateOfferOptions = {}): PairOffer {
		this.cancelOffer("replaced");
		// NaN and 0 fall back to the default, as before; the result is clamped to 30 s .. 15 min.
		const ttl = Math.max(30_000, Math.min(ttlMs || OFFER_TTL_MS, 15 * 60_000));
		const offer: PairOffer = {
			id: crypto.randomBytes(8).toString("hex"),
			code: newPairingCode(),
			createdAt: this.now(),
			expiresAt: this.now() + ttl,
			attempts: 0,
			owner: owner ?? null,
			state: "open",
		};
		this.offer = offer;
		this.onAudit({ event: "pair_offer", offer: offer.id });
		return offer;
	}

	/** Close the open offer and cancel a request that is still waiting on it. */
	cancelOffer(reason = "cancelled"): void {
		const offer = this.offer;
		if (!offer) return;
		this.offer = null;
		for (const request of this.requests.values()) {
			if (request.offerId === offer.id && request.state === "pending") this.settle(request, "cancelled", reason);
		}
		if (offer.owner && typeof offer.owner.onOfferClosed === "function") offer.owner.onOfferClosed(offer, reason);
	}

	/** Forget everything owned by a control connection that went away. */
	releaseOwner(owner: PairingOwner): void {
		if (this.offer?.owner === owner) this.cancelOffer("operator left");
		for (const request of this.requests.values()) {
			if (request.owner === owner && request.state === "pending") this.settle(request, "cancelled", "operator left");
		}
	}

	expire(): void {
		const now = this.now();
		if (this.offer?.state === "open" && now > this.offer.expiresAt) this.cancelOffer("expired");
		for (const [id, request] of this.requests) {
			if (request.state === "pending" && now > request.expiresAt) this.settle(request, "expired", "not decided in time");
			if (request.state !== "pending" && now - request.decidedAt > DECIDED_KEEP_MS) this.requests.delete(id);
		}
	}

	/**
	 * A phone presents a code. Wrong codes count against the offer; the fifth burns it.
	 * @returns the new pending request
	 */
	claim({ code, publicKey, name, proof, platform, address }: PairClaim): PairRequest {
		this.expire();
		const offer = this.offer;
		if (offer?.state !== "open") throw new PairingError(410, "no_offer", "no pairing code is active; run /remote pair on the computer");
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

		let parsed: DevicePublicKey;
		try {
			parsed = parseDevicePublicKey(publicKey);
		} catch (error) {
			throw new PairingError(400, "bad_key", error instanceof Error ? error.message : String(error));
		}
		// parseDevicePublicKey accepted it, so it is a string; the proof covers its exact text.
		const publicKeyText = typeof publicKey === "string" ? publicKey : "";
		const deviceName = cleanDeviceName(name);
		let signature: Buffer;
		try {
			signature = Buffer.from(proof ?? "", "base64");
		} catch {
			signature = Buffer.alloc(0);
		}
		const payload = pairProofPayload({ code: typed, fingerprint: this.fingerprint, publicKey: publicKeyText, name: name ?? "" });
		let valid: boolean;
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
		const request: PairRequest = {
			id: randomSecret(16),
			offerId: offer.id,
			owner: offer.owner,
			deviceId: parsed.id,
			name: deviceName,
			platform: cleanPlatform(platform),
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
	decide(requestId: string, approve: boolean, { owner }: DecideOptions = {}): PublicPairRequest {
		const request = this.requests.get(requestId);
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

	settle(request: PairRequest, state: PairRequestState, reason: string | null): void {
		request.state = state;
		request.reason = reason;
		request.decidedAt = this.now();
		for (const wake of request.waiters) wake();
		request.waiters.clear();
	}

	/** Long-poll a request's state for up to `waitMs`. */
	async poll(requestId: string, waitMs = 25_000): Promise<PublicPairRequest | null> {
		this.expire();
		const request = this.requests.get(requestId);
		if (!request) return null;
		if (request.state === "pending" && waitMs > 0) {
			const { waiters } = request;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, waitMs);
				function done(): void {
					clearTimeout(timer);
					waiters.delete(done);
					resolve();
				}
				waiters.add(done);
			});
			this.expire();
		}
		return publicRequest(request);
	}

	offerSummary(): { id: string; expiresAt: string; attempts: number } | null {
		this.expire();
		if (!this.offer) return null;
		return { id: this.offer.id, expiresAt: new Date(this.offer.expiresAt).toISOString(), attempts: this.offer.attempts };
	}
}

/** What may be shown about a request (no internal handles). */
export function publicRequest(request: PairRequest): PublicPairRequest {
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
