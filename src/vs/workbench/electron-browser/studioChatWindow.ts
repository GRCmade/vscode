/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IWebviewElement, IWebviewService } from '../contrib/webview/browser/webview.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';

export interface LaunchpadApp { port: number; accountUrl?: string }
export interface LaunchpadAppView { id: string; title: string; html: string }
interface MountedChat { window: IAuxiliaryWindow; webview: IWebviewElement; ready: Promise<boolean>; dispose(): void }

/** The runtime belongs to the resident host, but the chat document only ever lives in its own window. */
export class StudioChatWindow extends Disposable {
	private prepared?: { key: string; app: LaunchpadApp };
	private readonly chats = this._register(new DisposableMap<string, MountedChat>());
	private readonly opening = new Map<string, Promise<MountedChat | undefined>>();

	constructor(private readonly windows: IAuxiliaryWindowService, private readonly webviews: IWebviewService, private readonly opener: IOpenerService,
		private readonly openConversation: (conversation?: string, user?: string) => void) { super(); }

	prepare(key: string, app: LaunchpadApp): boolean {
		if (this.prepared?.key !== key) { this.clear(this.prepared?.key); this.prepared = { key, app }; }
		return true;
	}
	clear(key: string | undefined): void {
		if (this.prepared?.key === key) { this.prepared = undefined; this.opening.clear(); this.chats.clearAndDisposeAll(); }
	}
	async show(key: string, view: LaunchpadAppView): Promise<boolean> {
		const prepared = this.prepared;
		if (!prepared || prepared.key !== key || this._store.isDisposed || !view?.id) { return false; }
		let chat = this.chats.get(view.id);
		if (!chat) {
			const pending = this.opening.get(view.id) ?? this.mount(prepared, view);
			this.opening.set(view.id, pending);
			try { chat = await pending; } finally { if (this.opening.get(view.id) === pending) { this.opening.delete(view.id); } }
		}
		if (!chat || !await chat.ready || this.chats.get(view.id) !== chat || this.prepared !== prepared) { return false; }
		chat.window.window.focus(); chat.webview.focus(); return true;
	}
	private async mount(prepared: { key: string; app: LaunchpadApp }, view: LaunchpadAppView): Promise<MountedChat | undefined> {
		const window = await this.windows.open({ bounds: { width: 780, height: 680 }, nativeTitlebar: true });
		if (this.prepared !== prepared || this._store.isDisposed) { window.dispose(); return undefined; }
		const life = new DisposableStore();
		try {
			const app = prepared.app, ready = new DeferredPromise<boolean>(); life.add(toDisposable(() => { void ready.complete(false); }));
			window.window.document.title = view.title;
			// Auxiliary windows adopt workbench elements from the main document.
			const host = window.container.appendChild($('.studio-chat-window'));
			const webview = life.add(this.webviews.createWebviewElement({ title: view.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: app.port, extensionHostPort: app.port }] } }));
			const chat = { window, webview, ready: ready.p, dispose: () => life.dispose() };
			const close = () => { if (this.chats.get(view.id) === chat) { this.chats.deleteAndLeak(view.id)?.dispose(); } };
			this.chats.set(view.id, chat); life.add(window.onUnload(close)); life.add(webview.onFatalError(close));
			life.add(window);
			const deadline = life.add(new RunOnceScheduler(close, 20_000));
			life.add(webview.onMessage(({ message }) => {
				if (this.chats.get(view.id) !== chat || this.prepared !== prepared) { return; }
				if (message?.type === 'studio-launchpad-ready') { deadline.cancel(); void ready.complete(true); }
				else if (message?.type === 'studio-launchpad-close') { close(); }
				else if (message?.type === 'studio-launchpad-open-conversation') {
					if (typeof message.conversation === 'string') { this.openConversation(message.conversation); }
					else if (typeof message.user === 'string') { this.openConversation(undefined, message.user); }
				} else if (message?.type === 'studio-sidebar-account' && app.accountUrl) {
					const uri = URI.parse(app.accountUrl); if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }); }
				}
			}));
			webview.mountTo(host, window.window); deadline.schedule(); webview.setHtml(view.html); return chat;
		} catch (e) {
			if (this.chats.get(view.id)?.window === window) { this.chats.deleteAndLeak(view.id); }
			life.dispose(); window.dispose(); throw e;
		}
	}
}
