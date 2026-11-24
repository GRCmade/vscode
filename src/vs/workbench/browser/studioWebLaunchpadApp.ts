/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { getNLSLanguage } from '../../nls.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { studioWebImTarget, type StudioWebImTarget, studioWebImUrl } from '../common/studioWebImRoute.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWorkbenchLayoutService } from '../services/layout/browser/layoutService.js';
import { element } from './studioUiElements.js';

interface LaunchpadAppView { id: string; title: string; html: string }

function label(en: string, zh: string): string { return getNLSLanguage()?.startsWith('zh') ? zh : en; }

export function openStudioWebIm(target: StudioWebImTarget, notifications: INotificationService): boolean {
	if (mainWindow.open(studioWebImUrl(new URL(mainWindow.location.href), target).href, '_blank')) { return true; }
	notifications.warn(label('The browser blocked the IM tab. Allow pop-ups for this site and try again.', '浏览器拦截了 IM 标签页。请允许此站点打开弹出式窗口后重试。'));
	return false;
}

/** Each IM address restores its own account and preview through the regular Studio host. */
export class StudioWebLaunchpadApp extends Disposable {

	private requestId?: string;
	private prepared?: { key: string; accountUrl?: string };
	private readonly mount = this._register(new MutableDisposable<DisposableStore>());
	private readonly status = element('main', 'studio-chat-status');
	private readonly message = element('p', 'studio-chat-loading', label('Opening IM…', '正在打开 IM…'));
	private readonly actions = element('div', 'studio-chat-actions');
	private readonly home = new URL('?launchpad=1', mainWindow.location.href);
	private readonly unavailable = label('Could not open IM.', '无法打开 IM。');
	private readonly root: HTMLElement;

	constructor(
		target: StudioWebImTarget | 'invalid',
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IOpenerService private readonly opener: IOpenerService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.root = layout.mainContainer;
		this.message.setAttribute('role', 'status');
		const back = element('a', '', label('Back to Launchpad', '返回启动台'));
		back.href = this.home.href;
		this.actions.append(back);
		if (target !== 'invalid') {
			const retry = element('button', '', label('Retry', '重试'));
			retry.type = 'button';
			this._register(addDisposableListener(retry, 'click', () => mainWindow.location.reload()));
			this.actions.append(retry);
		}
		this.actions.hidden = true;
		this.status.append(this.message, this.actions);
		this.root.append(this.status);
		const parts = [...this.root.querySelectorAll<HTMLElement>('.part')].filter(part => !part.inert);
		for (const part of parts) { part.inert = true; }
		this._register(toDisposable(() => {
			this.release();
			for (const part of parts) { part.inert = false; }
			this.status.remove();
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalPrepareLaunchpadApp', (_accessor, key: string, app: { accountUrl?: string }) => {
			if (!this.requestId || this.prepared || this._store.isDisposed) { return false; }
			this.prepared = { key, accountUrl: app?.accountUrl };
			return true;
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadApp', (_accessor, key: string, requestId: string, view: LaunchpadAppView) =>
			this.show(key, requestId, view)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadApp', (_accessor, key: string) => {
			if (this.prepared?.key === key) {
				this.prepared = undefined; // The extension host has already revoked this preview.
				this.fail(label('Your IM session ended.', 'IM 会话已断开。'));
			}
		}));

		if (target === 'invalid') {
			this.fail(label('This IM link is invalid.', '此 IM 链接无效。'));
		} else {
			void this.open(target);
		}
	}

	private async open(target: StudioWebImTarget): Promise<void> {
		const id = this.requestId = generateUuid();
		const result = await this.commands.executeCommand<true | string>('studio.openLaunchpadInbox', id,
			target.kind === 'conversation' ? target.id : undefined, target.kind === 'user' ? target.id : undefined,
			'id' in target ? undefined : target.kind).catch(() => undefined);
		if (this.requestId !== id || this._store.isDisposed) { return; }
		this.requestId = undefined;
		if (result !== true) { this.fail(typeof result === 'string' ? result : this.unavailable); }
	}

	private release(): void {
		this.requestId = undefined;
		const key = this.prepared?.key;
		this.prepared = undefined;
		this.mount.clear();
		if (key) { void this.commands.executeCommand('studio.internalReleaseHostedLaunchpadApp', key).catch(() => undefined); }
	}

	private fail(message: string): void {
		this.release();
		mainWindow.document.title = 'IM';
		this.message.textContent = message;
		this.message.classList.remove('studio-chat-loading');
		this.actions.hidden = false;
		this.status.hidden = false;
	}

	private close(): void {
		if (mainWindow.opener) { mainWindow.close(); }
		if (!mainWindow.closed) { mainWindow.location.replace(this.home.href); }
	}

	private async show(key: string, requestId: string, view: LaunchpadAppView): Promise<boolean> {
		const prepared = this.prepared;
		if (!prepared || prepared.key !== key || requestId !== this.requestId || !view?.id || this.mount.value || this._store.isDisposed) { return false; }
		const life = this.mount.value = new DisposableStore();
		const isCurrent = () => this.prepared === prepared && !life.isDisposed;
		const ready = new DeferredPromise<boolean>();
		life.add(toDisposable(() => { void ready.complete(false); }));
		const surface = element('div', 'studio-chat-window');
		surface.setAttribute('role', 'document');
		surface.setAttribute('aria-label', view.title);
		surface.style.visibility = 'hidden';
		life.add(toDisposable(() => surface.remove()));
		let shown = false;
		const fail = () => { if (shown) { this.fail(this.unavailable); } else { void ready.complete(false); } };
		try {
			const webview = life.add(this.webviews.createWebviewElement({ title: view.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [] } }));
			const deadline = life.add(new RunOnceScheduler(fail, 20_000));
			life.add(webview.onFatalError(fail));
			life.add(webview.onMessage(({ message }) => {
				if (message?.type === 'studio-launchpad-ready') { void ready.complete(true); }
				if (!shown || !isCurrent()) { return; }
				if (message?.type === 'studio-launchpad-close') { this.close(); }
				else if (message?.type === 'studio-launchpad-open-conversation') {
					const target = studioWebImTarget(typeof message.conversation === 'string' ? message.conversation : undefined,
						typeof message.user === 'string' ? message.user : undefined);
					if (!target) { return; }
					if (message.closeSource === true) {
						mainWindow.location.replace(studioWebImUrl(new URL(mainWindow.location.href), target).href);
					} else { openStudioWebIm(target, this.notifications); }
				} else if (message?.type === 'studio-sidebar-account' && prepared.accountUrl) {
					const uri = URI.parse(prepared.accountUrl);
					if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }).catch(() => undefined); }
				} else if (message?.type === 'studio-web-app-clipboard' && webview.isFocused && typeof message.requestId === 'string' &&
					message.requestId.length <= 128 && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 1_000_000) {
					const reply = (ok: boolean) => { if (isCurrent()) { void webview.postMessage({ type: 'studio-web-app-clipboard-result', requestId: message.requestId, ok }); } };
					void this.clipboard.writeText(message.text).then(() => reply(true), () => reply(false));
				}
			}));
			this.root.append(surface);
			webview.mountTo(surface, mainWindow);
			deadline.schedule();
			webview.setHtml(view.html);
			if (!await ready.p || !isCurrent()) { return false; }
			deadline.cancel();
			shown = true;
			mainWindow.document.title = view.title;
			this.message.classList.remove('studio-chat-loading');
			this.status.hidden = true;
			surface.style.visibility = '';
			return true;
		} catch { return false; }
	}
}
