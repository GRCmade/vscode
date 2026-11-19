/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../base/common/event.js';

let order: readonly string[] = [];
const change = new Emitter<void>();
export const onDidChangeStudioSidebarTabs = change.event;
export const isStudioSidebarTab = (id: string): boolean => id === 'studio-assistant' || /^studio-sidebar\.[\w-]{1,80}$/.test(id);

export function setStudioSidebarOrder(ids: readonly string[]): void {
	order = ids;
	change.fire();
}

export function applyStudioSidebarOrder<T extends { id: string; pinned: boolean }>(items: readonly T[]): T[] {
	const byId = new Map(items.filter(item => isStudioSidebarTab(item.id)).map(item => [item.id, item]));
	return [...order.flatMap(id => {
		const item = byId.get(id);
		return item ? [{ ...item, pinned: true }] : [];
	}), ...items.filter(item => !isStudioSidebarTab(item.id))];
}
