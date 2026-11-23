/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { NotificationChangeType } from '../common/notifications.js';
import { NotificationService } from '../services/notification/common/notificationService.js';
import type { StudioNotice } from './studioLaunchpadProfile.js';

const prefix = 'studio.notificationInbox.';
const scope = StorageScope.PROFILE, target = StorageTarget.MACHINE;
interface Notice extends StudioNotice { owner: string }

/** One key per event: simultaneous project windows cannot overwrite each other's notifications. */
export class StudioNotificationInbox extends Disposable {
	private owner?: string;
	private stored?: Notice[];
	private revision = 0;
	private readonly change = this._register(new Emitter<void>());
	readonly onDidChange = this.change.event;

	constructor(@IStorageService private readonly storage: IStorageService, @INotificationService notifications: INotificationService, @ICommandService commands: ICommandService) {
		super();
		const update = (value: unknown) => {
			const account = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
			const owner = account?.localProfile === true ? 'local' : account?.status === 'authenticated' && account.hasAccount === true && typeof account.scopeKey === 'string' && /^[a-f\d]{64}$/.test(account.scopeKey) ? account.scopeKey : undefined;
			if (owner !== this.owner) { this.owner = owner; this.stored = undefined; this.change.fire(); }
		};
		this._register(commands.onDidExecuteCommand(({ commandId, args }) => {
			if (commandId === 'studio.internalUpdateAccountMenuState') { this.revision++; update(args[0]); }
		}));
		const model = (notifications as NotificationService).model;
		this._register(model.onDidChangeNotification(e => {
			if (!this.owner || e.kind !== NotificationChangeType.ADD || e.item.hasActiveProgress || e.item.sourceId === 'studio.builtinIm') { return; }
			const id = `${Date.now()}-${generateUuid()}`;
			this.storage.store(prefix + id, { owner: this.owner, id, title: e.item.message.raw.slice(0, 500), source: 'studio', read: false }, scope, target);
			for (const stale of this.keys().slice(300)) { this.storage.remove(stale, scope); }
		}));
		this._register(storage.onDidChangeValue(scope, undefined, this._store)(e => { if (e.key.startsWith(prefix)) { this.stored = undefined; this.change.fire(); } }));
		// Until the profile is known, do not persist potentially account-specific text.
		const rev = this.revision;
		void commands.executeCommand('studio.internalGetAccountMenuState').then(a => { if (rev === this.revision && !this._store.isDisposed) { update(a); } }, () => undefined);
	}
	private keys(): string[] { return this.storage.keys(scope, target).filter(k => k.startsWith(prefix)).sort().reverse(); }
	private owned(): Notice[] { return this.stored ??= this.owner ? this.keys().map(k => this.storage.getObject(k, scope) as Notice | undefined).filter((n): n is Notice => !!n && n.owner === this.owner) : []; }
	list(): StudioNotice[] { return this.owned().slice(0, 100); }
	unread(): StudioNotice[] { return this.owned().filter(notice => !notice.read); }
	hasUnread(): boolean { return this.owned().some(notice => !notice.read); }
	readAll(): void {
		for (const notice of this.owned()) {
			if (!notice.read) { this.read(notice.id); }
		}
	}
	read(id: string): void {
		const item = this.storage.getObject(prefix + id, scope) as Notice | undefined;
		if (this.owner && item?.owner === this.owner && item.id === id) { this.storage.store(prefix + id, { ...item, read: true }, scope, target); }
	}
}
