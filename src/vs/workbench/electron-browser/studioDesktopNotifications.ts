/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../base/common/actions.js';
import { mainWindow } from '../../base/browser/window.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationHandle, INotificationService, INotificationSource, Severity } from '../../platform/notification/common/notification.js';
import { NotificationText } from '../../platform/notification/common/notificationMessage.js';
import { IHostService } from '../services/host/browser/host.js';

interface DesktopNotice {
	id: string;
	source: INotificationSource;
	title: string;
	message: string;
	actionLabel: string;
}

const live = new Map<string, { id: string; close(): void }>();
const pending = new Set<string>();
const cancelled = new Set<string>();
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\r\n]/.test(value);
const desktopKey = 'studio.notifications.desktop';
const workbenchKey = 'studio.notifications.workbench';

CommandsRegistry.registerCommand('studio.internalIsNotificationWindow', accessor => accessor.get(INativeHostService).isStudioNotificationWindow());
CommandsRegistry.registerCommand('studio.internalGetDesktopNotificationStatus', accessor => accessor.get(INativeHostService).getStudioDesktopNotificationStatus());
CommandsRegistry.registerCommand('studio.internalOpenNotificationSettings', accessor => accessor.get(INativeHostService).openStudioNotificationSettings());
CommandsRegistry.registerCommand('studio.internalStudioSocialChanged', accessor => accessor.get(INativeHostService).notifyStudioSocialChanged());

CommandsRegistry.registerCommand('studio.internalPostDesktopNotification', async (accessor, notice: DesktopNotice) => {
	if (!safeId(notice?.id) || !safeId(notice.source?.id) || !text(notice.source.label, 80) || !text(notice.title, 120) ||
		!text(notice.message, 300) || !text(notice.actionLabel, 80) || pending.has(notice.id)) {
		return false;
	}
	const host = accessor.get(IHostService);
	const nativeHost = accessor.get(INativeHostService);
	const notifications = accessor.get(INotificationService);
	const commands = accessor.get(ICommandService);
	const configuration = accessor.get(IConfigurationService);
	const { id, source, message, title, actionLabel } = notice;
	pending.add(id);
	let owner = false;
	try { owner = await nativeHost.isStudioNotificationWindow(); } catch { /* No window claimed the notification. */ }
	finally { pending.delete(id); }
	if (cancelled.delete(id) || !owner) {
		return false;
	}
	live.get(source.id)?.close();
	let native = configuration.getValue<boolean>(desktopKey) !== false;
	const workbench = configuration.getValue<boolean>(workbenchKey) !== false;
	// Acknowledge the event even if both channels are disabled, so toggling them on does not replay it.
	if (!native && !workbench) { return true; }
	const lifetime = new DisposableStore();
	let closed = false;
	let activating = false;
	let acknowledging = false;
	let handle: INotificationHandle | undefined;
	const clearNative = () => {
		if (native) { void nativeHost.clearToast(id).catch(() => undefined); }
		native = false;
	};
	const close = () => {
		if (closed) { return; }
		closed = true;
		if (live.get(source.id)?.id === id) { live.delete(source.id); }
		lifetime.dispose();
		handle?.close();
		clearNative();
	};
	const closeIfIdle = () => { if (!handle && !native && !activating) { close(); } };
	const acknowledge = () => {
		if (!closed && !acknowledging) {
			acknowledging = true;
			void commands.executeCommand('studio.internalAcknowledgeDesktopNotification', id).catch(() => undefined).finally(() => { acknowledging = false; });
		}
	};
	const activate = async (focus: boolean) => {
		if (closed || activating) { return; }
		activating = true;
		try {
			const target = await commands.executeCommand<boolean | 'launchpadInbox'>('studio.internalDesktopNotificationAction', id);
			if (!target || closed) { return; }
			if (target === 'launchpadInbox') {
				if (!await nativeHost.openStudioLaunchpadInbox()) { return; }
			} else if (focus) {
				await host.focus(mainWindow, { mode: FocusMode.Force });
			}
			close();
		} finally {
			activating = false;
			closeIfIdle();
		}
	};
	live.set(source.id, { id, close });
	if (workbench) {
		// The normal workbench notification model handles its own Do Not Disturb and source filters.
		handle = notifications.notify({
			id, source, message: NotificationText.concat(message), severity: Severity.Info,
			onDidAcknowledge: acknowledge,
			actions: { primary: [toAction({ id: 'studio.openDesktopNotification', label: actionLabel, run: () => { acknowledge(); return activate(false); } })] },
		});
		lifetime.add(handle.onDidClose(() => { handle = undefined; closeIfIdle(); }));
	}
	lifetime.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(desktopKey) && configuration.getValue<boolean>(desktopKey) === false) { clearNative(); }
		if (event.affectsConfiguration(workbenchKey) && configuration.getValue<boolean>(workbenchKey) === false) { handle?.close(); }
		closeIfIdle();
	}));
	if (native) {
		// OS notifications are independent of workbench focus and its Do Not Disturb setting.
		void nativeHost.showToast({ id, dedupeKey: source.id, replaceExisting: true, title, body: message, actions: [actionLabel] }).then(async result => {
			const actionable = native;
			native = false;
			if (result.clicked && actionable) { await activate(true); }
		}).catch(() => undefined).finally(() => { native = false; closeIfIdle(); });
	}
	return true;
});

CommandsRegistry.registerCommand('studio.internalDismissDesktopNotification', (_accessor, id: unknown) => {
	if (!safeId(id)) { return; }
	if (pending.has(id)) { cancelled.add(id); }
	for (const notice of live.values()) {
		if (notice.id === id) { notice.close(); break; }
	}
});
