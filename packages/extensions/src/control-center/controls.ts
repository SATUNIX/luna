/**
 * The control registry: the shared in-process table a hub row and the old typed command both read,
 * so an owning extension registers one control and both paths call the same function.
 *
 * It is published on `globalThis[Symbol.for("pi-kit.controls")]` and follows the pattern the kit's
 * other registries use (effort, protections, delegation, compaction, unattended, subagents): an
 * extension that loads first creates it, the others add to it. In this phase the control-center
 * extension is the only writer and the hub falls back to its built-in row table for any control no
 * owner has registered yet.
 *
 * Self-containment rule: import only pi peer types. No sibling or toolchain-lib imports.
 */
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The page a control belongs on. `levels` are the header rows; the rest are pages. */
export type ControlGroup = "levels" | "work" | "session" | "connect" | "system" | "lab";

/** How dangerous applying a control is. `weakening` lowers oversight and needs a terminal confirm. */
export type ControlRisk = "none" | "weakening" | "external" | "destructive";

/** One control an owning extension publishes. Every field beyond `id`, `group`, `label` and `legacy` is optional. */
export interface KitControl {
  /** Stable id, e.g. "effort" or "display.layout". Also the merge key against a fallback row. */
  id: string;
  group: ControlGroup;
  label: string;
  /** One line shown under the row. */
  description?: string;
  /** The typed equivalent shown in the row, e.g. "/effort". */
  legacy: string;
  /** False hides the row behind a disabled state with `unavailableReason`. */
  available?(ctx: ExtensionContext): boolean;
  /** Current value shown in the row, the header and the footer. */
  value?(): string;
  /** Values the hub cycles in place (SettingsList `values`, and the select chain in RPC). */
  values?(): string[];
  /** Apply a value; the same code path the legacy subcommand uses. */
  set?(value: string, ctx: ExtensionCommandContext): Promise<void>;
  /** A sub-page: the controls to show when this row is opened. */
  rows?(ctx: ExtensionContext): KitControl[];
  /** A one-shot action. */
  run?(ctx: ExtensionCommandContext, input?: string): Promise<void>;
  /** Ask the operator for a string before `run()`. */
  input?: { title: string; placeholder?: string };
  risk?: ControlRisk;
  /** reload / new / fork / switch: the hub closes and does not reopen afterwards. */
  changesSession?: boolean;
  /** Live refresh of the hub and footer; returns an unsubscribe function. */
  onChange?(listener: () => void): () => void;
}

/** The registry facade published on globalThis. */
export interface KitControls {
  register(control: KitControl): () => void;
  list(): KitControl[];
  snapshot(): Record<string, string>;
}

const CONTROLS_KEY: unique symbol = Symbol.for("pi-kit.controls");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKitControls(value: unknown): value is KitControls {
  return isRecord(value) && typeof value.register === "function" && typeof value.list === "function" && typeof value.snapshot === "function";
}

/** The registry, if a kit extension has published one in this process. */
export function getControls(): KitControls | undefined {
  const value: unknown = (globalThis as Record<symbol, unknown>)[CONTROLS_KEY];
  return isKitControls(value) ? value : undefined;
}

/** Publish the registry once, or return the one already published. */
export function getOrCreateControls(): KitControls {
  const existing = getControls();
  if (existing) return existing;
  const controls = new Map<string, KitControl>();
  const registry: KitControls = {
    register(control: KitControl): () => void {
      controls.set(control.id, control);
      return () => {
        // Only remove the exact control this registration added: a later replacement wins.
        if (controls.get(control.id) === control) controls.delete(control.id);
      };
    },
    list(): KitControl[] {
      return [...controls.values()];
    },
    snapshot(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const control of controls.values()) {
        try {
          const value = control.value?.();
          if (typeof value === "string") out[control.id] = value;
        } catch {
          /* a broken control must not break the hub */
        }
      }
      return out;
    },
  };
  (globalThis as Record<symbol, unknown>)[CONTROLS_KEY] = registry;
  return registry;
}

/** Remove the registry. Test-only: lets a test start from a clean process state. */
export function resetControls(): void {
  Reflect.deleteProperty(globalThis, CONTROLS_KEY);
}
