/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Menu, nativeImage, Tray } from 'electron';
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { getNLSLanguage } from '../../../nls.js';

// Four launchpad tiles, with a transparent template for the macOS menu bar.
const templatePng = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAVUlEQVR42u3WMQ4AEBBEUUdy/8bRUIgokS1I3k+mNPmVnZTwObmn9NTNlPEmumNyUrQWRndM6mWiOwgRIkSI0Den47njCgPNQPNTEyJEiJCBZqA9TgOdQPgfhQ16EgAAAABJRU5ErkJggg==';
const colorPng = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAnklEQVR42u3VwQmAMAyF4Q7isQNkDbfx7gyu4QjepLN4d4eYXooWA0lPLbzAfwvlgx4SAmbkidtFUpLYWN6l9xvTcpCUJDaWd0kDeTAFVYE8mILSQNxSBeKWAAIIIIAAMoK6Ox19HVfMcDPvN0lJYmN59/P/cT1JShIby7ukgTyYgqpAHkxBaSBuqQJxSwABBBBAABlB3Z2Ovo4r5mcejsiY1iXUlYUAAAAASUVORK5CYII=';

export function createStudioTray(show: () => void, quit: () => void): IDisposable {
	const zh = getNLSLanguage()?.toLowerCase().startsWith('zh');
	const image = nativeImage.createFromBuffer(Buffer.from(isMacintosh ? templatePng : colorPng, 'base64'), { scaleFactor: 2 });
	if (isMacintosh) { image.setTemplateImage(true); }
	const tray = new Tray(image);
	const menu = Menu.buildFromTemplate([
		{ label: zh ? '显示启动台' : 'Show Launchpad', click: show },
		{ type: 'separator' },
		{ label: zh ? '退出 SteamHarness Studio' : 'Quit SteamHarness Studio', click: quit },
	]);
	tray.setToolTip('SteamHarness Studio');
	tray.on('click', show);
	if (isLinux) {
		tray.setContextMenu(menu);
	} else {
		tray.on('right-click', () => tray.popUpContextMenu(menu));
	}
	return toDisposable(() => tray.destroy());
}
