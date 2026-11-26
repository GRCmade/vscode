/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../base/common/uuid.js';
import type { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { projectUsageKey, type ProjectUsageBridge, type UsagePart as Part, type ProjectUsageSnapshot as Snapshot, type ProjectUsageTarget as UsageTarget } from './studioProjectUsageView.js';

export { ProjectUsageView as StudioProjectUsage, projectUsageKey, type ProjectUsageBridge } from './studioProjectUsageView.js';

const cachePrefix = 'studio.projectUsage.v1:';
const cacheLimit = 32;
const cacheSizeLimit = 1_000_000;

export function projectUsageBridge(commands: ICommandService, clipboard: IClipboardService, storage: IStorageService): ProjectUsageBridge {
	const command = 'studio.internalProjectUsage';
	const cacheKey = (target: UsageTarget, part: Part) => `${cachePrefix}${projectUsageKey(target)}:${part}`;
	const readCache = (key: string) => {
		try { return storage.getObject<Snapshot>(key, StorageScope.PROFILE); }
		catch { return undefined; }
	};
	return {
		requestId: generateUuid,
		cached: target => {
			const directory = readCache(cacheKey(target, 'directory')), runtime = readCache(cacheKey(target, 'runtime'));
			return {
				directory: directory?.part === 'directory' && Array.isArray(directory.usage?.folders) ? directory : undefined,
				runtime: runtime?.part === 'runtime' && runtime.usage?.size && Array.isArray(runtime.usage.entries) ? runtime : undefined,
			};
		},
		remember: (target, snapshot) => {
			const key = cacheKey(target, snapshot.part);
			if ((readCache(key)?.measuredAt ?? 0) > snapshot.measuredAt) { return; }
			const encoded = JSON.stringify(snapshot);
			if (encoded.length > cacheSizeLimit) { return; }
			// Usage includes local paths. Keep it in the current profile, off Settings Sync.
			storage.store(key, encoded, StorageScope.PROFILE, StorageTarget.MACHINE);
			const entries = storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE).filter(key => key.startsWith(cachePrefix))
				.map(key => ({ key, length: storage.get(key, StorageScope.PROFILE, '').length }));
			let count = entries.length, length = entries.reduce((total, entry) => total + entry.length, 0);
			if (count > cacheLimit || length > cacheSizeLimit) {
				const oldest = entries.filter(entry => entry.key !== key).map(entry => ({ ...entry, time: readCache(entry.key)?.measuredAt ?? 0 }))
					.sort((a, b) => a.time - b.time);
				for (const entry of oldest) {
					if (count <= cacheLimit && length <= cacheSizeLimit) { break; }
					storage.remove(entry.key, StorageScope.PROFILE);
					count--;
					length -= entry.length;
				}
			}
		},
		read: ({ uri, projectId, distribution, managed }, part, id) => commands.executeCommand<Snapshot | undefined>(command,
			{ uri, managed, part, id, refresh: true, identity: [projectId, distribution].join(':') }),
		cancel: id => { void commands.executeCommand(command, { id, cancel: true }).catch(() => undefined); },
		copy: path => { void clipboard.writeText(path).catch(() => undefined); },
	};
}
