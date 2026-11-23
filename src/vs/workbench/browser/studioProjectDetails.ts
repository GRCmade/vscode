/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { studioProjectCardIcon, studioProjectIcon } from '../common/studioProjectIcons.js';
import { button, element, icon, picture, type StudioLabel } from './studioUiElements.js';
import './media/studioProjectDetails.css';

export interface StudioProjectEntry {
	entryId: string;
	name: string;
	type: string;
	primary: boolean;
	avatarUrl?: string;
	available?: boolean;
}

export interface StudioProjectDetails {
	kind: 'folder' | 'workspace';
	uri: string;
	name: string;
	path: string;
	projectId?: string;
	projectType?: string;
	avatarUrl?: string;
	description?: string;
	version?: string;
	distribution?: 'source' | 'release' | 'download';
	windowId?: number;
	dirty?: boolean;
	lastOpened?: number;
	missing?: boolean;
	entries?: readonly StudioProjectEntry[];
}

export function glyph(p: StudioProjectDetails): string {
	return studioProjectIcon(p.projectType) ?? (p.kind === 'workspace' ? 'project' : p.distribution ? 'package' : 'folder');
}

export function projectMark(p: StudioProjectDetails): HTMLElement {
	const source = p.avatarUrl?.startsWith('data:image/') ? p.avatarUrl : studioProjectCardIcon(p.projectType);
	return source ? picture(source) : icon(glyph(p));
}

export function projectTypeMark(type: string | undefined, fallback: HTMLElement): HTMLElement {
	const source = studioProjectCardIcon(type);
	return source ? picture(source) : fallback;
}

export function typeLabel(type: string | undefined, t: StudioLabel): string {
	switch (type) {
		case 'bot': return 'Bot'; case 'kanban': return t('Kanban', '看板'); case 'workflow': return t('Workflow', '工作流'); case 'aggregate': return t('Multi-entry', '多入口'); default: return t('Folder', '文件夹');
	}
}

export function edition(p: StudioProjectDetails, t: StudioLabel): string {
	switch (p.distribution) {
		case 'download': return t('Downloaded source · Steam', '已下载源码 · Steam'); case 'release': return t('Release · Steam', '发行版 · Steam'); case 'source': return t('Source · IDE', '源码 · IDE');
		default: return p.kind === 'workspace' ? t('Workspace', '工作区') : p.projectType ? t('Project', '项目') : t('Folder', '文件夹');
	}
}

interface ProjectDetailsOptions {
	actions: readonly HTMLElement[];
	openEntry?(entryId: string): void;
	currentWindow?: boolean;
	extraFacts?: [label: string, value: string | undefined][];
	usage?: HTMLElement;
}

/** The resident library and IDE use the same layout; each supplies its own window actions. */
export function projectDetails(p: StudioProjectDetails, t: StudioLabel, options: ProjectDetailsOptions): HTMLElement {
	const page = element('article', 'lp-project-details');
	const head = element('header', 'lp-detail-head'), mark = element('span', 'lp-detail-mark');
	mark.append(projectMark(p));
	const identity = element('div', 'lp-detail-identity'), title = element('h1', '', p.name);
	title.tabIndex = -1; title.dataset.key = 'detail:' + p.uri;
	identity.append(element('span', 'lp-section-kicker', t('Project details', '项目详情')), title);
	const controls = element('div', 'lp-detail-actions');
	controls.append(...options.actions);
	head.append(mark, identity, controls); page.append(head);

	if (p.description?.trim()) { page.append(element('p', 'lp-detail-description', p.description)); }
	const facts = element('dl', 'lp-detail-facts');
	const fact = (label: string, value?: string, className = '') => {
		if (value) { const row = element('div'); row.append(element('dt', '', label), element('dd', className, value)); facts.append(row); }
	};
	fact(t('Format', '项目形式'), edition(p, t));
	if (p.projectType) { fact(t('Project type', '项目类型'), typeLabel((p.entries?.length ?? 0) > 1 ? 'aggregate' : p.projectType, t), 'lp-detail-type'); }
	fact(t('Version', '版本'), p.version);
	for (const [label, value] of options.extraFacts ?? []) { fact(label, value); }
	fact(t('Window', '窗口状态'), p.missing ? t('Not found', '路径失效') : p.windowId === undefined && !options.currentWindow ? t('Closed', '未打开') : p.dirty ? t('Unsaved', '未保存') : t('Open', '已打开'));
	if (p.lastOpened !== undefined) { fact(t('Last opened', '最近打开时间'), new Date(p.lastOpened).toLocaleString(t('en', 'zh-CN'))); }
	fact(t('Location', '位置'), p.path, 'lp-detail-location');
	fact(t('Project ID', '项目 ID'), p.projectId);
	page.append(facts);
	if (options.usage) { page.append(options.usage); }
	if (p.entries?.length) {
		page.append(projectEntryList(p.entries, t, options.openEntry, p.uri));
	}
	return page;
}

type ListedEntry = Omit<StudioProjectEntry, 'entryId'> & { entryId?: string };

export function projectEntryList(entries: readonly ListedEntry[], t: StudioLabel, openEntry?: (entryId: string) => void, uri?: string): HTMLElement {
	const section = element('section', 'lp-detail-entries'), list = element('ul');
	for (const entry of entries) {
		const { entryId } = entry;
		const row = element('li'), identity = element('span', 'lp-entry-identity');
		if (entryId) { row.dataset.entryId = entryId; }
		const mark = entry.avatarUrl?.startsWith('data:image/') ? picture(entry.avatarUrl) : projectTypeMark(entry.type, icon('extensions'));
		identity.append(element('strong', 'lp-entry-name', entry.name));
		if (entry.primary) { identity.append(element('small', 'lp-entry-default', t('Default', '默认入口'))); }
		row.append(mark, identity, element('small', 'lp-entry-type', typeLabel(entry.type, t)));
		if (entryId && openEntry) {
			if (entry.available === false) {
				row.append(element('small', 'lp-entry-unavailable', t('Unavailable', '不可用')));
			} else {
				const label = t('Open entry', '打开入口');
				const open = button(label, 'play', () => openEntry(entryId), 'lp-outline studio-project-action');
				open.setAttribute('aria-label', `${label}: ${entry.name}`);
				open.dataset.key = `entry:${uri}:${entryId}`;
				row.append(open);
			}
		}
		list.append(row);
	}
	section.append(element('h2', '', t('Project entries', '项目入口')), list);
	return section;
}
