import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionBridge, terminalUi, type BridgeState } from "./bridge.ts";
import { ControlLink, ensureHost, HostError, hostStatus, adminRequest, resetIdentity, stopHost, stateDir, type Json } from "./host.ts";

// remote-control adds `/remote`: drive this pi from the pi remote Android app, directly over the
// LAN or a VPN such as Tailscale. No cloud service is involved.
//
// `/remote` starts the pi remote host (packages/web-ui/server/remote-host.js, a detached Node
// process shared by every terminal), shares this session with it, and, when no phone is linked
// yet, shows a QR code to link one. Linking needs the one-time code from this terminal AND the
// operator's approval here, after comparing the device ID the phone shows; phones then log in
// with a key kept in the phone's keystore. See docs/remote-control.md for the security design.
//
// The extension opens no socket and starts no timer until `/remote` is used (or, with
// PI_REMOTE_AUTO_ATTACH=1, until a session starts while a host is already running). It only acts
// in an interactive terminal: in rpc, json and print mode the commands that link phones or share
// sessions are refused, so a session driven from a phone cannot link another phone.
//
// Self-containment rule: import only node:* builtins and pi peers.

const SHARED_KEY = Symbol.for("pi-system.remote-control.shared");
const WIDGET = "remote-pair";
const STATUS = "remote";
const PAIR_TTL_SEC = 300;
const APPROVAL_TIMEOUT_MS = 270_000;

interface Shared {
  /** This pi process asked to share its sessions; survives /new, /resume, /fork and /reload. */
  wantAttach: boolean;
}

function shared(): Shared {
  const g = globalThis as any;
  if (!g[SHARED_KEY]) g[SHARED_KEY] = { wantAttach: false } satisfies Shared;
  return g[SHARED_KEY] as Shared;
}

const USAGE = [
  "Usage: /remote [pair|status|devices|revoke <id>|rename <id> <name>|detach|stop|reset]",
  "  (none)   Start the pi remote host if needed and share this session with linked phones.",
  "           Shows a QR code to link a phone when none is linked yet.",
  "  pair     Link a phone: scan the QR code with the pi remote app, then approve it here.",
  "  status   Host addresses, certificate fingerprint, linked phones and shared sessions.",
  "  devices  List linked phones.",
  "  revoke   Unlink a phone (by device id prefix or name); its sessions are closed at once.",
  "  rename   Rename a linked phone.",
  "  detach   Stop sharing this session; the host keeps serving other terminals.",
  "  stop     Stop the host: every phone is disconnected.",
  "  reset    New certificate and server identity; every phone must be linked again.",
].join("\n");

const SUBCOMMANDS = ["pair", "status", "devices", "revoke", "rename", "detach", "stop", "reset", "help"];

function isTerminal(ctx: ExtensionContext): boolean {
  const mode = (ctx as any).mode as string | undefined;
  return mode ? mode === "tui" : ctx.hasUI;
}

function say(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  try {
    terminalUi(ctx.ui).notify(message, level);
  } catch {
    /* the session may be shutting down */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ rendering ---
/** Half-block QR code: two module rows per text row, dark modules black on a white background. */
export function qrLines(rows: string[], quiet = 2): string[] {
  const size = rows.length;
  const dark = (r: number, c: number) => r >= 0 && r < size && c >= 0 && c < size && rows[r][c] === "1";
  const lines: string[] = [];
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = "";
    for (let c = -quiet; c < size + quiet; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines;
}

function hostLine(status: Json): string {
  const addresses: string[] = Array.isArray(status.addresses) ? status.addresses : [];
  if (!addresses.length) return `port ${status.port} (no network address found; set PI_REMOTE_ADVERTISE)`;
  return addresses.map((a) => `${a.includes(":") ? `[${a}]` : a}:${status.port}`).join(", ");
}

/** Rows kept for what shares the screen with the widget: the waiting dialog, the footer and a spacer. */
const RESERVED_ROWS = 10;
/** The narrowest details column worth putting beside the QR code: "Certificate  " plus the 39-character fingerprint. */
const DETAILS_MIN = 52;
const GAP = 3;

/**
 * Word-wrap `text` to `width`, indenting continuation lines by `hang` (dropped when it would leave too little
 * room); a word longer than the room is split. No line is ever longer than `width`.
 */
function wrap(text: string, width: number, hang = 0): string[] {
  width = Math.max(1, width);
  const pad = " ".repeat(hang <= width / 2 ? hang : 0);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length <= width) {
      line += ` ${word}`;
      continue;
    }
    if (!word) continue;
    if (line) lines.push(line);
    let lead = lines.length ? pad : "";
    let rest = word;
    while (lead.length + rest.length > width) {
      const room = Math.max(1, width - lead.length);
      lines.push(lead + rest.slice(0, room));
      rest = rest.slice(room);
      lead = pad;
    }
    line = lead + rest;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The pairing panel, laid out for the room there is. pi cuts a string-array widget off at 10 lines, but the QR
 * code alone is 23 to 27 rows, so the panel is a component that reads the terminal size on every render:
 * the QR code beside the details when the terminal is wide enough, above them when it is only tall enough,
 * and otherwise just the details (which link a phone by hand) with the size the QR code needs.
 * Every line is at most `width` columns wide. `termRows` of 0 means the height is unknown.
 */
export function pairPanel(offer: Json, width: number, termRows: number, style?: { title(s: string): string; dim(s: string): string }): string[] {
  const inner = Math.max(1, width - 2);
  const qr = Array.isArray(offer.qr?.rows) ? qrLines(offer.qr.rows) : [];
  const qrWidth = (offer.qr?.size || 0) + 4;
  const expires = new Date(offer.expiresAt);
  const at = Number.isNaN(expires.getTime()) ? "" : ` (expires ${expires.toTimeString().slice(0, 5)})`;
  const title = `pi remote: link a phone${at}`;
  const room = termRows > 0 ? termRows - RESERVED_ROWS : Infinity;
  const fields = (w: number) => [
    ...wrap(`Address      ${hostLine(offer)}`, w, 13),
    ...wrap(`Code         ${offer.codeDisplay}`, w, 13),
    ...wrap(`Certificate  ${offer.fingerprintDisplay}`, w, 13),
  ];
  const approve = (w: number) => wrap("You approve the phone here after it asks; the code alone links nothing.", w);
  const out: string[] = wrap(title, inner).map((line) => (style ? style.title(line) : line));

  if (qr.length && inner >= qrWidth + GAP + DETAILS_MIN && qr.length + 1 <= room) {
    const w = inner - qrWidth - GAP;
    const details = [...wrap("Scan this with the pi remote app, or add the host by hand in the app:", w), "", ...fields(w), "", ...approve(w)];
    const blank = " ".repeat(qrWidth);
    for (let i = 0; i < Math.max(qr.length, details.length); i++) out.push(`${qr[i] ?? blank}${" ".repeat(GAP)}${details[i] ?? ""}`);
  } else if (qr.length && inner >= qrWidth && qr.length + fields(inner).length + approve(inner).length + 4 <= room) {
    out.push(...wrap("Scan this with the pi remote app, or add the host by hand in the app:", inner), "", ...qr, "", ...fields(inner), "", ...approve(inner));
  } else {
    // The rows it would take at this width: beside the details when they fit, otherwise above them.
    const beside = inner >= qrWidth + GAP + DETAILS_MIN;
    const rowsNeeded = RESERVED_ROWS + qr.length + (beside ? 1 : fields(Math.max(inner, qrWidth)).length + approve(Math.max(inner, qrWidth)).length + 4);
    const note = `The QR code needs a terminal of at least ${qrWidth + 2} columns by ${rowsNeeded} rows (this one is ${width} by ${termRows || "?"}); enlarge it, or add the host by hand in the pi remote app:`;
    out.push(...wrap(note, inner).map((line) => (style ? style.dim(line) : line)), "", ...fields(inner), "", ...approve(inner));
  }
  return out.map((line) => ` ${line}`);
}

/** The widget pi mounts above the editor: a component, so pi does not cut it off at 10 lines. */
function pairWidget(offer: Json) {
  return (tui: any, theme: any) => ({
    render: (width: number) =>
      pairPanel(offer, width, Number(tui?.terminal?.rows) || 0, theme ? { title: (s) => theme.bold(theme.fg("accent", s)), dim: (s) => theme.fg("dim", s) } : undefined),
    invalidate() {},
  });
}

function deviceLines(devices: Json[]): string[] {
  if (!devices.length) return ["  (no phones linked; /remote pair links one)"];
  return devices.map((d) => {
    const seen = d.lastSeenAt ? `last seen ${String(d.lastSeenAt).slice(0, 16).replace("T", " ")}` : "never seen";
    return `  ${d.online ? "●" : "○"} ${d.name}  ${d.display}  ${seen}${d.lastAddress ? ` from ${d.lastAddress}` : ""}`;
  });
}

function statusLines(status: Json, attachedHere: boolean): string[] {
  const sessions: Json[] = Array.isArray(status.terminalSessions) ? status.terminalSessions : [];
  return [
    `pi remote host "${status.name}" (pid ${status.pid}, ${status.version})`,
    `  Listening    ${status.bindMode === "all" ? "all interfaces" : status.bind}, port ${status.port}`,
    `  Reach it at  ${hostLine(status)}`,
    `  Certificate  ${status.fingerprintDisplay}`,
    `  This session ${attachedHere ? "is shared" : "is not shared (/remote shares it)"}`,
    `  Shared terminal sessions: ${sessions.length}; sessions started from phones: ${status.runningSessions}; open phone streams: ${status.streams}`,
    "Linked phones:",
    ...deviceLines(Array.isArray(status.devices) ? status.devices : []),
    ...(Array.isArray(status.recent) && status.recent.length
      ? ["Recent refusals:", ...status.recent.map((r: Json) => `  ${String(r.at || "").slice(0, 19).replace("T", " ")} ${r.event}${r.address ? ` from ${r.address}` : ""}`)]
      : []),
  ];
}

// ------------------------------------------------------------------- pairing ---
type PairOutcome = "linked" | "rejected" | "cancelled" | "failed";

/**
 * Show a pairing code and QR code, wait for a phone to claim it, and ask the operator to approve.
 * The approval prompt uses the terminal's own dialog (never mirrored to a phone).
 */
async function runPairing(ctx: ExtensionCommandContext): Promise<PairOutcome> {
  const ui = terminalUi(ctx.ui);
  const admin = await ControlLink.open("admin");
  const events: Json[] = [];
  let wake: (() => void) | null = null;
  admin.onMessage = (msg) => {
    if (msg.t !== "evt") return;
    events.push(msg);
    wake?.();
  };
  let hostGone = false;
  admin.onClose = () => {
    hostGone = true;
    wake?.();
  };

  let offer: Json;
  try {
    offer = await admin.request("pair.create", { ttlSec: PAIR_TTL_SEC });
  } catch (error) {
    admin.close();
    throw error;
  }

  ctx.ui.setWidget(WIDGET, pairWidget(offer), { placement: "aboveEditor" });
  const expiresAt = Date.parse(offer.expiresAt) || Date.now() + PAIR_TTL_SEC * 1000;
  try {
    for (;;) {
      // Wait for a link request, the code to expire, or the operator to give up.
      const waiting = new AbortController();
      wake = () => waiting.abort();
      if (events.length || hostGone) waiting.abort();
      const expiry = setTimeout(() => waiting.abort(), Math.max(0, expiresAt - Date.now()));
      const choice = await ui.select("Waiting for the phone: scan the QR code above with pi remote", ["Cancel linking"], { signal: waiting.signal });
      clearTimeout(expiry);
      wake = null;

      if (hostGone) {
        say(ctx, "remote: the host stopped while linking.", "error");
        return "failed";
      }
      const event = events.shift();
      if (!event) {
        if (choice === "Cancel linking" || !waiting.signal.aborted) {
          await admin.request("pair.cancel").catch(() => {});
          say(ctx, "remote: linking cancelled.");
          return "cancelled";
        }
        if (Date.now() >= expiresAt) {
          await admin.request("pair.cancel").catch(() => {});
          say(ctx, "remote: the pairing code expired. /remote pair makes a new one.", "warning");
          return "failed";
        }
        continue;
      }
      if (event.name === "pair.closed") {
        say(ctx, `remote: pairing ended: ${event.data?.reason || "closed"}. /remote pair makes a new code.`, "warning");
        return "failed";
      }
      if (event.name !== "pair.request") continue;

      const request = event.data || {};
      ctx.ui.setWidget(WIDGET, undefined);
      const title = [
        `Link "${request.name}" (${request.platform || "phone"}) from ${request.address || "an unknown address"}?`,
        "",
        `   Device ID   ${request.deviceIdDisplay}`,
        "",
        "Approve only if the phone in your hand shows exactly this device ID.",
        request.alreadyLinked ? "This key is already linked; approving keeps it linked under the new name." : "",
      ]
        .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
        .join("\n");
      const approve = "Approve: the device IDs match";
      const answer = await ui.select(title, [approve, "Reject"], { timeout: APPROVAL_TIMEOUT_MS });
      const approved = answer === approve;
      const result: Json = await admin.request("pair.decide", { requestId: request.requestId, approve: approved });
      if (result.state === "approved") {
        say(ctx, `remote: linked "${result.name}" (${result.deviceIdDisplay}).`);
        return "linked";
      }
      say(ctx, `remote: ${result.state === "rejected" ? "rejected" : result.state} "${request.name}". /remote pair makes a new code.`, "warning");
      return "rejected";
    }
  } finally {
    wake = null;
    try {
      ctx.ui.setWidget(WIDGET, undefined);
    } catch {
      /* session ended */
    }
    admin.close();
  }
}

// ------------------------------------------------------------------ extension ---
export default function remoteControl(pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | null = null;

  const setStatus = (state: BridgeState, detail?: string) => {
    const ctx = currentCtx;
    if (!ctx || !ctx.hasUI) return;
    try {
      if (state === "attached") ctx.ui.setStatus(STATUS, "remote ●");
      else if (state === "reconnecting") ctx.ui.setStatus(STATUS, `remote ○ ${detail ? "host not running" : "reconnecting"}`);
      else if (state === "connecting") ctx.ui.setStatus(STATUS, "remote …");
      else ctx.ui.setStatus(STATUS, undefined);
    } catch {
      /* the session may be shutting down */
    }
  };

  const bridge = new SessionBridge({ pi, getCtx: () => currentCtx, onState: setStatus });

  const track = (ctx: ExtensionContext) => {
    currentCtx = ctx;
  };

  pi.on("session_start", async (_event, ctx) => {
    track(ctx);
    if (!isTerminal(ctx)) return;
    if (!shared().wantAttach && process.env.PI_REMOTE_AUTO_ATTACH !== "1") return;
    // Re-share after /new, /resume, /fork or /reload, or share automatically when asked to.
    // The host is never started from here: only an explicit /remote starts it.
    bridge.attach().catch((error) => {
      if (shared().wantAttach) setStatus("reconnecting", errorText(error));
    });
  });

  pi.on("session_shutdown", async () => {
    bridge.detach();
    currentCtx = null;
  });

  const forward = (event: any, ctx: ExtensionContext) => {
    currentCtx = ctx;
    bridge.observe(event);
  };
  pi.on("agent_start", forward);
  pi.on("agent_end", forward);
  pi.on("agent_settled", forward);
  pi.on("turn_start", forward);
  pi.on("turn_end", forward);
  pi.on("message_start", forward);
  pi.on("message_update", forward);
  pi.on("message_end", forward);
  pi.on("tool_execution_start", forward);
  pi.on("tool_execution_update", forward);
  pi.on("tool_execution_end", forward);
  pi.on("session_compact", (_event, ctx) => forward({ type: "compaction_end" }, ctx));

  const metaChanged = (_event: unknown, ctx: ExtensionContext) => {
    currentCtx = ctx;
    bridge.sendMeta();
  };
  pi.on("model_select", metaChanged);
  pi.on("thinking_level_select", metaChanged);
  pi.on("session_info_changed", metaChanged);

  pi.on("ui_prompt_start", (event, ctx) => {
    currentCtx = ctx;
    if (event.kind === "editor" || event.kind === "custom") {
      bridge.notify(`pi is waiting for input at the computer${event.title ? `: ${event.title}` : ""}`, "warning");
    }
  });

  async function share(ctx: ExtensionCommandContext, forcePair: boolean): Promise<void> {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS, "remote: starting…");
    let status: Json;
    let started: boolean;
    try {
      ({ status, started } = await ensureHost());
    } catch (error) {
      setStatus(bridge.attached ? "attached" : "detached");
      say(ctx, `remote: could not start the host: ${errorText(error)}`, "error");
      return;
    }
    try {
      await bridge.attach();
      shared().wantAttach = true;
    } catch (error) {
      setStatus("detached");
      say(ctx, `remote: the host is running but this session could not be shared: ${errorText(error)}`, "error");
      return;
    }
    const devices: Json[] = Array.isArray(status.devices) ? status.devices : [];
    if (started) say(ctx, `remote: host started, reachable at ${hostLine(status)}`);
    if (forcePair || devices.length === 0) {
      const outcome = await runPairing(ctx).catch((error) => {
        say(ctx, `remote: linking failed: ${errorText(error)}`, "error");
        return "failed" as const;
      });
      if (outcome !== "linked" && devices.length === 0) {
        say(ctx, "remote: this session is shared, but no phone is linked yet. /remote pair links one.");
      }
      if (outcome !== "linked") return;
    }
    say(ctx, `remote: this session is shared with your linked phones (open pi remote). Host: ${hostLine(status)}. /remote detach stops sharing it.`);
  }

  pi.registerCommand("remote", {
    description: "Drive this pi from the pi remote Android app: share this session, link phones, manage the host",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const matches = SUBCOMMANDS.filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s }));
      return matches.length ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      currentCtx = ctx;
      const words = args.trim().split(/\s+/).filter(Boolean);
      const sub = (words[0] || "").toLowerCase();

      if (sub === "help" || sub === "-h" || sub === "--help") return say(ctx, USAGE);
      if (sub && !SUBCOMMANDS.includes(sub) && !["on", "start", "attach", "off"].includes(sub)) {
        return say(ctx, `remote: unknown action "${sub}"\n\n${USAGE}`, "error");
      }

      // Read-only views work everywhere; anything that links phones or shares sessions needs a
      // person at an interactive terminal.
      if (sub === "status") {
        let status: Json | null;
        try {
          status = await hostStatus();
        } catch (error) {
          return say(ctx, `remote: ${errorText(error)}`, "error");
        }
        if (!status) return say(ctx, `remote: the host is not running. /remote starts it. (State: ${stateDir()})`);
        return say(ctx, statusLines(status, bridge.attached).join("\n"));
      }
      if (sub === "devices") {
        try {
          const { devices } = await adminRequest<{ devices: Json[] }>("devices.list");
          return say(ctx, ["Linked phones:", ...deviceLines(devices)].join("\n"));
        } catch (error) {
          if (error instanceof HostError && error.code === "not_running") return say(ctx, "remote: the host is not running. /remote starts it.");
          return say(ctx, `remote: ${errorText(error)}`, "error");
        }
      }
      if (!isTerminal(ctx)) {
        return say(ctx, "remote: this only works in an interactive pi terminal: linking a phone needs a person at the computer to approve it.", "error");
      }

      if (sub === "detach" || sub === "off") {
        shared().wantAttach = false;
        const was = bridge.attached;
        bridge.detach();
        return say(ctx, was ? "remote: this session is no longer shared. The host keeps running (/remote stop stops it)." : "remote: this session was not shared.");
      }

      if (sub === "stop") {
        shared().wantAttach = false;
        bridge.detach();
        try {
          const stopped = await stopHost();
          return say(ctx, stopped ? "remote: host stopped; every phone is disconnected." : "remote: the host was not running.");
        } catch (error) {
          return say(ctx, `remote: could not stop the host: ${errorText(error)}`, "error");
        }
      }

      if (sub === "revoke" || sub === "rename") {
        const target = words[1];
        if (!target) return say(ctx, `Usage: /remote ${sub} <device id prefix or name>${sub === "rename" ? " <new name>" : ""}`, "error");
        try {
          if (sub === "rename") {
            const name = words.slice(2).join(" ");
            if (!name) return say(ctx, "Usage: /remote rename <device id prefix or name> <new name>", "error");
            const { device } = await adminRequest<{ device: Json }>("devices.rename", { deviceId: target, name });
            return say(ctx, `remote: renamed ${device.display} to "${device.name}".`);
          }
          const { devices } = await adminRequest<{ devices: Json[] }>("devices.list");
          const q = target.toUpperCase().replace(/[\s-]/g, "");
          const match = devices.filter((d) => d.id.startsWith(q) || String(d.name).toUpperCase() === target.toUpperCase());
          if (match.length !== 1) return say(ctx, `remote: ${match.length ? "more than one" : "no"} linked phone matches "${target}".\n${deviceLines(devices).join("\n")}`, "error");
          const ok = await terminalUi(ctx.ui).confirm(`Unlink "${match[0].name}" (${match[0].display})?`, "It is disconnected at once and must be linked again to come back.");
          if (!ok) return say(ctx, "remote: not unlinked.");
          const { revoked } = await adminRequest<{ revoked: Json }>("devices.revoke", { deviceId: match[0].id });
          return say(ctx, `remote: unlinked "${revoked.name}" (${revoked.display}).`);
        } catch (error) {
          if (error instanceof HostError && error.code === "not_running") return say(ctx, "remote: the host is not running. /remote starts it.");
          return say(ctx, `remote: ${errorText(error)}`, "error");
        }
      }

      if (sub === "reset") {
        const ok = await terminalUi(ctx.ui).confirm(
          "Reset pi remote?",
          "The host stops, its certificate and server identity are replaced, and every linked phone is unlinked. Phones must be linked again.",
        );
        if (!ok) return say(ctx, "remote: nothing changed.");
        shared().wantAttach = false;
        bridge.detach();
        try {
          await stopHost();
          const removed = resetIdentity();
          return say(ctx, `remote: reset (${removed.length ? `removed ${removed.join(", ")}` : "nothing to remove"}). /remote starts a host with a new identity.`);
        } catch (error) {
          return say(ctx, `remote: reset failed: ${errorText(error)}`, "error");
        }
      }

      // (none) | on | start | attach | pair
      return share(ctx, sub === "pair");
    },
  });
}
