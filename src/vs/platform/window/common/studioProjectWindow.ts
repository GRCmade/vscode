/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import { hasWorkspaceFileExtension, IAnyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { IOpenWindowOptions, IWindowOpenable, isFileToOpen, isFolderToOpen, isWorkspaceToOpen } from './window.js';

export interface IStudioProjectEntry {
	readonly uri: string;
	readonly entryId?: string;
	readonly conversationId?: string;
	readonly botArtifacts?: true;
	readonly botMemory?: true;
}

export function studioEntryForOpenables(toOpen: readonly IWindowOpenable[], options: IOpenWindowOptions): IStudioProjectEntry | undefined {
	const [item] = toOpen;
	const entry = options.studioProjectEntry;
	if (!entry || toOpen.length !== 1 || options.addMode || options.removeMode) { return undefined; }
	const { conversationId, botArtifacts, botMemory } = entry;
	if (conversationId !== undefined && (typeof conversationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversationId))) { return undefined; }
	if (botArtifacts !== undefined && botArtifacts !== true || botMemory !== undefined && botMemory !== true || botArtifacts && botMemory) { return undefined; }
	const navigation = { ...(conversationId && { conversationId }), ...(botArtifacts && { botArtifacts }), ...(botMemory && { botMemory }) };
	if (isFolderToOpen(item)) {
		return { uri: URI.revive(item.folderUri).toString(), entryId: entry.entryId, ...navigation };
	}
	if ((conversationId || botArtifacts || botMemory) && isWorkspaceToOpen(item) && hasWorkspaceFileExtension(URI.revive(item.workspaceUri))) {
		return { uri: URI.revive(item.workspaceUri).toString(), ...navigation };
	}
	return undefined;
}

export function studioEntryForFolder(entry: IStudioProjectEntry | undefined, folder: URI | undefined): IStudioProjectEntry | undefined {
	if (entry && folder && extUriBiasedIgnorePathCase.isEqual(folder, URI.parse(entry.uri))) {
		return { ...entry, uri: folder.toString() };
	}
	return undefined;
}

export function studioEntryForWorkspace(entry: IStudioProjectEntry | undefined, workspace: IAnyWorkspaceIdentifier | undefined): IStudioProjectEntry | undefined {
	if (isSingleFolderWorkspaceIdentifier(workspace)) { return studioEntryForFolder(entry, workspace.uri); }
	if ((entry?.conversationId || entry?.botArtifacts || entry?.botMemory) && isWorkspaceIdentifier(workspace)) { return studioEntryForFolder(entry, workspace.configPath); }
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
