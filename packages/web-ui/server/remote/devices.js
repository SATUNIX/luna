// devices.js — the registry of linked phones: public keys only, never a secret.
import crypto from "node:crypto";
import { DEVICE_ID_RE, deviceIdFromSpki } from "./codes.js";
import { readJsonFile, writePrivateFile } from "./store.js";

const NAME_MAX = 64;
const SEEN_WRITE_INTERVAL_MS = 60_000;

/** A display name a phone may claim: printable, trimmed, bounded. */
export function cleanDeviceName(value) {
	const text = String(value ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, NAME_MAX);
	return text || "phone";
}

/**
 * Parse a phone's public key (base64 SPKI DER). Only EC P-256 keys are accepted: that is what
 * the app generates in the Android Keystore, and it bounds what the verifier has to handle.
 * @returns {{key: crypto.KeyObject, spki: Buffer, id: string}}
 */
export function parseDevicePublicKey(b64) {
	if (typeof b64 !== "string" || b64.length > 400) throw new Error("public key missing or too long");
	const spki = Buffer.from(b64, "base64");
	let key;
	try {
		key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
	} catch {
		throw new Error("public key is not a valid SPKI structure");
	}
	const details = key.asymmetricKeyDetails || {};
	if (key.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") {
		throw new Error("public key must be EC P-256");
	}
	const canonical = key.export({ type: "spki", format: "der" });
	return { key, spki: canonical, id: deviceIdFromSpki(canonical) };
}

export class DeviceRegistry {
	constructor(file) {
		this.file = file;
		this.devices = new Map();
		this.keys = new Map();
		this.dirty = false;
		this.lastWrite = 0;
		const saved = readJsonFile(file, { devices: [] });
		for (const record of Array.isArray(saved.devices) ? saved.devices : []) {
			if (!record || !DEVICE_ID_RE.test(String(record.id))) continue;
			try {
				const parsed = parseDevicePublicKey(record.publicKey);
				if (parsed.id !== record.id) continue; // a record whose id does not match its key is not trusted
				this.devices.set(record.id, { ...record, name: cleanDeviceName(record.name) });
				this.keys.set(record.id, parsed.key);
			} catch {
				/* unusable record: ignored, never treated as a device */
			}
		}
	}

	list() {
		return [...this.devices.values()].sort((a, b) => String(a.pairedAt).localeCompare(String(b.pairedAt)));
	}

	get(id) {
		return this.devices.get(id) || null;
	}

	publicKey(id) {
		return this.keys.get(id) || null;
	}

	/** Find a device by full id or an unambiguous prefix (dashes ignored, case-insensitive). */
	resolve(query) {
		const q = String(query ?? "")
			.toUpperCase()
			.replace(/[\s-]/g, "");
		if (!q) return null;
		if (this.devices.has(q)) return this.devices.get(q);
		const matches = this.list().filter((d) => d.id.startsWith(q) || d.name.toUpperCase() === q);
		return matches.length === 1 ? matches[0] : null;
	}

	add({ publicKey, name, platform, address }) {
		const parsed = parseDevicePublicKey(publicKey);
		const now = new Date().toISOString();
		const record = {
			id: parsed.id,
			name: cleanDeviceName(name),
			platform: String(platform || "android").slice(0, 20),
			publicKey: parsed.spki.toString("base64"),
			pairedAt: now,
			pairedFrom: address || null,
			lastSeenAt: now,
			lastAddress: address || null,
		};
		this.devices.set(record.id, record);
		this.keys.set(record.id, parsed.key);
		this.save();
		return record;
	}

	setName(id, name) {
		const record = this.devices.get(id);
		if (!record) return null;
		record.name = cleanDeviceName(name);
		this.save();
		return record;
	}

	remove(id) {
		const existed = this.devices.delete(id);
		this.keys.delete(id);
		if (existed) this.save();
		return existed;
	}

	/** Record a successful authentication; written to disk at most once a minute. */
	touch(id, address) {
		const record = this.devices.get(id);
		if (!record) return;
		record.lastSeenAt = new Date().toISOString();
		record.lastAddress = address || record.lastAddress;
		this.dirty = true;
		if (Date.now() - this.lastWrite > SEEN_WRITE_INTERVAL_MS) this.save();
	}

	save() {
		writePrivateFile(this.file, `${JSON.stringify({ version: 1, devices: this.list() }, null, 2)}\n`);
		this.dirty = false;
		this.lastWrite = Date.now();
	}

	flush() {
		if (this.dirty) this.save();
	}
}
