/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IWebviewElement, IWebviewService } from '../contrib/webview/browser/webview.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';

export interface LaunchpadApp { title: string; html: string; port: number; accountUrl?: string }
interface MountedChat { window: IAuxiliaryWindow; webview: IWebviewElement; ready: Promise<boolean>; dispose(): void }

/** The runtime belongs to the resident host, but the chat document only ever lives in its own window. */
export class StudioChatWindow extends Disposable {
	private prepared?: { key: string; app: LaunchpadApp };
	private readonly chat = this._register(new MutableDisposable<MountedChat>());
	private opening?: Promise<MountedChat | undefined>;

	constructor(private readonly windows: IAuxiliaryWindowService, private readonly webviews: IWebviewService, private readonly opener: IOpenerService, private readonly social: (section: 'people' | 'favorites') => void) { super(); }

	prepare(key: string, app: LaunchpadApp): boolean {
		if (this.prepared?.key !== key) { this.chat.clear(); this.opening = undefined; this.prepared = { key, app }; }
		return true;
	}
	clear(key: string): void { if (this.prepared?.key === key) { this.prepared = undefined; this.opening = undefined; this.chat.clear(); } }
	async show(key: string, conversation?: string): Promise<boolean> {
		const prepared = this.prepared;
		if (!prepared || prepared.key !== key || this._store.isDisposed) { return false; }
		if (!this.chat.value && !this.opening) {
			const pending = this.mount(prepared); this.opening = pending;
			try { await pending; } finally { if (this.opening === pending) { this.opening = undefined; } }
		} else if (this.opening) { await this.opening; }
		const chat = this.chat.value;
		if (!chat || !await chat.ready || this.chat.value !== chat || this.prepared !== prepared) { return false; }
		chat.window.window.focus(); chat.webview.focus(); return chat.webview.postMessage({ type: 'studio-launchpad-view', visible: true, conversation });
	}
	private async mount(prepared: { key: string; app: LaunchpadApp }): Promise<MountedChat | undefined> {
		const window = await this.windows.open({ bounds: { width: 920, height: 680 }, nativeTitlebar: true });
		if (this.prepared !== prepared || this._store.isDisposed) { window.dispose(); return undefined; }
		const life = new DisposableStore(); life.add(window);
		try {
			const app = prepared.app, ready = new DeferredPromise<boolean>(); life.add(toDisposable(() => { void ready.complete(false); }));
			const doc = window.window.document; doc.title = app.title;
			const host = doc.createElement('div'); host.className = 'studio-chat-window'; window.container.append(host);
			const webview = life.add(this.webviews.createWebviewElement({ title: app.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: app.port, extensionHostPort: app.port }] } }));
			const chat = { window, webview, ready: ready.p, dispose: () => life.dispose() };
			const close = () => { if (this.chat.value === chat) { this.chat.clear(); } };
			this.chat.value = chat; life.add(window.onUnload(close)); life.add(webview.onFatalError(close));
			const deadline = life.add(new RunOnceScheduler(close, 20_000));
			life.add(webview.onMessage(({ message }) => {
				if (message?.type === 'studio-launchpad-social' && (message.section === 'people' || message.section === 'favorites')) { this.social(message.section); }
				if (message?.type === 'studio-launchpad-ready') { deadline.cancel(); void ready.complete(true); }
				if (message?.type === 'studio-sidebar-account' && app.accountUrl) {
					const uri = URI.parse(app.accountUrl); if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }); }
				}
			}));
			life.add(addDisposableListener(doc, 'visibilitychange', () => { void webview.postMessage({ type: 'studio-launchpad-view', visible: !doc.hidden }); }));
			webview.mountTo(host, window.window); webview.setHtml(app.html); deadline.schedule(); return chat;
		} catch (e) { if (this.chat.value?.window === window) { this.chat.clear(); } life.dispose(); throw e; }
	}
}
