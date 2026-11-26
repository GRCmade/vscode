/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IMeteredConnectionService, UnmeteredConnectionService } from '../common/meteredConnection.js';

registerSingleton(IMeteredConnectionService, UnmeteredConnectionService, InstantiationType.Delayed);
