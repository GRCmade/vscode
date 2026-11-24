/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { button, element, LaunchpadLabel } from './studioLaunchpadPicker.js';

interface LaunchpadAppView { id: string; title: string; html: string }

/** The extension supplies a gateway-scoped preview, so no desktop port mapping or native window is needed. */
export class StudioWebLaunchpadApp extends Disposable {

	private prepared?: { key: string; accountUrl?: string };
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly container: HTMLElement,
		private readonly t: LaunchpadLabel,
		private readonly webviews: IWebviewService,
		private readonly opener: IOpenerService,
		private readonly clipboard: IClipboardService,
		private readonly onOpen: () => void,
		private readonly onBack: () => void,
		private readonly openConversation: (conversation?: string, user?: string) => void,
	) { super(); }

	prepare(key: string, accountUrl: string | undefined): boolean {
		if (this.prepared?.key !== key) { this.reset(); this.prepared = { key, accountUrl }; }
		return true;
	}

	clear(key: string): void { if (this.prepared?.key === key) { this.reset(); } }

	dismiss(): void { this.pending.clear(); this.current.clear(); }

	reset(): void {
		this.prepared = undefined;
		const wasOpen = !!this.current.value;
		this.dismiss();
		if (wasOpen) { this.onBack(); }
	}

	async show(key: string, view: LaunchpadAppView, isRequested: () => boolean): Promise<boolean> {
		const prepared = this.prepared;
		if (!prepared || prepared.key !== key || !view?.id || this._store.isDisposed || !isRequested()) { return false; }
		const life = new DisposableStore();
		this.pending.value = life;
		const ready = new DeferredPromise<boolean>();
		life.add(toDisposable(() => { void ready.complete(false); }));
		const surface = element('div', 'studio-launchpad-settings');
		surface.setAttribute('role', 'document');
		surface.setAttribute('aria-label', view.title);
		surface.style.visibility = 'hidden';
		const close = () => {
			if (this.pending.value === life) { this.pending.clear(); }
			if (this.current.value === life) { this.current.clear(); this.onBack(); }
		};
		const back = button(this.t('Back to Launchpad', '返回启动台'), 'chevron-left', close, 'studio-launchpad-app-close');
		life.add(toDisposable(() => { surface.remove(); back.remove(); }));
		try {
			const webview = life.add(this.webviews.createWebviewElement({ title: view.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [] } }));
			const deadline = life.add(new RunOnceScheduler(close, 20_000));
			life.add(webview.onFatalError(close));
			life.add(webview.onMessage(({ message }) => {
				if (message?.type === 'studio-launchpad-ready') { void ready.complete(true); }
				if (this.current.value !== life) { return; }
				if (message?.type === 'studio-launchpad-close') { close(); }
				else if (message?.type === 'studio-launchpad-open-conversation') {
					if (typeof message.conversation === 'string') { this.openConversation(message.conversation); }
					else if (typeof message.user === 'string') { this.openConversation(undefined, message.user); }
				} else if (message?.type === 'studio-sidebar-account' && prepared.accountUrl) {
					const uri = URI.parse(prepared.accountUrl);
					if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }).catch(() => undefined); }
				} else if (message?.type === 'studio-web-app-clipboard' && webview.isFocused && typeof message.requestId === 'string' &&
					message.requestId.length <= 128 && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 1_000_000) {
					const reply = (ok: boolean) => { if (this.current.value === life) { void webview.postMessage({ type: 'studio-web-app-clipboard-result', requestId: message.requestId, ok }); } };
					void this.clipboard.writeText(message.text).then(() => reply(true), () => reply(false));
				}
			}));
			this.container.append(surface);
			webview.mountTo(surface, mainWindow);
			deadline.schedule();
			webview.setHtml(view.html);
			if (!await ready.p || this.pending.value !== life || this.prepared !== prepared || !isRequested()) { close(); return false; }
			deadline.cancel();
			this.current.value = this.pending.clearAndLeak();
			this.onOpen();
			surface.style.visibility = '';
			this.container.append(back);
			back.focus({ preventScroll: true });
			return true;
		} catch { close(); return false; }
	}
}
