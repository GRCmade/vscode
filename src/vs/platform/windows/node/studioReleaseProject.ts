/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'fs/promises';
import { join } from '../../../base/common/path.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { IStudioReleaseProject, parseStudioReleaseProject } from '../../window/common/studioReleaseProject.js';

/** Detect local release folders before creating their window; never execute project code. */
export async function readStudioReleaseProject(folder: URI | undefined): Promise<IStudioReleaseProject | undefined> {
	if (folder?.scheme !== Schemas.file) { return undefined; }
	try {
		const files = ['steamharness.json', 'steamharness.release.json'].map(name => join(folder.fsPath, name));
		const stats = await Promise.all(files.map(file => stat(file)));
		if (stats.some(value => !value.isFile() || value.size > 2_000_000)) { return undefined; }
		const [project, release] = await Promise.all(files.map(file => readFile(file, 'utf8')));
		return parseStudioReleaseProject(folder.toString(), project, release);
	} catch { return undefined; }
}
