/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { projectWindowLabels, shouldChooseProjectWindow } from '../../window/common/studioProjectWindow.js';
import type { ICodeWindow } from '../../window/electron-main/window.js';
import type { IOpenConfiguration, IWindowsMainService } from './windows.js';

export async function openWithProjectWindowChoice(openConfig: IOpenConfiguration, windows: IWindowsMainService,
	showMessageBox: (windowId: number | undefined, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>): Promise<ICodeWindow[] | undefined> {
	if (shouldChooseProjectWindow(openConfig.urisToOpen ?? [], openConfig)) {
		const window = (typeof openConfig.contextWindowId === 'number' ? windows.getWindowById(openConfig.contextWindowId) : undefined)
			?? windows.getFocusedWindow() ?? windows.getLastActiveWindow();
		const labels = projectWindowLabels();
		const { response } = await showMessageBox(window?.id, {
			type: 'question', message: labels.message,
			buttons: [labels.newWindow, labels.currentWindow, labels.cancel], defaultId: 0, cancelId: 2, noLink: true
		});
		if ((response !== 0 && response !== 1) || window?.win?.isDestroyed()) {
			return;
		}
		openConfig = { ...openConfig, contextWindowId: window?.id, forceNewWindow: response === 0, forceReuseWindow: response === 1 };
	}
	return windows.open(openConfig);
}
