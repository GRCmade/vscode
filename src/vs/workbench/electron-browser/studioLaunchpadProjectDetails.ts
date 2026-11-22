/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { studioProjectIcon } from '../common/studioProjectIcons.js';
import { edition, LaunchpadProject, openProjectLabel, projectMark, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

export function projectDetails(p: LaunchpadProject, t: LaunchpadLabel, open: () => void, manage: (origin: HTMLElement) => void): HTMLElement {
	const page = element('article', 'lp-project-details');
	const head = element('header', 'lp-detail-head'), mark = element('span', 'lp-detail-mark');
	mark.append(projectMark(p));
	const identity = element('div', 'lp-detail-identity'), title = element('h1', '', p.name);
	title.tabIndex = -1; title.dataset.key = 'detail:' + p.uri;
	identity.append(element('span', 'lp-section-kicker', t('Project details', '项目详情')), title);
	const controls = element('div', 'lp-detail-actions');
	const launch = button(openProjectLabel(p, t), 'open-in-window', open, 'lp-primary'); launch.dataset.key = 'open:' + p.uri;
	const more = button('', 'ellipsis', () => manage(more), 'lp-outline lp-tool'); more.dataset.key = 'more:' + p.uri;
	more.title = t('Project actions', '项目操作'); more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'menu');
	controls.append(launch, more); head.append(mark, identity, controls); page.append(head);

	const facts = element('dl', 'lp-detail-facts');
	const fact = (label: string, value?: string) => {
		if (value) { const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); facts.append(row); }
	};
	fact(t('Format', '项目形式'), edition(p, t));
	if (p.projectType) { fact(t('Project type', '项目类型'), typeLabel(p.projectType, t)); }
	fact(t('Version', '版本'), p.version);
	fact(t('Window', '窗口状态'), p.missing ? t('Not found', '路径失效') : p.windowId === undefined ? t('Closed', '未打开') : p.dirty ? t('Unsaved', '未保存') : t('Open', '已打开'));
	if (p.lastOpened !== undefined) { fact(t('Last opened', '最近打开时间'), new Date(p.lastOpened).toLocaleString(t('en', 'zh-CN'))); }
	fact(t('Location', '位置'), p.path);
	fact(t('Project ID', '项目 ID'), p.projectId);
	page.append(facts);
	if (p.entries?.length) { page.append(projectEntryList(p.entries, t)); }
	return page;
}

export function projectEntryList(entries: readonly { name: string; type: string; primary: boolean }[], t: LaunchpadLabel): HTMLElement {
	const section = element('section', 'lp-detail-entries'), list = element('ul');
	for (const entry of entries) {
		const row = element('li'); row.append(icon(studioProjectIcon(entry.type) ?? 'extensions'), element('strong', '', entry.name));
		if (entry.primary) { row.append(element('small', 'lp-entry-default', t('Default', '默认入口'))); }
		row.append(element('small', 'lp-entry-type', typeLabel(entry.type, t))); list.append(row);
	}
	section.append(element('h2', '', t('Project entries', '项目入口')), list);
	return section;
}
