/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface INodeTaskRuntime {
	nodePath: string;
	args?: string[];
	env: { PATH: string };
}

/** Resolve implicit local Node/tool process tasks; explicit executables and PATH win. */
export async function resolveNodeTaskRuntime(command: string, env: Record<string, unknown> | undefined, remoteAuthority: string | undefined, resolve: (command: string) => Promise<INodeTaskRuntime | undefined>): Promise<INodeTaskRuntime | undefined> {
	if (remoteAuthority || !/^(?:node(?:\.exe)?|(?:npm|npx|pnpm)(?:\.cmd)?)$/i.test(command) || Object.keys(env ?? {}).some(key => key.toLowerCase() === 'path')) {
		return undefined;
	}
	return resolve(command);
}
