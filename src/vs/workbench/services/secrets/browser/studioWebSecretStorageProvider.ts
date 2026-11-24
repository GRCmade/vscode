/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BroadcastDataChannel } from '../../../../base/browser/broadcast.js';
import { IndexedDB } from '../../../../base/browser/indexedDB.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';

interface EncryptedSecret {
	readonly iv: Uint8Array<ArrayBuffer>;
	readonly ciphertext: ArrayBuffer;
}

const secretsStore = 'secrets';
const keyStore = 'keys';
const keyName = 'encryption';
const algorithm = 'AES-GCM';

export class StudioWebSecretStorageProvider extends Disposable implements Omit<ISecretStorageService, '_serviceBrand'> {
	static isSupported(): boolean {
		return !!mainWindow.crypto?.subtle && 'indexedDB' in mainWindow;
	}

	readonly type = 'persisted';
	private readonly database: Lazy<Promise<IndexedDB>>;
	private readonly key = new Lazy(() => this.loadKey());
	private readonly changes: BroadcastDataChannel<string>;
	readonly onDidChangeSecret;

	constructor(basePath: string | undefined) {
		super();
		const name = `steamharness-studio-web-secrets:${basePath || '/'}`;
		this.database = new Lazy(async () => {
			const database = await IndexedDB.create(name, 1, [secretsStore, keyStore]);
			this._register(toDisposable(() => database.close()));
			return database;
		});
		this.changes = this._register(new BroadcastDataChannel<string>(name));
		this.onDidChangeSecret = this.changes.onDidReceiveData;
	}

	private async loadKey(): Promise<CryptoKey> {
		const db = await this.database.value;
		const stored = await db.runInTransaction<CryptoKey | undefined>(keyStore, 'readonly', store => store.get(keyName));
		if (stored instanceof CryptoKey) {
			return stored;
		}
		const candidate = await mainWindow.crypto.subtle.generateKey({ name: algorithm, length: 256 }, false, ['encrypt', 'decrypt']);
		// Concurrent first sign-ins must agree on one non-exportable key for this origin.
		const result = await db.compareAndSwap(keyStore, keyName, undefined, candidate, (value): value is CryptoKey => value instanceof CryptoKey);
		return result.currentValue ?? candidate;
	}

	async get(key: string): Promise<string | undefined> {
		const db = await this.database.value;
		const record = await db.runInTransaction<EncryptedSecret | undefined>(secretsStore, 'readonly', store => store.get(key));
		if (!record) {
			return undefined;
		}
		const encryptionKey = await this.key.value;
		try {
			const plaintext = await mainWindow.crypto.subtle.decrypt({ name: algorithm, iv: record.iv, additionalData: new TextEncoder().encode(key) }, encryptionKey, record.ciphertext);
			return new TextDecoder().decode(plaintext);
		} catch {
			// Damaged or undecryptable records should not prevent a new sign-in.
			return undefined;
		}
	}

	async set(key: string, value: string): Promise<void> {
		const db = await this.database.value;
		const iv = mainWindow.crypto.getRandomValues(new Uint8Array(12));
		const encode = new TextEncoder();
		const ciphertext = await mainWindow.crypto.subtle.encrypt({ name: algorithm, iv, additionalData: encode.encode(key) }, await this.key.value, encode.encode(value));
		await db.runInTransaction(secretsStore, 'readwrite', store => store.put({ iv, ciphertext } satisfies EncryptedSecret, key));
		this.notify(key);
	}

	async delete(key: string): Promise<void> {
		const db = await this.database.value;
		await db.runInTransaction(secretsStore, 'readwrite', store => store.delete(key));
		this.notify(key);
	}

	async keys(): Promise<string[]> {
		const db = await this.database.value;
		return (await db.runInTransaction(secretsStore, 'readonly', store => store.getAllKeys())).filter(key => typeof key === 'string');
	}

	private notify(key: string): void {
		try { this.changes.postData(key); } catch { /* A failed cross-tab notification does not undo a committed write. */ }
	}
}
