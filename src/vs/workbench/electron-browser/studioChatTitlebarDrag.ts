/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRectangle } from '../../platform/window/common/window.js';

/** Cover the titlebar without intercepting the embedded controls. */
export function chatTitlebarDragRegions(width: number, height: number, controls: readonly IRectangle[]): IRectangle[] | undefined {
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 || height > 256
		|| !Array.isArray(controls) || controls.length > 32) {
		return undefined;
	}
	let regions: IRectangle[] = [{ x: 0, y: 0, width, height }];
	for (const control of controls) {
		if (!control || ![control.x, control.y, control.width, control.height].every(Number.isSafeInteger)
			|| control.x < 0 || control.y < 0 || control.width <= 0 || control.height <= 0
			|| control.x + control.width > width || control.y + control.height > height) {
			return undefined;
		}
		regions = regions.flatMap(region => {
			const left = Math.max(region.x, control.x), top = Math.max(region.y, control.y);
			const right = Math.min(region.x + region.width, control.x + control.width);
			const bottom = Math.min(region.y + region.height, control.y + control.height);
			if (left >= right || top >= bottom) { return [region]; }
			return [
				{ x: region.x, y: region.y, width: region.width, height: top - region.y },
				{ x: region.x, y: bottom, width: region.width, height: region.y + region.height - bottom },
				{ x: region.x, y: top, width: left - region.x, height: bottom - top },
				{ x: right, y: top, width: region.x + region.width - right, height: bottom - top },
			].filter(rect => rect.width > 0 && rect.height > 0);
		});
	}
	return regions;
}
