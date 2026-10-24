// Deliberately vulnerable, synthetic lab API. No real users or data.
// Bind-mounted into the lab container and run as `node /target.ts`: node:* imports only.
import http from "node:http";
import fs from "node:fs";
interface Invoice { id: number; owner: string; amount: number }
// Maps, not object literals: a header or path naming a prototype member ("constructor",
// "__proto__") must not resolve to a user or an invoice.
const invoices = new Map<string, Invoice>([["101", { id: 101, owner: "alice", amount: 35 }], ["202", { id: 202, owner: "bob", amount: 99 }]]);
const users = new Map([["Bearer lab-alice", "alice"], ["Bearer lab-bob", "bob"]]);
const userFor = (authorization: string | undefined): string | undefined => authorization === undefined ? undefined : users.get(authorization);
http.createServer((req, res) => {
  res.on("finish", () => { fs.appendFileSync("/logs/requests.jsonl", JSON.stringify({ method: req.method, path: req.url,
    user: userFor(req.headers.authorization) || "anonymous", status: res.statusCode }) + "\n"); });
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") { res.end('{"ok":true}'); return; }
  const user = userFor(req.headers.authorization);
  if (!user) { res.writeHead(401).end('{"error":"authentication required"}'); return; }
  const id = req.url?.match(/^\/invoices\/(\d+)$/)?.[1];
  const invoice = id === undefined ? undefined : invoices.get(id);
  if (!invoice) { res.writeHead(404).end('{"error":"not found"}'); return; }
  // Intentionally missing: invoice.owner === user authorization check.
  res.end(JSON.stringify(invoice));
}).listen(8080, "0.0.0.0");
