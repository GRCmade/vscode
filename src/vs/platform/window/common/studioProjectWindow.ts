/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import { hasWorkspaceFileExtension } from '../../workspace/common/workspace.js';
import { IOpenWindowOptions, IWindowOpenable, isFileToOpen, isFolderToOpen, isWorkspaceToOpen } from './window.js';

export interface IStudioProjectEntry {
	readonly uri: string;
	readonly entryId?: string;
}

export function studioEntryForOpenables(toOpen: readonly IWindowOpenable[], options: IOpenWindowOptions): IStudioProjectEntry | undefined {
	const [folder] = toOpen;
	const entry = options.studioProjectEntry;
	if (entry && toOpen.length === 1 && isFolderToOpen(folder) && !options.addMode && !options.removeMode) {
		return { uri: URI.revive(folder.folderUri).toString(), entryId: entry.entryId };
	}
	return undefined;
}

export function studioEntryForFolder(entry: IStudioProjectEntry | undefined, folder: URI | undefined): IStudioProjectEntry | undefined {
	if (entry && folder && extUriBiasedIgnorePathCase.isEqual(folder, URI.parse(entry.uri))) {
		return { uri: folder.toString(), entryId: entry.entryId };
	}
	return undefined;
}

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
