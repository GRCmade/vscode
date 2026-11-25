/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import File from 'vinyl';
import { type IExtensionDefinition } from '../builtInExtensions.ts';
import { packageMarketplaceExtensionStream } from '../extensions.ts';
import { gulp, vinylZip } from '../gulp/facade.ts';

test('bundles a pinned VSIX without rewriting self-checked files when requested', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-extension-packaging-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const manifest = { name: 'fixture', publisher: 'test', version: '1.0.0' };
	const contents = {
		'package.json': Buffer.from(JSON.stringify({ ...manifest, scripts: { build: 'build' }, dependencies: { sample: '1.0.0' } }, null, 2) + '\n'),
		'language-configuration.json': Buffer.from('{\n\t"comments": { "lineComment": "--" }\n}\n'),
	};
	const files = Object.entries(contents).map(([name, contents]) => new File({
		base: root, path: path.join(root, 'extension', name), contents
	}));
	await pipeline(Readable.from(files), vinylZip.zip('fixture.vsix'), gulp.dest(root));
	const vsix = path.join(root, 'fixture.vsix');
	const extension: IExtensionDefinition = {
		name: `test.${path.basename(root)}`,
		version: manifest.version,
		repo: '',
		sha256: createHash('sha256').update(await fs.readFile(vsix)).digest('hex'),
		vsix,
		metadata: { id: 'fixture-id', publisherId: { publisherId: 'test-id', publisherName: 'test', displayName: 'Test', flags: '' }, publisherDisplayName: 'Test' },
	};
	const original = Object.values(contents);
	const optimized = [
		Buffer.from(JSON.stringify({ ...manifest, __metadata: extension.metadata })),
		Buffer.from('{"comments":{"lineComment":"--"}}'),
	];
	for (const [preserveVsixContents, expected] of [[true, original], [false, optimized]] as const) {
		const output = path.join(root, preserveVsixContents ? 'preserved' : 'optimized');
		await pipeline(packageMarketplaceExtensionStream({ ...extension, preserveVsixContents }), gulp.dest(output));
		assert.deepStrictEqual(await Promise.all(Object.keys(contents).map(name =>
			fs.readFile(path.join(output, 'extensions', extension.name, name)))), expected);
	}
});
