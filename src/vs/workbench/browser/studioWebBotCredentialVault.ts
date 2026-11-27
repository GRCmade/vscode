/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISecretStorageService } from '../../platform/secrets/common/secrets.js';

export type WebBotCredentialKind = 'api-key' | 'password' | 'ssh-private-key' | 'structured';
export interface WebBotCredentialSlot { name: string; kind: WebBotCredentialKind }
export type WebBotCredentialAction = { action: 'list' } | { action: 'add' | 'replace'; name: string; kind: WebBotCredentialKind; value: string } | { action: 'delete'; name: string; kind: WebBotCredentialKind };
type Result = { status: 'ok'; rows: WebBotCredentialSlot[] } | { status: 'invalid' | 'too-large' | 'existing' | 'missing' | 'unavailable' };

const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const prefixPattern = /^web-bot-credentials:v1:[a-f0-9]{64}:$/;
const isKind = (kind: string): kind is WebBotCredentialKind => kind === 'api-key' || kind === 'password' || kind === 'ssh-private-key' || kind === 'structured';

/** Only metadata goes to the extension host. The write and cross-tab lock stay in the trusted browser workbench. */
export async function applyWebBotCredentialAction(secrets: Pick<ISecretStorageService, 'type' | 'keys' | 'set' | 'delete'>,
	authorize: () => Promise<string | undefined>, signal: AbortSignal, action: WebBotCredentialAction): Promise<Result> {
	if (secrets.type !== 'persisted' || !secrets.keys || !navigator.locks || signal.aborted) { return { status: 'unavailable' }; }
	const prefix = await authorize();
	if (!prefix || !prefixPattern.test(prefix) || signal.aborted) { return { status: 'unavailable' }; }
	return navigator.locks.request(prefix, { signal }, async (): Promise<Result> => {
		const keys = new Set(await secrets.keys!());
		if (await authorize() !== prefix || signal.aborted) { return { status: 'unavailable' }; }
		if (action.action !== 'list') {
			const { name, kind } = action;
			if (!namePattern.test(name) || !isKind(kind)) { return { status: 'invalid' }; }
			const key = `${prefix}${kind}:${name}`;
			if (action.action === 'delete') {
				await secrets.delete(key); keys.delete(key);
			} else {
				if (new TextEncoder().encode(action.value).length > 65_536) { return { status: 'too-large' }; }
				if (keys.has(key) && action.action === 'add') { return { status: 'existing' }; }
				if (!keys.has(key) && action.action === 'replace') { return { status: 'missing' }; }
				await secrets.set(key, action.value); keys.add(key);
			}
		}
		if (signal.aborted) { return { status: 'unavailable' }; }
		const rows: WebBotCredentialSlot[] = [];
		for (const key of keys) {
			if (!key.startsWith(prefix)) { continue; }
			const [kind, name, extra] = key.slice(prefix.length).split(':');
			if (extra === undefined && namePattern.test(name) && isKind(kind)) { rows.push({ name, kind }); }
		}
		return { status: 'ok', rows: rows.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)) };
	});
}
