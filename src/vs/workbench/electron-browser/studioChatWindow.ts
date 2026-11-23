/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWCOTitlebarAreaRect, getZoomFactor, isFullscreen, onDidChangeFullscreen, onDidChangeZoomLevel } from '../../base/browser/browser.js';
import { $, addDisposableListener } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { isMacintosh } from '../../base/common/platform.js';
import { URI } from '../../base/common/uri.js';
import { INativeHostService } from '../../platform/native/common/native.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { COMPACT_AUXILIARY_TITLEBAR_HEIGHT } from '../../platform/window/common/window.js';
import { IWebviewElement, IWebviewService } from '../contrib/webview/browser/webview.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';

export interface LaunchpadApp { port: number; accountUrl?: string }
export interface LaunchpadAppView { id: string; title: string; html: string; titlebarOverlay?: boolean }
interface MountedChat { window: IAuxiliaryWindow; webview: IWebviewElement; ready: Promise<boolean>; dispose(): void }

/** The runtime belongs to the resident host, but the chat document only ever lives in its own window. */
export class StudioChatWindow extends Disposable {
	private prepared?: { key: string; app: LaunchpadApp };
	private readonly chats = this._register(new DisposableMap<string, MountedChat>());
	private readonly opening = new Map<string, Promise<MountedChat | undefined>>();

	constructor(private readonly windows: IAuxiliaryWindowService, private readonly webviews: IWebviewService, private readonly opener: IOpenerService,
		private readonly native: INativeHostService,
		private readonly openConversation: (conversation?: string, user?: string) => Promise<boolean>) { super(); }

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
		await this.native.focusWindow({ targetWindowId: chat.window.window.vscodeWindowId });
		if (this.chats.get(view.id) !== chat || this.prepared !== prepared) { return false; }
		chat.webview.focus(); return true;
	}
	private async mount(prepared: { key: string; app: LaunchpadApp }, view: LaunchpadAppView): Promise<MountedChat | undefined> {
		const titlebarOverlay = isMacintosh && view.titlebarOverlay === true;
		const window = await this.windows.open({ bounds: { width: 780, height: 680 }, nativeTitlebar: true, keepAboveParent: true, titlebarOverlay });
		if (this.prepared !== prepared || this._store.isDisposed) { window.dispose(); return undefined; }
		const life = new DisposableStore();
		try {
			const app = prepared.app, ready = new DeferredPromise<boolean>(); life.add(toDisposable(() => { void ready.complete(false); }));
			window.window.document.title = view.title;
			// Auxiliary windows adopt workbench elements from the main document.
			const host = window.container.appendChild($('.studio-chat-window'));
			const webview = life.add(this.webviews.createWebviewElement({ title: view.title, options: { preserveNativeMenuShortcuts: true }, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: app.port, extensionHostPort: app.port }] } }));
			const chat = { window, webview, ready: ready.p, dispose: () => life.dispose() };
			const close = () => { if (this.chats.get(view.id) === chat) { this.chats.deleteAndLeak(view.id)?.dispose(); } };
			this.chats.set(view.id, chat); life.add(window.onUnload(close)); life.add(webview.onFatalError(close));
			life.add(window);
			const deadline = life.add(new RunOnceScheduler(close, 20_000));
			const syncTitlebar = titlebarOverlay ? this.installTitlebar(window.window, host, webview, life) : undefined;
			life.add(webview.onMessage(({ message }) => {
				if (this.chats.get(view.id) !== chat || this.prepared !== prepared) { return; }
				if (message?.type === 'studio-launchpad-ready') { deadline.cancel(); void ready.complete(true); }
				else if (message?.type === 'studio-launchpad-titlebar-request') { syncTitlebar?.(); }
				else if (message?.type === 'studio-launchpad-close') { close(); }
				else if (message?.type === 'studio-launchpad-open-conversation') {
					const { conversation, user, closeSource } = message;
					if (typeof conversation === 'string') {
						void this.openConversation(conversation).then(opened => { if (opened && closeSource === true && conversation !== view.id) { close(); } });
					} else if (typeof user === 'string') { void this.openConversation(undefined, user); }
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

	private installTitlebar(target: IAuxiliaryWindow['window'], host: HTMLElement, webview: IWebviewElement, life: DisposableStore): () => void {
		// Draggable regions in a cross-origin iframe don't reach the owning native window.
		const drag = host.appendChild($('.studio-chat-titlebar-drag'));
		drag.setAttribute('aria-hidden', 'true');
		const overlay = (target.navigator as Navigator & { windowControlsOverlay?: EventTarget }).windowControlsOverlay;
		const sync = () => {
			const zoom = getZoomFactor(target), area = getWCOTitlebarAreaRect(target);
			const left = area && area.width > 0 ? Math.ceil(area.x) + 8 : isFullscreen(target) ? 12 : Math.ceil(92 / zoom);
			const height = Math.max(34, Math.ceil(COMPACT_AUXILIARY_TITLEBAR_HEIGHT / zoom), Math.ceil(area?.height ?? 0) + 2);
			host.style.setProperty('--studio-chat-titlebar-height', `${height}px`);
			host.style.setProperty('--studio-chat-titlebar-left', `${left}px`);
			void webview.postMessage({ type: 'studio-launchpad-titlebar', left, height });
		};
		const refresh = life.add(new RunOnceScheduler(sync, 0));
		if (overlay) { life.add(addDisposableListener(overlay, 'geometrychange', () => refresh.schedule())); }
		life.add(onDidChangeZoomLevel(id => { if (id === target.vscodeWindowId) { refresh.schedule(); } }));
		life.add(onDidChangeFullscreen(id => { if (id === target.vscodeWindowId) { refresh.schedule(); } }));
		return sync;
	}
}
