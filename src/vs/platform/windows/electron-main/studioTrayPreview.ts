/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Rectangle, screen } from 'electron';
import { pathToFileURL } from 'url';
import { FileAccess } from '../../../base/common/network.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { getNLSLanguage } from '../../../nls.js';
import type { IStudioTrayNotifications, IStudioTrayPreview } from '../common/studioTrayNotifications.js';

function previewBounds(anchor: Rectangle, workArea: Rectangle, rows: number): Rectangle {
	const gap = 6;
	const width = Math.min(360, workArea.width - gap * 2);
	const height = Math.min(49 + Math.min(5, Math.max(rows, 1)) * 73, workArea.height - gap * 2);
	const bottom = workArea.y + workArea.height;
	const below = anchor.y + anchor.height + gap;
	const above = anchor.y - height - gap;
	const preferBelow = below + height <= bottom || bottom - below > anchor.y - workArea.y;
	return {
		x: Math.max(workArea.x + gap, Math.min(anchor.x + Math.round((anchor.width - width) / 2), workArea.x + workArea.width - width - gap)),
		y: Math.max(workArea.y + gap, Math.min(preferBelow ? below : above, bottom - height - gap)),
		width,
		height,
	};
}

export class StudioTrayPreview {
	private readonly window: BrowserWindow;
	private readonly anchor: Rectangle;
	private readonly labels: IStudioTrayPreview['labels'];
	private readonly language = getNLSLanguage() ?? 'en';
	private ready = false;
	private marking = false;

	constructor(anchor: Rectangle | undefined, private notices: IStudioTrayNotifications, markAll: () => Promise<boolean>, onClose: () => void, onError: (error: unknown) => void) {
		const url = pathToFileURL(FileAccess.asFileUri('vs/platform/windows/electron-browser/studioTrayPreview.html').fsPath).href;
		this.anchor = anchor && anchor.width > 0 && anchor.height > 0 ? anchor : { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
		this.labels = this.language.toLowerCase().startsWith('zh') ? {
			title: '未读通知', readAll: '全部已读', reading: '正在标记…', noPreview: '暂时没有可预览的内容。', failed: '未能将全部通知标为已读，请重试。',
		} : {
			title: 'Unread notifications', readAll: 'Mark all as read', reading: 'Marking…', noPreview: 'No preview available.', failed: 'Could not mark all notifications as read. Try again.',
		};
		const win = this.window = new BrowserWindow({
			...this.bounds(),
			title: this.labels.title, show: false, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
			skipTaskbar: true, alwaysOnTop: true, type: isMacintosh ? 'panel' : undefined,
			webPreferences: {
				preload: FileAccess.asFileUri('vs/platform/windows/electron-browser/preload-studioTrayPreview.js').fsPath,
				sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false,
			},
		});
		win.on('closed', onClose);
		win.on('blur', () => this.close());
		const fail = (error: unknown) => {
			if (!win.isDestroyed()) { this.close(); onError(error); }
		};
		win.webContents.on('preload-error', (_event, _path, error) => fail(error));
		win.webContents.on('render-process-gone', (_event, { reason }) => {
			if (this.ready) { this.close(); }
			else { fail(new Error(`Studio tray preview renderer exited: ${reason}`)); }
		});
		win.webContents.on('will-frame-navigate', event => event.preventDefault());
		win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		win.webContents.on('before-input-event', (event, input) => {
			if (input.type === 'keyDown' && input.key === 'Escape') {
				event.preventDefault();
				this.close();
			} else if (input.type === 'keyDown' && input.key.toLowerCase() === 'c' && (isMacintosh ? input.meta : input.control) && !input.alt && !input.shift) {
				event.preventDefault();
				win.webContents.copy();
			}
		});
		win.webContents.ipc.handle('vscode:studioTray:readAll', async event => {
			if (!this.ready || !win.isVisible() || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== url || this.marking || !this.notices.count) {
				return false;
			}
			this.marking = true;
			try {
				return await markAll();
			} finally {
				this.marking = false;
				if (!this.notices.count) { this.close(); }
			}
		});
		void win.loadURL(url).then(() => {
			if (!win.isDestroyed()) {
				this.render();
				win.show();
				this.ready = true;
			}
		}).catch(fail);
	}

	private bounds(): Rectangle {
		const { x, y, width, height } = this.anchor;
		const display = screen.getDisplayNearestPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
		return previewBounds(this.anchor, display.workArea, this.notices.items.length);
	}

	private render(): void {
		const state: IStudioTrayPreview = { ...this.notices, language: this.language, labels: this.labels };
		this.window.setBounds(this.bounds());
		this.window.webContents.send('vscode:studioTray:preview', state);
	}

	update(notices: IStudioTrayNotifications): void {
		this.notices = notices;
		if (!notices.count && !this.marking) { this.close(); }
		else if (this.ready && !this.window.isDestroyed()) { this.render(); }
	}

	close(): void {
		if (!this.window.isDestroyed()) { this.window.destroy(); }
	}
}
