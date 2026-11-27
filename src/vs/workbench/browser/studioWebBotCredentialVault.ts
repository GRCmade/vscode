/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISecretStorageService } from '../../platform/secrets/common/secrets.js';

export type WebBotCredentialKind = 'api-key' | 'password' | 'ssh-private-key' | 'structured';
export interface WebBotCredentialSlot { name: string; kind: WebBotCredentialKind }
export type WebBotCredentialAction = { action: 'list' } | { action: 'add' | 'replace'; name: string; kind: WebBotCredentialKind; value: string } | { action: 'delete'; name: string; kind: WebBotCredentialKind };
type Result = { status: 'ok'; rows: WebBotCredentialSlot[] } | { status: 'invalid' | 'existing' | 'missing' | 'unavailable' };

const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const prefixPattern = /^web-bot-credentials:v1:[a-f0-9]{64}:$/;
const isKind = (kind: string): kind is WebBotCredentialKind => kind === 'api-key' || kind === 'password' || kind === 'ssh-private-key' || kind === 'structured';
const isSingleLine = (value: string) => !!value.trim() && !/[\0\r\n]/.test(value) && new TextEncoder().encode(value).length <= 16_384;

function validatedValue(kind: WebBotCredentialKind, value: string): string | undefined {
	if (kind === 'ssh-private-key') {
		return new TextEncoder().encode(value).length <= 65_536
			&& /^-----BEGIN ((?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----(?:\r?\n)?$/.test(value) ? value : undefined;
	}
	if (!isSingleLine(value)) { return undefined; }
	if (kind !== 'structured') { return value; }
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
		const fields = Object.entries(parsed);
		if (!fields.length || fields.length > 16 || fields.some(([key, text]) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(key)
			|| ['__proto__', 'prototype', 'constructor'].includes(key) || typeof text !== 'string' || !isSingleLine(text))) { return undefined; }
		return JSON.stringify(parsed);
	} catch { return undefined; }
}

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
				const value = validatedValue(kind, action.value);
				if (value === undefined) { return { status: 'invalid' }; }
				if (keys.has(key) && action.action === 'add') { return { status: 'existing' }; }
				if (!keys.has(key) && action.action === 'replace') { return { status: 'missing' }; }
				await secrets.set(key, value); keys.add(key);
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
