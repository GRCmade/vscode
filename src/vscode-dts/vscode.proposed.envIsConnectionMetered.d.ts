/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export namespace env {
		/**
		 * Whether the current network connection is metered (such as mobile data or tethering).
		 * Always `false` in SteamHarness Studio.
		 */
		export const isMeteredConnection: boolean;

		/**
		 * Event that fires when the metered connection status changes.
		 * Never fires in SteamHarness Studio.
		 */
		export const onDidChangeMeteredConnection: Event<boolean>;
	}
}
