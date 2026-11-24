/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { CancellationTokenSource } from '../../base/common/cancellation.js';
import { Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { IOverlayWebview, IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWebviewViewService } from '../contrib/webviewView/browser/webviewViewService.js';
import { LaunchpadLabel } from './studioLaunchpadPicker.js';

const viewType = 'studio.launchpadSettings';

/** Hosts the extension's existing settings view over the Launchpad in either renderer. */
export class StudioLaunchpadSettings extends Disposable {

	private readonly current = this._register(new MutableDisposable<{ webview: IOverlayWebview; dispose(): void }>());

	constructor(
		private readonly container: HTMLElement,
		private readonly t: LaunchpadLabel,
		private readonly onBack: () => void,
		private readonly onOpen: () => void,
		private readonly onError: (message: string) => void,
		private readonly webviews: IWebviewService,
		private readonly webviewViews: IWebviewViewService,
	) { super(); }

	get isOpen(): boolean { return !!this.current.value; }
	close(): void { this.current.clear(); }

	async show(title: string, pointer: boolean): Promise<void> {
		if (this.current.value) { this.current.value.webview.focus(); return; }
		const lifetime = new DisposableStore();
		const source = new CancellationTokenSource();
		lifetime.add(toDisposable(() => source.dispose(true)));
		const surface = document.createElement('div');
		surface.className = 'studio-launchpad-settings';
		surface.setAttribute('role', 'document');
		surface.setAttribute('aria-label', title);
		surface.tabIndex = 0;
		const back = document.createElement('button');
		back.type = 'button';
		back.className = 'studio-launchpad-app-close';
		const arrow = document.createElement('span');
		arrow.className = 'codicon codicon-chevron-left';
		arrow.setAttribute('aria-hidden', 'true');
		back.append(arrow, this.t('Back to Launchpad', '返回启动台'));
		back.title = this.t(`Close ${title}`, `关闭 ${title}`);
		back.setAttribute('aria-label', back.title);
		lifetime.add(addDisposableListener(back, 'click', this.onBack));
		if (pointer) {
			back.classList.add('lp-pointer');
			const reset = () => back.classList.remove('lp-pointer');
			lifetime.add(addDisposableListener(back, 'blur', reset));
			lifetime.add(addDisposableListener(back, 'keydown', reset));
		}
		const failed = () => {
			if (lifetime.isDisposed) { return; }
			this.onBack();
			this.onError(this.t('Could not open Studio Settings', '无法打开 Studio 设置'));
		};
		try {
			const webview = lifetime.add(this.webviews.createWebviewOverlay({ providedViewType: viewType, title, options: {}, contentOptions: {}, extension: undefined }));
			this.current.value = { webview, dispose: () => lifetime.dispose() };
			this.container.append(back, surface);
			lifetime.add(toDisposable(() => { surface.remove(); back.remove(); }));
			const deadline = lifetime.add(new RunOnceScheduler(failed, 15_000));
			lifetime.add(webview.onMessage(({ message }) => { if (message?.type === 'ready') { deadline.cancel(); } }));
			lifetime.add(webview.onFatalError(failed));
			lifetime.add(addDisposableListener(surface, 'focus', () => webview.focus()));
			this.onOpen();
			webview.claim(surface, mainWindow, undefined);
			webview.setAnchorElement(surface);
			back.focus({ preventScroll: true });
			deadline.schedule();
			await this.webviewViews.resolve(viewType, {
				title, webview, onDidChangeVisibility: Event.None, onDispose: webview.onDidDispose,
				dispose: () => { if (!lifetime.isDisposed) { this.onBack(); } },
				show: preserveFocus => { if (!preserveFocus && !lifetime.isDisposed) { webview.focus(); } },
			}, source.token);
		} catch {
			failed();
			lifetime.dispose();
		}
	}
}
