#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type ChainTail, dataRoot, isRecord, readJsonlTail, readLastChainRecord, countJsonl, stringOf } from "./ledger.ts";

/** A hash-chained JSONL record as appendChainedJsonl writes it. */
type ChainedRecord = ChainTail & Record<string, unknown>;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

/** What upsertDelegatedTask forwards to memory-mcp; undefined fields are dropped by JSON.stringify. */
type DelegatedTaskUpdate = {
  task_id: string;
  title: string | undefined;
  status: string | undefined;
  active_step: string | undefined;
  next_step: string | undefined;
  notes: string | undefined;
};

const CAPABILITY_ID = "pi-system";
const LEDGER_SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);
const FIELD_LIMITS = {
  short: 256,
  medium: 2048,
  long: 8192,
  artifact: 262144
};

function ensureDirs(): void {
  for (const dir of [
    "audit",
    "checkpoints",
    "evidence/artifacts",
    "findings",
    "hypotheses",
    "memory",
    "reports",
    "tasks/history",
    "verification"
  ]) {
    fs.mkdirSync(path.join(dataRoot(), dir), { recursive: true });
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)])
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

async function withFileLock<T>(file: string, callback: () => T | Promise<T>): Promise<T> {
  const lockDir = `${file}.lock`;
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" || Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out acquiring file lock for ${file}`, { cause: error });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await callback();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

async function appendChainedJsonl(file: string, record: Record<string, unknown>): Promise<ChainedRecord> {
  ensureDirs();
  return withFileLock(file, () => {
    const previous = readLastChainRecord(file);
    const chained = {
      schema_version: LEDGER_SCHEMA_VERSION,
      sequence: previous.sequence + 1,
      previous_hash: previous.record_hash,
      ...record
    };
    const finalRecord: ChainedRecord = {
      ...chained,
      record_hash: hashValue(chained)
    };
    fs.appendFileSync(file, `${JSON.stringify(finalRecord)}\n`, { encoding: "utf8", flag: "a" });
    return finalRecord;
  });
}

async function audit(event: Record<string, unknown>): Promise<ChainedRecord> {
  return appendChainedJsonl(path.join(dataRoot(), "audit", "audit.jsonl"), {
    timestamp: new Date().toISOString(),
    capability_id: CAPABILITY_ID,
    ...event
  });
}

async function appendJsonl<T>(file: string, record: T): Promise<T> {
  ensureDirs();
  return withFileLock(file, () => {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
    return record;
  });
}

function textAndStructured(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}

/**
 * Runs one memory-mcp `--call` and returns its JSON result. The output of a child process is
 * untrusted: anything but a JSON object is refused.
 */
async function callMemoryMcp(toolName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const command = process.env.MEMORY_MCP_COMMAND || process.env.PI_KIT_MEMORY_MCP_COMMAND || "node";
  const args = (process.env.MEMORY_MCP_ARGS || process.env.PI_KIT_MEMORY_MCP_ARGS || "/opt/pi-agent/mcp-servers/memory-mcp/index.ts").split(/\s+/).filter(Boolean);
  const { stdout } = await execFileAsync(command, [...args, "--call", toolName, JSON.stringify(params || {})], {
    env: {
      ...process.env,
      PI_KIT_MEMORY_MCP_DATA_ROOT: process.env.PI_KIT_MEMORY_MCP_DATA_ROOT || dataRoot()
    },
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed)) throw new Error(`memory-mcp ${toolName} returned a non-object result`);
  return parsed;
}

/** A list field of a memory-mcp result: absent (or falsy) is empty, anything but an array is refused. */
function listField(result: Record<string, unknown>, key: string): unknown[] {
  const value = result[key];
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error(`memory-mcp result field ${key} is not a list`);
  return value;
}

async function upsertDelegatedTask(params: DelegatedTaskUpdate): Promise<Record<string, unknown>> {
  const existing = await callMemoryMcp("task_state_read", { task_id: params.task_id });
  if (!existing.task) {
    return callMemoryMcp("task_create", {
      task_id: params.task_id,
      title: params.title || params.task_id,
      status: params.status || "candidate",
      active_step: params.active_step || "",
      next_step: params.next_step || "",
      notes: params.notes || ""
    });
  }
  return callMemoryMcp("task_state_update", params);
}

function safeId(value: unknown, prefix: string): string {
  const normalized = stringOf(value || "").trim();
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(normalized)) {
    throw new Error(`${prefix} must be 1-96 characters using letters, digits, dot, underscore, or dash`);
  }
  return normalized;
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "evidence_append",
    {
      title: "Append Evidence",
      description: "Append a normalized evidence record and optional text artifact to the Pi System evidence ledger.",
      inputSchema: {
        summary: z.string().min(1).max(FIELD_LIMITS.long),
        source_tool: z.string().min(1).max(FIELD_LIMITS.short),
        source_action_id: z.string().min(1).max(FIELD_LIMITS.short).optional(),
        target_asset: z.string().min(1).max(FIELD_LIMITS.medium).optional(),
        artifact_text: z.string().max(FIELD_LIMITS.artifact).optional(),
        sensitivity_label: z.string().min(1).max(FIELD_LIMITS.short).optional(),
        linked_hypotheses: z.array(z.string().min(1).max(FIELD_LIMITS.short)).max(50).optional()
      }
    },
    async (params) => {
      ensureDirs();
      if ((params.target_asset || params.source_tool.startsWith("mcp")) && !params.source_action_id) {
        throw new Error("source_action_id is required for target-derived evidence");
      }

      const evidenceId = `EV-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex")}`;
      const artifactDir = path.join(dataRoot(), "evidence", "artifacts", evidenceId);
      fs.mkdirSync(artifactDir, { recursive: true });

      const artifactRefs: string[] = [];
      let sha256 = "";
      if (params.artifact_text) {
        const artifactPath = path.join(artifactDir, "output.txt");
        fs.writeFileSync(artifactPath, params.artifact_text, { encoding: "utf8", flag: "wx" });
        sha256 = crypto.createHash("sha256").update(params.artifact_text).digest("hex");
        artifactRefs.push(artifactPath);
      }

      const record = {
        evidence_id: evidenceId,
        timestamp: new Date().toISOString(),
        source_tool: params.source_tool,
        source_action_id: params.source_action_id || null,
        target_asset: params.target_asset || null,
        raw_artifact_refs: artifactRefs,
        normalized_summary: params.summary,
        sha256,
        sensitivity_label: params.sensitivity_label || "internal",
        chain_of_custody: "created_by_pi_system_governance_mcp",
        linked_hypotheses: params.linked_hypotheses ?? [],
        linked_findings: []
      };

      await appendChainedJsonl(path.join(dataRoot(), "evidence", "ledger.jsonl"), record);
      await audit({ event: "evidence_appended", evidence_id: evidenceId, source_tool: params.source_tool, via: "pi_system_governance_mcp" });
      return textAndStructured(`Evidence appended: ${evidenceId}`, record);
    }
  );

  server.registerTool(
    "note_append",
    {
      title: "Append Note",
      description: "Append an operator or agent note to the audit ledger without modifying evidence.",
      inputSchema: {
        note: z.string().min(1).max(FIELD_LIMITS.long),
        category: z.string().min(1).max(FIELD_LIMITS.short).optional()
      }
    },
    async (params) => {
      const record = await audit({ event: "note", category: params.category || "general", note: params.note, via: "pi_system_governance_mcp" });
      return textAndStructured("Pentest note recorded", record);
    }
  );

  server.registerTool(
    "checkpoint_append",
    {
      title: "Append Checkpoint",
      description: "Append a durable checkpoint for long-horizon work, compaction, or handoff.",
      inputSchema: {
        task_id: z.string().min(1).max(FIELD_LIMITS.short),
        summary: z.string().min(1).max(FIELD_LIMITS.medium),
        current_state: z.string().max(FIELD_LIMITS.long).optional(),
        next_step: z.string().max(FIELD_LIMITS.medium).optional(),
        blockers: z.array(z.string().max(FIELD_LIMITS.medium)).max(20).optional(),
        evidence_ids: z.array(z.string().max(FIELD_LIMITS.short)).max(100).optional(),
        verification_ids: z.array(z.string().max(FIELD_LIMITS.short)).max(100).optional()
      }
    },
    async (params) => {
      const taskId = safeId(params.task_id, "task_id");
      const record = await callMemoryMcp("checkpoint_append", {
        task_id: taskId,
        summary: params.summary,
        current_state: params.current_state || "",
        next_step: params.next_step || "",
        blockers: params.blockers ?? []
      });
      await audit({ event: "checkpoint_appended", task_id: taskId, checkpoint_id: record.checkpoint_id, via: "pi_system_governance_mcp" });
      return textAndStructured(`Checkpoint appended: ${stringOf(record.checkpoint_id)}`, record);
    }
  );

  server.registerTool(
    "task_state_read",
    {
      title: "Read Task State",
      description: "Read the latest task snapshot or list known task snapshots.",
      inputSchema: {
        task_id: z.string().min(1).max(FIELD_LIMITS.short).optional()
      }
    },
    async (params) => {
      if (params.task_id) {
        const taskId = safeId(params.task_id, "task_id");
        const delegated = await callMemoryMcp("task_state_read", { task_id: taskId });
        await audit({ event: "task_state_read", task_id: taskId, found: Boolean(delegated.task), via: "pi_system_governance_mcp" });
        return textAndStructured(delegated.task ? `Task state: ${taskId}` : `Task state absent: ${taskId}`, { task_id: taskId, snapshot: delegated.task });
      }

      const delegated = await callMemoryMcp("task_state_read", {});
      const tasks = listField(delegated, "tasks").map((task) => {
        if (!isRecord(task) || typeof task.task_id !== "string") throw new Error("memory-mcp task_state_read returned a malformed task");
        return task.task_id;
      }).sort();
      await audit({ event: "task_state_index_read", count: tasks.length, via: "pi_system_governance_mcp" });
      return textAndStructured(`Task states: ${tasks.length}`, { tasks });
    }
  );

  server.registerTool(
    "task_state_update",
    {
      title: "Update Task State",
      description: "Append a task state version and refresh the latest task snapshot.",
      inputSchema: {
        task_id: z.string().min(1).max(FIELD_LIMITS.short),
        title: z.string().max(FIELD_LIMITS.medium).optional(),
        status: z.enum(["candidate", "active", "blocked", "validated", "rejected", "done"]).optional(),
        active_step: z.string().max(FIELD_LIMITS.medium).optional(),
        next_step: z.string().max(FIELD_LIMITS.medium).optional(),
        evidence_ids: z.array(z.string().max(FIELD_LIMITS.short)).max(100).optional(),
        verification_ids: z.array(z.string().max(FIELD_LIMITS.short)).max(100).optional(),
        notes: z.string().max(FIELD_LIMITS.long).optional()
      }
    },
    async (params) => {
      const taskId = safeId(params.task_id, "task_id");
      const snapshot = await upsertDelegatedTask({
        task_id: taskId,
        title: params.title,
        status: params.status,
        active_step: params.active_step,
        next_step: params.next_step,
        notes: params.notes
      });
      await audit({ event: "task_state_updated", task_id: taskId, version: snapshot.version, via: "pi_system_governance_mcp" });
      return textAndStructured(`Task state updated: ${taskId} v${stringOf(snapshot.version)}`, snapshot);
    }
  );

  server.registerTool(
    "memory_append",
    {
      title: "Append Memory",
      description: "Append durable, operator-reviewable memory for the engagement or coding task.",
      inputSchema: {
        topic: z.string().min(1).max(FIELD_LIMITS.medium),
        content: z.string().min(1).max(FIELD_LIMITS.long),
        source: z.string().max(FIELD_LIMITS.medium).optional(),
        sensitivity_label: z.string().min(1).max(FIELD_LIMITS.short).optional()
      }
    },
    async (params) => {
      const record = await callMemoryMcp("memory_store", {
        topic: params.topic,
        content: params.content,
        tags: [params.source || "pi_system_governance_mcp", params.sensitivity_label || "internal"]
      });
      await audit({ event: "memory_appended", memory_id: record.memory_id, topic: params.topic, via: "pi_system_governance_mcp" });
      return textAndStructured(`Memory appended: ${stringOf(record.memory_id)}`, record);
    }
  );

  server.registerTool(
    "verification_append",
    {
      title: "Append Verification",
      description: "Append a verification record linked to evidence where available.",
      inputSchema: {
        target: z.string().min(1).max(FIELD_LIMITS.medium),
        method: z.string().min(1).max(FIELD_LIMITS.medium),
        result: z.enum(["passed", "failed", "inconclusive"]),
        evidence_ids: z.array(z.string().max(FIELD_LIMITS.short)).max(100).optional(),
        notes: z.string().max(FIELD_LIMITS.long).optional()
      }
    },
    async (params) => {
      const record = {
        verification_id: `VER-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex")}`,
        timestamp: new Date().toISOString(),
        target: params.target,
        method: params.method,
        result: params.result,
        evidence_ids: params.evidence_ids ?? [],
        notes: params.notes || ""
      };
      await appendJsonl(path.join(dataRoot(), "verification", "verification.jsonl"), record);
      await audit({ event: "verification_appended", verification_id: record.verification_id, result: params.result, via: "pi_system_governance_mcp" });
      return textAndStructured(`Verification appended: ${record.verification_id}`, record);
    }
  );

  server.registerTool(
    "state_summary",
    {
      title: "Read Compact State Summary",
      description: "Return a compact recovery summary for small-context models without dumping raw ledgers.",
      inputSchema: {
        max_items: z.number().int().min(1).max(20).optional()
      }
    },
    async (params) => {
      ensureDirs();
      const maxItems = params.max_items || 5;
      const auditFile = path.join(dataRoot(), "audit", "audit.jsonl");
      const evidenceFile = path.join(dataRoot(), "evidence", "ledger.jsonl");
      const verificationFile = path.join(dataRoot(), "verification", "verification.jsonl");
      const memorySummary = await callMemoryMcp("state_summary", { max_items: maxItems });
      const latestEvidence = readJsonlTail(evidenceFile, maxItems).map((record) => ({
        evidence_id: record.evidence_id,
        timestamp: record.timestamp,
        source_tool: record.source_tool,
        source_action_id: record.source_action_id,
        target_asset: record.target_asset,
        summary: record.normalized_summary,
        record_hash: record.record_hash
      }));
      const latestVerification = readJsonlTail(verificationFile, maxItems).map((record) => ({
        verification_id: record.verification_id,
        timestamp: record.timestamp,
        target: record.target,
        method: record.method,
        result: record.result,
        evidence_ids: record.evidence_ids
      }));
      const summary = {
        data_root: dataRoot(),
        counts: {
          audit_records: countJsonl(auditFile),
          evidence_records: countJsonl(evidenceFile),
          memory_records: (isRecord(memorySummary.counts) ? memorySummary.counts.memories : undefined) || 0,
          verification_records: countJsonl(verificationFile)
        },
        latest_hashes: {
          audit: readLastChainRecord(auditFile).record_hash,
          evidence: readLastChainRecord(evidenceFile).record_hash
        },
        tasks: listField(memorySummary, "tasks"),
        latest_evidence: latestEvidence,
        latest_verification: latestVerification,
        latest_memory: listField(memorySummary, "latest_memory")
      };
      await audit({ event: "state_summary_read", max_items: maxItems, via: "pi_system_governance_mcp" });
      return textAndStructured(`State summary: ${summary.tasks.length} tasks, ${summary.counts.evidence_records} evidence records`, summary);
    }
  );
}

async function main(): Promise<void> {
  ensureDirs();
  const server = new McpServer({
    name: "pi-system-governance",
    version: "0.1.0"
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
