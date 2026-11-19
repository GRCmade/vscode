/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../base/common/actions.js';
import { mainWindow } from '../../base/browser/window.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService, INotificationSource, NotificationPriority, NotificationsFilter, Severity } from '../../platform/notification/common/notification.js';
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

CommandsRegistry.registerCommand('studio.internalIsNotificationWindow', accessor => accessor.get(IHostService).hadLastFocus());

CommandsRegistry.registerCommand('studio.internalPostDesktopNotification', async (accessor, notice: DesktopNotice) => {
	if (!safeId(notice?.id) || !safeId(notice.source?.id) || !text(notice.source.label, 80) || !text(notice.title, 120) ||
		!text(notice.message, 300) || !text(notice.actionLabel, 80) || pending.has(notice.id)) {
		return false;
	}
	const host = accessor.get(IHostService);
	const nativeHost = accessor.get(INativeHostService);
	const notifications = accessor.get(INotificationService);
	const commands = accessor.get(ICommandService);
	const { id, source, message, title, actionLabel } = notice;
	pending.add(id);
	let owner = false;
	try { owner = await host.hadLastFocus(); } catch { /* No window claimed the notification. */ }
	finally { pending.delete(id); }
	if (cancelled.delete(id) || !owner) {
		return false;
	}
	const background = !host.hasFocus;
	const nativeAllowed = () => notifications.getFilter() === NotificationsFilter.OFF && notifications.getFilter(source) === NotificationsFilter.OFF;
	live.get(source.id)?.close();
	let closed = false;
	let native = false;
	const clearNative = () => {
		if (native) { void nativeHost.clearToast(id).catch(() => undefined); }
		native = false;
	};
	const activate = async (focus: boolean) => {
		if (!closed && await commands.executeCommand<boolean>('studio.internalDesktopNotificationAction', id) && !closed) {
			if (focus) { await host.focus(mainWindow, { mode: FocusMode.Force }); }
			handle.close();
		}
	};
	const handle = notifications.notify({
		id, source, message: NotificationText.concat(message), severity: Severity.Info,
		priority: background ? NotificationPriority.SILENT : NotificationPriority.DEFAULT,
		actions: { primary: [toAction({ id: 'studio.openDesktopNotification', label: actionLabel, run: () => activate(false) })] },
	});
	const filter = notifications.onDidChangeFilter(() => { if (!nativeAllowed()) { clearNative(); } });
	const closeListener = handle.onDidClose(() => {
		closed = true;
		clearNative();
		filter.dispose();
		closeListener.dispose();
		if (live.get(source.id)?.id === id) { live.delete(source.id); }
	});
	live.set(source.id, { id, close: () => handle.close() });
	if (background && nativeAllowed()) {
		native = true;
		// Use the desktop notification service directly: no browser permission prompt or focus change on delivery.
		void nativeHost.showToast({ id, dedupeKey: source.id, replaceExisting: true, title, body: message, actions: [actionLabel] }).then(async result => {
			const actionable = native;
			native = false;
			if (result.clicked && actionable) { await activate(true); }
		}).catch(() => { native = false; });
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
