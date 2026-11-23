/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { setZoomFactor, setZoomLevel } from '../../../base/browser/browser.js';
import { IRegisteredCodeWindow, trackAttributes } from '../../../base/browser/dom.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { timeout } from '../../../base/common/async.js';
import { DisposableStore, GCBasedDisposableTracker, IDisposable, setDisposableTracker, toDisposable } from '../../../base/common/lifecycle.js';
import { mock } from '../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { BaseWindow } from '../../browser/window.js';
import { TestContextMenuService, TestEnvironmentService, TestHostService, TestLayoutService } from './workbenchTestServices.js';

suite('Window', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class TestWindow extends BaseWindow {

		constructor(window: CodeWindow, dom: { getWindowsCount: () => number; getWindows: () => Iterable<IRegisteredCodeWindow> }, container = document.createElement('div')) {
			super(window, dom, new TestHostService(), TestEnvironmentService, new TestContextMenuService(), new class extends TestLayoutService {
				override getContainer(): HTMLElement { return container; }
			}());
		}

		protected override enableWindowFocusOnElementFocus(): void { }
	}

	test('keeps window zoom factors local when auxiliary document attributes are mirrored', async () => {
		class ZoomTestWindow extends TestWindow {
			protected override enableMultiWindowAwareTimeout(): void { }
		}
		const sourceWindow = new class extends mock<CodeWindow>() {
			override readonly vscodeWindowId = 801;
		}();
		const auxiliaryWindow = new class extends mock<CodeWindow>() {
			override readonly vscodeWindowId = 802;
		}();
		const sourceDocument = document.createElement('div');
		const auxiliaryDocument = document.createElement('div');
		const sourceContainer = sourceDocument.appendChild(document.createElement('div'));
		const auxiliaryContainer = auxiliaryDocument.appendChild(document.createElement('div'));
		document.body.append(sourceDocument, auxiliaryDocument);
		store.add(toDisposable(() => {
			sourceDocument.remove();
			auxiliaryDocument.remove();
			for (const window of [sourceWindow, auxiliaryWindow]) {
				setZoomFactor(1, window);
				setZoomLevel(0, window);
			}
		}));
		setZoomFactor(0.5, auxiliaryWindow);
		setZoomLevel(-1, auxiliaryWindow);

		const dom = { getWindowsCount: () => 2, getWindows: () => [] };
		store.add(new ZoomTestWindow(sourceWindow, dom, sourceContainer));
		const auxiliary = store.add(new ZoomTestWindow(auxiliaryWindow, dom, auxiliaryContainer));
		store.add(trackAttributes(sourceDocument, auxiliaryDocument));
		const factors = () => [sourceContainer, auxiliaryContainer].map(container => mainWindow.getComputedStyle(container).getPropertyValue('--window-zoom-factor'));
		const initial = factors();

		setZoomFactor(1.2, sourceWindow);
		setZoomLevel(1, sourceWindow);
		sourceDocument.style.setProperty('--window-zoom-factor', '1.2');
		await timeout(0);
		const afterSourceZoom = factors();

		setZoomFactor(0.8, auxiliaryWindow);
		setZoomLevel(-2, auxiliaryWindow);
		const afterAuxiliaryZoom = factors();
		auxiliary.dispose();
		setZoomFactor(1, auxiliaryWindow);
		setZoomLevel(0, auxiliaryWindow);

		assert.deepStrictEqual({ initial, afterSourceZoom, afterAuxiliaryZoom, afterDispose: factors() }, {
			initial: ['1', '0.5'],
			afterSourceZoom: ['1.2', '0.5'],
			afterAuxiliaryZoom: ['1.2', '0.8'],
			afterDispose: ['1.2', '0.8'],
		});
	});

	test('multi window aware setTimeout()', async function () {
		return runWithFakedTimers({ useFakeTimers: true }, async () => {
			const disposables = new DisposableStore();

			let windows: IRegisteredCodeWindow[] = [];
			const dom = {
				getWindowsCount: () => windows.length,
				getWindows: () => windows
			};

			const setTimeoutCalls: number[] = [];
			const clearTimeoutCalls: number[] = [];

			function createWindow(id: number, slow?: boolean) {
				// eslint-disable-next-line local/code-no-any-casts
				const res = {
					setTimeout: function (callback: Function, delay: number, ...args: unknown[]): number {
						setTimeoutCalls.push(id);

						return mainWindow.setTimeout(() => callback(id), slow ? delay * 2 : delay, ...args);
					},
					clearTimeout: function (timeoutId: number): void {
						clearTimeoutCalls.push(id);

						return mainWindow.clearTimeout(timeoutId);
					}
				} as any;

				disposables.add(new TestWindow(res, dom));

				return res;
			}

			const window1 = createWindow(1);
			windows = [{ window: window1, disposables }];

			// Window Count: 1

			let called = false;
			await new Promise<void>((resolve, reject) => {
				window1.setTimeout(() => {
					if (!called) {
						called = true;
						resolve();
					} else {
						reject(new Error('timeout called twice'));
					}
				}, 1);
			});

			assert.strictEqual(called, true);
			assert.deepStrictEqual(setTimeoutCalls, [1]);
			assert.deepStrictEqual(clearTimeoutCalls, []);
			called = false;
			setTimeoutCalls.length = 0;
			clearTimeoutCalls.length = 0;

			await new Promise<void>((resolve, reject) => {
				window1.setTimeout(() => {
					if (!called) {
						called = true;
						resolve();
					} else {
						reject(new Error('timeout called twice'));
					}
				}, 0);
			});

			assert.strictEqual(called, true);
			assert.deepStrictEqual(setTimeoutCalls, [1]);
			assert.deepStrictEqual(clearTimeoutCalls, []);
			called = false;
			setTimeoutCalls.length = 0;
			clearTimeoutCalls.length = 0;

			// Window Count: 3

			let window2 = createWindow(2);
			const window3 = createWindow(3);
			windows = [
				{ window: window2, disposables },
				{ window: window1, disposables },
				{ window: window3, disposables }
			];

			await new Promise<void>((resolve, reject) => {
				window1.setTimeout(() => {
					if (!called) {
						called = true;
						resolve();
					} else {
						reject(new Error('timeout called twice'));
					}
				}, 1);
			});

			assert.strictEqual(called, true);
			assert.deepStrictEqual(setTimeoutCalls, [2, 1, 3]);
			assert.deepStrictEqual(clearTimeoutCalls, [2, 1, 3]);
			called = false;
			setTimeoutCalls.length = 0;
			clearTimeoutCalls.length = 0;

			// Window Count: 2 (1 fast, 1 slow)

			window2 = createWindow(2, true);
			windows = [
				{ window: window2, disposables },
				{ window: window1, disposables },
			];

			await new Promise<void>((resolve, reject) => {
				window1.setTimeout((windowId: number) => {
					if (!called && windowId === 1) {
						called = true;
						resolve();
					} else if (called) {
						reject(new Error('timeout called twice'));
					} else {
						reject(new Error('timeout called for wrong window'));
					}
				}, 1);
			});

			assert.strictEqual(called, true);
			assert.deepStrictEqual(setTimeoutCalls, [2, 1]);
			assert.deepStrictEqual(clearTimeoutCalls, [2, 1]);
			called = false;
			setTimeoutCalls.length = 0;
			clearTimeoutCalls.length = 0;

			disposables.dispose();
		});
	});

	test('multi-window timers are not tracked again after firing or cancellation', async () => {
		const disposed = new WeakSet<IDisposable>();
		let trackedAfterDisposal = 0;
		setDisposableTracker(new class extends GCBasedDisposableTracker {
			override trackDisposable(disposable: IDisposable): void {
				if (disposed.has(disposable)) {
					trackedAfterDisposal++;
				}
				super.trackDisposable(disposable);
			}
			override markAsDisposed(disposable: IDisposable): void {
				disposed.add(disposable);
				super.markAsDisposed(disposable);
			}
		}());
		try {
			await runWithFakedTimers({ useFakeTimers: true }, async () => {
				const disposables = new DisposableStore();
				try {
					const windows = [1, 2].map(id => ({
						window: new class extends mock<CodeWindow>() {
							override readonly vscodeWindowId = id;
							override readonly document = new class extends mock<Document>() {
								override readonly visibilityState = 'visible';
							}();
							override readonly setTimeout = mainWindow.setTimeout.bind(mainWindow);
							override readonly clearTimeout = mainWindow.clearTimeout.bind(mainWindow);
						}(),
						disposables
					}));
					const dom = { getWindowsCount: () => windows.length, getWindows: () => windows };
					for (const { window } of windows) {
						disposables.add(new TestWindow(window, dom));
					}
					const { window } = windows[0];
					let fired = 0;
					let firedAfterCancellation = 0;
					window.setTimeout(() => fired++, 1);
					window.clearTimeout(window.setTimeout(() => firedAfterCancellation++, 1));
					await timeout(2);
					assert.deepStrictEqual({ fired, firedAfterCancellation, trackedAfterDisposal }, {
						fired: 1, firedAfterCancellation: 0, trackedAfterDisposal: 0,
					});
				} finally {
					disposables.dispose();
				}
			});
		} finally {
			setDisposableTracker(null);
		}
	});
});
