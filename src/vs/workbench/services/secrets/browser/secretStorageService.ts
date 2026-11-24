/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageProvider, ISecretStorageService, BaseSecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { StudioWebSecretStorageProvider } from './studioWebSecretStorageProvider.js';

export class BrowserSecretStorageService extends BaseSecretStorageService {

	private readonly _secretStorageProvider: ISecretStorageProvider | undefined;
	private readonly _embedderSequencer: SequencerByKey<string> | undefined;

	constructor(
		@IStorageService storageService: IStorageService,
		@IEncryptionService encryptionService: IEncryptionService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@ILogService logService: ILogService
	) {
		// We don't have encryption in the browser so instead we use the
		// in-memory base class implementation instead.
		super(true, storageService, encryptionService, logService);

		const options = environmentService.options;
		let provider = options?.secretStorageProvider;
		if (!provider && options?.studioWeb && StudioWebSecretStorageProvider.isSupported()) {
			const studioProvider = this._register(new StudioWebSecretStorageProvider(options.serverBasePath));
			this._register(studioProvider.onDidChangeSecret(key => this.onDidChangeSecretEmitter.fire(key)));
			provider = studioProvider;
		}
		if (provider) {
			this._secretStorageProvider = provider;
			this._embedderSequencer = new SequencerByKey<string>();
		}
	}

	override get(key: string): Promise<string | undefined> {
		if (this._secretStorageProvider) {
			return this._embedderSequencer!.queue(key, () => this._secretStorageProvider!.get(key));
		}

		return super.get(key);
	}

	override set(key: string, value: string): Promise<void> {
		if (this._secretStorageProvider) {
			return this._embedderSequencer!.queue(key, async () => {
				await this._secretStorageProvider!.set(key, value);
				this.onDidChangeSecretEmitter.fire(key);
			});
		}

		return super.set(key, value);
	}

	override delete(key: string): Promise<void> {
		if (this._secretStorageProvider) {
			return this._embedderSequencer!.queue(key, async () => {
				await this._secretStorageProvider!.delete(key);
				this.onDidChangeSecretEmitter.fire(key);
			});
		}

		return super.delete(key);
	}

	override get type() {
		if (this._secretStorageProvider) {
			return this._secretStorageProvider.type;
		}

		return super.type;
	}

	override keys(): Promise<string[]> {
		if (this._secretStorageProvider) {
			if (!this._secretStorageProvider.keys) {
				throw new Error('Secret storage provider does not support keys() method');
			}
			return this._secretStorageProvider!.keys();
		}

		return super.keys();

	}
}

registerSingleton(ISecretStorageService, BrowserSecretStorageService, InstantiationType.Delayed);
