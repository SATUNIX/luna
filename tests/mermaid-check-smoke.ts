#!/usr/bin/env node
// The diagram gate must fail on a broken diagram, not just pass on good ones. This drives the
// checker (packages/core/check-mermaid.ts) on fixtures: valid flowchart, sequence and state
// diagrams parse; a syntax error, an empty block and an unclosed fence are each reported with
// the file and line of the diagram. It then applies the checker to the repository's own docs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.ts";
import { checkFiles, extractDiagrams, listMarkdown } from "../packages/core/check-mermaid.ts";

let checks = 0;
const ok = (name: string): void => { checks += 1; console.log(`  ok  ${name}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-mermaid-"));
const write = (name: string, text: string): string => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); return name; };

try {
  // extraction: fence styles, indentation, several blocks, other languages ignored
  {
    const md = ["# t", "```mermaid", "flowchart LR", "  A --> B", "```", "text", "~~~mermaid", "sequenceDiagram", "  A->>B: hi", "~~~", "```js", "mermaid", "```"].join("\n");
    const found = extractDiagrams(md);
    assert.deepEqual(found.map((d) => d.line), [2, 7]);
    assert.ok(found.every((d) => d.closed));
    ok("extraction finds each mermaid fence (backticks or tildes) with its line, and ignores other languages");
  }

  // valid diagrams parse
  {
    const good = write("good.md", [
      "```mermaid", "flowchart TD", "  A[Start] --> B{ok?}", "  B -->|yes| C[Done]", "```", "",
      "```mermaid", "sequenceDiagram", "  participant A", "  A->>B: hi", "  B-->>A: yo", "```", "",
      "```mermaid", "stateDiagram-v2", "  [*] --> Idle", "  Idle --> Running", "  Running --> [*]", "```",
    ].join("\n"));
    const r = await checkFiles([good], dir);
    assert.deepEqual(r.problems, []);
    assert.equal(r.checked, 3);
    ok("flowchart, sequence and state diagrams parse");
  }

  // each kind of breakage is reported with file:line
  {
    write("bad.md", "intro\n\n```mermaid\nflowchart LR\n  A --> --> B\n```\n");
    write("empty.md", "```mermaid\n```\n");
    write("open.md", "```mermaid\nflowchart LR\n  A --> B\n");
    for (const [file, pattern] of [["bad.md", /^bad\.md:3: /], ["empty.md", /^empty\.md:1: the mermaid block is empty/], ["open.md", /^open\.md:1: the mermaid fence is never closed/]] satisfies Array<[string, RegExp]>) {
      const r = await checkFiles([file], dir);
      assert.equal(r.problems.length, 1, `${file}: ${JSON.stringify(r)}`);
      const [problem] = r.problems;
      assert.ok(problem !== undefined, `${file}: no problem reported`);
      assert.match(problem, pattern);
    }
    ok("a syntax error, an empty block and an unclosed fence are each reported with file and line");
  }

  // the repository itself
  {
    const files = listMarkdown(ROOT);
    assert.ok(files.includes("docs/index.md"), "the Markdown walk finds docs/");
    assert.ok(!files.some((f) => f.startsWith("node_modules/")), "node_modules is skipped");
    const r = await checkFiles(files, ROOT);
    assert.deepEqual(r.problems, [], `the repository has broken diagrams:\n${r.problems.join("\n")}`);
    assert.ok(r.checked >= 5, `expected the docs to contain diagrams, found ${r.checked}`);
    ok(`the repository's ${r.checked} diagrams all parse`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`[mermaid-check-smoke] OK (${checks} checks)`);
process.exit(0);
