/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { containsDragType, extractEditorsDropData, getPathForFile } from '../../../../platform/dnd/browser/dnd.js';

/** Native paths are resolved before a drop crosses the sandboxed project frame. */
export class StudioWebviewDrop extends Disposable {
	private target: string | undefined;

	constructor(private readonly send: (message: unknown) => void) { super(); }

	update(target: unknown): void {
		this.target = typeof target === 'string' && target.length > 0 && target.length <= 512 ? target : undefined;
	}

	resolveLocalFiles({ target, requestId, files }: { target?: unknown; requestId?: unknown; files?: unknown }): void {
		if (!this.target || target !== this.target || typeof requestId !== 'string' || !requestId || requestId.length > 128
			|| !Array.isArray(files) || !files.length || files.length > 32) {
			return;
		}
		// A File cloned from the project frame still lets the native renderer resolve its backing file.
		let paths: string[] = [];
		try {
			const nativePaths = files.map(file => getPathForFile(file));
			if (nativePaths.every((file): file is string => !!file && isAbsolute(file))) {
				paths = nativePaths.map(file => URI.file(file).toString());
			}
		} catch { /* Not a native File. Do not forward partial results or read bytes. */ }
		this.send({ type: 'workflow-host', localFilePaths: { version: 1, target, requestId, paths } });
	}

	mount(container: HTMLElement, targetWindow: Window): void {
		for (const type of [EventType.DRAG_OVER, EventType.DROP]) {
			this._register(addDisposableListener(targetWindow, type, (event: DragEvent) => {
				if (!this.target || !event.dataTransfer || !containsDragType(event, 'Files', 'CodeFiles', 'ResourceURLs', 'CodeEditors', 'text/uri-list')) {
					return;
				}
				if (container.checkVisibility?.({ checkVisibilityCSS: true, checkOpacity: true }) === false) {
					return;
				}
				const rect = container.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0 || event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) {
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				event.dataTransfer.dropEffect = 'copy';
				if (type !== EventType.DROP) {
					return;
				}
				const resources = extractEditorsDropData(event).map(editor => editor.resource).filter(resource => resource?.scheme === 'file');
				for (const line of event.dataTransfer.getData('text/uri-list').split(/\r?\n/)) {
					if (line.startsWith('file:')) {
						try { resources.push(URI.parse(line)); } catch { /* Invalid external URI. */ }
					}
				}
				const paths = [...new Set(resources.map(resource => resource!.toString()))];
				if (paths.length) {
					this.send({ type: 'workflow-host', drop: { target: this.target, paths } });
				}
			}, true));
		}
	}
}
