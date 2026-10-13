// codes.js — identifiers and secrets of the remote host, and how people read them.
import crypto from "node:crypto";

// Crockford base32 without I, L, O and U: nothing an operator can misread or mistype.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Base32 of `buf`, `chars` characters long (5 bits per character, most significant first). */
export function base32(buf, chars) {
	let out = "";
	let acc = 0;
	let bits = 0;
	for (const byte of buf) {
		acc = (acc << 8) | byte;
		bits += 8;
		while (bits >= 5 && out.length < chars) {
			out += ALPHABET[(acc >>> (bits - 5)) & 31];
			bits -= 5;
		}
		acc &= (1 << bits) - 1;
	}
	if (out.length < chars) throw new Error("not enough input for the requested length");
	return out;
}

/** A pairing code: 10 characters, 50 bits, shown as XXXXX-XXXXX. */
export function newPairingCode() {
	return base32(crypto.randomBytes(8), 10);
}

/** Canonical form of a typed code: upper case, no separators, look-alikes mapped. */
export function normalizeCode(input) {
	return String(input ?? "")
		.toUpperCase()
		.replace(/[\s-]/g, "")
		.replace(/O/g, "0")
		.replace(/[IL]/g, "1")
		.replace(/U/g, "V");
}

export function formatCode(code) {
	return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * A device's id: the first 80 bits of SHA-256 over its public key (SPKI DER), base32.
 * Phones derive the same value, so the operator can compare the two screens.
 */
export function deviceIdFromSpki(spkiDer) {
	return base32(crypto.createHash("sha256").update(spkiDer).digest(), 16);
}

export const DEVICE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

export function formatDeviceId(id) {
	return String(id).match(/.{1,4}/g).join("-");
}

/** 256 random bits, URL-safe. */
export function randomSecret(bytes = 32) {
	return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(text) {
	return crypto.createHash("sha256").update(String(text)).digest("base64url");
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a, b) {
	const ha = crypto.createHash("sha256").update(String(a)).digest();
	const hb = crypto.createHash("sha256").update(String(b)).digest();
	return crypto.timingSafeEqual(ha, hb);
}
