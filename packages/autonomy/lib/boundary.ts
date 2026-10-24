// The effective boundary of a run, rendered for a human and as JSON, with a stable digest.
//
// `plan` prints it, `start` shows it and requires either an interactive confirmation or an
// `authorisation` block in the contract whose boundaryDigest equals the digest computed here.
// The digest covers the security-relevant fields only (canonical JSON, sha256): change what a
// run may touch, spend, run or promote and the digest changes; change the title, the
// specification, the backlog or the run id and it does not, so an authorised configuration can
// be reused for repeated runs. The authorisation record is a consent/integrity record, not a
// signature: whoever can write the contract file can write it. The trusted supervisor runs on
// the host from a checkout outside the worker's writable area, so the worker cannot change
// the contract, the digest, the check definitions or the supervisor's code.
import fs from "node:fs";
import type { ContractAuthorisation, ContractDraft, RunContract } from "./contract.ts";
import type { EffortApi } from "./effort.ts";
import { canonicalJson, sha256 } from "./fsutil.ts";
import type { RunAuthorisation } from "./lifecycle.ts";

export const BOUNDARY_VERSION = 1;

/** Always-on properties of every container the supervisor starts (not configurable). */
export const INVARIANTS = [
  "runs as a non-root user with a read-only root filesystem",
  "has all Linux capabilities dropped, no-new-privileges and pids/memory/cpu limits",
  "is on an internal network only, with no route off the host and no DNS beyond container names (the relay and the egress proxy are the only exceptions, and only toward their fixed destinations)",
  "is never privileged, on the host network or sharing a host namespace",
  "has no container-engine socket, home directory or credential store mounted",
];

function fileHash(file: string): string | null {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

type Draft = ContractDraft;
type DraftPermissions = Draft["permissions"];

/** Which credential a run service receives, under which variable. */
export interface CredentialDelivery {
  service: string;
  env: string;
  name: string;
}

/** The security-relevant subset of a contract (see boundaryFields); the digest is computed over it. */
export interface BoundaryFields {
  boundaryVersion: number;
  template: Draft["template"];
  inputs: { repository: Draft["inputs"]["repository"]; references: Draft["inputs"]["references"] };
  filesystem: { writeAreas: DraftPermissions["writeAreas"] };
  network: { egress: DraftPermissions["network"]["egress"]; serviceImages: DraftPermissions["network"]["serviceImages"]; services: DraftPermissions["network"]["services"] };
  credentials: { names: DraftPermissions["credentials"]["names"]; delivery: CredentialDelivery[] };
  process: Pick<Draft["runtime"], "engine" | "image" | "user" | "memory" | "cpus" | "pids" | "tmpSize">;
  outputs: DraftPermissions["outputs"];
  promotion: Draft["promotion"];
  unattended: DraftPermissions["unattended"];
  model: {
    provider: Draft["model"]["provider"]; worker: string; manager: string; review: string; extra: string[];
    upstream: Draft["providerSettings"]["upstream"]; apiKeyEnv: Draft["providerSettings"]["apiKeyEnv"]; authName: Draft["providerSettings"]["authName"];
    headers: Draft["providerSettings"]["headers"]; pricing: Draft["providerSettings"]["pricing"];
  };
  effort: Draft["effort"];
  budget: Draft["budget"];
  recovery: Draft["recovery"];
  acceptance: { review: boolean; checks: Draft["acceptance"]["checks"]; overlay: Array<{ target: string; sha256: string | null }> };
  templateOptions: Draft["templateOptions"];
}

/** The security-relevant subset of a resolved contract. */
export function boundaryFields(contract: ContractDraft): BoundaryFields {
  const p = contract.permissions;
  return {
    boundaryVersion: BOUNDARY_VERSION,
    template: contract.template,
    inputs: { repository: contract.inputs.repository, references: contract.inputs.references },
    filesystem: { writeAreas: p.writeAreas },
    network: { egress: p.network.egress, serviceImages: p.network.serviceImages, services: p.network.services },
    credentials: { names: p.credentials.names, delivery: p.network.services.flatMap((s) => Object.entries(s.credentialEnv).map(([env, name]) => ({ service: s.name, env, name }))) },
    process: { engine: contract.runtime.engine, image: contract.runtime.image, user: contract.runtime.user, memory: contract.runtime.memory, cpus: contract.runtime.cpus, pids: contract.runtime.pids, tmpSize: contract.runtime.tmpSize },
    outputs: p.outputs,
    promotion: contract.promotion,
    unattended: p.unattended,
    // Everything that decides WHICH credential the relay sends WHERE is part of the boundary: the variable, the pi login and the
    // extra headers as well as the destination, so none can be swapped after the operator authorised the digest.
    model: { provider: contract.model.provider, worker: contract.model.worker, manager: contract.model.manager, review: contract.model.review, extra: contract.model.extra, upstream: contract.providerSettings.upstream, apiKeyEnv: contract.providerSettings.apiKeyEnv, authName: contract.providerSettings.authName, headers: contract.providerSettings.headers, pricing: contract.providerSettings.pricing },
    effort: contract.effort,
    budget: contract.budget,
    recovery: contract.recovery,
    acceptance: {
      review: contract.acceptance.review,
      checks: contract.acceptance.checks,
      overlay: contract.acceptance.overlay.map((o) => ({ target: o.target, sha256: fileHash(o.source) })),
    },
    templateOptions: contract.templateOptions,
  };
}

export function boundaryDigest(contract: ContractDraft): string {
  return sha256(canonicalJson(boundaryFields(contract)));
}

const list = (items: readonly string[], none = "none"): string => (items.length ? items.join(", ") : none);
const upstreamHost = (url: string | undefined): string => { try { return new URL(String(url)).host; } catch { return String(url); } };
/** Which secret the relay uses, in words: the value of a variable in the supervisor's environment, and/or a pi login. */
const inferenceKeyText = (s: Draft["providerSettings"]): string => [s.apiKeyEnv ? `the value of ${s.apiKeyEnv} in your environment` : null, s.authName ? `${s.apiKeyEnv ? "else " : ""}your pi login "${s.authName}"` : null].filter(Boolean).join(", ") || "your provider login";
const usd = (n: unknown): string => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;

/** renderBoundary's JSON form (`plan --json`, `boundary --json`). */
export interface BoundaryJson {
  run: string;
  template: Draft["template"];
  digest: string;
  invariants: readonly string[];
  boundary: BoundaryFields;
}

export interface RenderedBoundary {
  digest: string;
  fields: BoundaryFields;
  text: string;
  json: BoundaryJson;
}

/**
 * The boundary of a resolved contract (or a draft, for display), as text and JSON.
 * `effort` is the effort API, for the tier label.
 */
export function renderBoundary(contract: ContractDraft, { effort }: { effort?: Pick<EffortApi, "tierLabel"> | null | undefined } = {}): RenderedBoundary {
  const fields = boundaryFields(contract);
  const digest = sha256(canonicalJson(fields));
  const p = contract.permissions;
  const tier = (id: string): string => { try { return effort?.tierLabel ? effort.tierLabel(id) : id; } catch { return id; } };
  const repo = contract.inputs.repository;
  const lines: string[] = [];
  const section = (title: string, rows: readonly string[]): void => { lines.push(title); for (const r of rows) lines.push(`  ${r}`); };

  section("Filesystem", [
    `worker writes: /work (${repo ? `a clone of ${String(repo.path ?? repo.url)} at ${repo.ref}` : "an empty repository"}), /state (its own pi state), /tmp (${contract.runtime.tmpSize} tmpfs)`,
    `worker reads:  /run (this contract, sanitised, read-only)${Object.keys(contract.inputs.references).length ? `, /reference/{${Object.keys(contract.inputs.references).join(",")}} (read-only snapshots)` : ""}`,
    `changes accepted only under: ${p.writeAreas.join(", ")}`,
    "never mounted: your home directory, credential stores, the host root, the container-engine socket",
  ]);
  section("Network", [
    "the worker is on an internal network with no route off the host and no DNS beyond container names",
    `model inference: only through the relay to ${String(contract.providerSettings.upstream)} (models: ${list([...new Set([contract.model.worker, contract.model.manager, contract.model.review, ...contract.model.extra])])})`,
    p.network.egress.length
      ? `egress (through the allowlist proxy, DNS resolved by the proxy, no private/loopback/metadata addresses): ${p.network.egress.map((e) => `${e.host}:${e.ports.join("/")}${e.plainGet ? " (+plain GET)" : ""}`).join(", ")}`
      : "egress: none (no package downloads, no internet, no LAN)",
    p.network.services.length
      ? `run services, started by the supervisor: ${p.network.services.map((s) => `${s.name} (${s.image}, port ${s.port}${s.workspaceMounts.length ? `, serves ${s.workspaceMounts.map((m) => m.source).join("+")} from the workspace` : ""})`).join("; ")}`
      : "run services: none",
  ]);
  section("Credentials", [
    p.credentials.names.length ? `names: ${p.credentials.names.join(", ")} (values are read from your environment by the supervisor; ${fields.credentials.delivery.length ? `given only to ${list([...new Set(fields.credentials.delivery.map((d) => d.service))])}` : "given to nothing"}; never to the worker or a check)` : "none",
    `inference key: ${inferenceKeyText(contract.providerSettings)} is sent to ${upstreamHost(contract.providerSettings.upstream)} by the relay, held by the relay only (received on stdin), never in a worker mount or environment`,
    ...(Object.keys(contract.providerSettings.headers ?? {}).length ? [`extra request headers to the provider: ${Object.keys(contract.providerSettings.headers).join(", ")}`] : []),
  ]);
  section("Processes and resources", [
    `${contract.runtime.engine} image ${contract.runtime.image}; memory ${contract.runtime.memory}, cpus ${contract.runtime.cpus}, pids ${contract.runtime.pids}`,
    `user: ${contract.runtime.user === "host" ? "your own uid:gid" : contract.runtime.user.startsWith("0:") ? `${contract.runtime.user}, root INSIDE a rootless engine's user namespace only (mapped to your own user; the run refuses to start on a rootful engine)` : contract.runtime.user}`,
    ...INVARIANTS.map((s) => `each container ${s}`),
  ]);
  section("Unattended operation", [
    p.unattended.authorised
      ? `authorised: in-zone actions run without approval prompts (PI_KIT_UNATTENDED=1 with the boundary declared as the container); hard-deny rules stay; anything needing authority outside the zone fails closed`
      : "not authorised: the worker's normal approval prompts apply, so the run blocks whenever one appears",
    p.unattended.autoApprove ? "approval dialogs from the worker are answered automatically; questions that need a human block the run instead" : "approval dialogs are not answered automatically: the run blocks until you answer",
  ]);
  section("Outputs and promotion", [
    p.outputs.destinations.length ? `automatic outputs: ${p.outputs.destinations.map((d) => d.path).join(", ")}` : "automatic outputs: none (use `export` to take results out)",
    contract.promotion.policy === "none" ? "promotion: none. Nothing is pushed or written outside the run directory."
      : contract.promotion.policy === "local-branch" ? `promotion: local branch only: ${contract.promotion.destinations.map((d) => `${String(d.branch)} in ${("repo" in d ? d.repo : undefined) ?? "the run's own mirror"}`).join(", ")}. No remote is contacted.`
        : `promotion: PUSH to ${contract.promotion.destinations.map((d) => `${String("url" in d ? d.url : undefined)} (${String(d.branch)}${"tags" in d && d.tags ? " + tags" : ""})`).join(", ")}; ${contract.promotion.requiresOperatorApproval ? "each push needs your approval (`promote`)" : "pushed automatically without asking again"}`,
    "public deployment, production changes and anything outside the zone are never done by a worker",
  ]);
  section("Model and effort", [
    `provider ${contract.model.provider}; worker ${contract.model.worker}; manager ${contract.model.manager}; review ${contract.model.review}`,
    `effort ${tier(contract.effort.tier)} (cap ${tier(contract.effort.cap)}), fixed when the run starts; only \`reconfigure\` changes it`,
  ]);
  section("Budget and recovery", [
    `${usd(contract.budget.totalUsd)} total, ${usd(contract.budget.perStepUsd)} per step, ${contract.budget.maxSteps} steps, ${contract.budget.maxMinutes} minutes of active time`,
    `recovery: up to ${contract.recovery.softNudges} soft nudge(s), then ${contract.recovery.hardRestarts} hard restart(s), at most ${contract.recovery.maxAttemptsPerStep} attempts per step; counters persist and never reset`,
  ]);
  section("Completion", [
    `template ${String(contract.template)}: ${contract.acceptance.checks.length} check(s) [${contract.acceptance.checks.map((c) => `${c.id}${c.required ? "*" : ""}`).join(", ")}] (* required)${contract.acceptance.overlay.length ? `, ${contract.acceptance.overlay.length} held-out file(s) copied over the clone` : ""}; review ${contract.acceptance.review ? "required" : "not required"}`,
    // The files are copied from the host into the run directory and mounted into the (worker-code-running) check containers.
    ...contract.acceptance.overlay.map((o) => `held-out file: ${o.target} <- ${o.source} (copied at start; the check containers read it)`),
  ]);
  const text = [`Boundary for run ${contract.run} (template ${String(contract.template)})`, `digest ${digest}`, "", ...lines].join("\n");
  return { digest, fields, text, json: { run: contract.run, template: contract.template, digest, invariants: INVARIANTS, boundary: fields } };
}

/** authorisationStatus's answer; `H` is what a draft's unresolved fields may hold (undefined), `never` for a resolved contract. */
export type AuthorisationStatus<H = never> =
  | { status: "missing" }
  | { status: "authorised"; by: string | H; at: string | H }
  | { status: "mismatch"; expected: string; found: string | H; by: string | H; at: string | H };

/** Compare the contract's authorisation block with the digest computed from the rest of it. */
export function authorisationStatus<H = never>(contract: { readonly authorisation: ContractAuthorisation<H> | null }, digest: string): AuthorisationStatus<H> {
  const a = contract.authorisation;
  if (!a) return { status: "missing" };
  if (a.boundaryDigest === digest) return { status: "authorised", by: a.by, at: a.at };
  return { status: "mismatch", expected: digest, found: a.boundaryDigest, by: a.by, at: a.at };
}

/**
 * What `start` may do. Pure, so every path is tested.
 *   authorised in the contract            -> start without prompting
 *   digest mismatch                       -> refuse (always; the file is inconsistent)
 *   no authorisation, TTY                 -> confirm (or proceed on --yes: a person is present)
 *   no authorisation, no TTY              -> refuse, even with --yes: a flag alone is not consent
 */
export type StartDecision =
  | { action: "start"; via: "contract" | "tty-yes"; authorisation: RunAuthorisation; code?: never; message?: never }
  | { action: "refuse"; code: "digest_mismatch" | "authorisation_required"; message: string; via?: never; authorisation?: never }
  | { action: "confirm"; code?: never; message?: never; via?: never; authorisation?: never };

export function decideStart({ contract, digest, yes = false, isTTY = false }: { contract: Pick<RunContract, "authorisation">; digest: string; yes?: boolean; isTTY?: boolean }): StartDecision {
  const auth = authorisationStatus(contract, digest);
  if (auth.status === "authorised") return { action: "start", via: "contract", authorisation: { boundaryDigest: digest, by: auth.by, at: auth.at, via: "contract" } };
  if (auth.status === "mismatch") {
    return { action: "refuse", code: "digest_mismatch", message: `the authorisation in the contract is for boundary ${auth.found.slice(0, 12)}, but this contract's boundary is ${digest.slice(0, 12)}. The contract changed after it was authorised (or the authorisation belongs to another configuration). Review the boundary with \`plan\`, then re-authorise with \`plan --authorise\` or remove the authorisation block.` };
  }
  if (isTTY) return yes ? { action: "start", via: "tty-yes", authorisation: { boundaryDigest: digest, by: null, at: null, via: "tty-yes" } } : { action: "confirm" };
  return { action: "refuse", code: "authorisation_required", message: `no interactive terminal and no authorisation for boundary ${digest.slice(0, 12)} in the contract. --yes alone is not consent. Review the boundary with \`plan\`, then either run \`plan --authorise --by <name>\` (records the digest in the contract) or start from a terminal.` };
}
