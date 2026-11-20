/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { studioProjectIcon } from '../common/studioProjectIcons.js';

export interface LaunchpadProject {
	kind: 'folder' | 'workspace';
	uri: string;
	name: string;
	path: string;
	projectType?: string;
	avatarUrl?: string;
	windowId?: number;
	lastOpened?: number;
}

export interface LaunchpadInbox { message?: string; items: { name: string; preview: string; unread: number; avatarUrl?: string }[] }
export interface LaunchpadState {
	windows: LaunchpadProject[];
	recent: LaunchpadProject[];
	platform: boolean;
	canCreate: boolean;
	inbox?: LaunchpadInbox;
	store?: { message?: string; items: { id: string; name: string; description?: string; projectType?: string }[] };
}

export interface LaunchpadActions {
	open(): void;
	workspace(): void;
	create(): void;
	project(project: LaunchpadProject): void;
	resource(resource: 'docs' | 'github' | 'server'): void;
	inbox(): void;
	store(id?: string): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text;
	return node;
}
function icon(name: string): HTMLElement {
	const node = element('span', `codicon codicon-${name}`);
	node.setAttribute('aria-hidden', 'true');
	return node;
}
function button(text: string, glyph: string, action: () => void, className = ''): HTMLButtonElement {
	const node = element('button', className);
	node.type = 'button';
	if (glyph) { node.append(icon(glyph)); }
	node.append(text);
	node.addEventListener('click', action);
	return node;
}

/** The desktop controller supplies the same view with local or account-backed data. */
export class StudioLaunchpadView {
	readonly element = element('main', 'studio-launchpad');
	private readonly live = element('div', 'lp-live-list');
	private readonly history = element('div', 'lp-history-list');
	private readonly chats = element('div', 'lp-chat-list');
	private readonly cards = element('div', 'lp-store-list');
	private readonly liveCount = element('span', 'lp-count');
	private readonly recentCount = element('span', 'lp-count');
	private readonly search = element('input', 'lp-search');
	private readonly createButton: HTMLButtonElement;
	private readonly serverButton: HTMLButtonElement;
	private readonly inboxButton: HTMLButtonElement;
	private readonly unread = element('span', 'lp-unread');
	private readonly storeSection = element('section', 'lp-store');
	private readonly more: HTMLButtonElement;
	private expanded = false;
	private readonly signatures = new Map<HTMLElement, string>();
	private readonly date: Intl.DateTimeFormat;
	private alphabetical = false;
	private state?: LaunchpadState;

	constructor(language: string, private readonly actions: LaunchpadActions) {
		const zh = language.toLowerCase().startsWith('zh');
		this.label = (en, cn) => zh ? cn : en;
		const t = this.label;
		this.date = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { month: 'short', day: 'numeric' });
		this.element.tabIndex = -1;
		this.element.setAttribute('aria-label', t('Launchpad', '启动台'));
		const inner = element('div', 'lp-inner');
		const header = element('header', 'lp-header');
		const resources = element('div', 'lp-links');
		this.serverButton = button(t('Web console', 'Web 控制台'), 'link-external', () => actions.resource('server'));
		resources.append(button('GitHub', 'github', () => actions.resource('github')), button(t('Docs', '文档'), 'book', () => actions.resource('docs')), this.serverButton);
		const local = element('div', 'lp-actions');
		this.createButton = button(t('New project', '新建项目'), 'add', () => actions.create(), 'lp-primary');
		const workspace = button('', 'root-folder-opened', actions.workspace, 'lp-outline lp-workspace');
		workspace.title = t('Open workspace file…', '打开工作区文件…');
		workspace.setAttribute('aria-label', workspace.title);
		local.append(button(t('Open project…', '打开项目…'), 'folder-opened', actions.open, 'lp-outline'), workspace, this.createButton);
		header.append(element('h1', '', t('Launchpad', '启动台')), resources, local);
		const live = element('section', 'lp-live');
		const liveHead = element('header', 'lp-section-head');
		liveHead.append(element('h2', '', t('Open projects', '已打开的项目')), this.liveCount);
		live.append(liveHead, this.live);
		const columns = element('div', 'lp-columns');
		const recent = element('section', 'lp-history');
		const historyHead = element('header', 'lp-section-head');
		this.search.type = 'search';
		this.search.placeholder = t('Search projects', '搜索项目');
		this.search.setAttribute('aria-label', this.search.placeholder);
		this.search.addEventListener('input', () => this.renderHistory());
		const sort = button('', 'list-ordered', () => {
			this.alphabetical = !this.alphabetical;
			sort.setAttribute('aria-pressed', String(this.alphabetical));
			this.renderHistory();
		});
		sort.title = t('Sort by name', '按名称排序');
		sort.setAttribute('aria-label', sort.title);
		sort.setAttribute('aria-pressed', 'false');
		historyHead.append(element('h2', '', t('Recently opened', '最近打开')), this.recentCount, this.search, sort);
		const tableHead = element('div', 'lp-table-head');
		tableHead.append(element('span', '', t('Name and path', '名称与本地路径')), element('span', '', t('Status', '状态')), element('span', '', t('Last opened', '最后打开')));
		const foot = element('footer', 'lp-foot');
		this.more = button('', '', () => {
			this.expanded = !this.expanded;
			this.renderHistory();
		}, 'lp-link');
		foot.append(this.more);
		recent.append(historyHead, tableHead, this.history, foot);
		const inbox = element('section', 'lp-inbox');
		const inboxHead = element('header', 'lp-section-head');
		this.inboxButton = button(t('Open IM', '打开 IM'), 'comment-discussion', actions.inbox, 'lp-link');
		inboxHead.append(element('h2', '', t('Recent chats', '最近会话')), this.unread, this.inboxButton);
		inbox.append(inboxHead, this.chats);
		columns.append(recent, inbox);
		const storeHead = element('header', 'lp-section-head');
		const browse = button(t('Browse Store', '浏览商店'), 'link-external', () => actions.store(), 'lp-link');
		storeHead.append(element('h2', '', t('Store recommendations', '商店推荐')), browse);
		this.storeSection.append(storeHead, this.cards);
		inner.append(header, live, columns, this.storeSection);
		this.element.append(inner);
	}

	private readonly label: (en: string, zh: string) => string;

	private typeLabel(projectType: string | undefined): string | undefined {
		switch (projectType) {
			case 'workflow': return this.label('Workflow', '工作流');
			case 'bot': return this.label('Bot', 'Bot');
			case 'kanban': return this.label('Kanban', '看板');
			case 'conversation': return this.label('Conversation', '对话');
			case 'aggregate': return this.label('Aggregate Project', '聚合项目');
			case 'link': return this.label('Import from Link', '链接导入');
			default: return undefined;
		}
	}

	private projectIcon(row: LaunchpadProject): HTMLElement {
		if (row.kind === 'folder' && row.avatarUrl?.startsWith('data:image/svg+xml,')) {
			const image = element('img', 'lp-project-avatar');
			image.src = row.avatarUrl;
			image.alt = '';
			image.setAttribute('aria-hidden', 'true');
			return image;
		}
		return icon(row.kind === 'workspace' ? 'project' : studioProjectIcon(row.projectType) ?? 'folder');
	}

	private list<T>(root: HTMLElement, rows: T[], empty: string, render: (row: T) => HTMLElement): void {
		const signature = JSON.stringify([rows, empty]);
		if (this.signatures.get(root) === signature) { return; }
		this.signatures.set(root, signature);
		const focusedKey = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
		root.replaceChildren(...(rows.length ? rows.map(render) : [element('p', 'lp-empty', empty)]));
		if (focusedKey) { Array.from(root.children).find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.key === focusedKey)?.focus({ preventScroll: true }); }
	}

	private renderHistory(): void {
		const term = this.search.value.trim().toLocaleLowerCase();
		const projects = (this.state?.recent ?? []).filter(row => `${row.name} ${row.path}`.toLocaleLowerCase().includes(term));
		if (this.alphabetical) { projects.sort((a, b) => a.name.localeCompare(b.name)); }
		const shown = this.expanded || term ? projects : projects.slice(0, 5);
		this.recentCount.textContent = String(shown.length);
		this.more.hidden = projects.length <= 5 || !!term;
		this.more.setAttribute('aria-expanded', String(this.expanded));
		this.more.textContent = this.expanded ? this.label('Show fewer', '收起') : this.label(`All ${projects.length} projects ›`, `全部 ${projects.length} 条记录 ›`);
		this.list(this.history, shown, term ? this.label('No matching projects.', '没有匹配的项目。') : this.label('Projects you open will appear here.', '打开过的项目会显示在这里。'), row => {
			const action = button('', '', () => this.actions.project(row), 'lp-project-row');
			action.dataset.key = row.uri;
			action.title = row.path;
			const name = element('span', 'lp-project-name');
			const pair = element('span', 'lp-pair');
			const heading = element('span', 'lp-project-heading');
			heading.append(element('strong', '', row.name));
			const type = row.kind === 'folder' ? this.typeLabel(row.projectType) : undefined;
			if (type) { heading.append(element('span', 'lp-project-type', type)); }
			pair.append(heading, element('small', '', row.path));
			name.append(this.projectIcon(row), pair);
			const status = element('span', row.windowId === undefined ? 'lp-idle' : 'lp-running', row.windowId === undefined ? this.label('Closed', '已关闭') : this.label('Open', '已打开'));
			action.append(name, status, element('time', '', row.lastOpened ? this.date.format(row.lastOpened) : '—'));
			return action;
		});
	}

	setInboxBusy(busy: boolean): void {
		this.inboxButton.disabled = busy;
		this.inboxButton.setAttribute('aria-busy', String(busy));
	}

	focusInbox(): void {
		if (!this.inboxButton.hidden) { this.inboxButton.focus({ preventScroll: true }); }
	}

	update(state: LaunchpadState): void {
		this.state = state;
		const t = this.label;
		this.createButton.disabled = !state.canCreate;
		this.serverButton.hidden = !state.platform;
		this.inboxButton.hidden = !state.platform;
		this.liveCount.textContent = String(state.windows.length);
		this.list(this.live, state.windows, t('No project windows are open.', '当前没有打开的项目窗口。'), row => {
			const item = button('', row.kind === 'workspace' ? 'project' : 'folder', () => this.actions.project(row), 'lp-live-project');
			const pair = element('span', 'lp-pair');
			pair.append(element('strong', '', row.name), element('small', 'lp-running', t('Open', '已打开')));
			item.append(pair, icon('chevron-right'));
			item.title = row.path;
			item.dataset.key = row.uri;
			return item;
		});
		this.renderHistory();
		const unread = state.inbox?.items.reduce((count, row) => count + row.unread, 0) ?? 0;
		this.unread.textContent = unread ? t(`${unread} unread`, `${unread} 条未读`) : '';
		this.list(this.chats, state.inbox?.items ?? [], state.inbox?.message ?? (state.platform ? t('Loading recent chats…', '正在读取最近会话…') : t('IM is available in the enhanced edition.', '增强版可连接 IM。')), row => {
			const item = element('div', 'lp-chat');
			const pair = element('span', 'lp-pair');
			pair.append(element('strong', '', row.name), element('small', '', row.preview));
			if (row.avatarUrl?.startsWith('data:image/')) {
				const avatar = element('img', 'lp-avatar lp-chat-avatar');
				avatar.src = row.avatarUrl;
				avatar.alt = '';
				avatar.setAttribute('aria-hidden', 'true');
				item.append(avatar);
			} else {
				item.append(element('span', 'lp-avatar', Array.from(row.name)[0]));
			}
			item.append(pair);
			if (row.unread) { item.append(element('span', 'lp-count', String(row.unread))); }
			return item;
		});
		this.storeSection.hidden = !state.store;
		if (state.store) {
			this.list(this.cards, state.store.items, state.store.message ?? t('No recommendations yet.', '暂无推荐。'), row => {
				const card = button('', '', () => this.actions.store(row.id), 'lp-card');
				card.dataset.key = row.id;
				const pair = element('span', 'lp-pair');
				pair.append(element('strong', '', row.name), element('small', '', row.description ?? row.projectType ?? ''));
				card.append(icon(studioProjectIcon(row.projectType) ?? 'extensions'), pair, icon('link-external'));
				return card;
			});
		}
	}
}
