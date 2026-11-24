/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IStudioProjectEntry } from '../../../platform/window/common/studioProjectWindow.js';

const storageKey = 'studio.web.projectEntry';

// The run request goes to the new tab, not into the project URL. Shared links and reloads must not run it.
export function writeStudioWebProjectEntry(storage: Storage, href: string, entryId: string | undefined): void {
	storage.setItem(storageKey, JSON.stringify({ href, entryId }));
}

export function takeStudioWebProjectEntry(target: Pick<Window, 'sessionStorage'>, href: string, folderUri: string): IStudioProjectEntry | undefined {
	try {
		const storage = target.sessionStorage;
		const raw = storage.getItem(storageKey);
		if (raw === null) { return undefined; }
		storage.removeItem(storageKey);
		const entry = JSON.parse(raw) as { href?: string; entryId?: string } | null;
		if (entry?.href === href && (entry.entryId === undefined || typeof entry.entryId === 'string')) {
			return { uri: folderUri, entryId: entry.entryId };
		}
	} catch { /* The workspace still opens if browser storage is unavailable. */ }
	return undefined;
}
