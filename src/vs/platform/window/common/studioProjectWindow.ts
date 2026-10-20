/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getNLSLanguage, localize } from '../../../nls.js';
import { hasWorkspaceFileExtension } from '../../workspace/common/workspace.js';
import { IOpenWindowOptions, IWindowOpenable, isFileToOpen, isFolderToOpen, isWorkspaceToOpen } from './window.js';

export function shouldChooseProjectWindow(toOpen: readonly IWindowOpenable[], options?: IOpenWindowOptions): boolean {
	return !options?.forceNewWindow && !options?.forceReuseWindow && !options?.addMode && !options?.removeMode
		&& toOpen.some(openable => isFolderToOpen(openable) || isWorkspaceToOpen(openable)
			|| isFileToOpen(openable) && hasWorkspaceFileExtension(openable.fileUri));
}

export function projectWindowLabels(): { message: string; newWindow: string; currentWindow: string; cancel: string } {
	// Fork-specific strings are not included in the published VS Code language pack.
	if (getNLSLanguage()?.toLowerCase() === 'zh-cn') {
		return { message: '在何处打开项目？', newWindow: '在新窗口打开', currentWindow: '在当前窗口打开', cancel: '取消' };
	}
	return {
		message: localize('studio.projectWindow.message', "Where would you like to open the project?"),
		newWindow: localize('studio.projectWindow.newWindow', "Open in New Window"),
		currentWindow: localize('studio.projectWindow.currentWindow', "Open in Current Window"),
		cancel: localize('studio.projectWindow.cancel', "Cancel")
	};
}
