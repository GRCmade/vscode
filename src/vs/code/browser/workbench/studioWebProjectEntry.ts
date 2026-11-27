/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IStudioProjectEntry } from '../../../platform/window/common/studioProjectWindow.js';

const storageKey = 'studio.web.projectEntry';

// This tab owns the run view. Reloads can reattach, but sharing the folder URL must not open it.
export function writeStudioWebProjectEntry(storage: Storage, href: string, entryId: string | undefined): void {
	storage.setItem(storageKey, JSON.stringify({ href, entryId }));
}

export function readStudioWebProjectEntry(target: Pick<Window, 'sessionStorage'>, href: string, folderUri: string): IStudioProjectEntry | undefined {
	try {
		const storage = target.sessionStorage;
		const raw = storage.getItem(storageKey);
		if (raw === null) { return undefined; }
		const entry = JSON.parse(raw) as { href?: string; entryId?: string } | null;
		if (entry?.href === href && (entry.entryId === undefined || typeof entry.entryId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(entry.entryId))) {
			return { uri: folderUri, entryId: entry.entryId };
		}
		storage.removeItem(storageKey);
	} catch { /* The workspace still opens if browser storage is unavailable. */ }
	return undefined;
}
