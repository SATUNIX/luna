#!/usr/bin/env node
/**
 * Agent mailboxes (packages/core/shared/agent-mailbox.ts): send and receive between agents registered
 * in agent-state; caps; redaction; a forged sender or reader refused; symbolic links refused, never
 * followed; 0600 messages in a 0700 inbox. Hermetic: temporary state and mailbox directories.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentState, writeAgentState } from "../packages/core/shared/agent-state.ts";
import { BODY_MAX, INBOX_MAX_MESSAGES, mailboxDir, receiveMessages, sendMessage, type MailboxPaths } from "../packages/core/shared/agent-mailbox.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-mailbox-"));
try {
  const paths: MailboxPaths = { dir: path.join(work, "mailbox"), stateDir: path.join(work, "agents") };
  const ALICE = 41001;
  const BOB = 41002;
  const register = (id: string, pid: number) => assert.ok(writeAgentState(paths.stateDir, buildAgentState({ id, state: "working", source: "session", pid })));
  register("alice", ALICE);
  register("bob", BOB);
  const receive = (id: string, pid: number, consume = false) => {
    const r = receiveMessages(paths, { id, pid, consume });
    assert.ok(r.ok, r.ok ? "" : r.reason);
    return r.value;
  };

  // Where the mailbox lives: beside the agent-state files, or LUNA_MAILBOX_DIR.
  assert.equal(mailboxDir({ XDG_STATE_HOME: "/s" }, "/h"), path.join("/s", "luna", "mailbox"));
  assert.equal(mailboxDir({ LUNA_MAILBOX_DIR: "/m" }, "/h"), "/m");

  // Send and receive.
  const sent = sendMessage(paths, { from: "alice", to: "bob", subject: "  review\nplease ", body: "line one\nline two\u0007", pid: ALICE });
  assert.ok(sent.ok, sent.ok ? "" : sent.reason);
  assert.equal(sent.value.subject, "review please", "the subject is one line");
  assert.equal(sent.value.body, "line one\nline two ", "control characters other than newline and tab are removed");
  const file = path.join(paths.dir, "bob", `${sent.value.id}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "a message is 0600");
  assert.equal(fs.statSync(path.join(paths.dir, "bob")).mode & 0o777, 0o700, "an inbox is 0700");
  const reply = sendMessage(paths, { from: "bob", to: "alice", subject: "done", body: "ok", replyTo: sent.value.id, pid: BOB });
  assert.ok(reply.ok && reply.value.replyTo === sent.value.id, "a reply names the message it answers");
  const inbox = receive("bob", BOB);
  assert.deepEqual(inbox.messages.map((m) => [m.from, m.to, m.subject]), [["alice", "bob", "review please"]]);
  assert.equal(receive("bob", BOB, true).messages.length, 1, "consume reads the message");
  assert.equal(receive("bob", BOB).messages.length, 0, "and deletes it");
  console.log("  OK: send, receive, reply and consume; one-line subject, 0600 messages in a 0700 inbox");

  // Forged sender or reader, unknown recipient, bad ids.
  const forged = sendMessage(paths, { from: "alice", to: "bob", subject: "x", body: "x", pid: BOB });
  assert.ok(!forged.ok && /sender refused: process 41002 is not agent alice/.test(forged.reason), "a sender whose pid is not the record's is refused");
  const unregistered = sendMessage(paths, { from: "mallory", to: "bob", subject: "x", body: "x", pid: 41003 });
  assert.ok(!unregistered.ok && /no agent-state record for mallory/.test(unregistered.reason));
  const nobody = sendMessage(paths, { from: "alice", to: "nobody", subject: "x", body: "x", pid: ALICE });
  assert.ok(!nobody.ok && /no agent nobody/.test(nobody.reason), "no inbox for an agent that does not exist");
  assert.ok(!fs.existsSync(path.join(paths.dir, "nobody")));
  const traversal = sendMessage(paths, { from: "alice", to: "../agents/bob", subject: "x", body: "x", pid: ALICE });
  assert.ok(!traversal.ok && /is not an agent id/.test(traversal.reason), "an id is never rewritten into another");
  const snoop = receiveMessages(paths, { id: "alice", pid: BOB });
  assert.ok(!snoop.ok && /reader refused/.test(snoop.reason), "an agent cannot read another's inbox");
  console.log("  OK: a forged sender or reader, an unknown recipient and a path-like id are refused");

  // Redaction.
  const key = ["AKIA", "0123456789ABCDEF"].join("");
  const secret = sendMessage(paths, { from: "alice", to: "bob", subject: `key ${key}`, body: `use ${key} now`, pid: ALICE });
  assert.ok(secret.ok);
  assert.equal(secret.value.redacted, 2);
  const stored = fs.readFileSync(path.join(paths.dir, "bob", `${secret.value.id}.json`), "utf8");
  assert.ok(!stored.includes(key) && stored.includes("[REDACTED]"), "the stored message holds no secret");
  receive("bob", BOB, true);
  console.log("  OK: secrets are redacted before a message is stored");

  // Caps.
  const big = sendMessage(paths, { from: "alice", to: "bob", subject: "big", body: "x".repeat(BODY_MAX + 1), pid: ALICE });
  assert.ok(!big.ok && /the limit is 8000/.test(big.reason));
  for (let i = 0; i < INBOX_MAX_MESSAGES; i++) assert.ok(sendMessage(paths, { from: "alice", to: "bob", subject: `m${String(i)}`, body: "x", pid: ALICE }).ok);
  const full = sendMessage(paths, { from: "alice", to: "bob", subject: "one more", body: "x", pid: ALICE });
  assert.ok(!full.ok && /inbox of bob is full/.test(full.reason), "a full inbox refuses");
  assert.equal(receive("bob", BOB, true).messages.length, INBOX_MAX_MESSAGES);
  console.log("  OK: body and inbox caps");

  // Symbolic links: an inbox, a message and the mailbox root are refused, never followed.
  const outside = path.join(work, "outside");
  fs.mkdirSync(outside);
  fs.rmSync(path.join(paths.dir, "alice"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(paths.dir, "alice"));
  const viaLink = sendMessage(paths, { from: "bob", to: "alice", subject: "x", body: "x", pid: BOB });
  assert.ok(!viaLink.ok, "a linked inbox is refused");
  assert.deepEqual(fs.readdirSync(outside), [], "nothing is written through it");
  assert.ok(!receiveMessages(paths, { id: "alice", pid: ALICE }).ok, "and is not read");
  fs.rmSync(path.join(paths.dir, "alice"));
  const target = path.join(outside, "planted.json");
  const ok = sendMessage(paths, { from: "bob", to: "alice", subject: "real", body: "x", pid: BOB });
  assert.ok(ok.ok);
  fs.writeFileSync(target, JSON.stringify({ ...ok.value, id: "1700000000000-aaaaaaaaaaaa", subject: "planted" }));
  fs.symlinkSync(target, path.join(paths.dir, "alice", "1700000000000-aaaaaaaaaaaa.json"));
  const read = receive("alice", ALICE, true);
  assert.deepEqual(read.messages.map((m) => m.subject), ["real"], "a linked message is not read");
  assert.equal(read.skipped, 1);
  assert.ok(fs.existsSync(target), "and its target is not deleted");
  const rootLink = { ...paths, dir: path.join(work, "root-link") };
  fs.symlinkSync(paths.dir, rootLink.dir);
  assert.ok(!sendMessage(rootLink, { from: "alice", to: "bob", subject: "x", body: "x", pid: ALICE }).ok, "a linked mailbox root is refused");
  const stateLink = path.join(work, "agents-linked");
  fs.mkdirSync(stateLink);
  fs.symlinkSync(path.join(paths.stateDir, "alice.json"), path.join(stateLink, "alice.json"));
  fs.copyFileSync(path.join(paths.stateDir, "bob.json"), path.join(stateLink, "bob.json"));
  const linkedRecord = sendMessage({ ...paths, stateDir: stateLink }, { from: "alice", to: "bob", subject: "x", body: "x", pid: ALICE });
  assert.ok(!linkedRecord.ok && /not a regular file/.test(linkedRecord.reason), "a linked agent-state record is no identity");
  console.log("  OK: a linked inbox, message, mailbox root or agent-state record is refused, never followed");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log("[agent-mailbox-smoke] OK");
