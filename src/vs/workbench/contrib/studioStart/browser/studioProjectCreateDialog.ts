/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { IButton } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { StudioStartState } from '../../../browser/parts/editor/studioStart.js';
import { studioProjectIcon } from '../../../common/studioProjectIcons.js';
import { IHostService } from '../../../services/host/browser/host.js';
import './media/studioProjectCreateDialog.css';

interface ProjectCreationInput { templateId: string; name: string; parentDirectory: string }
export interface ProjectCreationDialogRequest {
	templates: StudioStartState['templates'];
	labels: Record<string, string>;
	parentDirectory: string;
	templateId?: string;
	projectType?: string;
}

/** Native form shared by the Start action and project creation commands. */
export class StudioProjectCreateDialog extends Disposable {
	private readonly dialog: Dialog;
	private readonly choices = this._register(new DisposableStore());
	private form!: HTMLElement;
	private name!: InputBox;
	private parent!: InputBox;
	private error!: HTMLElement;
	private createButton: IButton | undefined;
	private templateId: string;
	private projectType: string;
	private revision = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private browsing = false;

	constructor(
		private readonly request: ProjectCreationDialogRequest,
		@ICommandService private readonly commands: ICommandService,
		@IKeybindingService keybindings: IKeybindingService,
		@ILayoutService layout: ILayoutService,
		@IHostService host: IHostService,
	) {
		super();
		const initial = request.templates.find(template => template.id === request.templateId)
			?? request.templates.find(template => template.projectType === request.projectType)
			?? request.templates[0];
		this.projectType = initial?.projectType ?? 'workflow';
		this.templateId = initial?.id ?? '';
		this.dialog = this._register(new Dialog(layout.activeContainer, this.text('create'), [this.text('confirmCreate'), this.text('cancel')],
			createWorkbenchDialogOptions({
				type: 'none', cancelId: 1, extraClasses: ['studio-create-dialog'],
				renderBody: container => this.render(container),
				focusableElements: () => Array.from(this.form.querySelectorAll<HTMLElement>('input,button')).filter(element => element.tabIndex >= 0 && !element.matches(':disabled')),
				isExternalFocusAllowed: element => this.browsing && !!element.closest('.quick-input-widget'),
				buttonOptions: [{ styleButton: button => { this.createButton = button; button.enabled = false; } }],
			}, keybindings, layout, host)));
	}

	private text(key: string): string { return this.request.labels[key] ?? key; }

	private input(parent: HTMLElement, key: string, value = ''): InputBox {
		const field = append(parent, $('.studio-create-field'));
		const id = generateUuid();
		append(field, $('label', { for: id }, this.text(key)));
		const control = this._register(new InputBox(field, undefined, { ariaLabel: this.text(key), inputBoxStyles: defaultInputBoxStyles }));
		control.inputElement.id = id;
		control.inputElement.dataset.field = key;
		control.value = value;
		this._register(control.onDidChange(() => this.validate()));
		return control;
	}

	private render(container: HTMLElement): void {
		this.form = append(container, $('.studio-create-form'));
		const types = append(this.form, $('fieldset.studio-create-types'));
		append(types, $('legend', undefined, this.text('projectType')));
		const templates = append(this.form, $('fieldset.studio-create-templates'));
		append(templates, $('legend', undefined, this.text('template')));
		const options = append(templates, $('.studio-create-options'));
		for (const type of ['workflow', 'conversation', 'kanban']) {
			const label = append(types, $('label.studio-create-type'));
			const radio = append(label, $<HTMLInputElement>('input', { type: 'radio', name: 'projectType', value: type }));
			radio.checked = this.projectType === type;
			radio.tabIndex = radio.checked ? 0 : -1;
			append(label, $(`span.codicon.codicon-${studioProjectIcon(type)}`)).setAttribute('aria-hidden', 'true');
			append(label, $('span', undefined, this.text(`type.${type}`)));
			this._register(addDisposableListener(radio, 'change', () => {
				if (!radio.checked) { return; }
				this.projectType = type;
				for (const input of types.querySelectorAll<HTMLInputElement>('input')) { input.tabIndex = input.checked ? 0 : -1; }
				this.renderTemplates(options);
				this.validate();
			}));
		}
		this.renderTemplates(options);
		this.name = this.input(this.form, 'projectName');
		const directory = append(this.form, $('.studio-create-directory'));
		this.parent = this.input(directory, 'parentDirectory', this.request.parentDirectory);
		const browse = append(directory, $<HTMLButtonElement>('button.studio-create-browse', { type: 'button', title: this.text('browse'), 'aria-label': this.text('browse') }));
		append(browse, $('span.codicon.codicon-folder-opened')).setAttribute('aria-hidden', 'true');
		this._register(addDisposableListener(browse, 'click', async () => {
			if (this.browsing) { return; }
			this.browsing = true;
			browse.disabled = true;
			try {
				const selected = await this.commands.executeCommand<string | undefined>('studio.internalChooseProjectParent', this.parent.value);
				if (!this.closed && selected) { this.parent.value = selected; this.validate(); }
			} catch (error) {
				if (!this.closed) { this.error.textContent = String(error); }
			} finally {
				this.browsing = false;
				browse.disabled = false;
				if (!this.closed) { this.parent.focus(); }
			}
		}));
		this.error = append(this.form, $('p.studio-create-error', { role: 'status', 'aria-live': 'polite' }));
		this._register(addDisposableListener(this.form, 'keydown', event => {
			if (event.key === 'Enter' && !event.isComposing && (event.target === this.name.inputElement || event.target === this.parent.inputElement)) {
				event.preventDefault(); event.stopPropagation();
				if (this.createButton?.enabled) { this.createButton.element.click(); }
			}
		}));
	}

	private renderTemplates(container: HTMLElement): void {
		this.choices.clear(); clearNode(container);
		const templates = this.request.templates.filter(template => template.projectType === this.projectType);
		if (!templates.some(template => template.id === this.templateId)) { this.templateId = templates[0]?.id ?? ''; }
		for (const template of templates) {
			const label = append(container, $('label.studio-create-template'));
			const radio = append(label, $<HTMLInputElement>('input', { type: 'radio', name: 'templateId', value: template.id }));
			radio.checked = template.id === this.templateId;
			radio.tabIndex = radio.checked ? 0 : -1;
			const details = append(label, $('span.studio-create-template-details'));
			append(details, $('span.studio-create-template-name', undefined, template.name));
			append(details, $('span.studio-create-template-kind', undefined, this.text(template.kind === 'starter' ? 'starter' : 'examples')));
			append(details, $('span.studio-create-template-description', undefined, template.description));
			this.choices.add(addDisposableListener(radio, 'change', () => {
				if (radio.checked) {
					this.templateId = template.id;
					for (const input of container.querySelectorAll<HTMLInputElement>('input')) { input.tabIndex = input.checked ? 0 : -1; }
					this.validate();
				}
			}));
		}
	}

	private inputValue(): ProjectCreationInput {
		return { templateId: this.templateId, name: this.name.value.trim(), parentDirectory: this.parent.value.trim() };
	}

	private validate(): void {
		clearTimeout(this.timer);
		const revision = ++this.revision;
		if (this.createButton) { this.createButton.enabled = false; }
		const input = this.inputValue();
		this.error.textContent = !input.name ? this.text('requiredName') : !input.parentDirectory ? this.text('requiredParent') : '';
		if (!input.name || !input.parentDirectory || !input.templateId) { return; }
		this.timer = setTimeout(async () => {
			let error: string | undefined;
			try { error = (await this.commands.executeCommand<{ error?: string }>('studio.internalValidateProjectCreation', input))?.error; }
			catch (reason) { error = String(reason); }
			if (this.closed || revision !== this.revision) { return; }
			this.error.textContent = error ?? '';
			if (this.createButton) { this.createButton.enabled = !error; }
		}, 250);
	}

	async show(): Promise<ProjectCreationInput | undefined> {
		const result = this.dialog.show();
		this.name.focus();
		const { button } = await result;
		return button === 0 ? this.inputValue() : undefined;
	}

	override dispose(): void {
		this.closed = true; ++this.revision; clearTimeout(this.timer);
		super.dispose();
	}
}
