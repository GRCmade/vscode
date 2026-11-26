/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDelayedHoverOptions } from '../../base/browser/ui/hover/hover.js';
import { HoverPosition } from '../../base/browser/ui/hover/hoverWidget.js';
import { IAction, Separator, toAction } from '../../base/common/actions.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import type { IHoverService } from '../../platform/hover/browser/hover.js';
import { studioBotIcon } from '../common/studioProjectIcons.js';
import { projectDetails } from './studioProjectDetails.js';
import { projectBotAction, projectBotManagementLabel, projectDetailActionGroup } from './studioProjectDetailsView.js';
import { projectUsageKey, StudioProjectUsage, type ProjectUsageBridge } from './studioProjectUsage.js';
import { artwork, edition, LaunchpadProject, openProjectLabel, projectMark, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

export interface LibraryProjectCategory {
	label: string;
	emptyLabel: string;
	projectUris: string[];
}
export interface LibraryDetailAction { id: string; label: string; icon?: string }
export type LibraryBotCredentialList = { status: 'ok'; rows: { name: string; type: string }[] } | { status: 'untrusted' | 'unavailable' };
type ActivityProject = Pick<LaunchpadProject, 'uri' | 'projectId' | 'distribution' | 'managed'>;
type DetailActionSource = 'local' | 'account';
interface DetailActionState { key: string; items: LibraryDetailAction[]; loading?: boolean }

export interface LibraryActions {
	create(): void;
	importProjects(): void;
	project(p: LaunchpadProject, entryId?: string): void;
	runProject?(p: LaunchpadProject, entryId?: string): void;
	openBotArtifacts?(p: LaunchpadProject, entryId?: string): void;
	openBotMemory?(p: LaunchpadProject, entryId?: string): void;
	readBotCredentials?(p: LaunchpadProject, entryId?: string): Promise<LibraryBotCredentialList | undefined>;
	remove(p: LaunchpadProject): void;
	reveal?(p: LaunchpadProject): void;
	copyPath(p: LaunchpadProject): void;
	openProjectSchedules?(p: LaunchpadProject, entryId?: string): void;
	contextMenu: IContextMenuService;
	hoverService: IHoverService;
	usage?: ProjectUsageBridge;
	openLabel?(p: LaunchpadProject): string;
	cover(p: LaunchpadProject): Promise<string | undefined>;
	readActivity?(projects: ActivityProject[]): Promise<string[] | undefined>;
	detailActions?(p: LaunchpadProject, source: DetailActionSource): Promise<LibraryDetailAction[] | undefined>;
	runDetailAction?(p: LaunchpadProject, id: string): Promise<void>;
}

export class LaunchpadLibrary extends Disposable {
	readonly element = element('div', 'lp-library');
	private readonly index = element('div', 'lp-index lp-scroll');
	private readonly shelf = element('div', 'lp-shelf lp-scroll');
	private readonly toolbar = element('header', 'lp-library-title');
	private readonly content = element('div');
	private readonly loading = element('div', 'lp-library-loading lp-collection');
	private readonly createButton: HTMLButtonElement;
	private readonly importButton: HTMLButtonElement;
	private readonly search = element('input', 'lp-query');
	private readonly filters = element('div', 'lp-filters');
	private readonly categoryButton: HTMLButtonElement;
	private readonly collapsed = new Set<string>();
	private readonly searchCollapsed = new Set<string>();
	private category?: LibraryProjectCategory;
	private filter = 'all';
	private signature?: string;
	private actionScope = '';
	private readonly detailActionStates = new Map<DetailActionSource, DetailActionState>();
	private readonly runningActions = new Set<string>();
	private updateDetailActions?: () => void;
	private projects = new Map<string, LaunchpadProject>();
	private history = new Set<string>();
	private selected?: string;
	private pendingSelection?: string;
	private homeScroll = 0;
	private linkedProjects = new Set<string>();
	private activeProjects = new Set<string>();
	private readingActivity = false;
	private visible = false;
	private usage?: { key: string; view: StudioProjectUsage };
	private credentialList?: { projectKey: string; entryId?: string; panel: HTMLElement };

	constructor(private readonly t: LaunchpadLabel, private readonly actions: LibraryActions) {
		super();
		const rail = element('aside', 'lp-rail');
		this.search.type = 'search'; this.search.placeholder = t('Find a project', '查找项目'); this.search.setAttribute('aria-label', this.search.placeholder);
		this.search.addEventListener('input', () => { this.searchCollapsed.clear(); this.pendingSelection = this.selected = undefined; this.shelf.scrollTop = 0; this.render(); });
		const field = element('label', 'lp-search-field'); field.append(icon('search'), this.search);
		const railHeading = element('div', 'lp-rail-heading');
		const hover: IDelayedHoverOptions = {
			id: 'studio.library.statusGuide', content: this.statusGuide(),
			position: { hoverPosition: HoverPosition.RIGHT }, appearance: { showPointer: true },
			persistence: { hideOnHover: false },
		};
		const help = button('', 'question', () => { actions.hoverService.showInstantHover({ ...hover, target: help, trapFocus: true }, true); }, 'lp-rail-help');
		help.setAttribute('aria-label', t('Project status guide', '项目状态说明'));
		this._register(actions.hoverService.setupDelayedHover(help, hover));
		railHeading.append(element('h2', '', t('Library', '仓库')), help);
		rail.append(railHeading, field, this.index);
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
		this.importButton = button(t('Import project', '导入项目'), 'folder-opened', actions.importProjects, 'lp-outline');
		manage.append(this.importButton, this.createButton);
		heading.append(element('h1', '', t('Project library', '项目仓库')), manage);
		const status = element('p', 'lp-library-loading-status', t('Loading projects…', '正在加载项目…'));
		status.setAttribute('role', 'status');
		const skeleton = element('div', 'lp-library-skeleton'), caption = element('div', 'lp-caption');
		skeleton.setAttribute('aria-hidden', 'true');
		caption.append(element('span', 'lp-library-skeleton-title'), element('span', 'lp-library-skeleton-meta'));
		skeleton.append(element('div', 'lp-library-skeleton-cover'), caption);
		this.loading.append(status, skeleton); this.loading.hidden = true;
		this.toolbar.append(heading, this.filters); this.shelf.append(this.toolbar, this.loading, this.content);
		this.element.append(rail, this.shelf);
	}

	update(recent: LaunchpadProject[], windows: LaunchpadProject[], canCreate: boolean, actionScope: string, category?: LibraryProjectCategory, builtinProjects: LaunchpadProject[] = [], loading = false): void {
		this.createButton.disabled = loading || !canCreate;
		this.importButton.disabled = loading;
		const wasLoading = !this.loading.hidden;
		if (wasLoading !== loading) {
			this.loading.hidden = !loading;
			if (loading) {
				this.projectUsage();
				this.activeProjects.clear();
				this.projects = new Map();
				this.index.replaceChildren();
				this.content.replaceChildren();
				this.content.setAttribute('aria-busy', 'true');
				this.render();
			} else { this.content.removeAttribute('aria-busy'); }
		}
		if (loading) { this.signature = ''; return; }
		const signature = JSON.stringify([recent, windows, actionScope, category, builtinProjects]); if (signature === this.signature) { return; }
		this.signature = signature; this.history = new Set(recent.map(p => p.uri));
		if (actionScope !== this.actionScope) { this.activeProjects.clear(); }
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
		for (const p of builtinProjects) { this.projects.set(p.uri, p); }
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
		this.searchCollapsed.clear();
		if (this.search.value || this.filter !== 'all') { this.search.value = ''; this.filter = 'all'; this.render(); }
	}

	show(uri?: string): void {
		// Imported folders arrive with the debounced native history snapshot, not the picker result.
		this.pendingSelection = uri && !this.projects.has(uri) ? uri : undefined;
		if (this.pendingSelection || uri === this.selected) { return; }
		if (!this.selected) { this.homeScroll = this.shelf.scrollTop; }
		const project = uri ? this.projects.get(uri) : undefined;
		const parent = project && this.parentProject(project);
		if (parent) { (this.search.value.trim() ? this.searchCollapsed : this.collapsed).delete(parent.uri); }
		this.selected = uri; this.render();
		this.shelf.scrollTop = uri ? 0 : this.homeScroll;
		if (uri) { this.content.querySelector('h1')?.focus({ preventScroll: true }); }
	}

	private manage(p: LaunchpadProject, origin: HTMLElement, point?: { x: number; y: number }): void {
		const t = this.t;
		const action = (id: string, label: string, run: () => void) => toAction({ id: `studio.library.${id}`, label, run });
		const items: IAction[] = [action('details', t('View details', '查看详情'), () => this.show(p.uri)),
			action('open', this.actions.openLabel?.(p) ?? openProjectLabel(p, t), () => this.actions.project(p))];
		items.push(new Separator());
		if (this.actions.reveal && p.uri.startsWith('file:') && !p.missing) { items.push(action('reveal', t('Show in file manager', '在文件管理器中显示'), () => this.actions.reveal?.(p))); }
		items.push(action('copyPath', t('Copy path', '复制路径'), () => this.actions.copyPath(p)));
		if (!p.builtin && (p.managed || this.history.has(p.uri))) { items.push(new Separator(), action('forget', p.managed ? t('Remove folder Bot…', '移除分身…') : t('Remove from history…', '移除打开记录…'), () => this.actions.remove(p))); }
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

	private statusGuide(): HTMLElement {
		const t = this.t;
		const list = element('ul', 'lp-status-guide');
		const item = (state: 'open' | 'running' | 'linked', label: string, detail?: string) => {
			const row = element('li'), dot = element('span', `lp-index-dot lp-index-dot-${state}`);
			dot.setAttribute('aria-hidden', 'true');
			const text = element('div'); text.append(element('strong', '', label));
			if (detail) { text.append(element('p', '', detail)); }
			row.append(dot, text); list.append(row);
		};
		item('open', t('Blue: project is open', '蓝点：项目已打开'));
		item('running', t('Green: a task is running', '绿点：任务正在运行'), t('Replaces the blue dot while a task runs.', '运行时替代蓝点。'));
		item('linked', t('Orange: Bot linked to chat', '橙点：已加入对话的 Bot'), t(
			'In Studio Enhanced, this Bot has been added to your IM contacts. The dot does not indicate online status. The Bot runs locally and goes offline when Studio is closed.',
			'这个 Bot 已添加到增强版的 IM 通讯录，可以在 IM 中直接发消息。橙点不代表在线；Bot 在本机运行，关闭 Studio 后会离线。',
		));
		return list;
	}

	async refreshActivity(): Promise<void> {
		if (!this.actions.readActivity || this.readingActivity || !this.projects.size) { return; }
		const projects = this.projects;
		const scope = this.actionScope;
		const candidates = [...projects.values()].filter(p => !p.missing && (p.projectId || p.managed))
			.map(({ uri, projectId, distribution, managed }) => ({ uri, projectId, distribution, managed }));
		this.readingActivity = true;
		try {
			const active = candidates.length ? await this.actions.readActivity(candidates) : [];
			if (!Array.isArray(active) || this.projects !== projects || scope !== this.actionScope || !this.loading.hidden || !this.element.isConnected) { return; }
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
		if (project.builtin) { this.detailActionStates.delete(source); return; }
		if (source === 'account' && !this.actionScope) { this.detailActionStates.delete(source); return; }
		const target = [project.uri, project.missing, project.managed];
		const key = JSON.stringify(source === 'local' ? target : [...target, project.kind, project.projectType, project.distribution, this.actionScope]);
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
					this.updateDetailActions?.();
				}
			}).catch(() => undefined).finally(() => { current.loading = false; });
		}
		return state;
	}

	private detailActionGroup(project: LaunchpadProject, label: string, defaultIcon: string, alwaysVisible = false) {
		const { group, controls } = projectDetailActionGroup(document, label);
		let rendered: string | undefined;
		return {
			element: group,
			update: (items: readonly LibraryDetailAction[] = []) => {
				const signature = JSON.stringify(items);
				if (rendered === signature) { return; }
				rendered = signature;
				const active = controls.ownerDocument.activeElement;
				const focused = active instanceof HTMLElement && controls.contains(active) ? active.dataset.key : undefined;
				const buttons = items.map(item => {
					const key = `action:${project.uri}:${item.id}`;
					const action = button(item.label, item.id === 'create-folder-bot' ? studioBotIcon : item.icon ?? defaultIcon, () => {
						if (this.runningActions.has(key)) { return; }
						this.runningActions.add(key);
						action.disabled = true;
						void Promise.resolve(this.actions.runDetailAction?.(project, item.id)).finally(() => {
							this.runningActions.delete(key);
							if (this.selected === project.uri) { this.render(); }
						});
					}, 'studio-project-action lp-outline');
					action.disabled = this.runningActions.has(key);
					action.dataset.key = key;
					action.dataset.detailAction = item.id;
					return action;
				});
				group.hidden = !alwaysVisible && !buttons.length;
				controls.replaceChildren(...buttons);
				if (focused) { buttons.find(action => action.dataset.key === focused)?.focus({ preventScroll: true }); }
			},
		};
	}

	private parentProject(project: LaunchpadProject): LaunchpadProject | undefined {
		const parent = project.parentUri ? this.projects.get(project.parentUri) : undefined;
		return parent && !parent.parentUri ? parent : undefined;
	}

	private renderIndex(rows: LaunchpadProject[], builtins: LaunchpadProject[], collapsed: Set<string>): void {
		const roots = new Set(rows.map(p => p.uri));
		const branches = new Map<string, LaunchpadProject[]>();
		for (const p of rows) {
			const parent = this.parentProject(p);
			if (!parent) { continue; }
			roots.delete(p.uri);
			roots.add(parent.uri);
			let children = branches.get(parent.uri);
			if (!children) { branches.set(parent.uri, children = []); }
			children.push(p);
		}
		const row = (p: LaunchpadProject) => {
			const b = button('', '', () => this.show(p.uri), 'lp-index-row'); b.append(projectMark(p), element('span', 'lp-ellipsis', p.name)); b.title = p.path; b.dataset.key = 'index:' + p.uri;
			if (p.uri === this.selected) { b.setAttribute('aria-current', 'page'); }
			this.bindMenu(b, p); return b;
		};
		const items: HTMLElement[] = [];
		if (builtins.length) {
			const section = element('section', 'lp-index-builtin');
			const label = element('h3', 'lp-index-builtin-title', this.t('Built-in projects', '内置项目'));
			label.id = 'lp-index-builtin-title';
			section.setAttribute('aria-labelledby', label.id);
			section.append(label, ...builtins.map(row));
			items.push(section);
		}
		for (const p of this.projects.values()) {
			if (!roots.has(p.uri)) { continue; }
			const children = branches.get(p.uri);
			if (!children) { items.push(row(p)); continue; }
			const branch = element('div', 'lp-index-branch'), line = element('div', 'lp-index-line');
			const group = element('div', 'lp-index-children'); group.id = 'lp-index-children-' + items.length;
			const project = row(p); project.id = group.id + '-parent';
			group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', project.id);
			group.append(...children.map(row));
			const toggle = button('', '', () => {
				if (!collapsed.delete(p.uri)) { collapsed.add(p.uri); }
				update();
			}, 'lp-index-toggle');
			const update = () => {
				group.hidden = collapsed.has(p.uri);
				toggle.title = `${group.hidden ? this.t('Expand Bot instances', '展开 Bot 分身') : this.t('Collapse Bot instances', '折叠 Bot 分身')}: ${p.name}`;
				toggle.setAttribute('aria-label', toggle.title);
				toggle.setAttribute('aria-expanded', String(!group.hidden));
				toggle.replaceChildren(icon(group.hidden ? 'chevron-right' : 'chevron-down'));
			};
			toggle.dataset.key = 'branch:' + p.uri;
			toggle.setAttribute('aria-controls', group.id);
			update(); line.append(project, toggle); branch.append(line, group); items.push(branch);
		}
		this.index.replaceChildren(...items);
	}

	private render(): void {
		for (const b of this.filters.querySelectorAll('button')) { b.setAttribute('aria-pressed', String(b.dataset.id === this.filter)); }
		if (!this.loading.hidden) { return; }
		const t = this.t, query = this.search.value.trim().toLocaleLowerCase();
		const category = this.filter === 'product' ? this.category : undefined;
		const members = category && new Set(category.projectUris);
		const inFilter = (p: LaunchpadProject) => {
			switch (this.filter) {
				case 'installed': return p.distribution === 'release' || p.distribution === 'download';
				case 'source': return p.distribution === 'source';
				case 'folder': return p.kind === 'folder' && !p.projectType && !p.distribution;
				case 'product': return !p.missing && members?.has(p.uri) === true;
				default: return true;
			}
		};
		const matching = (p: LaunchpadProject) => !query || `${p.name} ${p.path}`.toLocaleLowerCase().includes(query);
		const builtins = [...this.projects.values()].filter(p => p.builtin && matching(p));
		const matches = [...this.projects.values()].filter(p => !p.builtin && matching(p));
		const rows = matches.filter(inFilter);
		// In the index, instances inherit their parent's folder/source/installed category, but not its IM binding.
		const indexRows = this.filter === 'all' || category ? rows : matches.filter(p => {
			const parent = this.parentProject(p);
			return inFilter(p) || !!(parent && inFilter(parent));
		});
		const focus = document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
		const heading = (title: string, count?: number) => { const h = element('header', 'lp-shelf-head'); h.append(element('h2', '', title)); if (count !== undefined) { h.append(element('small', '', String(count))); } return h; };
		this.renderIndex(indexRows, builtins, query ? this.searchCollapsed : this.collapsed);
		const selected = this.selected && this.projects.get(this.selected);
		if (this.credentialList && (!selected || selected.missing || this.credentialList.projectKey !== this.credentialProjectKey(selected))) { this.credentialList = undefined; }
		this.toolbar.hidden = !!selected;
		const restoreFocus = () => { if (focus) { Array.from(this.element.querySelectorAll<HTMLElement>('[data-key]')).find(b => b.dataset.key === focus)?.focus({ preventScroll: true }); } };
		this.updateIndexStatuses();
		if (selected) {
			const canRun = !!selected.distribution && !selected.missing;
			const runProject = (entryId?: string) => {
				if (this.actions.runProject) { this.actions.runProject(selected, entryId); }
				else { this.actions.project(selected, entryId); }
			};
			const open = button(this.actions.openLabel?.(selected) ?? openProjectLabel(selected, t), 'open-in-window', () => this.actions.project(selected), `studio-project-action ${canRun && !selected.builtin ? 'lp-outline' : 'lp-primary'}`);
			open.disabled = !!(selected.managed && selected.missing);
			open.dataset.key = 'open:' + selected.uri;
			const more = button('', 'ellipsis', () => this.manage(selected, more), 'studio-project-action lp-outline lp-tool');
			more.dataset.key = 'more:' + selected.uri;
			more.title = t('Project actions', '项目操作'); more.setAttribute('aria-label', more.title); more.setAttribute('aria-haspopup', 'menu');
			const actions = [open, more];
			if (canRun && !selected.builtin) {
				const run = button(t('Run project', '运行项目'), 'play', () => runProject(), 'studio-project-action lp-primary');
				run.dataset.key = 'run:' + selected.uri;
				actions.unshift(run);
			}
			const secondaryActions = element('div', 'lp-detail-secondary');
			const bot = this.detailActionGroup(selected, t('Bot instances', 'Bot 分身'), studioBotIcon);
			const im = this.detailActionGroup(selected, t('IM integration', 'IM 集成'), 'comment-discussion');
			secondaryActions.append(bot.element, im.element);
			const entryBots = (selected.entries ?? []).filter(entry => entry.type === 'bot');
			const botEntries = entryBots.length ? entryBots : selected.projectType === 'bot' ? [undefined] : [];
			const canManageBot = (this.actions.openBotArtifacts || this.actions.openBotMemory || this.actions.readBotCredentials) && !selected.missing && selected.uri.startsWith('file:') && botEntries.length > 0;
			const label = projectBotManagementLabel(t);
			const management = canManageBot && selected.managed ? this.detailActionGroup(selected, label, 'settings-gear', true) : undefined;
			if (canManageBot) {
				const staticGroup = management ? undefined : projectDetailActionGroup(document, label);
				const group = management?.element ?? staticGroup!.group;
				const controls = staticGroup?.controls ?? element('div', 'lp-detail-group-actions');
				for (const entry of botEntries) {
					const add = (key: string, title: string, icon: string, action: () => void) => {
						const open = button(botEntries.length > 1 ? `${title} · ${entry?.name ?? entry?.entryId}` : title, icon, action, 'studio-project-action lp-outline');
						open.dataset.key = `${key}:${selected.uri}:${entry?.entryId ?? ''}`;
						controls.append(open);
						return open;
					};
					if (this.actions.openBotArtifacts) { add('bot-artifacts', ...projectBotAction('artifacts', t), () => this.actions.openBotArtifacts?.(selected, entry?.entryId)); }
					if (this.actions.openBotMemory) { add('bot-memory', ...projectBotAction('memory', t), () => this.actions.openBotMemory?.(selected, entry?.entryId)); }
					if (this.actions.readBotCredentials) {
						const open = add('bot-credentials', ...projectBotAction('credentials', t), () => this.toggleBotCredentials(selected, entry?.entryId));
						const list = this.credentialList;
						open.setAttribute('aria-expanded', String(!!list && list.entryId === entry?.entryId));
						if (list && list.entryId === entry?.entryId) { open.setAttribute('aria-controls', list.panel.id); }
					}
				}
				if (management) { group.append(controls); }
				if (this.credentialList) { group.append(this.credentialList.panel); }
				secondaryActions.append(group);
			}
			// Local actions resolve independently of IM. Update each group only when its actions change.
			const local = this.detailActions(selected, 'local'), account = this.detailActions(selected, 'account');
			this.updateDetailActions = () => {
				bot.update(management ? [] : local?.items);
				management?.update(local?.items);
				im.update(account?.items);
				secondaryActions.hidden = bot.element.hidden && im.element.hidden && !canManageBot;
			};
			this.updateDetailActions();
			let detailActions = secondaryActions;
			if (this.actions.openProjectSchedules && selected.distribution === 'source' && selected.kind === 'folder' && !selected.missing && !selected.builtin && !selected.managed && selected.uri.startsWith('file:')) {
				const entries = (selected.entries ?? []).filter(entry => entry.type === 'workflow');
				const workflows = entries.length ? entries : selected.projectType === 'workflow' ? [undefined] : [];
				if (workflows.length) {
					const label = t('Workflow schedules', 'Workflow 定时计划');
					const group = element('section', 'lp-detail-action-group');
					const controls = element('div', 'lp-detail-group-actions');
					for (const entry of workflows) {
						const title = workflows.length > 1 ? `${label} · ${entry?.name ?? entry?.entryId}` : label;
						const open = button(title, 'calendar', () => this.actions.openProjectSchedules?.(selected, entry?.entryId), 'studio-project-action lp-outline');
						open.dataset.key = `workflow-schedules:${selected.uri}:${entry?.entryId ?? ''}`;
						controls.append(open);
					}
					group.setAttribute('aria-label', label);
					group.append(element('h2', '', label), controls);
					detailActions = element('div', 'lp-detail-secondary');
					detailActions.append(secondaryActions, group);
				}
			}
			const usage = this.projectUsage(selected);
			const detail = projectDetails(selected, t, { actions, secondaryActions: detailActions, usage: usage?.element,
				openEntry: canRun ? runProject : undefined });
			this.content.replaceChildren(detail); restoreFocus();
			usage?.setVisible(this.visible);
			return;
		}
		this.projectUsage();
		this.detailActionStates.clear();
		this.updateDetailActions = undefined;
		this.content.replaceChildren();
		const showBuiltins = builtins.length > 0 && (this.filter === 'all' || this.filter === 'installed');
		if (!rows.length && !showBuiltins) {
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
		if (showBuiltins) { gallery(t('Built-in projects', '内置项目'), 'builtins', builtins); }
		if (rows.length) {
			if (this.filter === 'all' && !query) { gallery(t('Recently opened', '最近打开'), 'recent', rows.slice(0, 6)); }
			gallery(category?.label ?? t('All projects', '所有项目'), category ? 'product' : 'all', rows);
		}
		restoreFocus();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.usage?.view.setVisible(visible);
	}

	private projectUsage(project?: LaunchpadProject): StudioProjectUsage | undefined {
		const key = project && `${this.actionScope}:${projectUsageKey(project)}`;
		if (key !== this.usage?.key) {
			this.usage?.view.dispose();
			const bridge = this.actions.usage;
			this.usage = key && project && bridge ? { key, view: new StudioProjectUsage(project, this.t, bridge) } : undefined;
		}
		return this.usage?.view;
	}

	private credentialProjectKey(project: LaunchpadProject): string {
		return JSON.stringify([project.uri, project.projectId, project.distribution, project.managed, project.builtin, project.projectType,
			project.entries?.filter(entry => entry.type === 'bot').map(entry => entry.entryId)]);
	}

	private toggleBotCredentials(project: LaunchpadProject, entryId?: string): void {
		const read = this.actions.readBotCredentials;
		if (!read) { return; }
		const projectKey = this.credentialProjectKey(project);
		if (this.credentialList?.projectKey === projectKey && this.credentialList.entryId === entryId) {
			this.credentialList = undefined;
			this.render();
			return;
		}
		const t = this.t;
		const panel = element('div', 'lp-bot-credential-list');
		panel.id = 'studio-bot-credential-list';
		panel.setAttribute('role', 'region');
		panel.setAttribute('aria-label', t('Credential management', '凭据管理'));
		const message = element('p', 'lp-credential-status', t('Loading credentials…', '正在加载凭据…'));
		message.setAttribute('role', 'status');
		panel.append(message);
		const current = this.credentialList = { projectKey, entryId, panel };
		this.render();
		void Promise.resolve().then(() => read(project, entryId)).catch(() => undefined).then(result => {
			if (this.credentialList !== current || this._store.isDisposed) { return; }
			if (result?.status !== 'ok' || !result.rows.length) {
				message.textContent = result?.status === 'ok' ? t('No saved credentials.', '暂无已保存的凭据。')
					: result?.status === 'untrusted' ? t('The project folder is not trusted.', '项目文件夹尚未受信任。')
						: t('Credential list unavailable.', '无法读取凭据列表。');
				return;
			}
			const table = element('table');
			const head = element('thead'), titles = element('tr'), body = element('tbody');
			for (const label of [t('Alias', '别名'), t('Type', '类型')]) {
				const heading = element('th', '', label); heading.scope = 'col'; titles.append(heading);
			}
			head.append(titles);
			for (const { name, type } of result.rows) {
				const row = element('tr');
				row.append(element('td', '', name), element('td', '', type));
				body.append(row);
			}
			table.append(head, body);
			panel.replaceChildren(table);
		});
	}

	override dispose(): void {
		this.projectUsage();
		this.credentialList = undefined;
		super.dispose();
	}
}
