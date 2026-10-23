import assert from "node:assert/strict";
import fs from "node:fs";
assert.equal(process.getuid?.(), 10001);
const status = fs.readFileSync("/proc/self/status", "utf8");
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.throws(() => fs.writeFileSync("/isolation-check", "must not write"), /EROFS|EACCES/);
assert.ok(!fs.existsSync("/var/run/docker.sock"));
// Plain HTTP on purpose: these probe the isolated eval container network (the inference proxy
// and the synthetic lab target), which has no TLS and no route outside the sandbox.
assert.equal((await fetch("http://inference:8081/not-an-inference-path")).status, 403); // nosemgrep: react-insecure-request
assert.equal((await fetch("http://lab:8080/health")).status, 200); // nosemgrep: react-insecure-request
console.log(JSON.stringify({ uid: process.getuid?.(), capabilities: "none", noNewPrivileges: true,
  rootWriteBlocked: true, dockerSocket: false, arbitraryProxyPathBlocked: true, syntheticTargetReachable: true }));
