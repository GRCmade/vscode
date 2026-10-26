/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SourceMapConsumer } from 'source-map';
import { mapWithConcurrency, transpileFile } from '../transpile.ts';

suite('transpile', () => {
	test('source NLS keeps stable keys and maps code after translated calls to the original source', async t => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-nls-map-'));
		t.after(() => fs.rm(root, { recursive: true, force: true }));
		const input = path.join(root, 'src', 'vs', 'sample.ts');
		const output = path.join(root, 'out', 'vs', 'sample.js');
		const source = `import { localize } from '../nls.js';\nexport const label = localize({ key: 'name', comment: ['Name'] }, 'Name'); export function sentinel() { return label; }`;
		await fs.mkdir(path.dirname(input), { recursive: true });
		await fs.writeFile(input, source);
		await transpileFile(input, output, path.join(root, 'src'));
		const code = await fs.readFile(output, 'utf8');
		assert.match(code, /%%NLS:vs\/sample#name%%/);
		const encodedMap = /sourceMappingURL=data:application\/json;base64,([^\s]+)/.exec(code)![1];
		const map = new SourceMapConsumer(JSON.parse(Buffer.from(encodedMap, 'base64').toString()));
		const lines = code.split('\n');
		const line = lines.findIndex(line => line.includes('function sentinel'));
		const original = map.originalPositionFor({ line: line + 1, column: lines[line].indexOf('sentinel') });
		assert.deepStrictEqual({ line: original.line, column: original.column }, { line: 2, column: source.split('\n')[1].indexOf('sentinel') });
	});
	test('bounds concurrent work and preserves result order', async () => {
		let active = 0;
		let maximumActive = 0;

		const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async item => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise(resolve => setImmediate(resolve));
			active--;
			return item * 2;
		});

		assert.deepStrictEqual({ maximumActive, results }, {
			maximumActive: 2,
			results: [0, 2, 4, 6, 8],
		});
	});

	test('propagates errors and stops scheduling work', async () => {
		const started: number[] = [];

		await assert.rejects(mapWithConcurrency([0, 1, 2, 3], 2, async item => {
			started.push(item);
			if (item === 0) {
				throw new Error('expected failure');
			}
			await new Promise(resolve => setImmediate(resolve));
		}), /expected failure/);

		assert.deepStrictEqual(started, [0, 1]);
	});
});
