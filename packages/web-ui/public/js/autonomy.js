// Generated from packages/web-ui/src/public/js/autonomy.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// autonomy.ts — the read-only Autonomy view: runs, recent host events and the status file
// (GET /api/autonomy). Every string here can carry worker-influenced text (a blocker question, a
// reason, a branch name), so it is set as text through el(), never parsed as HTML.
import { clear, el } from "./render.js";
import { displayText, isArray, isObject } from "./guards.js";
/**
 * `load` run at most once at a time: a call made while one is still pending is skipped and
 * resolves false, so a slow read and the next poll never overlap or render out of order.
 */
export function oneAtATime(load) {
    let pending = false;
    return async () => {
        if (pending)
            return false;
        pending = true;
        try {
            await load();
            return true;
        }
        finally {
            pending = false;
        }
    };
}
/** "12s", "4m", "3h", "2d"; "—" when the time is unknown or unreadable. */
export function formatAge(at, now = Date.now()) {
    if (typeof at !== "string")
        return "—";
    const then = Date.parse(at);
    if (!Number.isFinite(then))
        return "—";
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48)
        return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}
/** An age as a sentence fragment: "5m ago", or just "—" when the time is unknown. */
export function ageText(at, now = Date.now()) {
    const age = formatAge(at, now);
    return age === "—" ? age : `${age} ago`;
}
/** A dollar figure, or "—" when the server had none (it sends null, never a guess). */
function usd(value) {
    return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
}
function spend(run) {
    return run.budgetUsd === null || typeof run.budgetUsd !== "number"
        ? usd(run.spentUsd)
        : `${usd(run.spentUsd)} / ${usd(run.budgetUsd)}`;
}
/** The status cell: the run's status, then what it waits on or why it ended. */
function statusText(run) {
    const status = displayText(run.status ?? "unknown");
    if (isObject(run.blocker))
        return `${status}: ${displayText(run.blocker.kind)}: ${displayText(run.blocker.question)}`;
    if (isObject(run.outcome) && run.outcome.reason)
        return `${status}: ${displayText(run.outcome.reason)}`;
    return status;
}
/** An event's own fields as key=value, in the order they were written. */
function eventFields(event) {
    return Object.entries(event)
        .filter(([key]) => key !== "v" && key !== "at" && key !== "run" && key !== "type")
        .map(([key, value]) => `${key}=${isArray(value) ? value.map((item) => displayText(item)).join(",") : displayText(value)}`)
        .join(" ");
}
function table(head, rows, className) {
    return el("table", { class: `md-table autonomy-table ${className}` }, [
        el("thead", {}, [el("tr", {}, head.map((h) => el("th", { text: h })))]),
        el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((cell) => el("td", { text: cell }))))),
    ]);
}
function section(title, body) {
    return el("section", { class: "autonomy-section" }, [el("h2", { class: "section-title", text: title }), ...(isArray(body) ? body : [body])]);
}
/** Render the Autonomy view into `target`: a summary line, the runs, the newest events, the status file. */
export function renderAutonomy(target, data, now = Date.now()) {
    clear(target);
    const skipped = isObject(data.skipped) ? data.skipped : { runs: 0, events: 0, status: 0 };
    const notes = [
        `${data.runs.length}${data.runsTotal > data.runs.length ? ` of ${data.runsTotal}` : ""} run(s)`,
        `${data.events.length} recent event(s)`,
        `read ${ageText(data.at, now)}`,
    ];
    const left = [
        skipped.runs ? `${skipped.runs} unreadable run(s)` : "",
        skipped.events ? `${skipped.events} unreadable event line(s)` : "",
        skipped.status ? "an unreadable status file" : "",
    ].filter(Boolean);
    if (left.length)
        notes.push(`skipped ${left.join(", ")}`);
    target.append(el("p", { class: "mono-sm muted autonomy-summary", text: notes.join(" · ") }));
    if (!data.runs.length) {
        target.append(section("Runs", el("p", { class: "muted", text: "No runs in the autonomy state home." })));
    }
    else {
        target.append(section("Runs", table(["run", "template", "status", "step", "spend / budget", "last event"], data.runs.map((run) => [
            displayText(run.run) + (run.legacy ? " (legacy)" : ""),
            displayText(run.template ?? "—"),
            statusText(run),
            typeof run.step === "number" ? String(run.step) : "—",
            spend(run),
            run.lastEventAt ? ageText(run.lastEventAt, now) : "—",
        ]), "autonomy-runs")));
    }
    if (!data.events.length) {
        target.append(section("Recent events", el("p", { class: "muted", text: "No host events recorded." })));
    }
    else {
        // Newest first: the log is in written order.
        const newest = [...data.events].reverse();
        target.append(section("Recent events", table(["age", "run", "event", "detail"], newest.map((event) => [ageText(event.at, now), displayText(event.run), displayText(event.type), eventFields(event)]), "autonomy-events")));
    }
    const status = data.status;
    if (status) {
        const parts = [el("p", { class: "mono-sm muted", text: `generated ${ageText(status.generatedAt, now)}` })];
        const sources = isObject(status.spend) ? Object.entries(status.spend) : [];
        if (sources.length) {
            parts.push(table(["source", "today", "this month"], sources.map(([source, window]) => [displayText(source), usd(window.todayUsd), usd(window.monthUsd)]), "autonomy-spend"));
        }
        if (isArray(status.openPrs) && status.openPrs.length) {
            parts.push(table(["pull request", "title", "ci"], status.openPrs.map((pr) => [`#${displayText(pr.number)}`, displayText(pr.title), displayText(pr.ci)]), "autonomy-prs"));
        }
        target.append(section("Status file", parts));
    }
}
/** The view when the route could not be read: the reason as text. */
export function renderAutonomyError(target, message) {
    clear(target);
    target.append(el("p", { class: "muted", text: `Could not read the autonomy state: ${message}` }));
}
