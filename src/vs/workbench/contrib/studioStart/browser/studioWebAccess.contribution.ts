/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

// Run from the workbench origin rather than granting its cookie to the extension host or a webview.
CommandsRegistry.registerCommand('studio.internalWebAccess', async (_accessor, route: string, input: { action?: string }) => {
	if (route !== 'manage' && route !== 'preview') {
		return { error: 'unavailable' };
	}
	try {
		const result = await fetch(`/_studio/web/${route}`, {
			method: 'POST', redirect: 'error', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000),
			headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
		});
		if (result.status === 401 || result.ok && route === 'manage' && input.action === 'logout') {
			mainWindow.location.replace('/pair');
		}
		return await result.json();
	} catch {
		return { error: 'unavailable' };
	}
});
