/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Shared project glyphs for native Studio surfaces. */
export function studioProjectIcon(projectType: string | undefined): string | undefined {
	switch (projectType) {
		case 'workflow': return 'run-all';
		case 'bot': return 'hubot';
		case 'kanban': return 'layout';
		default: return undefined;
	}
}
