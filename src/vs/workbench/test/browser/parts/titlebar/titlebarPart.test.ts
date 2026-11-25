/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CodeWindow, mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestColorTheme, TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import '../../../../browser/actions/layoutActions.js';
import { DEFAULT_EDITOR_PART_OPTIONS } from '../../../../browser/parts/editor/editor.js';
import { BrowserTitlebarPart } from '../../../../browser/parts/titlebar/titlebarPart.js';
import { WindowTitle } from '../../../../browser/parts/titlebar/windowTitle.js';
import { AuxiliaryBarVisibleContext } from '../../../../common/contextkeys.js';
import { MODERN_UI_INACTIVE_SHELL_BACKGROUND, MODERN_UI_SHELL_BACKGROUND, TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_INACTIVE_BACKGROUND } from '../../../../common/theme.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorGroupsContainer } from '../../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { TestContextMenuService, TestEditorGroupsService, TestHostService, TestLayoutService, workbenchInstantiationService } from '../../workbenchTestServices.js';

suite('TitlebarPart colors', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class TestTitlebarPart extends BrowserTitlebarPart {
		protected override createContentArea(parent: HTMLElement): HTMLElement {
			this.element = parent;
			return parent;
		}
	}

	test('resolves shell and title colors from the target window focus', () => {
		let focused = false;
		const targetWindow = new class extends mock<CodeWindow>() {
			override vscodeWindowId = mainWindow.vscodeWindowId;
			override document = new class extends mock<Document>() {
				override hasFocus(): boolean { return focused; }
			}();
		}();
		const activeWindowEmitter = store.add(new Emitter<number>());
		const hostService = new class extends TestHostService {
			override readonly onDidChangeActiveWindow = activeWindowEmitter.event;
		}();
		const themeService = new TestThemeService(new TestColorTheme({
			[TITLE_BAR_ACTIVE_BACKGROUND]: '#112233',
			[TITLE_BAR_INACTIVE_BACKGROUND]: '#223344',
			[MODERN_UI_SHELL_BACKGROUND]: '#334455',
			[MODERN_UI_INACTIVE_SHELL_BACKGROUND]: '#445566',
		}));
		const root = document.createElement('div');
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(IThemeService, themeService);
		instantiationService.stub(IContextMenuService, new TestContextMenuService());
		instantiationService.stub(IWorkbenchLayoutService, new class extends TestLayoutService {
			override getContainer(): HTMLElement { return root; }
		}());
		instantiationService.stubInstance(WindowTitle, { dispose() { } });
		const groups = new class extends mock<IEditorGroupsContainer>() {
			override onDidChangeEditorPartOptions = Event.None;
		}();
		const part = store.add(instantiationService.createInstance(TestTitlebarPart, Parts.TITLEBAR_PART, targetWindow, groups));
		const container = document.createElement('div');
		part.create(container);
		const colors = () => ({
			title: container.style.backgroundColor,
			shell: root.style.getPropertyValue('--modern-ui-shell-background'),
		});
		const initiallyInactive = colors();
		focused = true;
		activeWindowEmitter.fire(targetWindow.vscodeWindowId);
		const active = colors();
		focused = false;
		activeWindowEmitter.fire(targetWindow.vscodeWindowId + 1);
		hostService.setFocus(false);
		hostService.setFocus(true);
		const anotherWindowActive = colors();

		themeService.setTheme(new TestColorTheme({
			[TITLE_BAR_ACTIVE_BACKGROUND]: '#112233',
			[MODERN_UI_SHELL_BACKGROUND]: '#334455',
		}));
		const missingInactiveColors = colors();

		assert.deepStrictEqual({ initiallyInactive, active, anotherWindowActive, missingInactiveColors }, {
			initiallyInactive: { title: 'rgb(34, 51, 68)', shell: '#445566' },
			active: { title: 'rgb(17, 34, 51)', shell: '#334455' },
			anotherWindowActive: { title: 'rgb(34, 51, 68)', shell: '#445566' },
			missingInactiveColors: { title: 'rgb(17, 34, 51)', shell: '#334455' },
		});
	});

	test('uses title bar foreground colors for action toolbar icons', () => {
		const workbench = document.createElement('div');
		workbench.className = 'monaco-workbench';
		workbench.style.color = '#abcdef';
		workbench.style.setProperty('--vscode-titleBar-activeForeground', '#112233');
		workbench.style.setProperty('--vscode-titleBar-inactiveForeground', '#445566');

		const titlebar = document.createElement('div');
		titlebar.className = 'part titlebar';
		const titlebarContainer = document.createElement('div');
		titlebarContainer.className = 'titlebar-container';
		const titlebarRight = document.createElement('div');
		titlebarRight.className = 'titlebar-right';
		const actionToolbar = document.createElement('div');
		actionToolbar.className = 'action-toolbar-container';
		const icon = document.createElement('span');
		icon.className = 'codicon';
		actionToolbar.appendChild(icon);
		titlebarRight.appendChild(actionToolbar);
		titlebarContainer.appendChild(titlebarRight);
		titlebar.appendChild(titlebarContainer);
		workbench.appendChild(titlebar);
		document.body.appendChild(workbench);

		try {
			const active = mainWindow.getComputedStyle(icon).color;
			titlebar.classList.add('inactive');
			const inactive = mainWindow.getComputedStyle(icon).color;

			assert.deepStrictEqual({ active, inactive }, {
				active: 'rgb(17, 34, 51)',
				inactive: 'rgb(68, 85, 102)',
			});
		} finally {
			workbench.remove();
		}
	});
});

suite('Workbench - Titlebar Part', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const updateTitleBarToolBarOverflow = Reflect.get(BrowserTitlebarPart.prototype, 'updateTitleBarToolBarOverflow') as (this: BrowserTitlebarPart) => void;

	test('hides optional toolbar groups in priority order', () => {
		let rootClientWidth = 130;
		const centerAdjacentToolBar = mainWindow.document.createElement('div');
		const updateToolBar = mainWindow.document.createElement('div');
		const root = createMeasuredElement(
			() => rootClientWidth,
			() => 100 + visibleWidth(centerAdjacentToolBar, 30) + visibleWidth(updateToolBar, 30)
		);
		const titlebarPart = Object.create(BrowserTitlebarPart.prototype) as BrowserTitlebarPart;
		Reflect.set(titlebarPart, 'rootContainer', root);
		Reflect.set(titlebarPart, 'centerAdjacentToolBarElement', centerAdjacentToolBar);
		Reflect.set(titlebarPart, 'updateToolBarElement', updateToolBar);

		updateTitleBarToolBarOverflow.call(titlebarPart);
		const centerHiddenFirst = [centerAdjacentToolBar, updateToolBar].map(element => element.classList.contains('overflowing'));

		rootClientWidth = 100;
		updateTitleBarToolBarOverflow.call(titlebarPart);
		const bothHidden = [centerAdjacentToolBar, updateToolBar].map(element => element.classList.contains('overflowing'));

		rootClientWidth = 160;
		updateTitleBarToolBarOverflow.call(titlebarPart);
		const bothVisible = [centerAdjacentToolBar, updateToolBar].map(element => element.classList.contains('overflowing'));

		assert.deepStrictEqual({ centerHiddenFirst, bothHidden, bothVisible }, {
			centerHiddenFirst: [true, false],
			bothHidden: [true, true],
			bothVisible: [false, false],
		});
	});
});

suite('Workbench - Compact titlebar layout controls', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createTitlebar(type: 'both' | 'menu', enabled = true) {
		const workbench = document.createElement('div');
		workbench.className = 'monaco-workbench mac';
		const titlebar = document.createElement('div');
		titlebar.className = 'part titlebar';
		titlebar.style.height = '44px';
		workbench.appendChild(titlebar);
		document.body.appendChild(workbench);
		store.add({ dispose: () => workbench.remove() });

		const instantiationService = workbenchInstantiationService({
			configurationService: () => new TestConfigurationService({
				window: { commandCenter: false, menuBarVisibility: 'compact' },
				workbench: { sideBar: { location: 'left' }, layoutControl: { type, enabled } },
			}),
		}, store);
		const contextKeys = store.add(instantiationService.createInstance(ContextKeyService));
		instantiationService.stub(IContextKeyService, contextKeys);
		const commands = store.add(instantiationService.createInstance(CommandService));
		instantiationService.stub(ICommandService, commands);
		instantiationService.stub(IMenuService, store.add(instantiationService.createInstance(MenuService)));
		instantiationService.stubInstance(WindowTitle, { value: 'Project', onDidChange: Event.None, dispose() { } });
		const visible = AuxiliaryBarVisibleContext.bindTo(contextKeys);
		instantiationService.stub(IWorkbenchLayoutService, new class extends TestLayoutService {
			override mainContainer = workbench;
			override getContainer(): HTMLElement { return workbench; }
			override toggleSecondarySideBar(): void { visible.set(!visible.get()); }
		}());
		const groups = new TestEditorGroupsService();
		groups.partOptions = DEFAULT_EDITOR_PART_OPTIONS;
		class TestTitlebar extends BrowserTitlebarPart {
			protected override get hasStudioModeSwitcher(): boolean { return false; }
		}
		const part = store.add(instantiationService.createInstance(TestTitlebar, Parts.TITLEBAR_PART, mainWindow, groups));
		part.create(titlebar);
		return {
			titlebar,
			part,
			contextKeys,
			commands,
			isSecondarySideBarVisible: () => visible.get(),
			layout(width: number, fullscreen: boolean) {
				workbench.classList.toggle('fullscreen', fullscreen);
				workbench.style.width = `${width}px`;
				part.layout(width, 44);
			},
		};
	}

	function assertClickable(element: HTMLElement | null): asserts element is HTMLElement {
		assert.ok(element);
		const { x, y, width, height } = element.getBoundingClientRect();
		assert.ok(width > 0 && height > 0);
		assert.ok(element.contains(document.elementFromPoint(x + width / 2, y + height / 2)));
	}

	test('keeps the IDE secondary side bar toggle clickable in compact fullscreen', async () => {
		const fixture = createTitlebar('both');
		const toggle = () => fixture.titlebar.querySelector<HTMLElement>('.action-toolbar-container [class*="codicon-auxiliarybar-right-"][role="button"]');
		fixture.layout(1200, false);
		assertClickable(toggle());
		fixture.layout(894, true);
		assert.strictEqual(fixture.titlebar.querySelectorAll('.action-toolbar-container .action-item').length, 2);
		assertClickable(fixture.titlebar.querySelector('.action-toolbar-container .codicon-toolbar-more'));
		for (const visible of [true, false]) {
			const button = toggle();
			assertClickable(button);
			const executed = Event.toPromise(fixture.commands.onDidExecuteCommand);
			button.click();
			assert.strictEqual((await executed).commandId, 'workbench.action.toggleAuxiliaryBar');
			assert.strictEqual(fixture.isSecondarySideBarVisible(), visible);
		}
		fixture.layout(1200, false);
		assertClickable(toggle());
		assert.ok(fixture.titlebar.querySelectorAll('.action-toolbar-container .action-item').length > 1);
	});

	test('keeps the layout menu in menu-only mode and leaves disabled layout controls hidden', () => {
		const menu = createTitlebar('menu');
		menu.layout(894, true);
		assertClickable(menu.titlebar.querySelector('.action-toolbar-container .codicon-configure-layout-icon'));
		const disabled = createTitlebar('both', false);
		disabled.layout(894, true);
		assert.strictEqual(disabled.titlebar.querySelector('.action-toolbar-container [class*="codicon-auxiliarybar-right-"]'), null);
	});

	test('reports project actions even while the title bar is hidden and updates when they disappear', async () => {
		const fixture = createTitlebar('both', false);
		fixture.titlebar.style.display = 'none';
		assert.strictEqual(fixture.part.hasTitlebarContent, false);
		const canRun = fixture.contextKeys.createKey<boolean>('studio.projectReleaseAvailable', false);
		let changed = Event.toPromise(fixture.part.onDidChangeTitlebarContent);
		canRun.set(true);
		await changed;
		assert.strictEqual(fixture.part.hasTitlebarContent, true);
		changed = Event.toPromise(fixture.part.onDidChangeTitlebarContent);
		canRun.set(false);
		await changed;
		assert.strictEqual(fixture.part.hasTitlebarContent, false);
	});
});

function createMeasuredElement(clientWidth: () => number, scrollWidth: () => number): HTMLElement {
	const element = mainWindow.document.createElement('div');
	Object.defineProperties(element, {
		clientWidth: { get: clientWidth },
		scrollWidth: { get: scrollWidth },
	});
	return element;
}

function visibleWidth(element: HTMLElement, width: number): number {
	return element.classList.contains('overflowing') || element.classList.contains('has-no-actions') ? 0 : width;
}
