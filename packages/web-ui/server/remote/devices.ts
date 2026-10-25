// devices.ts — the registry of linked phones: public keys only, never a secret.
import crypto from "node:crypto";
import { DEVICE_ID_RE, deviceIdFromSpki } from "./codes.ts";
import { type Infer, isRecord, nullable, object, safeParse, string } from "../../../core/lib/guard.ts";
import { readJsonFile, writePrivateFile } from "./store.ts";

const NAME_MAX = 64;
const PUBLIC_KEY_MAX = 400;
const SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * A linked device as devices.json stores it (exactly what `add` writes). The file is read as
 * untrusted: a record of any other shape is ignored, and one whose id does not match its key too.
 */
export const DeviceRecordSchema = object({
	id: string({ pattern: DEVICE_ID_RE }),
	name: string(),
	platform: string(),
	publicKey: string({ maxLength: PUBLIC_KEY_MAX }),
	pairedAt: string(),
	pairedFrom: nullable(string()),
	lastSeenAt: string(),
	lastAddress: nullable(string()),
});
export type DeviceRecord = Infer<typeof DeviceRecordSchema>;

/** A phone's public key, parsed and checked. */
export interface DevicePublicKey {
	readonly key: crypto.KeyObject;
	/** The canonical SPKI DER encoding. */
	readonly spki: Buffer;
	readonly id: string;
}

/** What a newly approved phone brings: its key and the details it claimed. */
export interface NewDevice {
	readonly publicKey: unknown;
	readonly name?: unknown;
	readonly platform?: string | null;
	readonly address?: string | null;
}

/** A display name a phone may claim: printable, trimmed, bounded. Anything but a string is "phone". */
export function cleanDeviceName(value: unknown): string {
	const text = (typeof value === "string" ? value : "")
		// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, NAME_MAX);
	return text || "phone";
}

/**
 * Parse a phone's public key (base64 SPKI DER). Only EC P-256 keys are accepted: that is what
 * the app generates in the Android Keystore, and it bounds what the verifier has to handle.
 */
export function parseDevicePublicKey(b64: unknown): DevicePublicKey {
	if (typeof b64 !== "string" || b64.length > PUBLIC_KEY_MAX) throw new Error("public key missing or too long");
	const spki = Buffer.from(b64, "base64");
	let key: crypto.KeyObject;
	try {
		key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
	} catch {
		throw new Error("public key is not a valid SPKI structure");
	}
	if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
		throw new Error("public key must be EC P-256");
	}
	const canonical = key.export({ type: "spki", format: "der" });
	return { key, spki: canonical, id: deviceIdFromSpki(canonical) };
}

export class DeviceRegistry {
	readonly file: string;
	private readonly devices = new Map<string, DeviceRecord>();
	private readonly keys = new Map<string, crypto.KeyObject>();
	/** Devices kept in the file but not trusted to log in (remote-host.ts: no pairing record in the audit log). */
	private readonly suspended = new Set<string>();
	private dirty = false;
	private lastWrite = 0;

	constructor(file: string) {
		this.file = file;
		const saved = readJsonFile(file);
		const records: unknown = isRecord(saved) ? saved.devices : undefined;
		for (const raw of Array.isArray(records) ? (records as unknown[]) : []) {
			const result = safeParse(DeviceRecordSchema, raw);
			if (!result.ok) continue; // a malformed record is ignored, never treated as a device
			const record = result.value;
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

	list(): DeviceRecord[] {
		return [...this.devices.values()].sort((a, b) => a.pairedAt.localeCompare(b.pairedAt));
	}

	get(id: string): DeviceRecord | null {
		return this.devices.get(id) ?? null;
	}

	/** The key a device logs in with; none for a suspended device, so it cannot get a token. */
	publicKey(id: string): crypto.KeyObject | null {
		if (this.suspended.has(id)) return null;
		return this.keys.get(id) ?? null;
	}

	/** Keep a device listed but refuse its logins until it is paired again (or revoked). */
	suspend(id: string): void {
		if (this.devices.has(id)) this.suspended.add(id);
	}

	isSuspended(id: string): boolean {
		return this.suspended.has(id);
	}

	/** Find a device by full id or an unambiguous prefix (dashes ignored, case-insensitive). Only a string matches. */
	resolve(query: unknown): DeviceRecord | null {
		const q = (typeof query === "string" ? query : "")
			.toUpperCase()
			.replace(/[\s-]/g, "");
		if (!q) return null;
		const exact = this.devices.get(q);
		if (exact) return exact;
		// The name is normalised the same way as the query, so "Pixel 8" finds a device named "Pixel 8".
		const matches = this.list().filter((d) => d.id.startsWith(q) || d.name.toUpperCase().replace(/[\s-]/g, "") === q);
		return matches.length === 1 ? (matches[0] ?? null) : null;
	}

	add({ publicKey, name, platform, address }: NewDevice): DeviceRecord {
		const parsed = parseDevicePublicKey(publicKey);
		const now = new Date().toISOString();
		const record: DeviceRecord = {
			id: parsed.id,
			name: cleanDeviceName(name),
			platform: (platform || "android").slice(0, 20),
			publicKey: parsed.spki.toString("base64"),
			pairedAt: now,
			pairedFrom: address || null,
			lastSeenAt: now,
			lastAddress: address || null,
		};
		this.devices.set(record.id, record);
		this.keys.set(record.id, parsed.key);
		this.suspended.delete(record.id); // paired again through the operator: trusted again
		this.save();
		return record;
	}

	setName(id: string, name: unknown): DeviceRecord | null {
		const record = this.devices.get(id);
		if (!record) return null;
		record.name = cleanDeviceName(name);
		this.save();
		return record;
	}

	remove(id: string): boolean {
		const existed = this.devices.delete(id);
		this.keys.delete(id);
		this.suspended.delete(id);
		if (existed) this.save();
		return existed;
	}

	/** Record a successful authentication; written to disk at most once a minute. */
	touch(id: string, address?: string | null): void {
		const record = this.devices.get(id);
		if (!record) return;
		record.lastSeenAt = new Date().toISOString();
		record.lastAddress = address || record.lastAddress;
		this.dirty = true;
		if (Date.now() - this.lastWrite > SEEN_WRITE_INTERVAL_MS) this.save();
	}

	save(): void {
		writePrivateFile(this.file, `${JSON.stringify({ version: 1, devices: this.list() }, null, 2)}\n`);
		this.dirty = false;
		this.lastWrite = Date.now();
	}

	flush(): void {
		if (this.dirty) this.save();
	}
}
