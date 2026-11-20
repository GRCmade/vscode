/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { STEAMHARNESS_ICON_DATA_URI } from '../common/studioBranding.js';
import { studioProjectIcon } from '../common/studioProjectIcons.js';
import { button, element, icon, LaunchpadLabel, LaunchpadOption, LaunchpadPicker } from './studioLaunchpadPicker.js';

export interface LaunchpadProject {
	kind: 'folder' | 'workspace'; uri: string; name: string; path: string;
	projectType?: string; avatarUrl?: string; windowId?: number; dirty?: boolean; lastOpened?: number; missing?: boolean;
}
export interface LaunchpadInbox {
	connection?: 'connected' | 'offline' | 'connecting' | 'guest'; message?: string;
	items: { id?: string; name: string; preview: string; unread: number; avatarUrl?: string; time?: number; group?: boolean }[];
}
export interface LaunchpadAccount {
	name: string; email?: string | null; avatarUrl?: string; serverUrl?: string; statusLabel?: string;
	hasAccount: boolean; signedIn: boolean;
}
export interface LaunchpadState {
	windows: LaunchpadProject[]; recent: LaunchpadProject[]; platform: boolean; canCreate: boolean;
	account?: LaunchpadAccount;
	inbox?: LaunchpadInbox;
	store?: { message?: string; items: { id: string; name: string; description?: string; projectType?: string; avatarUrl?: string }[] };
}
export interface LaunchpadActions {
	open(): void; workspace(): void; create(): void;
	project(project: LaunchpadProject): void; remove(project: LaunchpadProject): void;
	resource(resource: 'docs' | 'github' | 'server'): void;
	signIn(): void; settings(): void; inbox(id?: string): void; store(id?: string): void;
}

function image(src: string, className = ''): HTMLImageElement {
	const img = element('img', className); img.alt = ''; img.draggable = false; img.src = src; img.referrerPolicy = 'no-referrer'; return img;
}

function accountAvatar(src?: string): HTMLElement {
	const avatar = element('span', 'lp-avatar'); avatar.setAttribute('aria-hidden', 'true');
	const fallback = icon('account'); avatar.append(fallback);
	if (src && /^(https?:\/\/|data:image\/)/i.test(src)) {
		const img = image(src);
		img.addEventListener('error', () => { img.remove(); fallback.hidden = false; }, { once: true });
		fallback.hidden = true; avatar.append(img);
	}
	return avatar;
}

function sectionHead(title: HTMLElement, ...tools: HTMLElement[]): HTMLElement {
	const head = element('header', 'lp-section-head'); head.append(title, ...tools); return head;
}

function tool(label: string, glyph: string, action: () => void): HTMLButtonElement {
	const b = button('', glyph, action, 'lp-tool'); b.title = label; b.setAttribute('aria-label', label); return b;
}

/** The desktop controller supplies the same view with local or account-backed data. */
export class StudioLaunchpadView {
	readonly element = element('div', 'studio-launchpad');
	private readonly stateBar = element('footer', 'lp-statusbar');
	private readonly commandCenter: HTMLButtonElement;
	private readonly picker: LaunchpadPicker;
	private readonly accountButton: HTMLButtonElement;
	private readonly accountProfile = element('div', 'lp-account-profile');
	private readonly openButton: HTMLButtonElement;
	private readonly createButton: HTMLButtonElement;
	private readonly serverButton: HTMLButtonElement;
	private readonly live = element('div', 'lp-live-list lp-scroll');
	private readonly liveCount = element('span', 'lp-count');
	private readonly history = element('div', 'lp-history-list lp-scroll');
	private readonly historyTitle = element('h2');
	private readonly recentCount = element('span', 'lp-count');
	private readonly tableHead = element('div', 'lp-table-head');
	private readonly shown = element('span');
	private readonly sort: HTMLButtonElement;
	private readonly more: HTMLButtonElement;
	private readonly side = element('aside', 'lp-side');
	private readonly chats = element('div', 'lp-chat-list');
	private readonly cards = element('div', 'lp-store-list');
	private readonly storeSection = element('section', 'lp-store');
	private readonly inboxButton: HTMLButtonElement;
	private readonly unread = element('span', 'lp-unread');
	private readonly connection = element('span', 'lp-connection');
	private readonly signatures = new Map<HTMLElement, string>();
	private readonly label: LaunchpadLabel;
	private readonly date: Intl.DateTimeFormat;
	private readonly clock: Intl.DateTimeFormat;
	private alphabetical = false;
	private expanded = false;
	private selection?: string;
	private state?: LaunchpadState;

	constructor(language: string, private readonly actions: LaunchpadActions) {
		const zh = language.toLowerCase().startsWith('zh');
		const t = this.label = (en, cn) => zh ? cn : en;
		this.date = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { month: 'short', day: 'numeric' });
		this.clock = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
		this.picker = new LaunchpadPicker(t);
		this.element.tabIndex = -1; this.element.setAttribute('aria-label', t('Studio Launchpad', 'Studio 启动台'));
		this.element.addEventListener('pointerdown', () => this.element.classList.add('lp-pointer'), true);
		this.element.addEventListener('keydown', () => this.element.classList.remove('lp-pointer'), true);
		const chrome = element('header', 'lp-titlebar');
		const brand = element('span', 'lp-window-name'); brand.append(element('strong', '', 'SteamHarness'), ' Studio');
		this.commandCenter = button('', 'search', () => this.search(false, this.commandCenter), 'lp-command-center');
		const centerTitle = t('Search projects or run a command', '搜索项目或运行命令');
		this.commandCenter.append(element('span', 'lp-wide-label', centerTitle), element('span', 'lp-compact-label', t('Commands', '命令中心')));
		this.commandCenter.title = centerTitle; this.commandCenter.setAttribute('aria-haspopup', 'dialog');
		const resources: LaunchpadOption[] = [
			{ label: 'GitHub', glyph: 'github', run: () => actions.resource('github') },
			{ label: t('Docs', '文档'), glyph: 'book', run: () => actions.resource('docs') },
			{ label: t('Web console', 'Web 控制台'), glyph: 'link-external', run: () => actions.resource('server') },
		];
		const utilities = element('nav', 'lp-utilities');
		const links = element('div', 'lp-links');
		const resourceButtons = resources.map(r => button(r.label, r.glyph, r.run));
		this.serverButton = resourceButtons[2]; links.append(...resourceButtons);
		const compact = button(t('Resources', '资源'), 'chevron-down', () => this.picker.choices(t('Online resources', '在线资源'), this.state?.platform ? resources : resources.slice(0, 2), compact), 'lp-compact-resources');
		this.accountButton = tool(t('Studio account', 'Studio 账号'), 'account', () => this.account()); this.accountButton.classList.add('lp-account');
		this.accountButton.setAttribute('aria-haspopup', 'dialog');
		utilities.append(links, compact, this.accountButton); chrome.append(brand, this.commandCenter, utilities);
		const main = element('main', 'lp-home lp-scroll');
		const header = element('header', 'lp-header');
		const identity = element('div', 'lp-identity');
		const mark = element('span', 'lp-app-mark'); mark.append(image(STEAMHARNESS_ICON_DATA_URI));
		const titles = element('div'); const local = element('small', 'lp-local'); local.append(icon('device-desktop'), t('Local workspace', '本机工作区'));
		titles.append(element('h1', '', t('Studio Launchpad', 'Studio 启动台')), local); identity.append(mark, titles);
		const buttons = element('div', 'lp-actions');
		this.openButton = button(t('Open project…', '打开项目…'), 'folder-opened', () => this.openOptions(), 'lp-outline');
		this.createButton = button(t('New project', '新建项目'), 'add', actions.create, 'lp-primary');
		buttons.append(this.openButton, this.createButton); header.append(identity, buttons);
		const columns = element('div', 'lp-columns');
		const projects = element('div', 'lp-projects');
		const live = element('section', 'lp-live'); live.append(sectionHead(element('h2', '', t('Open projects', '已打开的项目')), this.liveCount), this.live);
		const recent = element('section', 'lp-history');
		const tools = element('div', 'lp-history-tools');
		const search = button(t('Search projects', '搜索项目'), 'search', () => this.search(false, search), 'lp-find');
		this.sort = tool(t('Sort open history', '打开记录排序'), 'list-ordered', () => this.sortOptions()); tools.append(search, this.sort);
		const grid = element('div'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', t('Project history', '项目打开记录'));
		this.tableHead.setAttribute('role', 'row');
		for (const label of [t('Name and local path', '名称与本地路径'), t('Status', '状态'), t('Last opened', '最后打开'), t('Actions', '操作')]) {
			const cell = element('span', '', label); cell.setAttribute('role', 'columnheader'); this.tableHead.append(cell);
		}
		this.history.setAttribute('role', 'rowgroup'); grid.append(this.tableHead, this.history);
		this.more = button('', '', () => this.setScope(!this.expanded), 'lp-link');
		const foot = element('footer', 'lp-foot'); this.shown.setAttribute('role', 'status'); foot.append(this.shown, this.more);
		recent.append(sectionHead(this.historyTitle, this.recentCount, tools), grid, foot); projects.append(live, recent);
		const inbox = element('section', 'lp-inbox');
		this.inboxButton = button(t('Open IM', '打开 IM'), '', () => actions.inbox(), 'lp-link'); this.inboxButton.append(icon('chevron-right'));
		inbox.append(sectionHead(element('h2', '', t('Recent chats', '最近会话')), this.unread, this.inboxButton), this.chats);
		const browse = button(t('Browse Store', '浏览商店'), '', () => actions.store(), 'lp-link'); browse.append(icon('link-external'));
		this.storeSection.append(sectionHead(element('h2', '', t('Store recommendations', '商店推荐')), browse), this.cards);
		this.side.append(inbox, this.storeSection); columns.append(projects, this.side); main.append(header, columns);
		const device = element('span', 'lp-device'); device.append(icon('device-desktop'), t('Local', '本机'));
		const commands = button(t('Command palette', '命令面板'), 'terminal', () => this.search(true, commands));
		this.stateBar.append(device, commands, this.connection);
		this.element.append(chrome, main, this.stateBar, this.picker.dialog);
	}

	private openOptions(): void {
		this.picker.choices(this.label('Open project', '打开项目'), this.fileOptions(), this.openButton);
	}
	private fileOptions(): LaunchpadOption[] {
		return [{ label: this.label('Open folder…', '打开文件夹…'), glyph: 'folder-opened', run: this.actions.open },
			{ label: this.label('Open workspace file…', '打开工作区文件…'), glyph: 'project', run: this.actions.workspace }];
	}
	private account(): void {
		const t = this.label;
		this.renderAccountProfile();
		this.picker.choices(t('Studio account', 'Studio 账号'), [
			{ label: t('Open Studio Settings', '打开 Studio 设置'), glyph: 'settings-gear', run: this.actions.settings },
			{ label: t('Open Web console', '打开 Web 控制台'), glyph: 'link-external', visible: () => !!this.state?.account?.signedIn, run: () => this.actions.resource('server') },
			{ label: t('Sign in with browser', '在浏览器中登录'), glyph: 'sign-in', visible: () => !this.state?.account?.signedIn, run: this.actions.signIn },
		], this.accountButton, this.accountProfile);
	}
	private renderAccountProfile(): void {
		const t = this.label;
		const account = this.state?.account;
		const identity = element('div', 'lp-account-identity');
		const name = account?.hasAccount ? account.name : t('Not signed in', '尚未登录');
		const text = element('div'); text.append(element('strong', '', name));
		if (account?.hasAccount && account.email && account.email !== name) { text.append(element('p', 'lp-account-email', account.email)); }
		identity.append(accountAvatar(account?.hasAccount ? account.avatarUrl : undefined), text);
		this.accountProfile.replaceChildren(identity);
		const details = element('dl', 'lp-account-details');
		if (account?.serverUrl) { details.append(element('dt', '', t('Server', '服务器')), element('dd', '', account.serverUrl)); }
		if (account?.statusLabel) { details.append(element('dt', '', t('Status', '状态')), element('dd', '', account.statusLabel)); }
		if (details.childElementCount) { this.accountProfile.append(details); }
	}
	private search(commands: boolean, origin: HTMLElement): void {
		const t = this.label;
		this.picker.search(commands, origin, mode => {
			if (!mode) { return (this.state?.recent ?? []).map(p => ({ label: p.name, detail: p.path, glyph: this.glyph(p), run: () => this.actions.project(p) })); }
			const options = this.fileOptions();
			if (this.state?.canCreate) { options.unshift({ label: t('New project…', '新建项目…'), glyph: 'add', run: this.actions.create }); }
			options.push({ label: t('Show recently opened', '显示最近打开'), glyph: 'history', run: () => this.setScope(false) },
				{ label: t('Show all open history', '显示全部打开记录'), glyph: 'library', run: () => this.setScope(true) });
			if (this.state?.platform) { options.push({ label: t('Open IM', '打开 IM'), glyph: 'comment-discussion', run: () => this.actions.inbox() }); }
			return options;
		});
	}

	/** Capture only our shortcuts, never editor shortcuts in the create dialog or hosted app. */
	shortcut(event: KeyboardEvent): void {
		if (this.element.hidden || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || !(event.target instanceof Node)
			|| (!this.element.contains(event.target) && event.target !== document.body) || (this.picker.dialog.open && !this.picker.dialog.classList.contains('lp-quick'))) { return; }
		const key = event.key.toLowerCase(); const mod = event.ctrlKey || event.metaKey;
		if (key !== 'f1' && (!mod || !['p', 'f', 'o'].includes(key) || (event.shiftKey && key !== 'p'))) { return; }
		event.preventDefault(); event.stopImmediatePropagation();
		this.element.classList.remove('lp-pointer');
		if (key === 'o') { this.openOptions(); }
		else { this.search(key === 'f1' || (key === 'p' && event.shiftKey), document.activeElement instanceof HTMLElement && this.element.contains(document.activeElement) ? document.activeElement : this.commandCenter); }
	}

	private setScope(all: boolean): void { this.expanded = all; this.renderHistory(); this.history.scrollTop = 0; }
	private sortOptions(): void {
		const name = this.label('Project name', '按项目名称'), time = this.label('Most recent first', '最近打开优先');
		this.picker.choices(this.label('Sort open history', '打开记录排序'), [false, true].map(byName => ({
			label: byName ? name : time, glyph: this.alphabetical === byName ? 'check' : byName ? 'case-sensitive' : 'clock',
			run: () => { this.alphabetical = byName; this.renderHistory(); },
		})), this.sort);
	}
	private kind(p: LaunchpadProject): string { return p.kind === 'workspace' ? this.label('Workspace', '工作区') : this.label('Folder', '文件夹'); }
	private projectLabel(p: LaunchpadProject): string { return (p.kind === 'folder' ? this.typeLabel(p.projectType) : undefined) ?? this.kind(p); }
	private glyph(p: LaunchpadProject): string { return p.kind === 'workspace' ? 'project' : studioProjectIcon(p.projectType) ?? 'folder'; }
	private typeLabel(type?: string): string | undefined {
		switch (type) {
			case 'workflow': return this.label('Workflow', '工作流'); case 'bot': return 'Bot'; case 'kanban': return this.label('Kanban', '看板');
			case 'aggregate': return this.label('Aggregate project', '聚合项目'); case 'conversation': return this.label('Conversation', '对话');
			case 'link': return this.label('Import from link', '链接导入'); default: return undefined;
		}
	}
	private projectIcon(p: LaunchpadProject): HTMLElement {
		return p.kind === 'folder' && p.avatarUrl?.startsWith('data:image/') ? image(p.avatarUrl, 'lp-project-avatar') : icon(this.glyph(p));
	}
	private historyStatus(p: LaunchpadProject) {
		const t = this.label;
		if (p.windowId !== undefined) {
			return { state: 'open', glyph: 'window', label: t('Open', '已打开'), action: t('Switch to window', '切换到项目窗口'), actionGlyph: 'window' };
		}
		if (p.missing) {
			return { state: 'missing', glyph: 'warning', label: t('Not found', '路径失效'), action: t('Open or locate project…', '打开或重新定位…'), actionGlyph: 'search' };
		}
		return { state: 'closed', glyph: 'history', label: t('Not open', '未打开'), action: t('Open in new window', '在新窗口打开'), actionGlyph: 'open-in-window' };
	}
	private historyStatusCell(p: LaunchpadProject): HTMLElement {
		const t = this.label, status = this.historyStatus(p);
		const cell = element('span', 'lp-history-status'); cell.dataset.state = status.state;
		const badge = element('span', 'lp-state-label'); badge.append(icon(status.glyph), status.label); cell.append(badge);
		if (status.state === 'open' && p.dirty) {
			const detail = element('small', 'lp-state-detail'); detail.append(icon('edit'), t('Unsaved', '未保存')); cell.append(detail);
		}
		cell.title = t(`Double-click or press Enter: ${status.action}`, `双击或按 Enter：${status.action}`);
		return cell;
	}
	private stamp(time?: number, compact = false): string {
		if (!time || !Number.isFinite(new Date(time).valueOf())) { return compact ? '' : '—'; }
		const day = new Date(time).toDateString(), now = new Date();
		if (day === now.toDateString()) { return (compact ? '' : this.label('Today ', '今天 ')) + this.clock.format(time); }
		now.setDate(now.getDate() - 1);
		if (day === now.toDateString()) { return this.label('Yesterday', '昨天') + (compact ? '' : ` ${this.clock.format(time)}`); }
		return this.date.format(time);
	}
	private manage(p: LaunchpadProject, origin: HTMLElement): void {
		const t = this.label, status = this.historyStatus(p);
		this.picker.choices(p.name, [
			{ label: status.action, glyph: status.actionGlyph, run: () => this.actions.project(p) },
			{ label: t('Project information', '显示项目信息'), glyph: 'info', run: () => this.picker.choices(p.name, [], origin, [p.path, this.projectLabel(p), this.stamp(p.lastOpened)].join('\n')) },
			{ label: t('Remove from history…', '移除打开记录…'), glyph: 'trash', run: () => this.actions.remove(p) },
		], origin, p.path);
	}

	private list<T>(root: HTMLElement, rows: T[], empty: string, render: (row: T) => HTMLElement, emptyGlyph: string): void {
		const signature = JSON.stringify([rows, empty]);
		if (this.signatures.get(root) === signature) { return; }
		this.signatures.set(root, signature);
		const active = document.activeElement;
		const key = active instanceof HTMLElement && root.contains(active) ? active.closest<HTMLElement>('[data-key]')?.dataset.key : undefined;
		if (rows.length) { root.replaceChildren(...rows.map(render)); }
		else { const msg = element('p', 'lp-empty'); msg.append(icon(emptyGlyph), empty); root.replaceChildren(msg); }
		if (key) {
			const row = Array.from(root.children).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.key === key);
			(active?.classList.contains('lp-row-more') ? row?.querySelector('button') : row)?.focus({ preventScroll: true });
		}
	}
	private select(uri: string | undefined, focus = false): void {
		this.selection = uri;
		for (const row of this.history.querySelectorAll<HTMLElement>('.lp-project-row')) {
			const selected = row.dataset.key === uri;
			row.setAttribute('aria-selected', String(selected));
			row.tabIndex = selected || (uri === undefined && row === this.history.firstElementChild) ? 0 : -1;
			row.querySelector('button')!.tabIndex = row.tabIndex;
			if (selected && focus) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
		}
	}
	private historyRow(p: LaunchpadProject): HTMLElement {
		const t = this.label;
		const row = element('div', 'lp-project-row'); row.dataset.key = p.uri; row.setAttribute('role', 'row'); row.title = p.path;
		row.tabIndex = -1;
		const name = element('span', 'lp-project-name'); const tile = element('span', `lp-tile lp-${p.kind}`); tile.title = this.projectLabel(p); tile.append(this.projectIcon(p));
		const pair = element('span', 'lp-pair'); const heading = element('span', 'lp-project-heading'); heading.append(element('strong', 'lp-ellipsis', p.name));
		const type = p.kind === 'folder' ? this.typeLabel(p.projectType) : undefined; if (type) { heading.append(element('span', 'lp-project-type', type)); }
		pair.append(heading, element('small', 'lp-path lp-ellipsis', p.path)); name.append(tile, pair);
		const more = tool(t(`Manage ${p.name}`, `管理「${p.name}」的打开记录`), 'ellipsis', () => { this.select(p.uri); this.manage(p, more); });
		more.classList.add('lp-row-more'); more.setAttribute('aria-haspopup', 'dialog');
		const actions = element('span'); actions.append(more);
		const cells = [name, this.historyStatusCell(p), element('time', '', this.stamp(p.lastOpened)), actions];
		for (const cell of cells) { cell.setAttribute('role', 'gridcell'); } row.append(...cells);
		row.addEventListener('click', e => { if (!(e.target instanceof Element && e.target.closest('button'))) { this.select(p.uri, true); } });
		row.addEventListener('dblclick', e => { if (!(e.target instanceof Element && e.target.closest('button'))) { this.actions.project(p); } });
		row.addEventListener('contextmenu', e => { e.preventDefault(); this.select(p.uri); this.manage(p, row); });
		row.addEventListener('keydown', e => {
			if (e.target !== row) { return; }
			if (e.key === 'Enter') { e.preventDefault(); this.actions.project(p); }
			else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); this.manage(p, row); }
			else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
				e.preventDefault(); const rows = Array.from(this.history.children) as HTMLElement[];
				const i = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)));
				this.select(rows[i].dataset.key!, true);
			}
		});
		return row;
	}
	private renderHistory(): void {
		const t = this.label; const records = this.state?.recent ?? [];
		const rows = records.slice(0, this.expanded ? undefined : 5);
		if (this.alphabetical) { rows.sort((a, b) => a.name.localeCompare(b.name, this.date.resolvedOptions().locale, { numeric: true })); }
		this.historyTitle.textContent = this.expanded ? t('All open history', '全部打开记录') : t('Recently opened', '最近打开');
		this.recentCount.textContent = String(rows.length); this.tableHead.hidden = !rows.length;
		this.shown.textContent = rows.length ? t(`Showing ${rows.length} of ${records.length}`, `显示 ${rows.length} 条，共 ${records.length} 条`) : '';
		this.more.hidden = !this.expanded && records.length <= 5; this.more.setAttribute('aria-expanded', String(this.expanded));
		this.more.replaceChildren(...(this.expanded ? [icon('chevron-left'), t('Back to recent', '返回最近打开')] : [t(`All ${records.length} records`, `全部 ${records.length} 条记录`), icon('chevron-right')]));
		this.sort.title = this.alphabetical ? t('Sort: project name', '排序：项目名称') : t('Sort: most recent first', '排序：最近打开优先');
		this.list(this.history, rows, t('No open history yet.', '还没有打开记录。'), p => this.historyRow(p), 'folder-opened');
		this.select(rows.find(p => p.uri === this.selection)?.uri);
	}

	setInboxBusy(busy: boolean): void { this.inboxButton.disabled = busy; this.inboxButton.setAttribute('aria-busy', String(busy)); }
	focusInbox(): void { if (this.state?.platform) { this.inboxButton.focus({ preventScroll: true }); } }
	focusAccount(): void { (this.state?.platform ? this.accountButton : this.element).focus({ preventScroll: true }); }
	closePicker(): void { this.picker.close(); }

	update(state: LaunchpadState): void {
		const previous = this.state; this.state = state; const t = this.label;
		this.createButton.disabled = !state.canCreate; this.serverButton.hidden = this.accountButton.hidden = this.connection.hidden = this.side.hidden = !state.platform;
		if (JSON.stringify(state.account) !== JSON.stringify(previous?.account)) {
			this.accountButton.replaceChildren(accountAvatar(state.account?.hasAccount ? state.account.avatarUrl : undefined));
			this.accountButton.title = state.account?.hasAccount ? state.account.name : t('Studio account', 'Studio 账号');
			if (this.accountProfile.isConnected) { this.renderAccountProfile(); }
		}
		this.liveCount.textContent = String(state.windows.length);
		this.list(this.live, state.windows, t('No project windows are open.', '当前没有打开的项目窗口。'), p => {
			const item = button('', '', () => this.actions.project(p), 'lp-live-project'); item.title = p.path; item.dataset.key = p.uri;
			const plate = element('span', 'lp-plate'); plate.dataset.tone = p.kind === 'workspace' ? 'workspace' : p.projectType ?? 'folder';
			const kind = element('small', 'lp-plate-kind'); kind.append(icon(this.glyph(p)), this.projectLabel(p));
			const art = element('span', 'lp-plate-art'); art.append(this.projectIcon(p)); plate.append(kind, art);
			const body = element('span', 'lp-window-body'); const status = element('span', 'lp-window-status'); status.append(element('span', 'lp-open', t('Open', '已打开')), icon('arrow-right'));
			body.append(element('strong', 'lp-ellipsis', p.name), status); item.append(plate, body); return item;
		}, 'window');
		this.renderHistory();
		const inbox = state.inbox;
		const unread = inbox?.items.reduce((sum, row) => sum + row.unread, 0) ?? 0;
		this.unread.hidden = !unread; this.unread.textContent = t(`${unread} unread`, `${unread} 条未读`);
		const connection = inbox?.connection ?? 'connecting'; this.connection.dataset.state = connection;
		this.connection.textContent = connection === 'connected' ? t('IM connected', 'IM 已连接') : connection === 'connecting' ? t('Connecting to IM…', '正在连接 IM…') : t('IM offline', 'IM 未连接');
		this.list(this.chats, inbox?.items ?? [], inbox?.message ?? t('Loading recent chats…', '正在读取最近会话…'), chat => {
			const item = button('', '', () => this.actions.inbox(chat.id), 'lp-chat'); item.dataset.key = chat.id ?? chat.name;
			const avatar = chat.avatarUrl?.startsWith('data:image/') ? image(chat.avatarUrl, 'lp-avatar lp-chat-avatar') : element('span', 'lp-avatar', chat.group ? '' : Array.from(chat.name)[0]);
			if (chat.group) { avatar.classList.add('lp-group'); if (!chat.avatarUrl) { avatar.append(icon('comment-discussion')); } }
			const pair = element('span', 'lp-pair'); const heading = element('span', 'lp-spread'); heading.append(element('strong', 'lp-ellipsis', chat.name), element('time', '', this.stamp(chat.time, true)));
			const line = element('span', 'lp-spread'); line.append(element('small', 'lp-ellipsis', chat.preview)); if (chat.unread) { line.append(element('span', 'lp-badge', String(chat.unread))); }
			pair.append(heading, line); item.append(avatar, pair); return item;
		}, 'comment-discussion');
		if (connection === 'guest' && !this.chats.querySelector('button')) { this.chats.append(button(t('Connect account', '连接账号'), 'sign-in', this.actions.signIn, 'lp-link')); }
		else if (connection !== 'guest') { this.chats.querySelector(':scope > .lp-link')?.remove(); }
		this.storeSection.hidden = !state.store;
		if (state.store) {
			this.list(this.cards, state.store.items, state.store.message ?? t('No recommendations yet.', '暂无推荐。'), p => {
				const card = button('', '', () => this.actions.store(p.id), 'lp-card'); card.dataset.key = p.id;
				const mark = element('span', 'lp-store-mark'); mark.dataset.type = p.projectType; mark.append(p.avatarUrl?.startsWith('data:image/') ? image(p.avatarUrl) : icon(studioProjectIcon(p.projectType) ?? 'extensions'));
				const pair = element('span', 'lp-pair'); pair.append(element('strong', '', p.name), element('small', '', p.description ?? this.typeLabel(p.projectType) ?? ''));
				card.append(mark, pair, icon('link-external')); return card;
			}, 'extensions');
		}
		if (previous?.recent !== state.recent || previous?.canCreate !== state.canCreate || previous?.platform !== state.platform) { this.picker.update(); }
	}
}
