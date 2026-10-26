/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyChangeEvent, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IExtensionGalleryService, IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ColorThemeData } from '../../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';
import { onboardingStrings } from '../../common/onboardingStrings.js';

suite('OnboardingVariationA', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	function createOnboarding(signedIn = false) {
		const container = mainWindow.document.body.appendChild($('div'));
		store.add(toDisposable(() => container.remove()));
		const configuration = new TestConfigurationService();
		store.add(configuration.onDidChangeConfigurationEmitter);
		const contextChange = store.add(new Emitter<IContextKeyChangeEvent>());
		const contextKeys = new MockContextKeyService();
		const authenticated = contextKeys.createKey('studio.authenticated', signedIn);
		sinon.stub(contextKeys, 'onDidChangeContext').get(() => contextChange.event);
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(ILayoutService, { activeContainer: container });
		instantiationService.stub(IWorkbenchThemeService, { getColorTheme: () => ColorThemeData.createLoadedEmptyTheme('test', '') });
		instantiationService.stub(IExtensionGalleryService, {});
		instantiationService.stub(IExtensionManagementService, {});
		instantiationService.stub(IConfigurationService, configuration);
		instantiationService.stub(IContextKeyService, contextKeys);
		instantiationService.stub(IFileService, { exists: async () => false });
		const notifications = new TestNotificationService();
		const notify = sinon.spy(notifications, 'notify');
		instantiationService.stub(INotificationService, notifications);
		const executeCommand = sinon.stub().resolves();
		instantiationService.stub(ICommandService, { executeCommand });
		const onboarding = store.add(instantiationService.createInstance(OnboardingVariationA));
		onboarding.show();
		return {
			container, onboarding, executeCommand, notify,
			setSignedIn: (value: boolean) => {
				authenticated.set(value);
				contextChange.fire({ affectsSome: keys => keys.has('studio.authenticated'), allKeysContainedIn: () => false });
			},
		};
	}

	function button(container: HTMLElement, selector: string): HTMLButtonElement {
		const element = container.querySelector<HTMLButtonElement>(selector);
		assert.ok(element);
		return element;
	}

	test('offers the shared SteamHarness account page without Copilot or social providers', () => {
		const { container } = createOnboarding();
		assert.strictEqual(container.querySelector('h2.onboarding-a-signin-title')?.textContent, onboardingStrings.welcome);
		assert.strictEqual(button(container, '.onboarding-a-signin-actions button').textContent, onboardingStrings.signIn);
		assert.strictEqual(container.querySelectorAll('.onboarding-a-signin-actions button').length, 1);
		assert.strictEqual(container.querySelector('.onboarding-a-signin-disclaimer'), null);
		assert.doesNotMatch(container.textContent ?? '', /GitHub|Copilot|Google|Apple|GHE/);
	});

	test('removes the modal and notifies completion storage before opening Account', async () => {
		const { container, onboarding, executeCommand } = createOnboarding();
		let dismissed = 0;
		store.add(onboarding.onDidDismiss(() => dismissed++));
		executeCommand.callsFake(async () => {
			assert.strictEqual(container.querySelector('[role="dialog"]'), null);
			assert.strictEqual(onboarding.isShowing, false);
			assert.strictEqual(dismissed, 1);
		});
		const signIn = button(container, '.onboarding-a-signin-actions button');
		signIn.click();
		signIn.click();
		await executeCommand.firstCall.returnValue;
		assert.deepStrictEqual(executeCommand.getCalls().map(call => call.args), [['studio.openAccount']]);
	});

	test('shows an actionable failure and leaves the workbench usable when Account cannot open', async () => {
		const { container, executeCommand, notify } = createOnboarding();
		executeCommand.rejects(new Error('extension unavailable'));
		button(container, '.onboarding-a-signin-actions button').click();
		await assert.rejects(executeCommand.firstCall.returnValue);
		assert.strictEqual(notify.firstCall.args[0].message, onboardingStrings.openAccountError);
		assert.strictEqual(container.querySelector('[role="dialog"]'), null);
	});

	test('reads the existing session and updates when restoration or sign-out changes it', () => {
		const { container, setSignedIn } = createOnboarding(true);
		assert.strictEqual(container.querySelector('.onboarding-a-signin-confirmation')?.textContent, onboardingStrings.signedIn);
		assert.strictEqual(container.querySelector('.onboarding-a-signin-actions button'), null);
		assert.strictEqual(button(container, '.onboarding-a-footer-right button:last-child').textContent, onboardingStrings.continue);
		setSignedIn(false);
		assert.strictEqual(button(container, '.onboarding-a-signin-actions button').textContent, onboardingStrings.signIn);
		setSignedIn(true);
		assert.strictEqual(container.querySelector('.onboarding-a-signin-actions button'), null);
	});

	test('skipping sign-in still allows personalization and completion without authentication', () => {
		const { container, onboarding, executeCommand } = createOnboarding();
		let completed = 0, dismissed = 0;
		store.add(onboarding.onDidComplete(() => completed++));
		store.add(onboarding.onDidDismiss(() => dismissed++));
		button(container, '.onboarding-a-footer-right button:last-child').click();
		assert.ok(container.querySelector('.onboarding-a-personalize'));
		button(container, '.onboarding-a-footer-right button:last-child').click();
		container.querySelector('.onboarding-a-overlay')?.dispatchEvent(new mainWindow.Event('transitionend'));
		assert.strictEqual(container.querySelector('[role="dialog"]'), null);
		assert.deepStrictEqual({ completed, dismissed, commands: executeCommand.callCount }, { completed: 1, dismissed: 1, commands: 0 });
	});

	test('the personalization sign-in nudge still works after navigating back and forward', async () => {
		const { container, executeCommand } = createOnboarding();
		button(container, '.onboarding-a-footer-right button:last-child').click();
		button(container, '.onboarding-a-footer-right button:first-child').click();
		button(container, '.onboarding-a-footer-right button:last-child').click();
		button(container, '.onboarding-a-signin-nudge-btn').click();
		await executeCommand.firstCall.returnValue;
		assert.deepStrictEqual(executeCommand.firstCall.args, ['studio.openAccount']);
	});

	test('the personalization nudge follows account changes while the step remains open', () => {
		const { container, setSignedIn } = createOnboarding();
		button(container, '.onboarding-a-footer-right button:last-child').click();
		setSignedIn(true);
		assert.strictEqual(container.querySelector('.onboarding-a-signin-nudge-btn'), null);
		setSignedIn(false);
		assert.ok(container.querySelector('.onboarding-a-signin-nudge-btn'));
	});

	test('repeated show uses one modal and reopening reads the latest session', () => {
		const { container, onboarding, setSignedIn } = createOnboarding();
		onboarding.show();
		assert.strictEqual(container.querySelectorAll('[role="dialog"]').length, 1);
		button(container, '.onboarding-a-close-btn').click();
		container.querySelector('.onboarding-a-overlay')?.dispatchEvent(new mainWindow.Event('transitionend'));
		setSignedIn(true);
		onboarding.show();
		assert.ok(container.querySelector('.onboarding-a-signin-confirmation'));
		onboarding.dispose();
		onboarding.show();
		assert.strictEqual(container.querySelector('[role="dialog"]'), null);
	});
});
