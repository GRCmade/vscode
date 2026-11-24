/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../base/common/event.js';
import { StringSHA1 } from '../../base/common/hash.js';
import { Disposable, DisposableMap } from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { INotificationViewItem, NotificationChangeType } from '../common/notifications.js';
import { NotificationService } from '../services/notification/common/notificationService.js';
import type { StudioNotice } from './studioLaunchpadProfile.js';

const prefix = 'studio.notificationInbox.';
const socialDismissalsPrefix = 'studio.dismissedSocialNotifications.';
const scope = StorageScope.PROFILE, target = StorageTarget.MACHINE;
const titleLimit = 500;
interface Notice extends StudioNotice { owner: string; fingerprint?: string }

function fingerprint(item: INotificationViewItem): string {
	const hash = new StringSHA1();
	hash.update(JSON.stringify([item.sourceId, item.sourceId === undefined ? item.source : undefined, item.severity, item.message.raw, item.message.linkedText.nodes]));
	return hash.digest();
}

/** Separate occurrence keys preserve independent writes from project windows. */
export class StudioNotificationInbox extends Disposable {
	private owner?: string;
	private stored?: Notice[];
	private dismissedSocial?: ReadonlySet<string>;
	private revision = 0;
	private readonly change = this._register(new Emitter<void>());
	private readonly acknowledgements = this._register(new DisposableMap<INotificationViewItem>());
	readonly onDidChange = this.change.event;

	constructor(@IStorageService private readonly storage: IStorageService, @INotificationService notifications: INotificationService, @ICommandService commands: ICommandService) {
		super();
		const update = (value: unknown) => {
			const account = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
			const owner = account?.localProfile === true ? 'local' : account?.status === 'authenticated' && account.hasAccount === true && typeof account.scopeKey === 'string' && /^[a-f\d]{64}$/.test(account.scopeKey) ? account.scopeKey : undefined;
			if (owner !== this.owner) { this.owner = owner; this.stored = this.dismissedSocial = undefined; this.change.fire(); }
		};
		this._register(commands.onDidExecuteCommand(({ commandId, args }) => {
			if (commandId === 'studio.internalUpdateAccountMenuState') { this.revision++; update(args[0]); }
		}));
		const model = (notifications as NotificationService).model;
		this._register(model.onDidChangeNotification(({ kind, item }) => {
			if (kind === NotificationChangeType.REMOVE) {
				this.acknowledgements.deleteAndDispose(item);
			}
			const owner = this.owner;
			if (owner && kind === NotificationChangeType.ADD && !item.hasActiveProgress && item.sourceId !== 'studio.builtinIm') {
				this.add(item, owner);
			}
		}));
		this._register(storage.onDidChangeValue(scope, undefined, this._store)(e => {
			if (e.key.startsWith(prefix)) { this.stored = undefined; this.change.fire(); }
			else if (this.owner && e.key === socialDismissalsPrefix + this.owner) { this.dismissedSocial = undefined; this.change.fire(); }
		}));
		// Until the profile is known, do not persist potentially account-specific text.
		const rev = this.revision;
		void commands.executeCommand('studio.internalGetAccountMenuState').then(a => { if (rev === this.revision && !this._store.isDisposed) { update(a); } }, () => undefined);
	}

	private add(item: INotificationViewItem, owner: string): void {
		const key = fingerprint(item);
		const existing = this.owned().find(notice => notice.fingerprint === key && !notice.read);
		const id = existing?.id ?? `${Date.now()}-${generateUuid()}`;
		this.acknowledgements.set(item, Event.once(item.onDidAcknowledge)(() => {
			// An old toast must not acknowledge a later occurrence or another account's notice.
			if (this.owner === owner && this.get(id)?.read === false) {
				this.read(id);
			}
		}));
		if (!existing) {
			const notice: Notice = { owner, id, title: item.message.raw.slice(0, titleLimit), fingerprint: key, source: 'studio', read: false };
			this.storage.store(prefix + id, notice, scope, target);
			for (const stale of this.keys().slice(300)) { this.storage.remove(stale, scope); }
		}
	}

	private keys(): string[] { return this.storage.keys(scope, target).filter(k => k.startsWith(prefix)).sort().reverse(); }
	private owned(): Notice[] { return this.stored ??= this.owner ? this.keys().map(k => this.storage.getObject(k, scope) as Notice | undefined).filter((n): n is Notice => !!n && n.owner === this.owner) : []; }
	private get(id: string): Notice | undefined {
		const notice = this.storage.getObject(prefix + id, scope) as Notice | undefined;
		return this.owner && notice?.owner === this.owner && notice.id === id ? notice : undefined;
	}

	private groups(): Notice[][] {
		const notices = this.owned();
		// Older records only have the displayed title. Do not match a potentially truncated or ambiguous title to a newer record.
		const byTitle = new Map<string, string | null>();
		for (const notice of notices) {
			if (notice.fingerprint && notice.title.length < titleLimit) {
				const previous = byTitle.get(notice.title);
				byTitle.set(notice.title, previous === undefined || previous === notice.fingerprint ? notice.fingerprint : null);
			}
		}
		const groups = new Map<string, Notice[]>();
		for (const notice of notices) {
			const key = notice.fingerprint ?? (notice.title.length >= titleLimit ? `occurrence:${notice.id}` : byTitle.get(notice.title) ?? `legacy:${notice.title}`);
			const group = groups.get(key);
			if (group) {
				group.push(notice);
			} else {
				groups.set(key, [notice]);
			}
		}
		return [...groups.values()];
	}

	list(): StudioNotice[] { return this.groups().slice(0, 100).map(group => ({ ...group[0], read: group.every(notice => notice.read) })); }
	unread(): StudioNotice[] { return this.groups().flatMap(group => group.find(notice => !notice.read) ?? []); }
	hasUnread(): boolean { return this.owned().some(notice => !notice.read); }
	readAll(): void { this.markRead(this.owned()); }
	clearRead(): void {
		// Clear every occurrence of a read group, not just the one shown in the list.
		const entries = this.groups().filter(group => group.every(notice => notice.read === true))
			.flatMap(group => group.map(notice => ({ key: prefix + notice.id, value: undefined, scope, target })));
		this.storage.storeAll(entries, false);
	}

	get dismissedSocialNoticeIds(): ReadonlySet<string> | undefined {
		if (!this.owner || this.owner === 'local') { return undefined; }
		return this.dismissedSocial ??= new Set(this.storage.getObject<string[]>(socialDismissalsPrefix + this.owner, scope, []));
	}

	dismissReadSocialNotices(owner: string, notices: readonly StudioNotice[]): void {
		if (owner !== this.owner || owner === 'local') { throw new Error('The notification account changed'); }
		// Only dismiss the desktop copies. Pending invitations must stay actionable.
		const ids = new Set(this.dismissedSocialNoticeIds);
		const previousSize = ids.size;
		for (const notice of notices) {
			if (notice.read === true && !notice.inviteId && !notice.legacyInvite) { ids.add(notice.id); }
		}
		if (ids.size > previousSize) { this.storage.store(socialDismissalsPrefix + owner, [...ids].slice(-1000), scope, target); }
	}

	read(id: string): void {
		const notice = this.get(id);
		if (notice) {
			this.markRead(this.groups().find(group => group.some(item => item.id === id)) ?? [notice]);
		}
	}

	private markRead(notices: Notice[]): void {
		const entries = notices.filter(notice => !notice.read).map(notice => ({ key: prefix + notice.id, value: { ...notice, read: true }, scope, target }));
		this.storage.storeAll(entries, false);
	}
}
