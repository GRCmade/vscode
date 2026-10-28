/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface INodeTaskRuntime {
	nodePath: string;
	env: { PATH: string };
}

/** Resolve only implicit local Node process tasks; explicit executables and PATH win. */
export async function resolveNodeTaskRuntime(command: string, env: Record<string, unknown> | undefined, remoteAuthority: string | undefined, resolve: () => Promise<INodeTaskRuntime | undefined>): Promise<INodeTaskRuntime | undefined> {
	if (remoteAuthority || !/^(node|node\.exe)$/i.test(command) || Object.keys(env ?? {}).some(key => key.toLowerCase() === 'path')) {
		return undefined;
	}
	return resolve();
}
