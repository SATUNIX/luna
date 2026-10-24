// tls.ts — the remote host's TLS identity: an ECDSA P-256 key and a self-signed certificate.
//
// Phones never validate this certificate against a CA. They pin the SHA-256 of its DER encoding,
// learnt from the pairing QR code (or compared by the operator for a manual link), so the address
// a phone uses (LAN, Tailscale IP, MagicDNS name) does not matter and no hostname is checked.
//
// Node has no API that creates an X.509 certificate, and the kit takes no npm dependency for
// this, so the certificate is assembled here in DER and signed with crypto.sign(). The encoder
// covers exactly the ASN.1 this certificate needs; the result is parsed back with
// crypto.X509Certificate and its signature verified before it is ever used.
import crypto from "node:crypto";

/** A freshly created TLS identity: what the host writes to tls-key.pem and tls-cert.pem. */
export interface TlsIdentity {
	/** The private key, PKCS#8 PEM (secret). */
	readonly keyPem: string;
	readonly certPem: string;
	/** SHA-256 of the certificate's DER encoding, base64url (what phones pin). */
	readonly fingerprint: string;
}

export interface SelfSignedOptions {
	readonly privateKey: crypto.KeyObject;
	readonly publicKey: crypto.KeyObject;
	readonly commonName: string;
	readonly days?: number;
	readonly now?: Date;
}

// ------------------------------------------------------------------ DER ---
function derLength(n: number): Buffer {
	if (n < 0x80) return Buffer.from([n]);
	const bytes: number[] = [];
	for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer | readonly Buffer[]): Buffer {
	const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
	return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, items);
const set = (...items: Buffer[]): Buffer => tlv(0x31, items);

function integer(buf: Buffer): Buffer {
	let i = 0;
	while (i < buf.length - 1 && buf[i] === 0) i++;
	let body = buf.subarray(i);
	if ((body[0] ?? 0) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
	return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
	const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
	const out = [40 * first + second];
	for (const arc of rest) {
		const chunk: number[] = [];
		let v = arc;
		do {
			chunk.unshift(v & 0x7f);
			v = Math.floor(v / 128);
		} while (v > 0);
		out.push(...chunk.map((byte, k) => (k < chunk.length - 1 ? byte | 0x80 : byte)));
	}
	return tlv(0x06, Buffer.from(out));
}

const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
const bitString = (buf: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octetString = (buf: Buffer): Buffer => tlv(0x04, buf);
const boolTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 + n, inner);

function time(date: Date): Buffer {
	const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
	const digits = iso.slice(0, 19).replace(/[-T:]/g, "");
	const year = date.getUTCFullYear();
	// RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
	return year < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

const OID = {
	ecdsaWithSha256: "1.2.840.10045.4.3.2",
	commonName: "2.5.4.3",
	organization: "2.5.4.10",
	basicConstraints: "2.5.29.19",
	keyUsage: "2.5.29.15",
	extKeyUsage: "2.5.29.37",
	subjectAltName: "2.5.29.17",
	serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

function extension(id: string, critical: boolean, value: Buffer): Buffer {
	return critical ? seq(oid(id), boolTrue(), octetString(value)) : seq(oid(id), octetString(value));
}

function name(commonName: string): Buffer {
	return seq(set(seq(oid(OID.organization), utf8("pi-system"))), set(seq(oid(OID.commonName), utf8(commonName))));
}

/** Build a self-signed certificate for `privateKey` (ECDSA P-256); returns the certificate in PEM. */
export function selfSignedCertificate({ privateKey, publicKey, commonName, days = 3650, now = new Date() }: SelfSignedOptions): string {
	const spki = publicKey.export({ type: "spki", format: "der" });
	const algorithm = seq(oid(OID.ecdsaWithSha256));
	const notBefore = new Date(now.getTime() - 24 * 3600 * 1000); // tolerate a phone clock that is a little behind
	const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);
	const extensions = seq(
		extension(OID.basicConstraints, true, seq()),
		extension(OID.keyUsage, true, bitString(Buffer.from([0x80]))), // digitalSignature
		extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
		extension(OID.subjectAltName, false, seq(tlv(0x82, Buffer.from("pi-remote")))),
	);
	const tbs = seq(
		explicit(0, integer(Buffer.from([2]))), // v3
		integer(crypto.randomBytes(16)),
		algorithm,
		name(commonName),
		seq(time(notBefore), time(notAfter)),
		name(commonName),
		spki,
		explicit(3, extensions),
	);
	const signature = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
	const der = seq(tbs, algorithm, bitString(signature));
	const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").trim();
	return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** SHA-256 of a certificate's DER encoding, base64url (what phones pin). */
export function certificateFingerprint(certPem: string | Buffer): string {
	return crypto.createHash("sha256").update(new crypto.X509Certificate(certPem).raw).digest("base64url");
}

/** The fingerprint as operators compare it by eye: 8 groups of 4 hex digits (the first 128 bits). */
export function displayFingerprint(fingerprint: string): string {
	const hex = Buffer.from(fingerprint, "base64url").toString("hex").toUpperCase();
	return (hex.slice(0, 32).match(/.{4}/g) ?? []).join(" ");
}

/** Create a fresh key and certificate, checked before use. */
export function createTlsIdentity(commonName: string): TlsIdentity {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const certPem = selfSignedCertificate({ privateKey, publicKey, commonName });
	assertUsable(certPem, privateKey);
	return {
		keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
		certPem,
		fingerprint: certificateFingerprint(certPem),
	};
}

/** Throw unless `certPem` parses, is self-signed by `privateKey`'s pair and is currently valid. */
export function assertUsable(certPem: string | Buffer, privateKey: string | crypto.KeyObject): crypto.X509Certificate {
	const cert = new crypto.X509Certificate(certPem);
	const key = typeof privateKey === "string" ? crypto.createPrivateKey(privateKey) : privateKey;
	if (!cert.checkPrivateKey(key)) throw new Error("TLS certificate does not match its key");
	if (!cert.verify(cert.publicKey)) throw new Error("TLS certificate signature does not verify");
	const now = Date.now();
	if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) {
		throw new Error("TLS certificate is outside its validity period");
	}
	return cert;
}
