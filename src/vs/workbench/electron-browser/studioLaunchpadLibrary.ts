/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, toAction } from '../../base/common/actions.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { artwork, edition, LaunchpadProject, openProjectLabel, projectMark, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';
import { projectDetails } from './studioLaunchpadProjectDetails.js';

export interface LibraryActions {
	create(): void;
	importProjects(): void;
	project(p: LaunchpadProject): void;
	remove(p: LaunchpadProject): void;
	reveal(p: LaunchpadProject): void;
	copyPath(p: LaunchpadProject): void;
	contextMenu: IContextMenuService;
	cover(p: LaunchpadProject): Promise<string | undefined>;
	detailActions?(p: LaunchpadProject): Promise<{ id: string; label: string }[]>;
	runDetailAction?(p: LaunchpadProject, id: string): Promise<void>;
}

export class LaunchpadLibrary {
	readonly element = element('div', 'lp-library');
	private readonly index = element('div', 'lp-index lp-scroll');
	private readonly shelf = element('div', 'lp-shelf lp-scroll');
	private readonly toolbar = element('header', 'lp-library-title');
	private readonly content = element('div');
	private readonly createButton: HTMLButtonElement;
	private readonly search = element('input', 'lp-query');
	private readonly filters = element('div', 'lp-filters');
	private filter = 'all';
	private signature?: string;
	private projects = new Map<string, LaunchpadProject>();
	private history = new Set<string>();
	private selected?: string;
	private pendingSelection?: string;
	private homeScroll = 0;

	constructor(private readonly t: LaunchpadLabel, private readonly actions: LibraryActions) {
		const rail = element('aside', 'lp-rail');
		this.search.type = 'search'; this.search.placeholder = t('Find a project', '查找项目'); this.search.setAttribute('aria-label', this.search.placeholder);
		this.search.addEventListener('input', () => { this.pendingSelection = this.selected = undefined; this.shelf.scrollTop = 0; this.render(); });
		const field = element('label', 'lp-search-field'); field.append(icon('search'), this.search);
		rail.append(element('h2', '', t('Library', '仓库')), field, this.index);
		for (const [id, label] of [['all', t('All', '全部')], ['source', t('Source', '源码')], ['installed', t('Installed', '已安装')], ['folder', t('Folders', '文件夹')]]) {
			const b = button(label, '', () => { this.pendingSelection = undefined; this.filter = id; this.render(); }, 'lp-filter-btn'); b.dataset.id = id; this.filters.append(b);
		}
		const heading = element('div', 'lp-library-heading'), manage = element('div', 'lp-library-actions');
		this.createButton = button(t('New project', '新建项目'), 'add', actions.create, 'lp-primary'); this.createButton.disabled = true;
		manage.append(button(t('Import project', '导入项目'), 'folder-opened', actions.importProjects, 'lp-outline'), this.createButton);
		heading.append(element('h1', '', t('Project library', '项目仓库')), manage);
		this.toolbar.append(heading, this.filters); this.shelf.append(this.toolbar, this.content);
		this.element.append(rail, this.shelf);
	}

	update(recent: LaunchpadProject[], windows: LaunchpadProject[], canCreate: boolean, actionScope: string): void {
		this.createButton.disabled = !canCreate;
		const signature = JSON.stringify([recent, windows, actionScope]); if (signature === this.signature) { return; }
		this.signature = signature; this.history = new Set(recent.map(p => p.uri));
		this.projects = new Map(recent.map(p => [p.uri, p]));
		for (const p of windows) { if (!this.projects.has(p.uri)) { this.projects.set(p.uri, p); } }
		if (this.pendingSelection && this.projects.has(this.pendingSelection)) { this.show(this.pendingSelection); }
		else if (this.selected && !this.projects.has(this.selected)) { this.show(); } else { this.render(); }
	}

	resetFilters(): void {
		this.homeScroll = this.shelf.scrollTop = 0;
		if (this.search.value || this.filter !== 'all') { this.search.value = ''; this.filter = 'all'; this.render(); }
	}

	show(uri?: string): void {
		// Imported folders arrive with the debounced native history snapshot, not the picker result.
		this.pendingSelection = uri && !this.projects.has(uri) ? uri : undefined;
		if (this.pendingSelection || uri === this.selected) { return; }
		if (!this.selected) { this.homeScroll = this.shelf.scrollTop; }
		this.selected = uri; this.render();
		this.shelf.scrollTop = uri ? 0 : this.homeScroll;
		if (uri) { this.content.querySelector('h1')?.focus({ preventScroll: true }); }
	}

	private manage(p: LaunchpadProject, origin: HTMLElement, point?: { x: number; y: number }): void {
		const t = this.t;
		const action = (id: string, label: string, run: () => void) => toAction({ id: `studio.library.${id}`, label, run });
		const items: IAction[] = [action('details', t('View details', '查看详情'), () => this.show(p.uri)),
			action('open', openProjectLabel(p, t), () => this.actions.project(p))];
		items.push(new Separator());
		if (p.uri.startsWith('file:') && !p.missing) { items.push(action('reveal', t('Show in file manager', '在文件管理器中显示'), () => this.actions.reveal(p))); }
		items.push(action('copyPath', t('Copy path', '复制路径'), () => this.actions.copyPath(p)));
		if (this.history.has(p.uri)) { items.push(new Separator(), action('forget', t('Remove from history…', '移除打开记录…'), () => this.actions.remove(p))); }
		this.actions.contextMenu.showContextMenu({ getAnchor: () => point ?? origin, getActions: () => items, autoSelectFirstItem: !point });
	}

	private bindMenu(row: HTMLButtonElement, p: LaunchpadProject): void {
		row.addEventListener('contextmenu', e => {
			e.preventDefault(); e.stopPropagation(); row.focus({ preventScroll: true });
			this.manage(p, row, e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined);
		});
		row.addEventListener('keydown', e => {
			if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); e.stopPropagation(); this.manage(p, row); }
		});
	}

	private render(): void {
		const t = this.t, query = this.search.value.trim().toLocaleLowerCase();
		const rows = [...this.projects.values()].filter(p => (!query || `${p.name} ${p.path}`.toLocaleLowerCase().includes(query)) &&
			(this.filter === 'all' || (this.filter === 'installed' ? p.distribution === 'release' || p.distribution === 'download' : this.filter === 'source' ? p.distribution === 'source' : p.kind === 'folder' && !p.projectType && !p.distribution)));
		const focus = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
		for (const b of this.filters.querySelectorAll('button')) { b.setAttribute('aria-pressed', String(b.dataset.id === this.filter)); }
		const heading = (title: string, count?: number) => { const h = element('header', 'lp-shelf-head'); h.append(element('h2', '', title)); if (count !== undefined) { h.append(element('small', '', String(count))); } return h; };
		this.index.replaceChildren(...rows.map(p => {
			const b = button('', '', () => this.show(p.uri), 'lp-index-row'); b.append(projectMark(p), element('span', 'lp-ellipsis', p.name)); b.title = p.path; b.dataset.key = 'index:' + p.uri;
			if (p.uri === this.selected) { b.setAttribute('aria-current', 'page'); }
			this.bindMenu(b, p); return b;
		}));
		const selected = this.selected && this.projects.get(this.selected);
		this.toolbar.hidden = !!selected;
		const restoreFocus = () => { if (focus) { Array.from(this.element.querySelectorAll<HTMLElement>('[data-key]')).find(b => b.dataset.key === focus)?.focus({ preventScroll: true }); } };
		if (selected) {
			const detail = projectDetails(selected, t, () => this.actions.project(selected), origin => this.manage(selected, origin));
			this.content.replaceChildren(detail); restoreFocus();
			void this.actions.detailActions?.(selected).then(items => {
				if (detail.parentElement !== this.content) { return; }
				const controls = detail.querySelector('.lp-detail-actions');
				for (const item of items.slice(0, 4)) {
					const action = button(item.label, '', () => {
						action.disabled = true;
						void this.actions.runDetailAction?.(selected, item.id).finally(() => { if (detail.parentElement === this.content) { this.render(); } });
					}, 'lp-outline');
					controls?.insertBefore(action, controls.lastElementChild);
				}
			}).catch(() => undefined); return;
		}
		this.content.replaceChildren();
		if (!rows.length) {
			const empty = element('p', 'lp-empty'); empty.append(icon('library'), query || this.filter !== 'all' ? t('No matching projects.', '没有匹配的项目。') : t('No projects in your library yet.', '仓库里还没有项目。')); this.content.append(empty); return;
		}
		const gallery = (title: string, group: string, projects: LaunchpadProject[]) => {
			const section = element('section', `lp-collection lp-${group}`), grid = element('div', 'lp-library-grid');
			for (const p of projects) {
				const item = element('article', 'lp-library-item');
				const b = button('', '', () => this.show(p.uri), 'lp-library-card'); b.dataset.key = group + ':' + p.uri; b.title = p.path;
				const art = artwork(p.uri, p.artwork, projectMark(p), p.artwork?.cover && this.actions.cover(p));
				const meta = element('span', 'lp-caption'); meta.append(element('strong', 'lp-ellipsis', p.name));
				const tags = element('span', 'lp-card-tags'); tags.append(element('span', 'lp-edition', edition(p, t)));
				if (p.projectType) { tags.append(element('small', '', typeLabel(p.projectType, t))); }
				if (p.windowId !== undefined || p.missing) { tags.append(element('small', 'lp-state', p.missing ? t('Not found', '路径失效') : p.dirty ? t('Unsaved', '未保存') : t('Open', '已打开'))); }
				meta.append(tags); b.append(art, meta);
				const more = button('', 'ellipsis', () => this.manage(p, more), 'lp-card-more'); more.title = t('Project actions', '项目操作'); more.setAttribute('aria-label', `${more.title}: ${p.name}`); more.setAttribute('aria-haspopup', 'menu');
				this.bindMenu(b, p);
				item.append(b, more); grid.append(item);
			}
			section.append(heading(title, projects.length), grid); this.content.append(section);
		};
		if (this.filter === 'all' && !query) { gallery(t('Recently opened', '最近打开'), 'recent', rows.slice(0, 6)); }
		gallery(t('All projects', '所有项目'), 'all', rows);
		restoreFocus();
	}
}
