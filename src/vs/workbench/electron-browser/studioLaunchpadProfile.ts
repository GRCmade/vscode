/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { IAction, Separator, toAction } from '../../base/common/actions.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { picture } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel, LaunchpadPicker } from './studioLaunchpadPicker.js';

export interface LaunchpadAccount { name: string; email?: string | null; avatarUrl?: string; scopeKey?: string; storeScopeKey?: string; statusLabel?: string; hasAccount: boolean; signedIn: boolean }
interface NamedIdentity { name: string; avatarUrl?: string; badge?: string }
interface ConversationState { id: string; peerId?: string; unread: number; time?: number; pinned?: boolean; starred?: boolean; muted?: boolean }
interface RecentChat extends NamedIdentity, ConversationState { preview: string; group?: boolean }
export interface LaunchpadInbox { connection?: 'connected' | 'offline' | 'connecting' | 'guest'; message?: string; items: RecentChat[]; latestNotice?: StudioNotice }
export interface StudioPerson extends NamedIdentity { id: string; relation?: 'friend' | 'incoming' | 'outgoing' }
interface StudioGroup extends NamedIdentity { id: string; conversation: string; members?: number }
export interface LaunchpadDirectory { groups: StudioGroup[]; conversations: ConversationState[] }
export interface StudioFavorite { id: string; title: string; detail?: string; conversation?: string }
export interface StudioNotice { id: string; title: string; source: 'studio' | 'im'; read: boolean; conversation?: string; inviteId?: string; legacyInvite?: boolean; avatarUrl?: string; time?: number; detail?: string }
export interface SocialSnapshot { people: StudioPerson[]; favorites: StudioFavorite[]; notices: StudioNotice[]; directory?: LaunchpadDirectory; directoryUnavailable?: boolean }
export type SocialResult = SocialSnapshot | { unavailable: 'unsupported' };
export interface SocialAction { action: 'accept-invite' | 'decline-invite' | 'remove' | 'unfavorite' | 'read'; id: string }
export interface ConversationAction { setting: 'pin' | 'star' | 'mute' | 'read' | 'hide'; id: string; value: boolean }
export type InboxAction = 'add-contact' | 'create-group';
export interface ProfileActions {
	signIn(): void; inbox(id: string, title?: string): void; chatUser(id: string, title?: string): void;
	addContact(): void; createGroup(): void;
	contextMenu: IContextMenuService;
	confirmRemoveFriend(name: string): Promise<boolean>;
	social(query: string, directory: boolean): Promise<SocialResult>; change(action: SocialAction): Promise<void>;
	changeConversation(action: ConversationAction): Promise<void>;
	readAllNotices(): Promise<void>;
}
export function avatar(name: string, src?: string, glyph = 'account'): HTMLElement {
	const mark = element('span', 'lp-avatar');
	const fallback = glyph !== 'account' || !name ? icon(glyph) : element('span', '', Array.from(name)[0]);
	mark.append(fallback);
	if (src && /^(?:https?:\/\/|data:image\/)/i.test(src)) {
		const img = picture(src);
		img.addEventListener('load', () => { fallback.hidden = true; }, { once: true });
		img.addEventListener('error', () => { img.remove(); }, { once: true });
		fallback.hidden = img.complete && img.naturalWidth > 0;
		mark.append(img);
	}
	return mark;
}

type Section = 'activity' | 'people' | 'favorites' | 'notifications';
type Failure = 'unsupported' | 'unavailable' | 'change';

function socialText(name: string, detail: string): HTMLElement {
	const text = element('span', 'lp-social-text');
	text.append(element('strong', '', name));
	if (detail) { text.append(element('small', '', detail)); }
	return text;
}

function row(name: string, detail: string, mark: HTMLElement, ...buttons: HTMLButtonElement[]): HTMLLIElement {
	const item = element('li', 'lp-social-row');
	item.append(mark, socialText(name, detail));
	if (buttons.length) { const actions = element('div', 'lp-social-actions'); actions.append(...buttons); item.append(actions); }
	return item;
}

export class LaunchpadProfile extends Disposable {
	readonly element = element('div', 'lp-profile');
	private readonly header = element('header', 'lp-profile-header');
	private readonly nav = element('div', 'lp-profile-nav');
	private readonly tabs = new Map<Section, HTMLButtonElement>();
	private readonly content = element('section', 'lp-profile-content lp-scroll');
	private readonly heading = element('h1');
	private readonly count = element('span', 'lp-profile-count');
	private readonly rows = element('ul', 'lp-profile-rows');
	private readonly empty = element('div', 'lp-profile-empty');
	private readonly recentTools = element('div', 'lp-recent-tools');
	private readonly recentSearch = element('label', 'lp-search-field lp-recent-search');
	private readonly recentFilter = element('input', 'lp-query');
	private readonly searchChats: HTMLButtonElement;
	private readonly createGroup: HTMLButtonElement;
	private readonly search = element('label', 'lp-search-field');
	private readonly filter = element('input', 'lp-query');
	private readonly peopleTools = element('div', 'lp-social-actions');
	private readonly addContact: HTMLButtonElement;
	private readonly readAll: HTMLButtonElement;
	private readonly status = element('div', 'lp-message lp-profile-status');
	private readonly debounce = this._register(new RunOnceScheduler(() => void this.load(), 220));
	private readonly filterChats = this._register(new RunOnceScheduler(() => {
		if (this.active && this.section === 'activity') { this.renderRows(); this.content.scrollTop = 0; }
	}, 120));
	// The default snapshot serves all sections. Keep at most one additional friend search, in memory only.
	private readonly cache = new Map<string, { snapshot: SocialSnapshot; generation: number; directory: boolean }>();
	private generation = 0;
	private pending?: { query: string; generation: number; directory: boolean };
	private failure?: { query: string; reason: Failure };
	private changing = new Set<string>();
	private markingAll = false;
	private markAllFailed = false;
	private scope?: string;
	private active = false;
	private section: Section = 'activity';
	private inbox?: LaunchpadInbox;
	private nativeNotices: StudioNotice[] = [];
	private notificationUnread = false;
	private platform = false;
	private account?: LaunchpadAccount;

	constructor(private readonly t: LaunchpadLabel, private readonly actions: ProfileActions, private readonly readNative: (id: string) => void, private readonly picker: LaunchpadPicker) {
		super();
		this.status.setAttribute('role', 'status'); this.filter.type = 'search'; this.filter.maxLength = 100;
		this.filter.placeholder = t('Search friends and groups', '搜索好友和群聊'); this.filter.setAttribute('aria-label', this.filter.placeholder);
		this.search.append(icon('search'), this.filter);
		const searchLabel = t('Search recent chats', '搜索最近会话');
		this.recentSearch.id = 'lp-recent-search'; this.recentSearch.hidden = true;
		this.recentFilter.type = 'search'; this.recentFilter.maxLength = 100;
		this.recentFilter.placeholder = searchLabel; this.recentFilter.setAttribute('aria-label', searchLabel);
		this.recentSearch.append(icon('search'), this.recentFilter);
		const recentTool = (label: string, glyph: string, action: () => void) => {
			const b = button('', glyph, action); b.title = label; b.setAttribute('aria-label', label); return b;
		};
		this.searchChats = recentTool(searchLabel, 'search', () => this.toggleRecentSearch(this.recentSearch.hidden === true));
		this.searchChats.setAttribute('aria-controls', this.recentSearch.id); this.searchChats.setAttribute('aria-expanded', 'false');
		this.createGroup = recentTool(t('Start a group chat', '发起群聊'), 'new-session', this.actions.createGroup);
		this.recentTools.hidden = true; this.recentTools.append(this.searchChats, this.createGroup);
		this.recentFilter.addEventListener('input', e => { if (!(e as InputEvent).isComposing) { this.filterChats.schedule(); } });
		this.recentFilter.addEventListener('compositionend', () => this.filterChats.schedule());
		this.recentFilter.addEventListener('keydown', e => {
			if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); this.toggleRecentSearch(false); }
		});
		this.addContact = button(t('Add friend', '添加好友'), 'add', this.actions.addContact, 'lp-primary');
		this.readAll = button(t('Mark all as read', '全部已读'), 'check-all', () => void this.markAllRead(), 'lp-outline');
		this.readAll.hidden = true;
		this.peopleTools.hidden = true;
		this.peopleTools.append(this.search, this.addContact);
		this.filter.addEventListener('input', () => { if (this.pending?.query !== this.query) { this.pending = undefined; } this.failure = undefined; this.renderRows(); this.debounce.schedule(); });
		this.content.id = 'lp-profile-section'; this.content.setAttribute('role', 'tabpanel'); this.content.tabIndex = 0;
		this.nav.setAttribute('role', 'tablist'); this.nav.setAttribute('aria-label', t('My Studio sections', '我的分区'));
		for (const [id, title, short, glyph] of [
			['activity', t('Recent chats', '最近会话'), t('Chats', '会话'), 'comment-discussion'],
			['people', t('Contacts & friends', '通讯录与好友'), t('Friends', '好友'), 'organization'],
			['favorites', t('Favorites', '收藏'), t('Favorites', '收藏'), 'star-empty'],
			['notifications', t('Notifications', '通知'), t('Notices', '通知'), 'bell'],
		] as const) {
			const b = button('', glyph, () => this.select(id)); b.append(element('span', 'lp-profile-label', title), element('span', 'lp-profile-short', short));
			b.id = `lp-profile-tab-${id}`; b.title = title; b.setAttribute('aria-label', title); b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', this.content.id);
			this.tabs.set(id, b); this.nav.append(b);
		}
		const narrow = mainWindow.matchMedia('(max-width: 700px)');
		const orient = () => this.nav.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
		orient(); narrow.addEventListener('change', orient); this._register(toDisposable(() => narrow.removeEventListener('change', orient)));
		this.nav.addEventListener('keydown', e => {
			const ids = [...this.tabs.keys()].filter(id => !this.tabs.get(id)!.hidden), i = ids.indexOf(this.section);
			const prev = narrow.matches ? 'ArrowLeft' : 'ArrowUp', next = narrow.matches ? 'ArrowRight' : 'ArrowDown';
			if (i < 0 || ![prev, next, 'Home', 'End'].includes(e.key)) { return; }
			e.preventDefault(); const id = ids[e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === prev ? -1 : 1) + ids.length) % ids.length];
			this.select(id); this.tabs.get(id)!.focus();
		});
		const rail = element('aside', 'lp-profile-rail lp-scroll'), body = element('div', 'lp-profile-body'), toolbar = element('header', 'lp-profile-toolbar');
		const title = element('div', 'lp-profile-title'); title.append(this.heading, this.count); toolbar.append(title, this.recentTools, this.peopleTools, this.readAll);
		rail.append(this.header, this.nav); body.append(toolbar, this.recentSearch, this.status, this.rows, this.empty); this.content.append(body); this.element.append(rail, this.content);
	}

	setInboxActionBusy(action: InboxAction, busy: boolean): void { (action === 'add-contact' ? this.addContact : this.createGroup).disabled = busy; }

	private toggleRecentSearch(open: boolean, focus = true): void {
		this.recentSearch.hidden = !open; this.searchChats.setAttribute('aria-expanded', String(open));
		if (!open) { this.filterChats.cancel(); this.recentFilter.value = ''; }
		if (focus) {
			(open ? this.recentFilter : this.searchChats).focus();
			if (!open) { this.renderRows(); }
		}
	}

	select(section: Section): void {
		if (this.section === section || (!this.platform && section !== 'notifications')) { return; }
		if (this.section === 'activity') { this.toggleRecentSearch(false, false); }
		this.debounce.cancel(); this.section = section; this.failure = undefined;
		if (section === 'activity' || this.pending?.query !== this.query || this.pending.directory !== (section === 'people')) { this.pending = undefined; }
		this.renderSection(); this.content.scrollTop = 0;
		void this.load();
	}
	update(active: boolean, platform: boolean, account: LaunchpadAccount | undefined, inbox: LaunchpadInbox | undefined, notices: StudioNotice[], notificationUnread: boolean): void {
		const scope = JSON.stringify([platform, account?.signedIn, account?.scopeKey ?? account?.email ?? account?.name]);
		const changed = this.scope !== scope, enter = active && !this.active;
		const identityChanged = changed || JSON.stringify(this.account) !== JSON.stringify(account);
		const repaint = changed || enter || (this.section === 'activity' && inbox !== this.inbox) || (this.section === 'notifications' &&
			(notificationUnread !== this.notificationUnread || JSON.stringify(notices) !== JSON.stringify(this.nativeNotices)));
		if (!platform) { this.section = 'notifications'; } else if (!this.platform) { this.section = 'activity'; }
		this.active = active; this.platform = platform; this.account = account; this.inbox = inbox; this.nativeNotices = notices; this.notificationUnread = notificationUnread;
		if (changed) { this.pending = undefined; this.cache.clear(); this.changing = new Set(); this.markingAll = this.markAllFailed = false; this.debounce.cancel(); this.failure = undefined; this.scope = scope; this.filter.value = ''; this.toggleRecentSearch(false, false); }
		if (identityChanged) { this.renderAccount(); }
		if (changed || (active && repaint)) { this.renderSection(); }
		if (active && (enter || changed)) { this.refresh(); }
	}

	private get query(): string { return this.section === 'people' ? this.filter.value.trim() : ''; }
	refresh(): void { ++this.generation; this.pending = undefined; this.debounce.schedule(); }

	private async load(): Promise<void> {
		if (!this.active || !this.platform || !this.account?.signedIn || this.section === 'activity') { return; }
		const query = this.query, generation = this.generation, directory = this.section === 'people';
		const cached = this.cache.get(query);
		if ((cached?.generation === generation && (!directory || cached.directory)) ||
			(this.pending?.query === query && this.pending.generation === generation && (!directory || this.pending.directory))) { return; }
		const request = this.pending = { query, generation, directory };
		try {
			const result = await this.actions.social(query, directory);
			if (this.pending !== request) { return; }
			if ('unavailable' in result) { this.failure = { query, reason: result.unavailable }; }
			else {
				if (query) { for (const key of this.cache.keys()) { if (key && key !== query) { this.cache.delete(key); } } }
				this.cache.set(query, { snapshot: { ...result, directory: result.directory ?? cached?.snapshot.directory, people: result.people.filter(p => p.relation === 'friend') }, generation, directory }); this.failure = undefined;
			}
		} catch {
			if (this.pending !== request) { return; }
			this.failure = { query, reason: 'unavailable' };
		}
		this.pending = undefined;
		if (this.active && this.query === query) { this.renderRows(); }
	}

	refreshDirectory(): void { if (this.active && this.section === 'people') { this.refresh(); } }

	private entries(identity: NamedIdentity, preview: string, key: string, open: () => void, state?: ConversationState, contact?: StudioPerson | StudioGroup, group = false): HTMLLIElement {
		const t = this.t;
		const item = element('li', 'lp-conversation-row');
		const activate = button('', '', () => {
			const selection = mainWindow.getSelection();
			if (!selection?.isCollapsed && selection?.anchorNode && activate.contains(selection.anchorNode)) { return; }
			open();
		}, 'lp-conversation-open');
		activate.dataset.key = key;
		activate.setAttribute('aria-haspopup', 'menu');
		const meta = element('span', 'lp-conversation-meta');
		const badges = element('span', 'lp-conversation-badges');
		const statusIcon = (glyph: string, label: string) => {
			const mark = icon(glyph); mark.title = label; mark.setAttribute('aria-label', label); mark.setAttribute('aria-hidden', 'false'); badges.append(mark);
		};
		if (identity.badge) {
			const badge = element('span', 'lp-social-badge');
			if (identity.avatarUrl?.startsWith('data:image/')) { badge.append(picture(identity.avatarUrl)); }
			badge.append(identity.badge); badges.append(badge);
		}
		if (group) { statusIcon('organization', t('Group chat', '群聊')); }
		if (state?.pinned) { statusIcon('pinned', t('Pinned', '已置顶')); }
		if (state?.starred) { statusIcon('star-full', t('Starred', '已加星标')); }
		if (state?.muted) { statusIcon('bell-slash', t('Muted', '免打扰')); }
		if (state?.unread) {
			const unread = element('span', 'lp-unread-count', state.unread > 99 ? '99+' : String(state.unread));
			unread.title = t(`${state.unread} unread`, `${state.unread} 条未读`); badges.append(unread);
		}
		if (state?.time) {
			const date = new Date(state.time), now = new Date(), language = t('en', 'zh-CN');
			if (Number.isFinite(date.getTime())) {
				const today = date.toDateString() === now.toDateString();
				const options: Intl.DateTimeFormatOptions = today ? { hour: 'numeric', minute: '2-digit' }
					: { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
				const time = element('time', '', date.toLocaleString(language, options));
				time.dateTime = date.toISOString(); time.title = date.toLocaleString(language); meta.append(time);
			}
		}
		if (badges.childElementCount) { meta.append(badges); }
		activate.append(group && !identity.avatarUrl ? avatar('', undefined, 'organization') : avatar(identity.name, identity.avatarUrl), socialText(identity.name, preview));
		if (meta.childElementCount) { activate.append(meta); }
		item.append(activate);
		const menu = (point?: { x: number; y: number }) => this.showConversationMenu(identity, activate, open, state, contact, point);
		activate.addEventListener('contextmenu', e => {
			e.preventDefault(); e.stopPropagation(); activate.focus({ preventScroll: true });
			menu(e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined);
		});
		activate.addEventListener('keydown', e => {
			if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); e.stopPropagation(); menu(); }
		});
		return item;
	}

	private showConversationMenu(identity: NamedIdentity, origin: HTMLElement, open: () => void, state?: ConversationState, contact?: StudioPerson | StudioGroup, point?: { x: number; y: number }): void {
		const t = this.t, scope = this.changing;
		const action = (id: string, label: string, run: () => void | Promise<void>) => toAction({ id: `studio.social.${id}`, label, run: () => { if (scope === this.changing) { return run(); } } });
		const items: IAction[] = [action('open', t('Open conversation', '打开会话'), open)];
		if (state) {
			const toggle = (setting: ConversationAction['setting'], label: string, value: boolean) => action(setting, label, () => this.changeConversation({ id: state.id, setting, value }));
			items.push(new Separator(), toggle('pin', state.pinned ? t('Unpin', '取消置顶') : t('Pin', '置顶'), !state.pinned),
				toggle('star', state.starred ? t('Remove star', '取消星标') : t('Star', '加星标'), !state.starred),
				toggle('read', state.unread ? t('Mark as read', '标为已读') : t('Mark as unread', '标为未读'), !!state.unread),
				toggle('mute', state.muted ? t('Unmute', '取消免打扰') : t('Mute', '消息免打扰'), !state.muted));
			if (!contact) { items.push(toggle('hide', t('Hide conversation', '从最近会话中移除'), true)); }
		}
		if (contact) {
			const group = 'conversation' in contact;
			const title = group ? t('Group info', '群聊信息') : t('Friend info', '好友资料');
			items.push(new Separator(), action('info', group ? t('View group info', '查看群聊信息') : t('View friend info', '查看好友资料'), () => {
				const detail = element('span', 'lp-contact-detail');
				const description = group ? (contact.members !== undefined ? t(`${contact.members} members`, `${contact.members} 位成员`) : t('Group chat', '群聊')) : contact.badge ?? t('Friend', '好友');
				detail.append(avatar(identity.name, identity.avatarUrl, group ? 'organization' : undefined), socialText(identity.name, description),
					element('small', 'lp-contact-id', `${group ? t('Group ID', '群 ID') : t('User ID', '用户 ID')}: ${contact.id}`));
				this.picker.choices(title, [{ label: t('Open conversation', '打开会话'), glyph: 'comment', run: open }], origin, detail);
			}));
			if (!group) { items.push(action('remove', t('Remove friend…', '删除好友…'), () => this.removeFriend(contact))); }
		}
		this.actions.contextMenu.showContextMenu({ getAnchor: () => point ?? origin, getActions: () => items, autoSelectFirstItem: !point });
	}

	private async changeConversation(action: ConversationAction): Promise<void> {
		const changing = this.changing;
		if (changing.has(action.id)) { return; }
		changing.add(action.id);
		try {
			await this.actions.changeConversation(action);
			if (changing === this.changing) { this.failure = undefined; }
		} catch {
			if (changing === this.changing) {
				this.failure = { query: this.query, reason: 'change' }; this.renderRows();
			}
		} finally { changing.delete(action.id); }
	}

	private async mutate(action: SocialAction): Promise<void> {
		const changing = this.changing, section = this.section;
		if (changing.has(action.id)) { return; }
		changing.add(action.id); this.renderRows();
		try {
			await this.actions.change(action);
			if (changing !== this.changing) { return; }
			for (const { snapshot } of this.cache.values()) {
				if (action.action === 'remove') { snapshot.people = snapshot.people.filter(p => p.id !== action.id); }
				if (action.action === 'unfavorite') { snapshot.favorites = snapshot.favorites.filter(f => f.id !== action.id); }
				if (action.action === 'read' || action.action.endsWith('-invite')) {
					snapshot.notices = snapshot.notices.map(n => n.id === action.id || n.inviteId === action.id ? { ...n, read: true, inviteId: action.action === 'read' ? n.inviteId : undefined } : n);
				}
			}
			this.failure = undefined; this.refresh();
		} catch { if (changing === this.changing && section === this.section) { this.failure = { query: this.query, reason: 'change' }; } }
		finally { changing.delete(action.id); if (changing === this.changing && this.active) { this.renderRows(); } }
	}

	private async markAllRead(): Promise<void> {
		if (this.markingAll) { return; }
		const owner = this.changing;
		const existing = new Set([...this.cache.values()].flatMap(({ snapshot }) => snapshot.notices.map(notice => notice.id)));
		this.markingAll = true; this.markAllFailed = false; this.renderRows();
		try {
			await this.actions.readAllNotices();
			if (owner !== this.changing) { return; }
			for (const { snapshot } of this.cache.values()) {
				snapshot.notices = snapshot.notices.map(notice => existing.has(notice.id) ? { ...notice, read: true } : notice);
			}
			this.failure = undefined;
		} catch {
			if (owner === this.changing) { this.markAllFailed = true; }
		} finally {
			if (owner === this.changing) {
				this.markingAll = false;
				this.refresh();
				if (this.active) { this.renderRows(); }
			}
		}
	}

	private renderAccount(): void {
		const t = this.t, a = this.account;
		const name = a?.hasAccount ? a.name : this.platform ? t('Not signed in', '尚未登录') : t('Local profile', '本机用户');
		const identity = element('div', 'lp-profile-identity'); identity.append(element('strong', '', name));
		if (a?.email) { identity.append(element('small', '', a.email)); }
		this.header.replaceChildren(avatar(name, a?.avatarUrl), identity);
		if (this.platform && !a?.signedIn) { this.header.append(button(t('Sign in', '登录'), 'sign-in', this.actions.signIn, 'lp-primary')); }
	}

	private renderSection(): void {
		for (const [id, b] of this.tabs) {
			const selected = this.section === id; b.hidden = !this.platform && id !== 'notifications'; b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1;
			if (selected) { this.heading.textContent = b.title; this.content.setAttribute('aria-labelledby', b.id); }
		}
		this.peopleTools.hidden = this.section !== 'people' || !this.platform || !this.account?.signedIn;
		this.recentTools.hidden = this.section !== 'activity' || !this.platform || !this.account?.signedIn;
		this.renderRows();
	}

	private renderRows(): void {
		const t = this.t, needsSocial = this.section !== 'activity' && this.platform && !!this.account?.signedIn;
		const recentQuery = this.section === 'activity' ? this.recentFilter.value.trim().toLocaleLowerCase() : '';
		const query = this.query, data = this.cache.get(query)?.snapshot;
		const directory = data?.directory ?? this.cache.get('')?.snapshot.directory;
		const directoryUnavailable = this.section === 'people' && data?.directoryUnavailable;
		this.readAll.hidden = this.section !== 'notifications';
		this.readAll.disabled = this.markingAll || !(this.markAllFailed || this.notificationUnread || data?.notices.some(notice => !notice.read));
		const failure = this.failure?.query === query ? this.failure.reason : undefined;
		const friends = data?.people ?? (query ? this.cache.get('')?.snapshot.people.filter(p => p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : undefined);
		this.status.replaceChildren();
		if (this.section === 'notifications' && this.markAllFailed) {
			this.status.textContent = t('Could not mark all notifications as read. Try again.', '未能将所有通知标为已读，请重试。');
		} else if (failure === 'change') {
			this.status.textContent = t('Change could not be saved.', '更改未能保存。');
		} else if (needsSocial) {
			if (failure) {
				const message = failure === 'unsupported'
					? t('This server does not provide Studio social data. Check the server version and retry.', '当前服务器未提供 Studio 社交接口，请确认服务器版本后重试。')
					: t('Studio social data is unavailable.', '暂时无法读取 Studio 社交数据。');
				this.status.append(icon('warning'), message, button(t('Retry', '重试'), 'refresh', () => this.refresh()));
			} else if (directoryUnavailable) {
				this.status.append(icon('warning'), t('Could not refresh groups.', '暂时无法刷新群聊。'), button(t('Retry', '重试'), 'refresh', () => this.refresh()));
			} else if (!data && !friends?.length) { this.status.textContent = t('Loading…', '正在加载…'); }
		}
		const items: HTMLLIElement[] = [];
		const change = (label: string, glyph: string, action: SocialAction) => { const b = button(label, glyph, () => void this.mutate(action)); b.disabled = this.changing.has(action.id); return b; };
		if (this.section === 'activity') {
			for (const c of this.inbox?.items ?? []) {
				if (recentQuery && !c.name.toLocaleLowerCase().includes(recentQuery) && !c.preview.toLocaleLowerCase().includes(recentQuery)) { continue; }
				items.push(this.entries(c, c.preview, c.id, () => this.actions.inbox(c.id, c.name), c, undefined, c.group));
			}
		} else if (this.section === 'people') {
			const byPeer = new Map(directory?.conversations.flatMap(c => c.peerId ? [[c.peerId, c] as const] : []));
			const byId = new Map(directory?.conversations.map(c => [c.id, c] as const));
			for (const p of friends ?? []) {
				const chat = byPeer.get(p.id);
				items.push(this.entries(p, '', 'person:' + p.id, () => chat ? this.actions.inbox(chat.id, p.name) : this.actions.chatUser(p.id, p.name), chat, p));
			}
			for (const g of directory?.groups ?? []) {
				if (query && !g.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !g.id.includes(query)) { continue; }
				const detail = g.members !== undefined ? t(`${g.members} members`, `${g.members} 位成员`) : '';
				items.push(this.entries(g, detail, 'group:' + g.id, () => this.actions.inbox(g.conversation, g.name), byId.get(g.conversation), g, true));
			}
		} else if (this.section === 'favorites') {
			for (const f of data?.favorites ?? []) {
				const id = f.conversation;
				items.push(row(f.title, f.detail ?? '', icon('star-full'), ...(id ? [button(t('Open chat', '打开会话'), 'comment', () => this.actions.inbox(id), 'lp-outline')] : []), change(t('Remove', '移除'), 'remove', { action: 'unfavorite', id: f.id })));
			}
		} else {
			for (const n of [...this.nativeNotices, ...data?.notices ?? []]) {
				const id = n.conversation;
				const controls = id ? [button(t('Open chat', '打开会话'), 'comment', () => this.actions.inbox(id), 'lp-outline')]
					: n.source === 'im' ? [button(t('View recent chats', '查看最近会话'), 'comment', () => this.select('activity'), 'lp-outline')] : [];
				if (n.inviteId && n.id === 'request:' + n.inviteId) {
					controls.push(change(t('Accept', '接受'), 'check', { action: 'accept-invite', id: n.inviteId }), change(t('Decline', '拒绝'), 'close', { action: 'decline-invite', id: n.inviteId }));
				}
				if (!n.read) { controls.push(this.nativeNotices.includes(n) ? button(t('Mark read', '标为已读'), 'check', () => this.readNative(n.id)) : change(t('Mark read', '标为已读'), 'check', { action: 'read', id: n.id })); }
				const isRequest = n.id.startsWith('request:');
				const title = n.id.startsWith('im-unread:') ? t(`${n.title} unread IM messages`, `${n.title} 条未读 IM 消息`) : isRequest ? t(`${n.title} sent you a friend request`, `${n.title} 请求添加你为好友`) : n.id.startsWith('friend:') ? t(`${n.title} accepted your request`, `${n.title} 已接受好友申请`) : n.title;
				const detail = n.legacyInvite ? t('Update the Studio server to respond to this request.', '更新 Studio 服务器后可处理此申请。') : n.source === 'im' ? 'IM' : 'Studio';
				const mark = isRequest ? avatar(n.title, n.avatarUrl) : icon(n.read ? 'mail-read' : 'mail');
				const item = row(title, detail, mark, ...controls); item.classList.toggle('lp-unread', !n.read); items.push(item);
			}
		}
		const focused = this.rows.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key : undefined;
		this.rows.replaceChildren(...items);
		if (focused) { Array.from(this.rows.querySelectorAll<HTMLButtonElement>('button[data-key]')).find(el => el.dataset.key === focused)?.focus({ preventScroll: true }); }
		this.count.textContent = String(items.length); this.count.hidden = !items.length;
		this.empty.hidden = items.length > 0 || (needsSocial && (!data || !!failure || !!directoryUnavailable));
		if (!this.empty.hidden) {
			const guest = this.platform && !this.account?.signedIn;
			const noRecentMatches = recentQuery && !!this.inbox?.items.length;
			const label = this.section === 'people' ? guest ? t('Sign in to see your friends and groups.', '登录后可查看好友和群聊。') : query ? t('No matching friends or groups.', '没有匹配的好友或群聊。') : t('No friends or groups yet.', '暂无好友或群聊。')
				: this.section === 'favorites' ? guest ? t('Sign in to see your favorites.', '登录后可查看收藏。') : t('No favorites yet.', '暂无收藏。')
					: this.section === 'activity' ? noRecentMatches ? t('No matching chats.', '没有匹配的会话。') : this.inbox?.message || t('No recent chats.', '暂无最近会话。') : t('No notifications.', '暂无通知。');
			this.empty.replaceChildren(icon(this.section === 'people' ? query ? 'search' : 'organization' : this.section === 'favorites' ? 'star-empty' : this.section === 'activity' ? noRecentMatches ? 'search' : 'comment-discussion' : 'bell'), element('p', '', label));
		}
	}

	private async removeFriend(person: StudioPerson): Promise<void> {
		const owner = this.changing;
		if (await this.actions.confirmRemoveFriend(person.name) && owner === this.changing) { await this.mutate({ action: 'remove', id: person.id }); }
	}
	override dispose(): void { this.active = false; this.pending = undefined; this.changing = new Set(); super.dispose(); }
}
