/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { ISecretStorageService } from '../../platform/secrets/common/secrets.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../platform/workspace/common/workspaceTrust.js';
import { getNLSLanguage } from '../../nls.js';
import { IWorkbenchLayoutService } from '../services/layout/browser/layoutService.js';
import { button, element, type LaunchpadLabel } from './studioLaunchpadPicker.js';
import { applyWebBotCredentialAction, type WebBotCredentialAction, type WebBotCredentialKind, type WebBotCredentialSlot } from './studioWebBotCredentialVault.js';
import './media/studioWebBotCredentials.css';

export class StudioWebBotCredentials extends Disposable {

	private readonly current = this._register(new MutableDisposable<{ id: string; dispose(): void }>());
	private readonly t: LaunchpadLabel = (en, zh) => getNLSLanguage()?.startsWith('zh') ? zh : en;

	constructor(
		authority: string,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IWorkspaceTrustManagementService trust: IWorkspaceTrustManagementService,
		@IWorkspaceTrustEnablementService enablement: IWorkspaceTrustEnablementService,
		@ISecretStorageService private readonly secrets: ISecretStorageService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand('studio.internalCanPersistWebBotCredentials', () => trust.isWorkspaceTrusted()
			&& this.secrets.type === 'persisted' && typeof this.secrets.keys === 'function' && !!navigator.locks));
		this._register(CommandsRegistry.registerCommand('studio.internalIsWebBotFolderTrusted', async (_accessor, resource: string) => {
			const uri = URI.parse(resource);
			if (uri.scheme !== Schemas.file || uri.authority || uri.query || uri.fragment) { return false; }
			await trust.workspaceTrustInitialized;
			return !enablement.isWorkspaceTrustEnabled() || (await trust.getUriTrustInfo(uri.with({ scheme: Schemas.vscodeRemote, authority }))).trusted;
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalShowWebBotCredentials', (_accessor, id: string, name: string) => this.show(id, name)));
		this._register(CommandsRegistry.registerCommand('studio.internalDismissWebBotCredentials', (_accessor, id: string) => {
			if (this.current.value?.id === id) { this.current.clear(); }
		}));
		this._register(Event.any(trust.onDidChangeTrust, trust.onDidChangeTrustedFolders)(() => this.current.clear()));
	}

	private show(id: string, name: string): void {
		if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id) || typeof name !== 'string' || name.length > 1024) { return; }
		this.current.clear();
		const store = new DisposableStore();
		this.current.value = { id, dispose: () => store.dispose() };
		const controller = new AbortController();
		store.add(toDisposable(() => controller.abort()));
		const t = this.t;
		const dialog = element('dialog', 'studio-web-bot-credentials');
		const origin = this.layout.mainContainer.ownerDocument.activeElement;
		const close = () => { if (this.current.value?.id === id) { this.current.clear(); } };
		const title = element('h2', '', t('Credential management', '凭据管理'));
		title.id = 'studio-web-bot-credentials-heading';
		dialog.setAttribute('aria-labelledby', title.id);
		const dismiss = button('', 'close', close, 'studio-credentials-icon');
		dismiss.title = t('Close', '关闭');
		dismiss.setAttribute('aria-label', dismiss.title);
		const heading = element('header'); heading.append(title, dismiss);
		const content = element('div', 'studio-credentials-content');
		const status = element('p', 'studio-credentials-status'); status.setAttribute('role', 'status');
		const panel = element('div');
		content.append(element('p', 'studio-credentials-project', name), status, panel);
		dialog.append(heading, content);
		store.add(addDisposableListener(dialog, 'close', close));
		store.add(toDisposable(() => {
			const secret = dialog.querySelector<HTMLInputElement>('input:is([type=password], [type=file])');
			if (secret) { secret.value = ''; }
			dialog.close(); dialog.remove();
			void this.commands.executeCommand('studio.internalCloseWebBotCredentials', id).catch(() => undefined);
			if (origin instanceof HTMLElement && origin.isConnected) { origin.focus({ preventScroll: true }); }
		}));
		this.layout.mainContainer.append(dialog);
		dialog.showModal(); dismiss.focus({ preventScroll: true });

		let rows: WebBotCredentialSlot[] = [];
		const labels: Record<WebBotCredentialKind, string> = {
			'api-key': t('API key or token', 'API Key 或令牌'),
			password: t('Password', '密码'),
			'ssh-private-key': t('SSH private key', 'SSH 私钥'),
			structured: t('Structured credential', '结构化凭据'),
		};
		let busy = false;
		const control = (label: string, glyph: string, run: () => void, className = 'studio-credentials-button') => button(label, glyph, run, className);
		const request = async (action: WebBotCredentialAction, failure?: () => void) => {
			if (busy || store.isDisposed) { return; }
			busy = true;
			panel.setAttribute('inert', '');
			status.textContent = action.action === 'list' ? t('Loading credentials…', '正在加载凭据…') : '';
			let result: Awaited<ReturnType<typeof applyWebBotCredentialAction>> | undefined;
			try {
				result = await applyWebBotCredentialAction(this.secrets, () => this.commands.executeCommand<string | undefined>('studio.internalWebBotCredentialScope', id), controller.signal, action);
			} catch { /* Do not render errors that could contain submitted input. */ }
			finally {
				if ('value' in action) { action.value = ''; }
				busy = false;
				panel.removeAttribute('inert');
			}
			if (store.isDisposed || !dialog.open) { return; }
			if (result?.status === 'ok') {
				rows = result.rows;
				status.textContent = '';
				list(action.action !== 'list');
			} else {
				status.textContent = result?.status === 'invalid' ? t('Check the credential format and try again.', '请检查凭据格式后重试。')
					: result?.status === 'existing' ? t('This credential alias and type already exist.', '此凭据别名和类型已存在。')
						: result?.status === 'missing' ? t('This credential was removed. Reopen the list to refresh.', '该凭据已被删除，请重新打开列表刷新。')
							: t('Credential storage is unavailable. Reopen this dialog to try again.', '凭据存储不可用，请重新打开弹窗后重试。');
				failure?.();
			}
		};
		const list = (focus = false) => {
			const add = control(t('Add credential', '添加凭据'), 'add', () => edit());
			const toolbar = element('div', 'studio-credentials-toolbar'); toolbar.append(add);
			panel.replaceChildren(toolbar);
			if (rows.length) {
				const table = element('table'), head = element('thead'), headings = element('tr'), body = element('tbody');
				for (const label of [t('Alias', '别名'), t('Type', '类型'), t('Actions', '操作')]) {
					const cell = element('th', '', label); cell.scope = 'col'; headings.append(cell);
				}
				head.append(headings);
				for (const row of rows) {
					const tools = element('td');
					for (const [label, glyph, callback] of [
						[t('Replace credential', '替换凭据'), 'edit', () => edit(row)],
						[t('Delete credential', '删除凭据'), 'trash', () => confirmRemove(row)],
					] as const) {
						const action = control('', glyph, callback, 'studio-credentials-icon');
						action.title = `${label}: ${row.name}`; action.setAttribute('aria-label', action.title);
						tools.append(action);
					}
					const tr = element('tr'); tr.append(element('td', '', row.name), element('td', '', labels[row.kind]), tools); body.append(tr);
				}
				table.append(head, body); panel.append(table);
			} else { panel.append(element('p', 'studio-credentials-status', t('No saved credentials.', '暂无已保存的凭据。'))); }
			if (focus) { add.focus({ preventScroll: true }); }
		};
		const cancel = () => { status.textContent = ''; list(true); };
		const confirmRemove = (row: WebBotCredentialSlot) => {
			const cancelButton = control(t('Cancel', '取消'), '', cancel);
			const remove = control(t('Delete credential', '删除凭据'), 'trash', () => void request({ action: 'delete', name: row.name, kind: row.kind }, () => cancelButton.focus()));
			const actions = element('div', 'studio-credentials-toolbar'); actions.append(cancelButton, remove);
			panel.replaceChildren(element('p', '', t(`Delete the saved credential “${row.name}”?`, `删除已保存的凭据「${row.name}」？`)), actions);
			cancelButton.focus({ preventScroll: true });
		};
		const edit = (row?: WebBotCredentialSlot) => {
			status.textContent = '';
			const form = element('form');
			const alias = element('input'); alias.required = true; alias.pattern = '[a-z0-9][a-z0-9._\\-]{0,63}'; alias.maxLength = 64;
			alias.value = row?.name ?? ''; alias.readOnly = !!row; alias.spellcheck = false; alias.autocomplete = 'off';
			const kind = element('select');
			const choices = row ? [[row.kind, labels[row.kind]]] : Object.entries(labels);
			for (const [value, label] of choices) { const option = element('option', '', label); option.value = value; kind.append(option); }
			kind.disabled = !!row;
			const valueLabel = element('label');
			let valueInput: HTMLInputElement;
			const renderValue = () => {
				const keyFile = kind.value === 'ssh-private-key';
				const structured = kind.value === 'structured';
				valueInput = element('input'); valueInput.type = keyFile ? 'file' : 'password';
				valueInput.required = true; valueInput.maxLength = 16_384; valueInput.autocomplete = 'new-password';
				if (structured) { valueInput.placeholder = '{"field":""}'; }
				valueLabel.replaceChildren(keyFile ? t('SSH private key file', 'SSH 私钥文件') : structured ? t('Credential JSON', '凭据 JSON') : t('Credential value', '凭据值'), valueInput);
			};
			kind.addEventListener('change', renderValue); renderValue();
			const aliasLabel = element('label', '', t('Alias', '别名')); aliasLabel.append(alias);
			const typeLabel = element('label', '', t('Type', '类型')); typeLabel.append(kind);
			const save = control(t('Save', '保存'), 'save', () => { }); save.type = 'submit';
			const actions = element('div', 'studio-credentials-toolbar'); actions.append(control(t('Cancel', '取消'), '', cancel), save);
			form.append(aliasLabel, typeLabel, valueLabel, actions);
			form.addEventListener('submit', async event => {
				event.preventDefault();
				if (busy || save.disabled) { return; }
				save.disabled = true;
				const field = valueInput, file = field.files?.[0];
				try {
					if (file && file.size > 65_536) { throw new Error(); }
					const value = file ? await file.text() : field.value;
					if (!dialog.open || store.isDisposed || !form.isConnected || field !== valueInput) { return; }
					field.value = '';
					await request({ action: row ? 'replace' : 'add', name: alias.value, kind: kind.value as WebBotCredentialKind, value }, () => field.focus());
				} catch {
					if (!store.isDisposed && form.isConnected) { status.textContent = t('Choose a private key file up to 64 KiB.', '请选择不超过 64 KiB 的私钥文件。'); }
				} finally { save.disabled = false; }
			});
			panel.replaceChildren(form);
			(row ? valueInput! : alias).focus({ preventScroll: true });
		};
		void request({ action: 'list' });
	}
}
