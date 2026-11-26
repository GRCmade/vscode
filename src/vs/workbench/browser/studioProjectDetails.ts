/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { studioProjectCardIcon, studioProjectIcon } from '../common/studioProjectIcons.js';
import { picture, type StudioLabel } from './studioUiElements.js';
import { projectDetailMark, renderProjectDetails, renderProjectEntryList, type ProjectDetailsData, type ProjectDetailsEntry } from './studioProjectDetailsView.js';
import './media/studioProjectDetailsView.css';
import './media/studioProjectDetails.css';

export { edition, typeLabel } from './studioProjectDetailsView.js';

export interface StudioProjectEntry extends ProjectDetailsEntry {
	entryId: string;
}

export interface StudioProjectDetails extends ProjectDetailsData {
	path: string;
	entries?: readonly StudioProjectEntry[];
}

export function glyph(p: StudioProjectDetails): string {
	return studioProjectIcon(p.projectType) ?? (p.kind === 'workspace' ? 'project' : p.distribution ? 'package' : 'folder');
}

export function projectMark(p: StudioProjectDetails): HTMLElement {
	return projectDetailMark(document, avatar(p.avatarUrl, p.projectType), glyph(p));
}

export function projectTypeMark(type: string | undefined, fallback: HTMLElement): HTMLElement {
	const source = studioProjectCardIcon(type);
	return source ? picture(source) : fallback;
}

function avatar(url: string | undefined, type: string | undefined): string | undefined {
	return url?.startsWith('data:image/') ? url : studioProjectCardIcon(type);
}

function withEntryAvatars(entries: readonly ProjectDetailsEntry[]): ProjectDetailsEntry[] {
	return entries.map(entry => ({ ...entry, avatarUrl: avatar(entry.avatarUrl, entry.type) }));
}

interface ProjectDetailsOptions {
	actions: readonly HTMLElement[];
	secondaryActions?: HTMLElement;
	openEntry?(entryId: string): void;
	currentWindow?: boolean;
	extraFacts?: [label: string, value: string | undefined][];
	usage?: HTMLElement;
}

/** Native surfaces add window state and their own actions to the shared details view. */
export function projectDetails(p: StudioProjectDetails, t: StudioLabel, options: ProjectDetailsOptions): HTMLElement {
	return renderProjectDetails(document, { ...p, avatarUrl: avatar(p.avatarUrl, p.projectType), entries: p.entries && withEntryAvatars(p.entries) },
		t, { ...options, fallbackIcon: glyph(p), showWindowStatus: true });
}

export function projectEntryList(entries: readonly ProjectDetailsEntry[], t: StudioLabel): HTMLElement {
	return renderProjectEntryList(document, withEntryAvatars(entries), t);
}
