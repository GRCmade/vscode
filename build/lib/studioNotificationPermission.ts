/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../../src/vs/platform/native/electron-main/studioNotificationPermission.mm');
export const studioNotificationPermissionName = 'studio-notification-permission.node';

export function buildStudioNotificationPermission(destination: string, arch: string): void {
	const nodeHeaders = resolve(dirname(realpathSync(process.execPath)), '../include/node');
	mkdirSync(dirname(destination), { recursive: true });
	execFileSync('/usr/bin/xcrun', ['clang++', '-arch', arch === 'x64' ? 'x86_64' : arch, '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=11.0',
		'-framework', 'Foundation', '-framework', 'UserNotifications', '-I', nodeHeaders, source, '-o', destination], { stdio: 'inherit' });
}
