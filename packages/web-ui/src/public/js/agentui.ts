// agentui.ts — create / edit / delete agents from the web UI.
import { api } from "./api.ts";
import { byId, errorMessage } from "./guards.ts";
import { el } from "./render.ts";
import type * as Wire from "./wire.ts";

export interface AgentEditorOptions {
	readonly tools?: readonly string[] | undefined;
	/** Called (and awaited) after a save or delete. */
	readonly onSaved?: (() => unknown) | undefined;
	readonly toast?: ((message: string) => void) | undefined;
}

/** An agent to edit: a listed summary (its body is fetched) or a full record. */
export type EditableAgent = Wire.AgentSummary & { readonly body?: string | undefined };

export class AgentEditor {
	tools: readonly string[];
	onSaved: () => unknown;
	toast: (message: string) => void;
	/** The name and source of the record being edited; null for a new agent. */
	editing: { name: string; source: Wire.AgentSource } | null;
	// The dialog's elements, looked up once when the editor is made.
	dialog = byId("agent-dialog", HTMLDialogElement);
	form = byId("agent-form", HTMLFormElement);
	title = byId("agent-dialog-title", HTMLElement);
	name = byId("a-name", HTMLInputElement);
	source = byId("a-source", HTMLSelectElement);
	description = byId("a-description", HTMLInputElement);
	model = byId("a-model", HTMLInputElement);
	toolsBox = byId("a-tools", HTMLElement);
	body = byId("a-body", HTMLTextAreaElement);
	error = byId("agent-error", HTMLElement);
	save = byId("agent-save", HTMLButtonElement);
	remove = byId("agent-delete", HTMLButtonElement);

	constructor(options: AgentEditorOptions = {}) {
		this.tools = options.tools ?? [];
		this.onSaved = options.onSaved ?? (() => {});
		this.toast = options.toast ?? (() => {});
		this.editing = null;
		this.wire();
	}

	wire(): void {
		this.form.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.submit();
		});
		this.remove.addEventListener("click", () => void this.deleteCurrent());
		for (const button of document.querySelectorAll(
			'[data-close-dialog="agent-dialog"]',
		)) {
			button.addEventListener("click", () => this.dialog.close());
		}
	}

	renderToolPicker(selected: readonly string[] | null | undefined): void {
		this.toolsBox.replaceChildren();
		const chosen = new Set(selected ?? []);
		for (const tool of this.tools) {
			const input = el("input", { type: "checkbox", value: tool });
			input.checked = chosen.has(tool);
			const label = el(
				"label",
				{ class: `tool-opt${input.checked ? " is-on" : ""}` },
				[input, el("span", { text: tool })],
			);
			input.addEventListener("change", () =>
				label.classList.toggle("is-on", input.checked),
			);
			this.toolsBox.append(label);
		}
	}

	selectedTools(): string[] {
		return [...this.toolsBox.querySelectorAll("input:checked")].flatMap((i) =>
			i instanceof HTMLInputElement ? [i.value] : [],
		);
	}

	showError(message: string): void {
		this.error.textContent = message;
		this.error.hidden = false;
	}

	clearError(): void {
		this.error.hidden = true;
	}

	/** Open for a new agent, or for editing an existing record (full object with body). */
	async open(agent: EditableAgent | null, tools?: readonly string[]): Promise<void> {
		if (tools?.length) this.tools = tools;
		this.clearError();
		if (agent) {
			// The server answers 404 for an unknown agent, so a null record cannot arrive; the
			// summary stands in for it if one ever does.
			const record: EditableAgent =
				agent.body !== undefined
					? agent
					: ((await api.agent(agent.name, agent.source)).agent ?? agent);
			this.editing = { name: record.name, source: record.source };
			this.title.textContent = `Edit agent — ${record.name}`;
			this.name.value = record.name;
			this.source.value = record.source;
			this.description.value = record.description || "";
			this.model.value = record.model || "";
			this.body.value = record.body || "";
			this.renderToolPicker(record.tools || []);
			this.remove.hidden = false;
		} else {
			this.editing = null;
			this.title.textContent = "New agent";
			this.name.value = "";
			this.source.value = "user";
			this.description.value = "";
			this.model.value = "";
			this.body.value = "";
			this.renderToolPicker([]);
			this.remove.hidden = true;
		}
		if (!this.toolsBox.children.length) this.renderToolPicker([]);
		this.dialog.showModal();
	}

	payload(): Wire.AgentInput {
		return {
			name: this.name.value.trim(),
			description: this.description.value.trim(),
			tools: this.selectedTools(),
			// Always sent: an empty model clears the agent's (omitting it would keep the old one).
			model: this.model.value.trim(),
			body: this.body.value,
			source: this.source.value,
		};
	}

	async submit(): Promise<void> {
		this.clearError();
		const payload = this.payload();
		if (!payload.name) {
			this.showError("name is required");
			return;
		}
		this.save.disabled = true;
		try {
			if (this.editing) {
				await api.updateAgent(this.editing.name, payload);
				this.toast(`agent updated: ${payload.name}`);
			} else {
				await api.createAgent(payload);
				this.toast(`agent created: ${payload.name}`);
			}
			this.dialog.close();
			await this.onSaved();
		} catch (err) {
			this.showError(errorMessage(err));
		} finally {
			this.save.disabled = false;
		}
	}

	async deleteCurrent(): Promise<void> {
		if (!this.editing) return;
		const { name, source } = this.editing;
		if (
			!window.confirm(
				`Delete agent "${name}" (${source})? This removes its .md file.`,
			)
		)
			return;
		try {
			await api.deleteAgent(name, source);
			this.toast(`agent deleted: ${name}`);
			this.dialog.close();
			await this.onSaved();
		} catch (err) {
			this.showError(errorMessage(err));
		}
	}
}
