/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { artwork, edition, LaunchpadProject, projectMark, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

interface LibraryActions {
	project(p: LaunchpadProject): void;
	manage(p: LaunchpadProject, origin: HTMLElement): void;
	cover(p: LaunchpadProject): Promise<string | undefined>;
}

export class LaunchpadLibrary {
	readonly element = element('div', 'lp-library');
	private readonly index = element('div', 'lp-index lp-scroll');
	private readonly shelf = element('div', 'lp-shelf lp-scroll');
	private readonly search = element('input', 'lp-query');
	private readonly filters = element('div', 'lp-filters');
	private filter = 'all';
	private signature?: string;
	private recent: LaunchpadProject[] = [];
	private windows: LaunchpadProject[] = [];

	constructor(private readonly t: LaunchpadLabel, private readonly actions: LibraryActions) {
		const rail = element('aside', 'lp-rail');
		this.search.type = 'search'; this.search.placeholder = t('Find a project', '查找项目'); this.search.setAttribute('aria-label', this.search.placeholder);
		this.search.addEventListener('input', () => this.render());
		const field = element('label', 'lp-search-field'); field.append(icon('search'), this.search);
		rail.append(element('h2', '', t('Library', '仓库')), field, this.index);
		for (const [id, label] of [['all', t('All', '全部')], ['source', t('Source', '源码')], ['installed', t('Installed', '已安装')], ['folder', t('Folders', '文件夹')]]) {
			const b = button(label, '', () => { this.filter = id; this.render(); }, 'lp-filter-btn'); b.dataset.id = id; this.filters.append(b);
		}
		this.element.append(rail, this.shelf);
	}

	update(recent: LaunchpadProject[], windows: LaunchpadProject[]): void {
		const signature = JSON.stringify([recent, windows]); if (signature === this.signature) { return; }
		this.signature = signature; this.recent = recent; this.windows = windows; this.render();
	}

	private render(): void {
		const t = this.t, query = this.search.value.trim().toLocaleLowerCase();
		const rows = [...this.recent, ...this.windows.filter(p => !this.recent.some(r => r.uri === p.uri))].filter(p => (!query || `${p.name} ${p.path}`.toLocaleLowerCase().includes(query)) &&
			(this.filter === 'all' || (this.filter === 'installed' ? p.distribution === 'release' || p.distribution === 'download' : this.filter === 'source' ? p.distribution === 'source' : !p.projectType)));
		const focus = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
		for (const b of this.filters.querySelectorAll('button')) { b.setAttribute('aria-pressed', String(b.dataset.id === this.filter)); }
		const heading = (title: string, count?: number) => { const h = element('header', 'lp-shelf-head'); h.append(element('h2', '', title)); if (count !== undefined) { h.append(element('small', '', String(count))); } return h; };
		this.index.replaceChildren(...rows.map(p => {
			const b = button('', '', () => this.actions.project(p), 'lp-index-row'); b.append(projectMark(p), element('span', 'lp-ellipsis', p.name)); b.title = p.path; b.dataset.key = 'index:' + p.uri; return b;
		}));
		const toolbar = element('header', 'lp-library-title'); toolbar.append(element('h1', '', t('Project library', '项目仓库')), this.filters);
		this.shelf.replaceChildren(toolbar);
		if (!rows.length) {
			const empty = element('p', 'lp-empty'); empty.append(icon('library'), query || this.filter !== 'all' ? t('No matching projects.', '没有匹配的项目。') : t('No projects in your library yet.', '仓库里还没有项目。')); this.shelf.append(empty); return;
		}
		const gallery = (title: string, group: string, projects: LaunchpadProject[]) => {
			const section = element('section', `lp-collection lp-${group}`), grid = element('div', 'lp-library-grid');
			for (const p of projects) {
				const item = element('article', 'lp-library-item');
				const b = button('', '', () => this.actions.project(p), 'lp-library-card'); b.dataset.key = group + ':' + p.uri; b.title = p.path;
				const art = artwork(p.uri, p.artwork, projectMark(p), p.artwork?.cover && this.actions.cover(p));
				const meta = element('span', 'lp-caption'); meta.append(element('strong', 'lp-ellipsis', p.name));
				const tags = element('span', 'lp-card-tags'); tags.append(element('span', 'lp-edition', edition(p, t)));
				if (p.projectType) { tags.append(element('small', '', typeLabel(p.projectType, t))); }
				if (p.windowId !== undefined || p.missing) { tags.append(element('small', 'lp-state', p.missing ? t('Not found', '路径失效') : p.dirty ? t('Unsaved', '未保存') : t('Open', '已打开'))); }
				meta.append(tags); b.append(art, meta);
				const more = button('', 'ellipsis', () => this.actions.manage(p, more), 'lp-card-more'); more.title = t('Project actions', '项目操作'); more.setAttribute('aria-label', `${more.title}: ${p.name}`);
				b.addEventListener('contextmenu', e => { e.preventDefault(); this.actions.manage(p, b); });
				item.append(b, more); grid.append(item);
			}
			section.append(heading(title, projects.length), grid); this.shelf.append(section);
		};
		if (this.filter === 'all' && !query) { gallery(t('Recently opened', '最近打开'), 'recent', rows.slice(0, 6)); }
		gallery(t('All projects', '所有项目'), 'all', rows);
		if (focus) { Array.from(this.element.querySelectorAll<HTMLButtonElement>('button[data-key]')).find(b => b.dataset.key === focus)?.focus({ preventScroll: true }); }
	}
}
