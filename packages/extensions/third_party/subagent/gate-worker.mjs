// Workflows: a /regex/ gate tested off the host's loop. workflow.ts starts this file as a worker and
// ends it on a timer, because a checked pattern can still backtrack polynomially. A worker does not
// load through pi's extension loader, and node strips no types under node_modules, so this is plain
// JavaScript that imports only node builtins. The host checked the pattern (./shared/safe-regex.ts)
// before starting it (tests/workflow-plan-smoke.ts).
import { parentPort, workerData } from "node:worker_threads";

const { re, output } = workerData; // a RegExp survives the structured clone

// Ready first: the host's test timer starts here, so a slow start cannot read as a slow pattern.
parentPort.once("message", () => parentPort.postMessage(re.test(output)));
parentPort.postMessage("ready");
