/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { STEAMHARNESS_ICON_DATA_URI } from '../common/studioBranding.js';
import { glyph, LaunchpadProject, picture, StoreListing } from './studioLaunchpadCards.js';
import { LaunchpadLibrary, LibraryActions, LibraryProjectCategory } from './studioLaunchpadLibrary.js';
import { button, element, icon, LaunchpadLabel, LaunchpadOption, LaunchpadPicker } from './studioLaunchpadPicker.js';
import { avatar, InboxAction, LaunchpadAccount, LaunchpadInbox, LaunchpadProfile, ProfileActions, StudioNotice } from './studioLaunchpadProfile.js';
import { LaunchpadStore, StoreActions } from './studioLaunchpadStore.js';

export type { LaunchpadProject, LaunchpadAccount, LaunchpadInbox };
export interface LaunchpadState {
	windows: LaunchpadProject[]; recent: LaunchpadProject[]; platform: boolean; canCreate: boolean;
	account?: LaunchpadAccount; inbox?: LaunchpadInbox; store?: { items: StoreListing[] }; notices: StudioNotice[]; notificationUnread: boolean;
	libraryCategory?: LibraryProjectCategory;
}
interface LaunchpadActions extends ProfileActions, LibraryActions, StoreActions {
	open(): void; workspace(): void; settings(): void;
	readNotice(id: string): void;
	resource(id: 'docs' | 'github' | 'server'): void;
	openStore(): void;
}
type Tab = 'store' | 'library' | 'community' | 'profile';

export class StudioLaunchpadView extends Disposable {
	readonly element = element('div', 'studio-launchpad');
	private readonly drop = element('div', 'lp-project-drop');
	private readonly tabs = element('nav', 'lp-tabs');
	private readonly panels = element('main', 'lp-panels');
	private readonly commandCenter: HTMLButtonElement;
	private readonly settingsButton: HTMLButtonElement;
	private readonly accountButton: HTMLButtonElement;
	private readonly latestNotice: HTMLButtonElement;
	private readonly noticeContent = element('span');
	private readonly bell: HTMLButtonElement;
	private readonly consoleButton: HTMLButtonElement;
	private readonly picker: LaunchpadPicker;
	private readonly store: LaunchpadStore;
	private readonly library: LaunchpadLibrary;
	private readonly profile: LaunchpadProfile;
	private readonly t: LaunchpadLabel;
	private active: Tab = 'library';
	private state?: LaunchpadState;

	constructor(language: string, private readonly actions: LaunchpadActions) {
		super();
		const zh = language.toLowerCase().startsWith('zh'), t = this.t = (en, cn) => zh ? cn : en;
		this.picker = new LaunchpadPicker(t);
		this.element.tabIndex = -1; this.element.setAttribute('aria-label', t('Studio Launchpad', 'Studio 启动台'));
		this.element.addEventListener('pointerdown', () => this.element.classList.add('lp-pointer'), true);
		this.element.addEventListener('keydown', () => this.element.classList.remove('lp-pointer'), true);
		const chrome = element('header', 'lp-titlebar');
		const brand = element('span', 'lp-brand'), wordmark = element('span', 'lp-wordmark');
		wordmark.append(element('strong', '', 'SteamHarness'), ' Studio'); brand.append(picture(STEAMHARNESS_ICON_DATA_URI), wordmark);
		const tool = (name: string, glyph: string, run: () => void) => { const b = button('', glyph, run, 'lp-tool'); b.title = name; b.setAttribute('aria-label', name); return b; };
		const resources = element('div', 'lp-resources'); resources.setAttribute('role', 'group'); resources.setAttribute('aria-label', t('Resources', '资源'));
		const resource = (id: 'docs' | 'github' | 'server', name: string, glyph: string) => {
			const b = tool(name, glyph, () => actions.resource(id)); b.append(element('span', 'lp-resource-label', name)); return b;
		};
		this.consoleButton = resource('server', t('Web console', 'Web 控制台'), 'link-external'); this.consoleButton.hidden = true;
		resources.append(resource('docs', t('Documentation', '文档'), 'book'), resource('github', 'GitHub', 'github'), this.consoleButton);
		const searchLabel = t('Search projects or commands', '搜索项目或命令');
		this.commandCenter = button('', 'search', () => this.search(false), 'lp-command-center');
		this.commandCenter.append(element('span', 'lp-command-label', searchLabel), element('span', 'lp-command-short', t('Search', '搜索')));
		this.commandCenter.title = searchLabel;
		this.commandCenter.setAttribute('aria-label', searchLabel);
		this.commandCenter.setAttribute('aria-haspopup', 'dialog');
		this.commandCenter.setAttribute('aria-expanded', 'false');
		this.bell = tool(t('Studio notifications', 'Studio 通知'), 'bell', () => { this.select('profile'); this.profile.select('notifications'); });
		this.settingsButton = tool(t('Settings', '设置'), 'settings-gear', actions.settings);
		this.accountButton = tool(t('Studio account', 'Studio 账号'), 'account', () => this.select('profile'));
		this.accountButton.classList.add('lp-account');
		const utilities = element('div', 'lp-utilities'); utilities.append(resources, this.bell, this.settingsButton, this.accountButton);
		chrome.append(brand, this.commandCenter, utilities);
		const navigation = element('div', 'lp-navigation'); this.tabs.setAttribute('role', 'tablist'); this.tabs.setAttribute('aria-label', t('Launchpad navigation', '启动台导航'));
		for (const [id, name] of [['store', t('Store', '商店')], ['library', t('Library', '仓库')], ['community', t('Community', '社区')], ['profile', t('My Studio', '我的')]] as const) {
			const b = button(name, '', () => id === 'store' ? actions.openStore() : this.select(id)); b.id = `lp-tab-${id}`; b.dataset.tab = id; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', `lp-page-${id}`); this.tabs.append(b);
		}
		this.tabs.addEventListener('keydown', e => {
			const buttons = Array.from(this.tabs.querySelectorAll('button')), i = buttons.indexOf(document.activeElement as HTMLButtonElement);
			if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { return; }
			e.preventDefault(); const next = buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length]; next.focus(); if (next.dataset.tab === 'store') actions.openStore(); else this.select(next.dataset.tab as Tab);
		});
		navigation.append(this.tabs);
		this.library = new LaunchpadLibrary(t, actions);
		this.store = this._register(new LaunchpadStore(t, actions)); this.profile = this._register(new LaunchpadProfile(t, actions, actions.readNotice, this.picker));
		const community = element('div', 'lp-community'); community.append(icon('organization'), element('h1', '', t('Community', '社区')), element('p', '', t('Coming soon', '暂未开放')));
		for (const [id, page] of [['store', this.store.element], ['library', this.library.element], ['community', community], ['profile', this.profile.element]] as const) {
			page.id = `lp-page-${id}`; page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', `lp-tab-${id}`); this.panels.append(page);
		}
		const foot = element('footer', 'lp-statusbar'); const open = button(t('Open project…', '打开项目…'), 'folder-opened', () => this.openOptions(open));
		this.latestNotice = button('', 'bell', () => {
			const notice = this.state?.inbox?.latestNotice;
			if (notice?.conversation) { actions.inbox(notice.conversation, notice.title); }
		}, 'lp-latest-notice');
		this.latestNotice.hidden = true;
		this.latestNotice.append(this.noticeContent);
		foot.append(open, this.latestNotice); this.drop.append(icon('folder-opened'), t('Drop folders to import projects', '松开以导入项目文件夹')); this.drop.hidden = true;
		this.element.append(chrome, navigation, this.panels, foot, this.drop, this.picker.dialog); this.select(this.active);
	}

	select(id: Tab, projectUri?: string): void {
		this.active = id;
		for (const b of this.tabs.querySelectorAll('button')) { const selected = b.dataset.tab === id; b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1; }
		for (const page of Array.from(this.panels.children) as HTMLElement[]) { page.hidden = page.id !== `lp-page-${id}`; }
		if (this.state) { this.update(this.state); }
		if (id === 'library') { this.library.show(projectUri); }
		if (id === 'store') { this.store.showCatalog(false); }
	}

	private fileOptions(): LaunchpadOption[] { return [{ label: this.t('Open folder…', '打开文件夹…'), glyph: 'folder-opened', run: this.actions.open }, { label: this.t('Open workspace…', '打开工作区…'), glyph: 'project', run: this.actions.workspace }]; }
	private openOptions(origin: HTMLElement): void { this.picker.choices(this.t('Open project…', '打开项目…'), this.fileOptions(), origin); }
	private search(commands: boolean): void {
		this.picker.search(commands, this.commandCenter, mode => mode ? [...this.fileOptions(), ...(this.state?.platform ? [{ label: this.t('View recent chats', '查看最近会话'), glyph: 'comment', run: () => this.showSocial('activity') }] : [])] : (this.state?.recent ?? []).map(p => ({ label: p.name, glyph: glyph(p), detail: p.path, run: () => this.select('library', p.uri) })));
	}
	shortcut(event: KeyboardEvent): void {
		if (this.element.hidden || event.defaultPrevented || event.isComposing || event.altKey || !(event.target instanceof Node) || (!this.element.contains(event.target) && event.target !== document.body) || (this.picker.dialog.open && !this.picker.dialog.classList.contains('lp-quick'))) { return; }
		const key = event.key.toLowerCase(); if (key !== 'f1' && (!(event.ctrlKey || event.metaKey) || !['p', 'f', 'o'].includes(key) || (event.shiftKey && key !== 'p'))) { return; }
		event.preventDefault(); event.stopImmediatePropagation(); if (key === 'o') { this.openOptions(this.commandCenter); } else { this.search(key === 'f1' || event.shiftKey); }
	}
	get canDropProject(): boolean { return !this.element.hidden && !this.picker.dialog.open; }
	setProjectDropActive(active: boolean): void { this.drop.hidden = !active; }
	setVisible(visible: boolean): void { this.element.hidden = !visible; this.drop.hidden = true; }
	setInboxActionBusy(action: InboxAction, busy: boolean): void { this.profile.setInboxActionBusy(action, busy); }
	focusSettings(): void { this.settingsButton.focus({ preventScroll: true }); }
	closePicker(): void { this.picker.close(); }
	refreshLibraryActivity(): void {
		if (this.active === 'library' && !this.element.hidden && !document.hidden) { void this.library.refreshActivity(); }
	}
	refreshSocial(): void { void this.profile.refresh(); }
	refreshDirectory(): void { this.profile.refreshDirectory(); }
	showSocial(section: 'activity' | 'people' | 'favorites'): void { this.select('profile'); this.profile.select(section); }
	showImportedProjects(singleUri?: string): void { this.library.resetFilters(); this.select('library', singleUri); }
	update(state: LaunchpadState): void {
		const previous = this.state; this.state = state;
		this.consoleButton.hidden = !state.platform;
		if (previous?.account?.scopeKey !== state.account?.scopeKey || previous?.account?.signedIn !== state.account?.signedIn) { this.picker.close(); }
		if (!previous || JSON.stringify(previous.account) !== JSON.stringify(state.account)) { this.accountButton.replaceChildren(avatar(state.account?.name ?? '', state.account?.avatarUrl)); }
		const notice = state.platform && state.account?.signedIn ? state.inbox?.latestNotice : undefined;
		this.latestNotice.hidden = !notice?.conversation;
		const preview = notice ? `${notice.title}${notice.detail ? `: ${notice.detail}` : ''}` : '';
		if (this.noticeContent.textContent !== preview) { this.noticeContent.textContent = this.latestNotice.title = preview; }
		this.bell.classList.toggle('lp-has-unread', state.notificationUnread);
		this.library.update(state.recent, state.windows, state.canCreate, state.platform && state.account?.signedIn ? state.account.scopeKey ?? 'signed-in' : '', state.libraryCategory);
		this.store.update(this.active === 'store', state.platform, state.account?.scopeKey ?? state.account?.storeScopeKey, state.store?.items ?? []);
		this.profile.update(this.active === 'profile', state.platform, state.account, state.inbox, state.notices, state.notificationUnread);
		if (this.picker.dialog.open) { this.picker.update(); }
	}
}
