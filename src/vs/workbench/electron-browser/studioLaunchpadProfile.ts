/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { picture } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

export interface LaunchpadAccount { name: string; email?: string | null; avatarUrl?: string; scopeKey?: string; storeScopeKey?: string; statusLabel?: string; hasAccount: boolean; signedIn: boolean }
interface NamedIdentity { name: string; avatarUrl?: string; badge?: string }
export interface LaunchpadInbox { connection?: 'connected' | 'offline' | 'connecting' | 'guest'; message?: string; items: (NamedIdentity & { id?: string; preview: string; unread: number; time?: number; group?: boolean })[] }
export interface StudioPerson extends NamedIdentity { id: string; relation?: 'friend' | 'incoming' | 'outgoing' }
export interface StudioFavorite { id: string; title: string; detail?: string; conversation?: string }
export interface StudioNotice { id: string; title: string; source: 'studio' | 'im'; read: boolean; conversation?: string; inviteId?: string; legacyInvite?: boolean; avatarUrl?: string }
export interface SocialSnapshot { people: StudioPerson[]; favorites: StudioFavorite[]; notices: StudioNotice[] }
export type SocialResult = SocialSnapshot | { unavailable: 'unsupported' };
export interface SocialAction { action: 'accept-invite' | 'decline-invite' | 'remove' | 'unfavorite' | 'read'; id: string }
export interface ProfileActions {
	settings(): void; signIn(): void; inbox(id?: string): void; chatUser(id: string): void;
	addContact(): void;
	confirmRemoveFriend(name: string): Promise<boolean>;
	social(query: string): Promise<SocialResult>; change(action: SocialAction): Promise<void>;
}
export function avatar(name: string, src?: string): HTMLElement {
	const mark = element('span', 'lp-avatar');
	const fallback = name ? element('span', '', Array.from(name)[0]) : icon('account');
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

function tool(label: string, glyph: string, action: () => void): HTMLButtonElement {
	const b = button('', glyph, action, 'lp-profile-tool'); b.title = label; b.setAttribute('aria-label', label); return b;
}

function row(identity: string | NamedIdentity, detail: string, mark: HTMLElement, ...buttons: HTMLButtonElement[]): HTMLLIElement {
	const item = element('li', 'lp-social-row'), text = element('div', 'lp-social-text');
	const name = element('strong', '', typeof identity === 'string' ? identity : identity.name);
	if (typeof identity !== 'string' && identity.badge) {
		const title = element('div', 'lp-social-title'), badge = element('span', 'lp-social-badge');
		if (identity.avatarUrl?.startsWith('data:image/')) { badge.append(picture(identity.avatarUrl)); }
		badge.append(identity.badge);
		title.append(name, badge); text.append(title);
	} else { text.append(name); }
	if (detail) { text.append(element('small', '', detail)); }
	item.append(mark, text);
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
	private readonly search = element('label', 'lp-search-field');
	private readonly filter = element('input', 'lp-query');
	private readonly peopleTools = element('div', 'lp-social-actions');
	private readonly addContact: HTMLButtonElement;
	private readonly status = element('div', 'lp-message lp-profile-status');
	private readonly debounce = this._register(new RunOnceScheduler(() => void this.load(), 220));
	// The default snapshot serves all sections. Keep at most one additional friend search, in memory only.
	private readonly cache = new Map<string, { snapshot: SocialSnapshot; generation: number }>();
	private generation = 0;
	private pending?: { query: string; generation: number };
	private failure?: { query: string; reason: Failure };
	private changing = new Set<string>();
	private scope?: string;
	private active = false;
	private section: Section = 'activity';
	private inbox?: LaunchpadInbox;
	private nativeNotices: StudioNotice[] = [];
	private platform = false;
	private account?: LaunchpadAccount;

	constructor(private readonly t: LaunchpadLabel, private readonly actions: ProfileActions, private readonly readNative: (id: string) => void) {
		super();
		this.status.setAttribute('role', 'status'); this.filter.type = 'search'; this.filter.maxLength = 100;
		this.filter.placeholder = t('Search friends', '搜索好友'); this.filter.setAttribute('aria-label', this.filter.placeholder);
		this.search.append(icon('search'), this.filter);
		this.addContact = button(t('Add friend', '添加好友'), 'add', this.actions.addContact, 'lp-primary');
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
		const title = element('div', 'lp-profile-title'); title.append(this.heading, this.count); toolbar.append(title, this.peopleTools);
		rail.append(this.header, this.nav); body.append(toolbar, this.status, this.rows, this.empty); this.content.append(body); this.element.append(rail, this.content);
	}

	setInboxBusy(busy: boolean): void { this.addContact.disabled = busy; }

	select(section: Section): void {
		if (this.section === section || (!this.platform && section !== 'notifications')) { return; }
		this.debounce.cancel(); this.section = section; this.failure = undefined;
		if (section === 'activity' || this.pending?.query !== this.query) { this.pending = undefined; }
		this.renderSection(); this.content.scrollTop = 0;
		void this.load();
	}
	update(active: boolean, platform: boolean, account: LaunchpadAccount | undefined, inbox: LaunchpadInbox | undefined, notices: StudioNotice[]): void {
		const scope = JSON.stringify([platform, account?.signedIn, account?.scopeKey ?? account?.email ?? account?.name]);
		const changed = this.scope !== scope, enter = active && !this.active;
		const identityChanged = changed || JSON.stringify(this.account) !== JSON.stringify(account);
		const repaint = changed || enter || (this.section === 'activity' && inbox !== this.inbox) || (this.section === 'notifications' && JSON.stringify(notices) !== JSON.stringify(this.nativeNotices));
		if (!platform) { this.section = 'notifications'; } else if (!this.platform) { this.section = 'activity'; }
		this.active = active; this.platform = platform; this.account = account; this.inbox = inbox; this.nativeNotices = notices;
		if (changed) { this.pending = undefined; this.cache.clear(); this.changing = new Set(); this.debounce.cancel(); this.failure = undefined; this.scope = scope; this.filter.value = ''; }
		if (identityChanged) { this.renderAccount(); }
		if (changed || (active && repaint)) { this.renderSection(); }
		if (active && (enter || changed)) { this.refresh(); }
	}

	private get query(): string { return this.section === 'people' ? this.filter.value.trim() : ''; }
	refresh(): void { ++this.generation; this.pending = undefined; this.debounce.schedule(); }

	private async load(): Promise<void> {
		if (!this.active || !this.platform || !this.account?.signedIn || this.section === 'activity') { return; }
		const query = this.query, generation = this.generation;
		if (this.cache.get(query)?.generation === generation || (this.pending?.query === query && this.pending.generation === generation)) { return; }
		const request = this.pending = { query, generation };
		try {
			const result = await this.actions.social(query);
			if (this.pending !== request) { return; }
			if ('unavailable' in result) { this.failure = { query, reason: result.unavailable }; }
			else {
				if (query) { for (const key of this.cache.keys()) { if (key && key !== query) { this.cache.delete(key); } } }
				this.cache.set(query, { snapshot: { ...result, people: result.people.filter(p => p.relation === 'friend') }, generation }); this.failure = undefined;
			}
		} catch {
			if (this.pending !== request) { return; }
			this.failure = { query, reason: 'unavailable' };
		}
		this.pending = undefined;
		if (this.active && this.query === query) { this.renderRows(); }
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

	private renderAccount(): void {
		const t = this.t, a = this.account;
		const name = a?.hasAccount ? a.name : this.platform ? t('Not signed in', '尚未登录') : t('Local profile', '本机用户');
		const identity = element('div', 'lp-profile-identity'); identity.append(element('strong', '', name));
		if (a?.email) { identity.append(element('small', '', a.email)); }
		this.header.replaceChildren(avatar(name, a?.avatarUrl), identity, tool(t('Settings', '设置'), 'settings-gear', this.actions.settings));
		if (this.platform && !a?.signedIn) { this.header.append(button(t('Sign in', '登录'), 'sign-in', this.actions.signIn, 'lp-primary')); }
	}

	private renderSection(): void {
		for (const [id, b] of this.tabs) {
			const selected = this.section === id; b.hidden = !this.platform && id !== 'notifications'; b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1;
			if (selected) { this.heading.textContent = b.title; this.content.setAttribute('aria-labelledby', b.id); }
		}
		this.peopleTools.hidden = this.section !== 'people' || !this.platform || !this.account?.signedIn;
		this.renderRows();
	}

	private renderRows(): void {
		const t = this.t, needsSocial = this.section !== 'activity' && this.platform && !!this.account?.signedIn;
		const query = this.query, data = this.cache.get(query)?.snapshot;
		const failure = this.failure?.query === query ? this.failure.reason : undefined;
		const friends = data?.people ?? (query ? this.cache.get('')?.snapshot.people.filter(p => p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : undefined);
		this.status.replaceChildren();
		if (needsSocial) {
			if (failure === 'change') { this.status.textContent = t('Change could not be saved.', '更改未能保存。'); }
			else if (failure) {
				const message = failure === 'unsupported'
					? t('This server does not provide Studio social data. Check the server version and retry.', '当前服务器未提供 Studio 社交接口，请确认服务器版本后重试。')
					: t('Studio social data is unavailable.', '暂时无法读取 Studio 社交数据。');
				this.status.append(icon('warning'), message, button(t('Retry', '重试'), 'refresh', () => this.refresh()));
			} else if (!data && !friends?.length) { this.status.textContent = t('Loading…', '正在加载…'); }
		}
		const items: HTMLLIElement[] = [];
		const change = (label: string, glyph: string, action: SocialAction) => { const b = button(label, glyph, () => void this.mutate(action)); b.disabled = this.changing.has(action.id); return b; };
		if (this.section === 'activity') {
			for (const c of this.inbox?.items ?? []) {
				const item = row(c, c.preview, avatar(c.name, c.avatarUrl), button(t('Chat', '聊天'), 'comment', () => this.actions.inbox(c.id), 'lp-outline'));
				if (c.unread) { const unread = element('span', 'lp-unread-count', String(c.unread)); unread.title = t(`${c.unread} unread`, `${c.unread} 条未读`); item.lastElementChild?.prepend(unread); }
				items.push(item);
			}
		} else if (this.section === 'people') {
			for (const p of friends ?? []) {
				const remove = tool(t('Remove friend', '移除好友'), 'trash', () => void this.removeFriend(p)); remove.disabled = this.changing.has(p.id);
				items.push(row(p, '', avatar(p.name, p.avatarUrl), button(t('Chat', '聊天'), 'comment', () => this.actions.chatUser(p.id), 'lp-outline'), remove));
			}
		} else if (this.section === 'favorites') {
			for (const f of data?.favorites ?? []) { items.push(row(f.title, f.detail ?? '', icon('star-full'), ...(f.conversation ? [button(t('Open chat', '打开会话'), 'comment', () => this.actions.inbox(f.conversation), 'lp-outline')] : []), change(t('Remove', '移除'), 'remove', { action: 'unfavorite', id: f.id }))); }
		} else {
			for (const n of [...this.nativeNotices, ...data?.notices ?? []]) {
				const controls = n.conversation || n.source === 'im' ? [button(t('Open chat', '打开会话'), 'comment', () => this.actions.inbox(n.conversation), 'lp-outline')] : [];
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
		this.rows.replaceChildren(...items);
		this.count.textContent = String(items.length); this.count.hidden = !items.length;
		this.empty.hidden = items.length > 0 || (needsSocial && (!data || !!failure));
		if (!this.empty.hidden) {
			const guest = this.platform && !this.account?.signedIn;
			const label = this.section === 'people' ? guest ? t('Sign in to see your friends.', '登录后可查看好友。') : query ? t('No matching friends.', '没有匹配的好友。') : t('No friends yet.', '暂无好友。')
				: this.section === 'favorites' ? guest ? t('Sign in to see your favorites.', '登录后可查看收藏。') : t('No favorites yet.', '暂无收藏。')
					: this.section === 'activity' ? this.inbox?.message || t('No recent chats.', '暂无最近会话。') : t('No notifications.', '暂无通知。');
			this.empty.replaceChildren(icon(this.section === 'people' ? query ? 'search' : 'organization' : this.section === 'favorites' ? 'star-empty' : this.section === 'activity' ? 'comment-discussion' : 'bell'), element('p', '', label));
		}
	}

	private async removeFriend(person: StudioPerson): Promise<void> {
		const owner = this.changing;
		if (await this.actions.confirmRemoveFriend(person.name) && owner === this.changing) { await this.mutate({ action: 'remove', id: person.id }); }
	}
	override dispose(): void { this.active = false; this.pending = undefined; this.changing = new Set(); super.dispose(); }
}
