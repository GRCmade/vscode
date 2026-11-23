/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Severity } from '../../../platform/notification/common/notification.js';
import { NotificationsCenter } from '../../browser/parts/notifications/notificationsCenter.js';
import { NotificationsModel } from '../../common/notifications.js';
import { workbenchInstantiationService } from './workbenchTestServices.js';

suite('NotificationsCenter', () => {

	suiteSetup(() => {
		const warmupDisposables = new DisposableStore();
		try {
			const { model, center } = createCenter(warmupDisposables);
			model.addNotification({ severity: Severity.Info, message: 'Warmup' });
			center.show();
		} finally {
			warmupDisposables.dispose();
		}
	});

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createCenter(testDisposables: Pick<DisposableStore, 'add'> = disposables) {
		const container = document.createElement('div');
		container.classList.add('monaco-workbench');
		document.body.appendChild(container);
		testDisposables.add(toDisposable(() => container.remove()));

		const instantiationService = workbenchInstantiationService(undefined, testDisposables);
		const model = testDisposables.add(new NotificationsModel());
		testDisposables.add(toDisposable(() => {
			for (const notification of [...model.notifications]) {
				notification.close();
			}
		}));
		const center = testDisposables.add(instantiationService.createInstance(NotificationsCenter, container, model));
		return { container, model, center };
	}

	test('does not create the notification center when there are no notifications', () => {
		const { container, center } = createCenter();
		center.show();
		assert.deepStrictEqual({ visible: center.isVisible, panel: container.querySelector('.notifications-center') }, { visible: false, panel: null });
	});

	test('shows a notification and stays closed after dismissing the last one', () => {
		const { container, model, center } = createCenter();
		const message = 'Notification center test message';
		const notification = model.addNotification({ severity: Severity.Info, message });
		center.show();
		const shownMessage = container.querySelector('.notifications-center.visible .notification-list-item-message')?.textContent;
		notification.close();
		const visibleAfterDismissal = center.isVisible;
		center.show();
		assert.deepStrictEqual({ shownMessage, visibleAfterDismissal, visibleAfterReopen: center.isVisible }, {
			shownMessage: message,
			visibleAfterDismissal: false,
			visibleAfterReopen: false
		});
	});
});
