/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { Context } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { PreventDefaultContextMenuItemsContextKeyName } from '../../browser/webview.contribution.js';

suite('Webview context menu', () => {
	test('offers only native Copy for a Studio frame selection in a suppressed menu', () => {
		const context = new Context(0, null);
		const visibleClipboardCommands = () => MenuRegistry.getMenuItems(MenuId.WebviewContext)
			.filter(isIMenuItem)
			.filter(item => item.group === '5_cutcopypaste' && item.when?.evaluate(context))
			.map(item => item.command.id);

		const normalMenu = visibleClipboardCommands();
		context.setValue('studioFrameSelection', true);
		const normalMenuWithSelection = visibleClipboardCommands();
		context.setValue(PreventDefaultContextMenuItemsContextKeyName, true);
		const suppressedWithSelection = visibleClipboardCommands();
		context.setValue('studioFrameSelection', false);
		const suppressedWithoutSelection = visibleClipboardCommands();

		assert.deepStrictEqual({ normalMenuWithSelection, suppressedWithSelection, suppressedWithoutSelection }, {
			normalMenuWithSelection: normalMenu,
			suppressedWithSelection: ['editor.action.clipboardCopyAction'],
			suppressedWithoutSelection: [],
		});
	});
});
