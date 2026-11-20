/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lstat, readFile } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { downloadedStudioProject, IStudioReleaseProject, parseStudioReleaseProject } from '../../window/common/studioReleaseProject.js';

/** Detect local release folders before creating their window; never execute project code. */
export async function readStudioReleaseProject(folder: URI | undefined, locale = 'en'): Promise<IStudioReleaseProject | undefined> {
	if (folder?.scheme !== Schemas.file) { return undefined; }
	try {
		const read = async (name: string, limit: number) => {
			const file = join(folder.fsPath, name);
			const stat = await lstat(file).catch(() => undefined);
			return stat?.isFile() && stat.size <= limit ? readFile(file, 'utf8') : undefined;
		};
		const [release, receipt] = await Promise.all([read('steamharness.release.json', 2_000_000), read('.steamharness/download.json', 2048)]);
		if (!release && !receipt) { return undefined; }
		const project = await read('steamharness.json', 2_000_000);
		return project ? (release && parseStudioReleaseProject(folder.toString(), project, release, locale)) || downloadedStudioProject(folder.toString(), project, undefined, receipt) : undefined;
	} catch { return undefined; }
}
