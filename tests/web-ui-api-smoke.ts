#!/usr/bin/env node
// Offline regression smoke for the web-ui API query string. The server used to call
// handleApi(req, res, { pathname }) with no `search`, so routes.ts always saw an empty
// query and `?source=project` was ignored: GET returned the user-level agent and DELETE
// removed the user-level file when a project agent of the same name existed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-api-home-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-api-proj-"));
const savedEnv = {
  HOME: process.env.HOME,
  PI_CONSOLE_PROJECT_AGENTS: process.env.PI_CONSOLE_PROJECT_AGENTS,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
let failed = false;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`  not ok - ${name}`);
    console.error(error instanceof Error && error.stack ? error.stack : error);
  }
}

interface FakeRes {
  statusCode: number | null;
  body: string | null;
  writeHead(s: number): void;
  end(b: string): void;
  // Only an event stream writes or listens; these routes never do.
  write(): void;
  on(): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: null,
    body: null,
    writeHead(s: number) {
      this.statusCode = s;
    },
    end(b: string) {
      this.body = b;
    },
    write() {},
    on() {},
  };
}

// The fake response only ever receives a string body; a missing one fails the check.
function responseBody(res: FakeRes): string {
  if (res.body === null) throw new Error("no response body");
  return res.body;
}

function writeAgent(filePath: string, description: string, body: string): void {
  fs.writeFileSync(
    filePath,
    `---\nname: dup\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

try {
  // config.ts captures HOME and the agent dirs at import time, so set every env var
  // before the dynamic import.
  process.env.HOME = homeDir;
  process.env.PI_CONSOLE_PROJECT_AGENTS = projectDir;
  // A non-default agent dir, so a console that ignored PI_CODING_AGENT_DIR would be caught.
  const agentDir = path.join(homeDir, "custom-agent-dir");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { handleApi } = await import("../packages/web-ui/server/routes.ts");

  const userAgentPath = path.join(agentDir, "agents", "dup.md");
  const projectAgentPath = path.join(projectDir, "dup.md");
  fs.mkdirSync(path.dirname(userAgentPath), { recursive: true });
  writeAgent(userAgentPath, "user-copy", "user body");
  writeAgent(projectAgentPath, "project-copy", "project body");

  // GET must honour ?source=project even when handleApi only receives `pathname`
  // (the old server.ts shape).
  const getRes = fakeRes();
  await handleApi(
    { method: "GET", url: "/api/agents/dup?source=project", on() {} },
    getRes,
    { pathname: "/api/agents/dup" },
  );
  check("GET ?source=project selects the project agent", () => {
    assert.equal(getRes.statusCode, 200);
    const { agent } = JSON.parse(responseBody(getRes)) as { agent: { source: string; description: string } };
    assert.equal(agent.source, "project");
    assert.equal(agent.description, "project-copy");
  });

  // DELETE must remove the project copy, not the user copy.
  const delRes = fakeRes();
  await handleApi(
    { method: "DELETE", url: "/api/agents/dup?source=project", on() {} },
    delRes,
    { pathname: "/api/agents/dup" },
  );
  check("DELETE ?source=project removes only the project agent", () => {
    assert.equal(delRes.statusCode, 200);
    assert.equal(fs.existsSync(projectAgentPath), false, "project file must be deleted");
    assert.equal(fs.existsSync(userAgentPath), true, "user file must survive");
  });

  // An unexpected failure (an fs error, a bug) must not put its text, which can hold paths and internals, in the response:
  // the client gets a generic 500 and the detail goes to the server's log. A deliberate HttpError keeps its message.
  const secret = "EACCES: permission denied, open '/home/operator/.ssh/id_rsa'";
  const boomRes = fakeRes();
  const realStderr = process.stderr.write.bind(process.stderr);
  let logged = "";
  process.stderr.write = (chunk) => ((logged += String(chunk)), true);
  try {
    await handleApi(
      { method: "POST", url: "/api/agents", headers: { "content-type": "application/json" }, on() { throw new Error(secret); } },
      boomRes,
      { pathname: "/api/agents" },
    );
  } finally {
    process.stderr.write = realStderr;
  }
  check("an unexpected error is a generic 500 with no internals in the response, and is logged", () => {
    assert.equal(boomRes.statusCode, 500);
    assert.equal((JSON.parse(responseBody(boomRes)) as { error: string }).error, "internal error (see the console log)");
    const boomBody = responseBody(boomRes);
    assert.ok(!boomBody.includes("id_rsa") && !boomBody.includes("/home/operator"), boomBody);
    assert.ok(logged.includes(secret), "the detail is in the server's own log");
  });
  const { agentDirFor, createAgent, deleteAgent, getAgent, updateAgent } = await import("../packages/web-ui/server/agentstore.ts");
  const { HttpError } = await import("../packages/web-ui/server/validate.ts");
  // The subagent tool reads user roles from <agent dir>/agents; a role the console saves as a
  // user agent must be one the subagent tool discovers.
  const { discoverAgents } = await import("../packages/extensions/third_party/subagent/agents.ts");
  check("the console's user agents are the subagent tool's user agents (<agent dir>/agents)", () => {
    assert.equal(agentDirFor("user"), path.join(agentDir, "agents"));
    createAgent({ name: "shared-role", description: "made in the console", body: "x" });
    const found = discoverAgents(projectDir, "user").agents.find((agent) => agent.name === "shared-role");
    assert.equal(found?.source, "user", "the subagent tool discovers the console-made agent as a user agent");
    deleteAgent("shared-role", "user");
  });
  check("client-facing agent failures are HttpErrors with their status", () => {
    const attempts: Array<[string, () => unknown, number]> = [
      ["an invalid name", () => createAgent({ name: "Bad Name", body: "x" }), 400],
      ["a missing agent", () => deleteAgent("nosuch-agent", "user"), 404],
    ];
    for (const [label, attempt, status] of attempts) {
      let error: unknown = null;
      try { attempt(); } catch (e) { error = e; }
      assert.ok(error instanceof HttpError, `${label}: ${String(error)}`);
      assert.equal(error.statusCode, status, label);
    }
  });
  check("editing an agent without sending its model keeps the model", () => {
    createAgent({ name: "keeps-model", model: "provider/model-x", body: "x" });
    assert.equal(getAgent("keeps-model", "user")?.model, "provider/model-x", "the record carries the model");
    updateAgent("keeps-model", { description: "edited", body: "y", source: "user" });
    assert.equal(getAgent("keeps-model", "user")?.model, "provider/model-x");
    deleteAgent("keeps-model", "user");
  });
  // The editor sends "" when its model field is cleared (agentui.ts); that must remove the model.
  check("editing an agent with an empty model clears it", () => {
    createAgent({ name: "clears-model", model: "provider/model-x", body: "x" });
    updateAgent("clears-model", { model: "", body: "x", source: "user" });
    assert.equal(getAgent("clears-model", "user")?.model, undefined);
    deleteAgent("clears-model", "user");
  });
  check("a line break of any kind in a field cannot add a frontmatter key", () => {
    createAgent({ name: "one-line", description: "a\rmodel: injected\u2028tools: bash", body: "x" });
    const text = fs.readFileSync(path.join(agentDirFor("user"), "one-line.md"), "utf8");
    const frontmatter = text.split("---")[1] ?? "";
    assert.ok(!/[\r\u2028\u2029]/.test(frontmatter), "no raw line break survives in the frontmatter");
    assert.equal(getAgent("one-line", "user")?.model, undefined);
    deleteAgent("one-line", "user");
  });
} finally {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

if (failed) {
  console.error("web-ui-api smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-api smoke: OK");
