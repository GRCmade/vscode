/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { picture } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

export interface LaunchpadAccount { name: string; email?: string | null; avatarUrl?: string; scopeKey?: string; statusLabel?: string; hasAccount: boolean; signedIn: boolean }
export interface LaunchpadInbox { connection?: 'connected' | 'offline' | 'connecting' | 'guest'; message?: string; items: { id?: string; name: string; preview: string; unread: number; avatarUrl?: string; time?: number; group?: boolean }[] }
export interface StudioPerson { id: string; name: string; avatarUrl?: string; relation?: 'friend' | 'incoming' | 'outgoing' }
export interface StudioFavorite { id: string; title: string; detail?: string; conversation?: string }
export interface StudioNotice { id: string; title: string; source: 'studio' | 'im'; read: boolean; conversation?: string }
export interface SocialSnapshot { people: StudioPerson[]; favorites: StudioFavorite[]; notices: StudioNotice[] }
export type SocialResult = SocialSnapshot | { unavailable: 'unsupported' };
export interface SocialAction { action: 'request' | 'accept' | 'remove' | 'unfavorite' | 'read'; id: string }
export interface ProfileActions {
	settings(): void; signIn(): void; inbox(id?: string): void; chatUser(id: string): void;
	social(query: string): Promise<SocialResult>; change(action: SocialAction): Promise<void>;
}
export function avatar(name: string, src?: string): HTMLElement {
	const mark = element('span', 'lp-avatar', Array.from(name)[0] ?? '');
	if (src && /^(?:https?:\/\/|data:image\/)/i.test(src)) {
		const img = picture(src); img.addEventListener('error', () => img.remove(), { once: true }); mark.append(img);
	} else if (!name) { mark.append(icon('account')); }
	return mark;
}

type Section = 'activity' | 'people' | 'favorites' | 'notifications';

export class LaunchpadProfile extends Disposable {
	readonly element = element('div', 'lp-profile lp-scroll');
	private readonly header = element('header', 'lp-profile-header');
	private readonly nav = element('nav', 'lp-profile-nav');
	private readonly rows = element('div', 'lp-profile-rows');
	private readonly filter = element('input', 'lp-query');
	private readonly status = element('div', 'lp-message');
	private readonly debounce = this._register(new RunOnceScheduler(() => void this.refresh(), 280));
	private data?: { snapshot: SocialSnapshot; query: string };
	private failure?: 'unsupported' | 'unavailable' | 'change';
	private scope?: string;
	private revision = 0;
	private active = false;
	private section: Section = 'activity';
	private inbox?: LaunchpadInbox;
	private nativeNotices: StudioNotice[] = [];
	private platform = false;
	private account?: LaunchpadAccount;

	constructor(private readonly t: LaunchpadLabel, private readonly actions: ProfileActions, private readonly readNative: (id: string) => void) {
		super();
		this.status.setAttribute('role', 'status'); this.filter.type = 'search'; this.filter.placeholder = t('Find a Studio user', '查找 Studio 用户'); this.filter.setAttribute('aria-label', this.filter.placeholder);
		this.filter.addEventListener('input', () => { ++this.revision; this.failure = undefined; this.renderRows(); this.debounce.schedule(); });
		for (const [id, title, glyph] of [['activity', t('Recent chats', '最近会话'), 'comment-discussion'], ['people', t('Contacts & friends', '通讯录与好友'), 'organization'], ['favorites', t('Favorites', '收藏'), 'star-empty'], ['notifications', t('Notifications', '通知'), 'bell']] as const) {
			const b = button(title, glyph, () => this.select(id)); b.dataset.id = id; this.nav.append(b);
		}
		this.element.append(this.header, this.nav, this.filter, this.status, this.rows);
	}

	select(section: Section): void {
		++this.revision; this.debounce.cancel(); this.failure = undefined;
		this.section = section; this.filter.value = ''; this.render();
		if (this.active) { void this.refresh(); }
	}
	update(active: boolean, platform: boolean, account: LaunchpadAccount | undefined, inbox: LaunchpadInbox | undefined, notices: StudioNotice[]): void {
		const scope = JSON.stringify([platform, account?.signedIn, account?.scopeKey]);
		const changed = this.scope !== scope, enter = active && !this.active;
		const repaint = changed || enter || JSON.stringify([this.account, this.inbox, this.nativeNotices]) !== JSON.stringify([account, inbox, notices]);
		this.active = active; this.platform = platform; this.account = account; this.inbox = inbox; this.nativeNotices = notices;
		if (changed) { ++this.revision; this.debounce.cancel(); this.data = undefined; this.failure = undefined; this.scope = scope; this.filter.value = ''; }
		if (!platform) { this.section = 'notifications'; }
		if (active && repaint) { this.render(); }
		if (active && (enter || changed)) { void this.refresh(); }
	}

	async refresh(): Promise<void> {
		if (!this.account?.signedIn || !this.active || this.section === 'activity') { return; }
		const rev = ++this.revision, query = this.section === 'people' ? this.filter.value.trim() : '';
		try {
			const result = await this.actions.social(query);
			if (rev !== this.revision) { return; }
			if ('unavailable' in result) { this.failure = result.unavailable; }
			else { this.data = { snapshot: result, query }; this.failure = undefined; }
		} catch {
			if (rev !== this.revision) { return; }
			this.failure = 'unavailable';
		}
		this.renderRows();
	}

	private mutate(action: SocialAction, b: HTMLButtonElement): void {
		b.disabled = true; const scope = this.scope, section = this.section;
		void this.actions.change(action).then(async () => { if (scope === this.scope) { await this.refresh(); } }, () => { if (scope === this.scope && section === this.section) { this.failure = 'change'; this.renderRows(); } }).finally(() => b.disabled = false);
	}

	private render(): void {
		const t = this.t, a = this.account;
		const name = a?.hasAccount ? a.name : this.platform ? t('Not signed in', '尚未登录') : t('Local profile', '本机用户');
		const identity = element('div'); identity.append(element('h1', '', name), element('small', '', [a?.email, a?.statusLabel].filter(Boolean).join(' · ')));
		this.header.replaceChildren(avatar(name, a?.avatarUrl), identity, button(t('Settings', '设置'), 'settings-gear', this.actions.settings, 'lp-outline'));
		if (this.platform && !a?.signedIn) { this.header.append(button(t('Sign in', '登录'), 'sign-in', this.actions.signIn, 'lp-primary')); }
		for (const b of this.nav.querySelectorAll('button')) { b.hidden = !this.platform && b.dataset.id !== 'notifications'; b.setAttribute('aria-pressed', String(this.section === b.dataset.id)); }
		this.filter.hidden = this.section !== 'people' || !a?.signedIn;
		this.renderRows();
	}

	private renderRows(): void {
		const t = this.t, needsSocial = this.section !== 'activity' && this.platform && !!this.account?.signedIn;
		const data = this.section === 'people' && this.data?.query !== this.filter.value.trim() ? undefined : this.data?.snapshot;
		this.status.replaceChildren();
		if (needsSocial) {
			if (this.failure === 'change') { this.status.textContent = t('Change could not be saved.', '更改未能保存。'); }
			else if (this.failure) {
				const message = this.failure === 'unsupported'
					? t('This server does not provide Studio social data. Check the server version and retry.', '当前服务器未提供 Studio 社交接口，请确认服务器版本后重试。')
					: t('Studio social data is unavailable.', '暂时无法读取 Studio 社交数据。');
				this.status.append(message, button(t('Retry', '重试'), 'refresh', () => void this.refresh()));
			} else if (!data) { this.status.textContent = t('Loading…', '正在加载…'); }
		}
		const row = (name: string, detail: string, mark: HTMLElement, ...commands: HTMLButtonElement[]) => {
			const r = element('div', 'lp-social-row'), text = element('div', 'lp-social-text'); text.append(element('strong', '', name), element('small', '', detail)); r.append(mark, text, ...commands); return r;
		};
		const change = (label: string, glyph: string, action: SocialAction) => { const b = button(label, glyph, () => this.mutate(action, b), 'lp-outline'); return b; };
		this.rows.replaceChildren();
		if (this.section === 'activity') {
			for (const c of this.inbox?.items ?? []) { this.rows.append(row(c.name, c.preview, avatar(c.name, c.avatarUrl), button(c.unread ? String(c.unread) : t('Chat', '聊天'), 'comment', () => this.actions.inbox(c.id), 'lp-outline'))); }
		} else if (this.section === 'people') {
			for (const p of data?.people ?? []) {
				const controls = p.relation === 'friend' ? [button(t('Chat', '聊天'), 'comment', () => this.actions.chatUser(p.id), 'lp-outline'), change(t('Remove', '移除'), 'remove', { action: 'remove', id: p.id })] : p.relation === 'incoming' ? [change(t('Accept', '接受'), 'check', { action: 'accept', id: p.id }), change(t('Decline', '拒绝'), 'close', { action: 'remove', id: p.id })] : p.relation === 'outgoing' ? [change(t('Cancel request', '撤回申请'), 'close', { action: 'remove', id: p.id })] : [change(t('Add friend', '添加好友'), 'person-add', { action: 'request', id: p.id })];
				this.rows.append(row(p.name, p.relation === 'incoming' ? t('Friend request', '好友申请') : p.relation === 'friend' ? t('Friend', '好友') : p.relation === 'outgoing' ? t('Request sent', '已发出申请') : '', avatar(p.name, p.avatarUrl), ...controls));
			}
		} else if (this.section === 'favorites') {
			for (const f of data?.favorites ?? []) { this.rows.append(row(f.title, f.detail ?? '', icon('star-full'), ...(f.conversation ? [button(t('Open chat', '打开会话'), 'comment', () => this.actions.inbox(f.conversation))] : []), change(t('Remove', '移除'), 'remove', { action: 'unfavorite', id: f.id }))); }
		} else {
			for (const n of [...this.nativeNotices, ...data?.notices ?? []]) {
				const controls = n.conversation || n.source === 'im' ? [button(t('Open chat', '打开会话'), 'comment', () => this.actions.inbox(n.conversation), 'lp-outline')] : [];
				if (n.id.startsWith('request:') || n.id.startsWith('friend:')) { controls.push(button(t('View contacts', '查看联系人'), 'organization', () => this.select('people'), 'lp-outline')); }
				if (!n.read) { controls.push(this.nativeNotices.includes(n) ? button(t('Mark read', '标为已读'), 'check', () => this.readNative(n.id)) : change(t('Mark read', '标为已读'), 'check', { action: 'read', id: n.id })); }
				const title = n.id.startsWith('im-unread:') ? t(`${n.title} unread IM messages`, `${n.title} 条未读 IM 消息`) : n.id.startsWith('request:') ? t(`${n.title} sent you a friend request`, `${n.title} 请求添加你为好友`) : n.id.startsWith('friend:') ? t(`${n.title} accepted your request`, `${n.title} 已接受好友申请`) : n.title;
				this.rows.append(row(title, n.source === 'im' ? 'IM' : 'Studio', icon(n.read ? 'mail-read' : 'mail'), ...controls));
			}
		}
		const canShowEmpty = this.section === 'activity' || (needsSocial ? !!data && !this.failure : this.section === 'notifications');
		if (!this.rows.childElementCount && canShowEmpty) { this.rows.append(element('p', 'lp-empty', this.section === 'activity' ? this.inbox?.message || t('No recent chats.', '暂无最近会话。') : this.section === 'people' ? t('No contacts found.', '暂无联系人。') : this.section === 'favorites' ? t('No favorites yet.', '暂无收藏。') : t('No notifications.', '暂无通知。'))); }
	}
	override dispose(): void { ++this.revision; super.dispose(); }
}
