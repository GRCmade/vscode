/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, Separator, toAction } from '../../base/common/actions.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { projectDetails } from '../browser/studioProjectDetails.js';
import { artwork, edition, LaunchpadProject, openProjectLabel, projectMark, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

export interface LibraryProjectCategory {
	label: string;
	emptyLabel: string;
	projectUris: string[];
}
export interface LibraryDetailAction { id: string; label: string; icon?: string }
type ActivityProject = Pick<LaunchpadProject, 'uri' | 'projectId' | 'distribution' | 'managed'>;
type DetailActionSource = 'local' | 'account';
interface DetailActionState { key: string; items: LibraryDetailAction[]; loading?: boolean }

export interface LibraryActions {
	create(): void;
	importProjects(): void;
	project(p: LaunchpadProject, entryId?: string): void;
	remove(p: LaunchpadProject): void;
	reveal(p: LaunchpadProject): void;
	copyPath(p: LaunchpadProject): void;
	contextMenu: IContextMenuService;
	cover(p: LaunchpadProject): Promise<string | undefined>;
	readActivity?(projects: ActivityProject[]): Promise<string[] | undefined>;
	detailActions?(p: LaunchpadProject, source: DetailActionSource): Promise<LibraryDetailAction[] | undefined>;
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
	private readonly categoryButton: HTMLButtonElement;
	private category?: LibraryProjectCategory;
	private filter = 'all';
	private signature?: string;
	private actionScope = '';
	private readonly detailActionStates = new Map<DetailActionSource, DetailActionState>();
	private readonly runningActions = new Set<string>();
	private updateDetailButtons?: () => void;
	private projects = new Map<string, LaunchpadProject>();
	private history = new Set<string>();
	private selected?: string;
	private pendingSelection?: string;
	private homeScroll = 0;
	private linkedProjects = new Set<string>();
	private activeProjects = new Set<string>();
	private readingActivity = false;

	constructor(private readonly t: LaunchpadLabel, private readonly actions: LibraryActions) {
		const rail = element('aside', 'lp-rail');
		this.search.type = 'search'; this.search.placeholder = t('Find a project', '查找项目'); this.search.setAttribute('aria-label', this.search.placeholder);
		this.search.addEventListener('input', () => { this.pendingSelection = this.selected = undefined; this.shelf.scrollTop = 0; this.render(); });
		const field = element('label', 'lp-search-field'); field.append(icon('search'), this.search);
		rail.append(element('h2', '', t('Library', '仓库')), field, this.index);
		const addFilter = (id: string, label: string) => {
			const b = button(label, '', () => { this.pendingSelection = undefined; this.filter = id; this.render(); }, 'lp-filter-btn');
			b.dataset.id = id; this.filters.append(b);
			return b;
		};
		for (const [id, label] of [['all', t('All', '全部')], ['source', t('Source', '源码')], ['installed', t('Installed', '已安装')], ['folder', t('Folders', '文件夹')]]) {
			addFilter(id, label);
		}
		this.categoryButton = addFilter('product', ''); this.categoryButton.hidden = true;
		const heading = element('div', 'lp-library-heading'), manage = element('div', 'lp-library-actions');
		this.createButton = button(t('New project', '新建项目'), 'add', actions.create, 'lp-primary'); this.createButton.disabled = true;
		manage.append(button(t('Import project', '导入项目'), 'folder-opened', actions.importProjects, 'lp-outline'), this.createButton);
		heading.append(element('h1', '', t('Project library', '项目仓库')), manage);
		this.toolbar.append(heading, this.filters); this.shelf.append(this.toolbar, this.content);
		this.element.append(rail, this.shelf);
	}

	update(recent: LaunchpadProject[], windows: LaunchpadProject[], canCreate: boolean, actionScope: string, category?: LibraryProjectCategory): void {
		this.createButton.disabled = !canCreate;
		const signature = JSON.stringify([recent, windows, actionScope, category]); if (signature === this.signature) { return; }
		this.signature = signature; this.history = new Set(recent.map(p => p.uri));
		this.actionScope = actionScope;
		this.category = category;
		this.linkedProjects = new Set(category?.projectUris);
		this.categoryButton.textContent = category?.label ?? '';
		if (!category && this.filter === 'product') {
			this.filter = 'all';
			if (document.activeElement === this.categoryButton) { this.filters.querySelector<HTMLButtonElement>('[data-id="all"]')?.focus(); }
		}
		this.categoryButton.hidden = !category;
		const previously = this.projects;
		this.projects = new Map(recent.map(p => [p.uri, p]));
		for (const p of windows) { if (!this.projects.has(p.uri)) { this.projects.set(p.uri, p); } }
		for (const uri of this.activeProjects) {
			const current = this.projects.get(uri), prior = previously.get(uri);
			if (!current || current.missing || current.projectId !== prior?.projectId || current.distribution !== prior?.distribution || current.managed !== prior?.managed) {
				this.activeProjects.delete(uri);
			}
		}
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
		if (p.managed || this.history.has(p.uri)) { items.push(new Separator(), action('forget', p.managed ? t('Remove folder Bot…', '移除分身…') : t('Remove from history…', '移除打开记录…'), () => this.actions.remove(p))); }
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

	async refreshActivity(): Promise<void> {
		if (!this.actions.readActivity || this.readingActivity || !this.projects.size) { return; }
		const projects = this.projects;
		const candidates = [...projects.values()].filter(p => !p.missing && (p.projectId || p.managed))
			.map(({ uri, projectId, distribution, managed }) => ({ uri, projectId, distribution, managed }));
		this.readingActivity = true;
		try {
			const active = candidates.length ? await this.actions.readActivity(candidates) : [];
			if (!Array.isArray(active) || this.projects !== projects || !this.element.isConnected) { return; }
			const next = new Set(active.filter(uri => projects.has(uri)));
			if (next.size === this.activeProjects.size && [...next].every(uri => this.activeProjects.has(uri))) { return; }
			this.activeProjects = next;
			this.updateIndexStatuses();
		} catch { /* Retain the previous snapshot if the extension host is temporarily unavailable. */ }
		finally { this.readingActivity = false; }
	}

	private updateIndexStatuses(): void {
		const t = this.t;
		for (const row of this.index.querySelectorAll<HTMLButtonElement>('.lp-index-row[data-key]')) {
			const p = this.projects.get(row.dataset.key!.slice('index:'.length));
			if (!p) { continue; }
			const dots: { state: string; label: string }[] = [];
			if (!p.missing && this.activeProjects.has(p.uri)) { dots.push({ state: 'running', label: t('Task running', '任务正在运行') }); }
			else if (p.windowId !== undefined) { dots.push({ state: 'open', label: t('Open', '已打开') }); }
			if (!p.missing && this.linkedProjects.has(p.uri)) { dots.push({ state: 'linked', label: t('Bot linked to chat', 'Bot 已加入对话') }); }
			let status = row.querySelector('.lp-index-status');
			if (!status) {
				status = element('span', 'lp-index-status');
				status.setAttribute('aria-hidden', 'true');
				row.append(status);
			}
			const description = dots.map(dot => dot.label).join(' · ');
			if (row.getAttribute('aria-description') === (description || null)) { continue; }
			if (description) { row.setAttribute('aria-description', description); }
			else { row.removeAttribute('aria-description'); }
			status.replaceChildren(...dots.map(({ state, label }) => {
				const dot = element('span', `lp-index-dot lp-index-dot-${state}`);
				dot.title = label;
				return dot;
			}));
		}
	}

	private detailActions(project: LaunchpadProject, source: DetailActionSource): DetailActionState | undefined {
		if (source === 'account' && !this.actionScope) { this.detailActionStates.delete(source); return; }
		const key = JSON.stringify([project.uri, project.kind, project.missing, project.managed, project.projectType, project.distribution, source === 'account' ? this.actionScope : '']);
		let state = this.detailActionStates.get(source);
		if (!state || state.key !== key) {
			state = { key, items: [] };
			this.detailActionStates.set(source, state);
		}
		const pending = !state.loading && this.actions.detailActions?.(project, source);
		if (pending) {
			const current = state;
			current.loading = true;
			void pending.then(items => {
				if (items && this.detailActionStates.get(source) === current) {
					current.items = items;
					this.updateDetailButtons?.();
				}
			}).catch(() => undefined).finally(() => { current.loading = false; });
		}
		return state;
	}

	private render(): void {
		const t = this.t, query = this.search.value.trim().toLocaleLowerCase();
		const category = this.filter === 'product' ? this.category : undefined;
		const members = category && new Set(category.projectUris);
		const rows = [...this.projects.values()].filter(p => {
			if (query && !`${p.name} ${p.path}`.toLocaleLowerCase().includes(query)) { return false; }
			switch (this.filter) {
				case 'installed': return p.distribution === 'release' || p.distribution === 'download';
				case 'source': return p.distribution === 'source';
				case 'folder': return p.kind === 'folder' && !p.projectType && !p.distribution;
				case 'product': return !p.missing && members?.has(p.uri) === true;
				default: return true;
			}
		});
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
		this.updateIndexStatuses();
		if (selected) {
			const canRun = !!selected.distribution && !selected.missing;
			const open = button(openProjectLabel(selected, t), 'open-in-window', () => this.actions.project(selected), `studio-project-action ${canRun ? 'lp-outline' : 'lp-primary'}`);
			open.disabled = !!(selected.managed && selected.missing);
			open.dataset.key = 'open:' + selected.uri;
			const more = button('', 'ellipsis', () => this.manage(selected, more), 'studio-project-action lp-outline lp-tool');
			more.dataset.key = 'more:' + selected.uri;
			more.title = t('Project actions', '项目操作'); more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'menu');
			const actions = [open, more];
			if (canRun) {
				const run = button(t('Run project', '运行项目'), 'play', () => this.actions.project(selected), 'studio-project-action lp-primary');
				run.dataset.key = 'run:' + selected.uri;
				actions.unshift(run);
			}
			const detail = projectDetails(selected, t, { actions, openEntry: canRun ? entryId => this.actions.project(selected, entryId) : undefined });
			this.content.replaceChildren(detail); restoreFocus();
			// Local actions resolve independently of IM. Keep confirmed actions while revalidating them.
			const local = this.detailActions(selected, 'local'), account = this.detailActions(selected, 'account');
			let rendered = '';
			this.updateDetailButtons = () => {
				const items = [...(local?.items ?? []), ...(account?.items ?? [])].slice(0, 4);
				const signature = JSON.stringify(items);
				if (rendered === signature) { return; }
				rendered = signature;
				const controls = more.parentElement;
				const focused = document.activeElement instanceof HTMLElement && controls?.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
				controls?.querySelectorAll('[data-detail-action]').forEach(item => item.remove());
				for (const item of items) {
					const key = `action:${selected.uri}:${item.id}`;
					const action = button(item.label, item.icon ?? '', () => {
						if (this.runningActions.has(key)) { return; }
						this.runningActions.add(key);
						action.disabled = true;
						void Promise.resolve(this.actions.runDetailAction?.(selected, item.id)).finally(() => {
							this.runningActions.delete(key);
							if (this.selected === selected.uri) { this.render(); }
						});
					}, 'studio-project-action lp-outline');
					action.disabled = this.runningActions.has(key);
					action.dataset.key = key;
					action.dataset.detailAction = item.id;
					controls?.insertBefore(action, more);
					if (key === focused) { action.focus({ preventScroll: true }); }
				}
				if (focus?.startsWith('action:') && (document.activeElement === document.body || !document.activeElement?.isConnected)) { restoreFocus(); }
			};
			this.updateDetailButtons();
			return;
		}
		this.detailActionStates.clear();
		this.updateDetailButtons = undefined;
		this.content.replaceChildren();
		if (!rows.length) {
			const message = (!query && category?.emptyLabel) || (query || this.filter !== 'all' ? t('No matching projects.', '没有匹配的项目。') : t('No projects in your library yet.', '仓库里还没有项目。'));
			const empty = element('p', 'lp-empty'); empty.append(icon('library'), message); this.content.append(empty); return;
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
		gallery(category?.label ?? t('All projects', '所有项目'), category ? 'product' : 'all', rows);
		restoreFocus();
	}
}
