/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { INotification, INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationsModel } from '../../common/notifications.js';
import '../../electron-browser/studioDesktopNotifications.js';
import { IHostService } from '../../services/host/browser/host.js';

suite('StudioDesktopNotifications', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('details acknowledges and opens even after the workbench closes the toast; programmatic cleanup does not acknowledge', async () => {
		const model = disposables.add(new NotificationsModel());
		const services = disposables.add(new TestInstantiationService());
		const config = new TestConfigurationService({ 'studio.notifications.desktop': false });
		disposables.add(config.onDidChangeConfigurationEmitter);
		services.stub(IConfigurationService, config);
		const target = new DeferredPromise<'launchpadInbox'>();
		const calls: unknown[] = [];
		services.stub(ICommandService, {
			executeCommand: async <R>(command: string, ...args: unknown[]): Promise<R | undefined> => {
				calls.push([command, ...args]);
				return command === 'studio.internalDesktopNotificationAction' ? target.p as Promise<R> : undefined;
			}
		});
		services.stub(INotificationService, { notify: (notification: INotification) => model.addNotification(notification) });
		services.stub(INativeHostService, {
			isStudioNotificationWindow: async () => true,
			openStudioLaunchpadInbox: async () => { calls.push('open inbox'); return true; }
		});
		services.stub(IHostService, {});
		const post = (id: string) => services.invokeFunction(CommandsRegistry.getCommand('studio.internalPostDesktopNotification')!.handler, {
			id, source: { id: 'test-source', label: 'Test' }, title: 'Notification', message: 'New message', actionLabel: 'Details',
		});
		const dismiss = (id: string) => services.invokeFunction(CommandsRegistry.getCommand('studio.internalDismissDesktopNotification')!.handler, id);
		try {
			await post('old');
			await post('current'); // Replaces the previous notification without acknowledging it.
			const item = model.notifications[0];
			item.acknowledge(); // The renderer acknowledges before invoking the Details action.
			const opening = item.actions!.primary![0].run();
			item.close(); // The primary button automatically closes its notification, without waiting for the action.
			await target.complete('launchpadInbox');
			await opening;
			await post('cleared');
			dismiss('cleared');
			assert.deepStrictEqual({ calls, openNotifications: model.notifications.length }, {
				calls: [['studio.internalAcknowledgeDesktopNotification', 'current'], ['studio.internalDesktopNotificationAction', 'current'], 'open inbox'],
				openNotifications: 0,
			});
		} finally {
			dismiss('old');
			dismiss('current');
			dismiss('cleared');
		}
	});
});
