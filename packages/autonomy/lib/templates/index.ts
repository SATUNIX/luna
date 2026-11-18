// The task templates. A template is what turns the generic run engine (lib/engine.ts) into a
// particular kind of run: it supplies defaults, extra validation, the worker's prompts, how a
// step is judged and what promotion means. The engine owns everything that must not vary:
// the boundary, lifecycle, locks, budgets, recovery, evidence and export.
import selfImprove from "./self-improve.ts";
import implement from "./implement.ts";
import deploy from "./deploy.ts";
import dispatch from "./dispatch.ts";
import type { TemplateDescription } from "./common.ts";

export const TEMPLATES = { implement, deploy, "self-improve": selfImprove, dispatch };

export const templateIds = (): string[] => Object.keys(TEMPLATES);

export const describeTemplates = (): TemplateDescription[] => Object.values(TEMPLATES).map((t) => t.describe());

/**
 * A cycling template (self-improve, dispatch): it drives its own cycles on an integration branch,
 * keeps state.selfImprove and works a steward board. Everything special-cased for cycling runs
 * (init defaults, board, inbox and backlog, contract rules) asks this instead of naming an id.
 */
export const isCycleTemplate = (id: unknown): boolean => Object.values(TEMPLATES).some((t) => t.id === id && !t.finite);
