/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IMeteredConnectionService = createDecorator<IMeteredConnectionService>('meteredConnectionService');

/**
 * Service to report on metered connection status.
 */
export interface IMeteredConnectionService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether the current network connection is metered.
	 */
	readonly isConnectionMetered: boolean;

	/**
	 * Event that fires when the metered connection status changes.
	 */
	readonly onDidChangeIsConnectionMetered: Event<boolean>;
}

/** Keeps the service contract for existing consumers without enabling metered mode in Studio. */
export class UnmeteredConnectionService implements IMeteredConnectionService {
	declare readonly _serviceBrand: undefined;
	readonly isConnectionMetered = false;
	readonly onDidChangeIsConnectionMetered = Event.None;
}
