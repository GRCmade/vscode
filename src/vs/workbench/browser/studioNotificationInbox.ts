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
interface SharedSnapshot { notices: Omit<Notice, 'owner'>[]; dismissed: string[] }
type SharedAction = { kind: 'list' | 'read-all' } | { kind: 'add'; notice: Notice } | { kind: 'import'; notices: Notice[]; dismissed: string[] }
	| { kind: 'read' | 'clear' | 'dismiss'; ids: string[] };
interface SharedInbox {
	owner: string;
	pending: Promise<unknown>;
	migrated: boolean;
	snapshot?: SharedSnapshot;
	refreshing?: Promise<void>;
}

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
	private shared?: SharedInbox;
	private revision = 0;
	private readonly change = this._register(new Emitter<void>());
	private readonly acknowledgements = this._register(new DisposableMap<INotificationViewItem>());
	readonly onDidChange = this.change.event;

	constructor(@IStorageService private readonly storage: IStorageService, @INotificationService notifications: INotificationService, @ICommandService private readonly commands: ICommandService) {
		super();
		const update = (value: unknown) => {
			const account = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
			const shared = typeof account?.workspaceOwner === 'string' && /^[a-f\d]{64}$/.test(account.workspaceOwner) ? account.workspaceOwner : undefined;
			const owner = shared ?? (account?.localProfile === true ? 'local' : account?.status === 'authenticated' && account.hasAccount === true && typeof account.scopeKey === 'string' && /^[a-f\d]{64}$/.test(account.scopeKey) ? account.scopeKey : undefined);
			if (owner !== this.owner || shared !== this.shared?.owner) {
				this.owner = owner;
				this.shared = shared ? { owner: shared, pending: Promise.resolve(), migrated: false } : undefined;
				this.acknowledgements.clearAndDisposeAll();
				this.stored = this.dismissedSocial = undefined;
				this.change.fire();
				this.refresh();
			}
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
			if (this.shared) { return; }
			if (e.key.startsWith(prefix)) { this.stored = undefined; this.change.fire(); }
			else if (this.owner && e.key === socialDismissalsPrefix + this.owner) { this.dismissedSocial = undefined; this.change.fire(); }
		}));
		// Until the profile is known, do not persist potentially account-specific text.
		const rev = this.revision;
		void commands.executeCommand('studio.internalGetAccountMenuState').then(a => { if (rev === this.revision && !this._store.isDisposed) { update(a); } }, () => undefined);
	}

	refresh(): void {
		const current = this.shared;
		if (!current || current.refreshing) { return; }
		current.refreshing = this.updateShared(current, { kind: 'list' }).catch(() => undefined).finally(() => { current.refreshing = undefined; });
	}

	private updateShared(current: SharedInbox, action: SharedAction): Promise<void> {
		const run = async () => {
			const isCurrent = () => this.shared === current && !this._store.isDisposed;
			const send = (request: SharedAction) => this.commands.executeCommand<SharedSnapshot | undefined>('studio.internalWorkspaceInbox', current.owner, request);
			if (!isCurrent()) { return; }
			let snapshot: SharedSnapshot | undefined;
			if (!current.migrated) {
				// Only the legacy records that were already tagged with this account can be adopted.
				const notices = this.legacyNotices(current.owner);
				const dismissalKey = socialDismissalsPrefix + current.owner;
				const dismissed = this.storage.getObject<string[]>(dismissalKey, scope, []);
				if (notices.length || dismissed.length) {
					snapshot = await send({ kind: 'import', notices, dismissed });
					if (!isCurrent() || !snapshot) { return; }
					for (const notice of notices) {
						if (JSON.stringify(this.storage.getObject(prefix + notice.id, scope)) === JSON.stringify(notice)) { this.storage.remove(prefix + notice.id, scope); }
					}
					if (JSON.stringify(this.storage.getObject(dismissalKey, scope, [])) === JSON.stringify(dismissed)) { this.storage.remove(dismissalKey, scope); }
				}
				current.migrated = true;
			}
			if (!snapshot || action.kind !== 'list') { snapshot = await send(action); }
			if (!isCurrent() || !snapshot || JSON.stringify(snapshot) === JSON.stringify(current.snapshot)) { return; }
			current.snapshot = snapshot;
			this.stored = snapshot.notices.map(notice => ({ ...notice, owner: current.owner }));
			this.dismissedSocial = new Set(snapshot.dismissed);
			this.change.fire();
		};
		const operation = current.pending.then(run);
		current.pending = operation.catch(() => undefined);
		return operation;
	}

	private add(item: INotificationViewItem, owner: string): void {
		const shared = this.shared;
		const key = fingerprint(item);
		const existing = this.owned().find(notice => notice.fingerprint === key && !notice.read);
		const id = existing?.id ?? `${Date.now()}-${generateUuid()}`;
		this.acknowledgements.set(item, Event.once(item.onDidAcknowledge)(() => {
			// An old toast must not acknowledge a later occurrence or another account's notice.
			if (this.owner === owner && this.shared === shared) {
				if (shared && !this.get(id)) { void this.updateShared(shared, { kind: 'read', ids: [id] }).catch(() => undefined); }
				else { void this.read(id).catch(() => undefined); }
			}
		}));
		if (!existing) {
			const notice: Notice = { owner, id, title: item.message.raw.slice(0, titleLimit), fingerprint: key, source: 'studio', read: false };
			if (shared) { void this.updateShared(shared, { kind: 'add', notice }).catch(() => undefined); return; }
			this.storage.store(prefix + id, notice, scope, target);
			for (const stale of this.keys().slice(300)) { this.storage.remove(stale, scope); }
		}
	}

	private keys(): string[] { return this.storage.keys(scope, target).filter(k => k.startsWith(prefix)).sort().reverse(); }
	private legacyNotices(owner: string): Notice[] { return this.keys().map(k => this.storage.getObject<Notice>(k, scope)).filter((n): n is Notice => !!n && n.owner === owner); }
	private owned(): Notice[] { return this.stored ??= this.owner && !this.shared ? this.legacyNotices(this.owner) : []; }
	private get(id: string): Notice | undefined {
		if (this.shared) { return this.owned().find(notice => notice.id === id); }
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
	async readAll(): Promise<void> {
		if (this.shared) { await this.updateShared(this.shared, { kind: 'read-all' }); }
		else { await this.markRead(this.owned()); }
	}
	async clearRead(): Promise<void> {
		// Clear every occurrence of a read group, not just the one shown in the list.
		const ids = this.groups().filter(group => group.every(notice => notice.read === true)).flatMap(group => group.map(notice => notice.id));
		if (this.shared) { await this.updateShared(this.shared, { kind: 'clear', ids }); }
		else { this.storage.storeAll(ids.map(id => ({ key: prefix + id, value: undefined, scope, target })), false); }
	}

	get dismissedSocialNoticeIds(): ReadonlySet<string> | undefined {
		if (!this.owner || this.owner === 'local') { return undefined; }
		if (this.shared) { return this.dismissedSocial; }
		return this.dismissedSocial ??= new Set(this.storage.getObject<string[]>(socialDismissalsPrefix + this.owner, scope, []));
	}

	async dismissReadSocialNotices(owner: string, notices: readonly StudioNotice[]): Promise<void> {
		if (owner !== this.owner || owner === 'local') { throw new Error('The notification account changed'); }
		// Pending invitations must stay actionable.
		const read = notices.filter(notice => notice.read && !notice.inviteId && !notice.legacyInvite).map(notice => notice.id);
		if (this.shared) { await this.updateShared(this.shared, { kind: 'dismiss', ids: read }); return; }
		const ids = new Set(this.dismissedSocialNoticeIds);
		const previousSize = ids.size;
		for (const id of read) { ids.add(id); }
		if (ids.size > previousSize) { this.storage.store(socialDismissalsPrefix + owner, [...ids].slice(-1000), scope, target); }
	}

	async read(id: string): Promise<void> {
		const notice = this.get(id);
		if (notice) {
			await this.markRead(this.groups().find(group => group.some(item => item.id === id)) ?? [notice]);
		}
	}

	private async markRead(notices: Notice[]): Promise<void> {
		if (this.shared) { await this.updateShared(this.shared, { kind: 'read', ids: notices.filter(notice => !notice.read).map(notice => notice.id) }); return; }
		const entries = notices.filter(notice => !notice.read).map(notice => ({ key: prefix + notice.id, value: { ...notice, read: true }, scope, target }));
		this.storage.storeAll(entries, false);
	}
}
