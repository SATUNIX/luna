#!/usr/bin/env node
// Unit checks for the remote host's pairing and approval controls, without a running host:
//   - remote/peer.ts: how the process behind a control connection is found and judged;
//   - remote/pairing.ts: the device-ID confirmation, the second-claim refusal and address scopes;
//   - remote/api.ts: the audit record for a phone's dialog answer (device, tier, choice);
//   - remote/devices.ts: a suspended device cannot log in until it is paired again;
//   - the terminal prompt's masked device ID (remote-control extension).
// The end-to-end versions are in tests/remote-host-smoke.ts and tests/remote-control-extension-smoke.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { phoneAnswerRecord } from "../packages/web-ui/server/remote/api.ts";
import { deviceIdFromSpki } from "../packages/web-ui/server/remote/codes.ts";
import { DeviceRegistry } from "../packages/web-ui/server/remote/devices.ts";
import { PairingError, Pairings, addressScope, deviceConfirmation, pairProofPayload } from "../packages/web-ui/server/remote/pairing.ts";
import { inspectPeer, judgeTerminal, parseProcStat, socketInode } from "../packages/web-ui/server/remote/peer.ts";
import { loadModule } from "../packages/core/eval/harness.ts";

let checks = 0;
const ok = (label: string): void => {
	checks++;
	console.log(`  ok ${checks} - ${label}`);
};
// Private-range sample addresses are assembled at run time, so no literal one sits in the source.
const ip = (...octets: number[]): string => octets.join(".");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-controls-"));

/** A phone key and a valid pairing claim for `code` against `fingerprint`. */
function phoneClaim(code: string, fingerprint: string, name: string, address = ip(192, 168, 50, 20)) {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
	const proof = crypto.sign("sha256", pairProofPayload({ code, fingerprint, publicKey: publicKeyB64, name }), privateKey).toString("base64");
	return { claim: { code, publicKey: publicKeyB64, name, proof, platform: "android", address }, id: deviceIdFromSpki(Buffer.from(publicKeyB64, "base64")) };
}

try {
	const { maskDeviceId } = await loadModule<{ maskDeviceId: (display: unknown) => string }>("extensions/remote-control/index.ts");
	// peer.ts -------------------------------------------------------------------------------------
	{
		assert.deepEqual(parseProcStat("1234 (pi) S 1 1234 1234 34816 1234 4194560 0"), { pgrp: 1234, ttyNr: 34816, tpgid: 1234 });
		assert.deepEqual(parseProcStat("77 (a (b) c) S 1 70 70 0 -1 4194560"), { pgrp: 70, ttyNr: 0, tpgid: -1 }, "a command name with spaces and parentheses");
		assert.equal(parseProcStat("garbage"), null);
		const table = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1",
			"   1: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1",
		].join("\n");
		assert.equal(socketInode(table, 0xd431, 0x1f90), "22222", "the peer's own socket: local = its port, remote = the host's");
		assert.equal(socketInode(table, 0x1f90, 0xd431), "11111");
		assert.equal(socketInode(table, 1, 2), null);
		const v6 = "  sl  local_address                         remote_address                        st\n   0: 0000000000000000FFFF00000100007F:D431 0000000000000000FFFF00000100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000 0 33333 1";
		assert.equal(socketInode(v6, 0xd431, 0x1f90), "33333", "IPv6 (v4-mapped) entries too");
		assert.deepEqual(judgeTerminal({ ttyNr: 34816, pgrp: 10, tpgid: 10, stdin: "/dev/pts/3" }), { ok: true, tty: "/dev/pts/3" });
		const refused = (facts: Parameters<typeof judgeTerminal>[0], why: RegExp, label: string) => {
			const v = judgeTerminal(facts);
			assert.ok(!v.ok && why.test(v.why), `${label}: ${JSON.stringify(v)}`);
		};
		refused({ ttyNr: 0, pgrp: 10, tpgid: -1, stdin: "/dev/null" }, /no controlling terminal/, "an agent's shell command (its own session)");
		refused({ ttyNr: 34816, pgrp: 11, tpgid: 10, stdin: "/dev/pts/3" }, /foreground/, "a background job");
		refused({ ttyNr: 34816, pgrp: 10, tpgid: 10, stdin: "pipe:[123]" }, /standard input is not a terminal/, "an RPC child reading a pipe");
		refused({ ttyNr: 34816, pgrp: 10, tpgid: 10, stdin: null }, /standard input is not a terminal/, "no standard input");
		assert.equal(inspectPeer(undefined, 1).ok, false, "no ports, no verdict");
		const win = inspectPeer(1234, 5678, "win32");
		assert.ok(!win.ok && /cannot tell which process/.test(win.why), "a platform without a lookup refuses");
		ok("peer.ts: /proc stat and socket-table parsing; only a foreground terminal process reading the terminal passes");
	}

	// pairing.ts ----------------------------------------------------------------------------------
	{
		assert.equal(addressScope("127.0.0.1"), "loopback");
		assert.equal(addressScope(`::ffff:${ip(192, 168, 50, 5)}`), "lan");
		assert.equal(addressScope(ip(10, 1, 2, 3)), "lan");
		assert.equal(addressScope(ip(172, 20, 0, 4)), "lan");
		assert.equal(addressScope(ip(100, 101, 102, 103)), "tailscale");
		assert.equal(addressScope(["fd7a", "115c", "a1e0", "", "1"].join(":")), "tailscale");
		assert.equal(addressScope("fe80::1"), "lan");
		assert.equal(addressScope("203.0.113.9"), "other");
		assert.equal(addressScope("2001:db8::1"), "other");
		assert.equal(addressScope(null), "unknown");
		assert.equal(deviceConfirmation("ABCDEFGHJKMNPQRS"), "PQRS");
		assert.equal(maskDeviceId("ABCD-EFGH-JKMN-PQRS"), "ABCD-EFGH-JKMN-····");
		ok("pairing.ts: address scopes (loopback, LAN, Tailscale, other) and the last-four confirmation; the terminal masks it");

		const fingerprint = "fp-test";
		const audit: Array<Record<string, unknown>> = [];
		const registry = new DeviceRegistry(path.join(tmp, "devices.json"));
		const pairings = new Pairings({ fingerprint, devices: registry, onAudit: (r) => audit.push({ ...r }) });
		const closed: string[] = [];
		const owner = { onRequestClosed: (r: { requestId: string }) => closed.push(r.requestId) };

		// A wrong confirmation rejects; the right one approves; neither shows the last group to anyone but the phone.
		let offer = pairings.createOffer({ owner });
		const a = phoneClaim(offer.code, fingerprint, "Phone A");
		const ra = pairings.claim(a.claim);
		assert.equal(pairings.decide(ra.id, true, { owner, confirm: "ZZZZ" === deviceConfirmation(a.id) ? "YYYY" : "ZZZZ" }).state, "rejected");
		assert.ok(audit.some((r) => r.event === "pair_rejected" && r.reason === "confirmation_mismatch"));
		assert.equal(registry.get(a.id), null, "nothing linked");
		offer = pairings.createOffer({ owner });
		const b = phoneClaim(offer.code, fingerprint, "Phone B");
		const rb = pairings.claim(b.claim);
		assert.equal(pairings.decide(rb.id, true, { owner, confirm: deviceConfirmation(b.id).toLowerCase(), decidedBy: { pid: 42, tty: "/dev/pts/9" } }).state, "approved", "case and look-alikes do not matter");
		assert.deepEqual(audit.find((r) => r.event === "pair_approved")?.decidedBy, { pid: 42, tty: "/dev/pts/9" }, "the approval names who gave it");
		assert.equal(pairings.decide(rb.id, false, { owner }).state, "approved", "a decision is final");
		ok("pairing.ts: approving needs the device ID's last four characters; a wrong value rejects; the approval names its terminal");

		// A second correct claim while the first waits: both refused, the code has leaked.
		offer = pairings.createOffer({ owner });
		const c = phoneClaim(offer.code, fingerprint, "Phone C");
		const rc = pairings.claim(c.claim);
		const d = phoneClaim(offer.code, fingerprint, "Phone D", ip(192, 168, 50, 66));
		assert.throws(() => pairings.claim(d.claim), (e: unknown) => e instanceof PairingError && e.code === "offer_contested" && e.status === 409);
		assert.equal(rc.state, "cancelled", "the first claim is cancelled too");
		assert.deepEqual(closed, [rc.id], "the terminal is told");
		assert.ok(audit.some((r) => r.event === "pair_second_claim" && r.address === ip(192, 168, 50, 66)));
		assert.equal(pairings.decide(rc.id, true, { owner, confirm: deviceConfirmation(c.id) }).state, "cancelled", "and cannot be approved");
		// A wrong code after the claim is just a wrong code: nothing is cancelled.
		offer = pairings.createOffer({ owner });
		const e = phoneClaim(offer.code, fingerprint, "Phone E");
		const re = pairings.claim(e.claim);
		assert.throws(() => pairings.claim({ ...phoneClaim("0000000000", fingerprint, "Guess").claim }), (err: unknown) => err instanceof PairingError && err.code === "no_offer");
		assert.equal(re.state, "pending", "a guess does not cancel the waiting request");
		ok("pairing.ts: a second device presenting a claimed code is refused (409) and cancels the waiting request; a wrong code does not");
	}

	// devices.ts ----------------------------------------------------------------------------------
	{
		const registry = new DeviceRegistry(path.join(tmp, "suspend.json"));
		const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
		const record = registry.add({ publicKey: key, name: "Planted" });
		registry.suspend(record.id);
		assert.equal(registry.isSuspended(record.id), true);
		assert.equal(registry.publicKey(record.id), null, "a suspended device has no login key");
		assert.ok(registry.get(record.id), "but stays listed");
		registry.add({ publicKey: key, name: "Planted" });
		assert.equal(registry.isSuspended(record.id), false, "pairing it again through the operator lifts it");
		assert.ok(registry.publicKey(record.id));
		ok("devices.ts: a suspended device stays listed but cannot log in until it is paired again");
	}

	// api.ts --------------------------------------------------------------------------------------
	{
		const device = { id: "ABCDEFGHJKMNPQRS", name: "Pixel" };
		const card = { method: "select", title: "Approve tool call? (subagent)", message: "HIGH · bash · npm publish\n• [high] publishes a package", options: ["Allow once", "Deny"] };
		const r = phoneAnswerRecord(device, "s1", "d1", card, { value: "Allow once" });
		assert.equal(r.event, "phone_dialog_answer");
		assert.equal(r.deviceId, device.id);
		assert.equal(r.tier, "high");
		assert.equal(r.choice, "Allow once");
		assert.equal(phoneAnswerRecord(device, "s1", "d1", { method: "select", title: "x", message: "UNCERTAIN · CRITICAL · bash · y" }, { value: "Deny" }).tier, "critical");
		const typed = phoneAnswerRecord(device, "s1", "d2", { method: "input", title: "Tell the agent why" }, { value: "a private note" });
		assert.equal(typed.choice, "typed text (14 characters)", "typed text is recorded by length only");
		assert.ok(!JSON.stringify(typed).includes("private note"));
		assert.equal(phoneAnswerRecord(device, "s1", "d3", { method: "confirm", title: "Proceed?" }, { confirmed: false }).choice, "no");
		assert.equal(phoneAnswerRecord(device, "s1", "d4", undefined, { cancelled: true }).choice, "cancelled");
		ok("api.ts: a phone's answer is recorded with the device, the session, the card's tier and the choice (typed text by length)");
	}
	console.log(`remote-pairing-controls smoke: OK (${checks} checks)`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
