/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import '../../browser/meteredConnectionService.js';
import { IMeteredConnectionService } from '../../common/meteredConnection.js';

suite('Studio MeteredConnectionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the workbench stays unmetered even when an old setting forces metered mode', () => {
		const configuration = new TestConfigurationService({ 'network.meteredConnection': 'on' });
		store.add(configuration.onDidChangeConfigurationEmitter);
		const services = new ServiceCollection(...getSingletonServiceDescriptors().filter(([id]) => id === IMeteredConnectionService));
		services.set(IConfigurationService, configuration);
		const instantiationService = store.add(new InstantiationService(services, true));

		assert.strictEqual(instantiationService.invokeFunction(accessor => accessor.get(IMeteredConnectionService).isConnectionMetered), false);
	});
});
