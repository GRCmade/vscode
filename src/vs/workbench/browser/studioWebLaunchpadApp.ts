/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { element, LaunchpadLabel } from './studioLaunchpadPicker.js';

interface LaunchpadAppView { id: string; title: string; html: string }
interface ChatTab extends IDisposable {
	readonly life: DisposableStore;
	window?: IAuxiliaryWindow;
	loading?: HTMLElement;
	key?: string;
}

/** The launchpad owns the gateway preview; each conversation gets its own browser tab. */
export class StudioWebLaunchpadApp extends Disposable {

	private prepared?: { key: string; accountUrl?: string };
	private readonly tabs = this._register(new DisposableMap<string, ChatTab>());

	constructor(
		private readonly windows: IAuxiliaryWindowService,
		private readonly t: LaunchpadLabel,
		private readonly webviews: IWebviewService,
		private readonly opener: IOpenerService,
		private readonly clipboard: IClipboardService,
		private readonly openConversation: (conversation?: string, user?: string) => void,
	) { super(); }

	prepare(key: string, accountUrl: string | undefined): boolean {
		if (this.prepared?.key !== key) {
			if (this.prepared) { this.clear(this.prepared.key); }
			this.prepared = { key, accountUrl };
		}
		return true;
	}

	clear(key: string): void {
		if (this.prepared?.key !== key) { return; }
		this.prepared = undefined;
		for (const [id, tab] of this.tabs) {
			if (tab.key === key) { this.close(id); }
		}
	}

	reset(): void {
		this.prepared = undefined;
		this.tabs.clearAndDisposeAll();
	}

	async open(id: string, title?: string): Promise<boolean> {
		if (this._store.isDisposed) { return false; }
		const life = new DisposableStore();
		const tab: ChatTab = { life, dispose: () => life.dispose() };
		this.tabs.set(id, tab);
		try {
			const window = await this.windows.open({ asTab: true });
			if (life.isDisposed || window.window.closed) { window.dispose(); this.close(id); return false; }
			tab.window = window;
			life.add(window);
			life.add(addDisposableListener(window.window, 'pagehide', () => this.close(id)));
			window.window.document.title = title || 'IM';
			tab.loading = window.container.appendChild(element('div', 'studio-chat-loading', this.t('Opening IM…', '正在打开 IM…')));
			tab.loading.setAttribute('role', 'status');
			return true;
		} catch { this.close(id); return false; }
	}

	isOpen(id: string): boolean {
		const tab = this.tabs.get(id);
		return !!tab?.window && !tab.life.isDisposed && !tab.window.window.closed;
	}

	close(id: string): void { this.tabs.deleteAndLeak(id)?.dispose(); }

	async show(key: string, id: string, view: LaunchpadAppView): Promise<boolean> {
		const prepared = this.prepared, tab = this.tabs.get(id), window = tab?.window;
		if (!prepared || prepared.key !== key || !view?.id || !tab || !window || tab.key || !this.isOpen(id)) { return false; }
		tab.key = key;
		const life = tab.life;
		const isCurrent = () => this.prepared === prepared && this.isOpen(id);
		const ready = new DeferredPromise<boolean>();
		life.add(toDisposable(() => { void ready.complete(false); }));
		const surface = element('div', 'studio-chat-window');
		surface.setAttribute('role', 'document');
		surface.setAttribute('aria-label', view.title);
		surface.style.visibility = 'hidden';
		life.add(toDisposable(() => surface.remove()));
		let shown = false;
		const fail = () => { if (shown) { this.close(id); } else { void ready.complete(false); } };
		try {
			const webview = life.add(this.webviews.createWebviewElement({ title: view.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [] } }));
			const deadline = life.add(new RunOnceScheduler(fail, 20_000));
			life.add(webview.onFatalError(fail));
			life.add(webview.onMessage(({ message }) => {
				if (message?.type === 'studio-launchpad-ready') { void ready.complete(true); }
				if (!shown || !isCurrent()) { return; }
				if (message?.type === 'studio-launchpad-close') { this.close(id); }
				else if (message?.type === 'studio-launchpad-open-conversation') {
					if (typeof message.conversation === 'string') { this.openConversation(message.conversation); }
					else if (typeof message.user === 'string') { this.openConversation(undefined, message.user); }
				} else if (message?.type === 'studio-sidebar-account' && prepared.accountUrl) {
					const uri = URI.parse(prepared.accountUrl);
					if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }).catch(() => undefined); }
				} else if (message?.type === 'studio-web-app-clipboard' && webview.isFocused && typeof message.requestId === 'string' &&
					message.requestId.length <= 128 && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 1_000_000) {
					const reply = (ok: boolean) => { if (isCurrent()) { void webview.postMessage({ type: 'studio-web-app-clipboard-result', requestId: message.requestId, ok }); } };
					void this.clipboard.writeText(message.text).then(() => reply(true), () => reply(false));
				}
			}));
			window.container.append(surface);
			webview.mountTo(surface, window.window);
			deadline.schedule();
			webview.setHtml(view.html);
			if (!await ready.p || !isCurrent()) { return false; }
			deadline.cancel();
			shown = true;
			window.window.document.title = view.title;
			tab.loading?.remove();
			tab.loading = undefined;
			surface.style.visibility = '';
			return true;
		} catch { return false; }
	}
}
