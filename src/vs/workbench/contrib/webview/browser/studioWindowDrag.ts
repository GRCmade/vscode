/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';

interface DragRegion { x: number; y: number; width: number; height: number }
interface DragRegionsMessage { version: number; width: number; height: number; regions: DragRegion[] }

/** Mirror an embedded project header into the owning renderer's native drag surface. */
export class StudioWindowDragRegions extends Disposable {
	private readonly element: HTMLElement;

	constructor(frame: HTMLIFrameElement) {
		super();
		this.element = frame.ownerDocument.createElement('div');
		this.element.className = 'studio-project-drag-regions';
		this.element.setAttribute('aria-hidden', 'true');
		frame.parentElement?.appendChild(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}

	update(message: DragRegionsMessage): void {
		this.element.replaceChildren();
		if (message.version !== 1 || ![message.width, message.height].every(n => Number.isFinite(n) && n > 0 && n <= 32768)
			|| !Array.isArray(message.regions) || message.regions.length > 128) {
			return;
		}
		const regions = message.regions.filter(region => region && [region.x, region.y, region.width, region.height].every(Number.isFinite)
			&& region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
			&& region.x + region.width <= message.width && region.y + region.height <= Math.min(256, message.height));
		if (regions.length !== message.regions.length) { return; }
		for (const region of regions) {
			const element = this.element.ownerDocument.createElement('div');
			element.className = 'studio-project-drag-region';
			Object.assign(element.style, {
				left: `${region.x / message.width * 100}%`, top: `${region.y / message.height * 100}%`,
				width: `${region.width / message.width * 100}%`, height: `${region.height / message.height * 100}%`,
			});
			this.element.appendChild(element);
		}
	}
}
