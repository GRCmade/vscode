/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../services/host/browser/host.js';
import './media/studioProjectUploadDialog.css';

export interface ProjectUploadDialogRequest {
	id: string;
	name: string;
	version: string;
	serverUrl: string;
	folderPath: string;
	labels: Record<string, string>;
}

/** Keeps upload input, progress, and results in one native dialog. */
export class StudioProjectUploadDialog extends Disposable {
	private readonly dialog: Dialog;
	private form!: HTMLElement;
	private notes!: HTMLTextAreaElement;
	private status!: HTMLElement;
	private uploadButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private busy = false;
	private cancelling = false;
	private closed = false;
	private uploaded = false;

	constructor(
		private readonly request: ProjectUploadDialogRequest,
		@ICommandService private readonly commands: ICommandService,
		@IKeybindingService keybindings: IKeybindingService,
		@ILayoutService layout: ILayoutService,
		@IHostService host: IHostService,
	) {
		super();
		this.dialog = this._register(new Dialog(layout.activeContainer, this.text('title'), [], createWorkbenchDialogOptions({
			type: 'none', disableDefaultAction: true, extraClasses: ['studio-upload-dialog'],
			renderBody: container => this.render(container),
			focusableElements: () => Array.from(this.form.querySelectorAll<HTMLElement>('textarea,button')).filter(element => !element.matches(':disabled') && !element.hidden),
		}, keybindings, layout, host)));
	}

	private text(key: string): string { return this.request.labels[key] ?? key; }

	private render(container: HTMLElement): void {
		this.form = append(container, $('.studio-upload-form'));
		const metadata = append(this.form, $('dl.studio-upload-metadata'));
		for (const [key, value] of [['project', this.request.name], ['version', this.request.version || this.text('unavailable')], ['server', this.request.serverUrl], ['directory', this.request.folderPath]]) {
			append(metadata, $('dt', undefined, this.text(key)));
			append(metadata, $('dd', undefined, value));
		}
		const field = append(this.form, $('.studio-upload-field'));
		const id = generateUuid();
		append(field, $('label', { for: id }, this.text('releaseLog')));
		this.notes = append(field, $<HTMLTextAreaElement>('textarea', { id, rows: 5 }));
		this.status = append(this.form, $('p.studio-upload-status', { role: 'status', 'aria-live': 'polite' }));
		const actions = append(this.form, $('.studio-upload-actions'));
		this.uploadButton = append(actions, $<HTMLButtonElement>('button.studio-upload-submit', { type: 'button' }));
		append(this.uploadButton, $('span.codicon.codicon-cloud-upload', { 'aria-hidden': 'true' }));
		append(this.uploadButton, $('span', undefined, this.text('upload')));
		this.cancelButton = append(actions, $<HTMLButtonElement>('button.studio-upload-cancel', { type: 'button' }, this.text('cancel')));
		for (const button of [this.uploadButton, this.cancelButton]) {
			this._register(addDisposableListener(button, 'keydown', event => {
				if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing) {
					event.preventDefault(); event.stopPropagation();
					if (!event.repeat) { button.click(); }
				}
			}));
		}
		this._register(addDisposableListener(this.uploadButton, 'click', () => { void this.submit(); }));
		this._register(addDisposableListener(this.cancelButton, 'click', () => {
			if (!this.busy) { this.dialog.dispose(); return; }
			this.cancelling = true;
			this.cancelButton.disabled = true;
			this.status.textContent = this.text('cancelling');
			void this.commands.executeCommand('studio.internalCancelProjectUpload', this.request.id).catch(error => {
				if (!this.closed) { this.status.textContent = String(error); this.cancelButton.disabled = false; }
			});
		}));
	}

	update(progress: { id: string; message: string }): void {
		if (!this.closed && this.busy && !this.cancelling && progress.id === this.request.id) { this.status.textContent = progress.message; }
	}

	private async submit(): Promise<void> {
		if (this.busy || this.uploaded || this.closed) { return; }
		this.busy = true;
		this.cancelling = false;
		this.form.setAttribute('aria-busy', 'true');
		this.form.classList.remove('has-error');
		this.notes.readOnly = true;
		this.uploadButton.disabled = true;
		this.uploadButton.lastElementChild!.textContent = this.text('uploading');
		this.status.textContent = this.text('preparing');
		try {
			const result = await this.commands.executeCommand<{ success?: boolean; error?: string }>('studio.internalUploadProject', { id: this.request.id, releaseLog: this.notes.value });
			if (this.closed) { return; }
			if (!result?.success) { throw new Error(result?.error ?? this.text('failed')); }
			this.uploaded = true;
			this.uploadButton.hidden = true;
			this.cancelButton.textContent = this.text('close');
			this.status.textContent = this.text('success');
		} catch (error) {
			if (!this.closed) {
				this.form.classList.add('has-error');
				this.status.textContent = error instanceof Error ? error.message : String(error);
			}
		} finally {
			this.busy = false;
			if (!this.closed) {
				this.form.setAttribute('aria-busy', 'false');
				this.notes.readOnly = this.uploaded;
				this.uploadButton.disabled = this.uploaded;
				this.uploadButton.lastElementChild!.textContent = this.text('upload');
				this.cancelButton.disabled = false;
				(this.uploaded ? this.cancelButton : this.uploadButton).focus();
			}
		}
	}

	async show(): Promise<void> {
		const result = this.dialog.show();
		this.notes.focus();
		await result;
	}

	override dispose(): void {
		if (this.closed) { return; }
		this.closed = true;
		if (this.busy) { void this.commands.executeCommand('studio.internalCancelProjectUpload', this.request.id).catch(() => {}); }
		super.dispose();
	}
}
