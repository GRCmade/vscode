/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { projectTypeMark, type StudioProjectDetails } from '../browser/studioProjectDetails.js';
import { element, icon, picture, type StudioLabel } from '../browser/studioUiElements.js';

export { edition, glyph, projectMark, typeLabel } from '../browser/studioProjectDetails.js';
export { picture } from '../browser/studioUiElements.js';

export interface LibraryArtwork {
	cover?: { name: string; mtime: number };
	entries?: string[];
	files?: string[];
	entryTypes?: string[];
}

export interface LaunchpadProject extends StudioProjectDetails {
	artwork?: LibraryArtwork;
	builtin?: true;
	managed?: true;
	parentUri?: string;
}

export interface StoreListing {
	id: string; name: string; description?: string; version?: string; projectType?: string; avatarUrl?: string; images?: string[]; entries?: string[]; entryTypes?: string[];
}

export interface StoreListingDetails extends StoreListing {
	summary?: string; updatedAt?: string; projectEntries?: { name: string; type: string; primary: boolean }[];
}

export function storeArtwork(p: StoreListing, cover?: string | Promise<string | undefined>): HTMLElement {
	return artwork(p.id, { entries: p.entries?.length ? p.entries : p.avatarUrl ? [p.avatarUrl] : [], entryTypes: p.entryTypes }, projectTypeMark(p.projectType, icon('extensions')), cover);
}

export function openProjectLabel(p: LaunchpadProject, t: StudioLabel): string {
	if (p.windowId !== undefined) { return t('Switch to window', '切换到项目窗口'); }
	if (p.managed) { return t('Open Bot workspace', '打开 Bot 工作区'); }
	if (p.missing) { return t('Locate project…', '重新定位项目…'); }
	switch (p.distribution) {
		case 'source': return t('Open in IDE', '在 IDE 中打开');
		case 'release': case 'download': return t('Open in Steam mode', '在 Steam 模式打开');
		default: return t('Open in new window', '在新窗口打开');
	}
}

/** Use real entry identities or file names; never fetch a URL supplied by a local manifest. */
export function artwork(key: string, art: LibraryArtwork | undefined, fallback: HTMLElement, cover?: string | Promise<string | undefined>): HTMLElement {
	const surface = element('span', 'lp-artwork'); surface.setAttribute('aria-hidden', 'true');
	let hash = 0; for (const ch of key) { hash = (31 * hash + ch.charCodeAt(0)) | 0; }
	surface.dataset.ink = String(Math.abs(hash) % 5);
	const stack = element('span', 'lp-art-stack');
	const marks = art?.entries?.filter(src => src.startsWith('data:image/')).slice(0, 3).map(src => picture(src));
	if (marks?.length) { stack.append(...marks); }
	else if (art?.entryTypes?.length) { stack.append(...art.entryTypes.slice(0, 3).map(type => projectTypeMark(type, icon('extensions')))); }
	else if (art?.files?.length) {
		for (const filename of art.files.slice(0, 3)) {
			const sheet = element('span', 'lp-art-file'); sheet.title = filename;
			sheet.append(icon('file'), element('small', '', (filename.split('.').pop() || filename).slice(0, 6)), element('span', 'lp-file-lines')); stack.append(sheet);
		}
	} else { stack.append(fallback); }
	surface.append(stack);
	if (cover) {
		void Promise.resolve(cover).then(src => {
			if (!src) { return; }
			const img = picture(src, 'lp-cover'); img.addEventListener('load', () => { stack.hidden = true; }, { once: true });
			img.addEventListener('error', () => img.remove(), { once: true }); surface.append(img);
		}, () => undefined);
	}
	return surface;
}
