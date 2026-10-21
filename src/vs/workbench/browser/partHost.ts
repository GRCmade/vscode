/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../base/browser/dom.js';
import { IBoundarySashes } from '../../base/browser/ui/sash/sash.js';
import { ISerializableView, IViewSize } from '../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Part } from './part.js';

/** Keeps a stable grid leaf when a native part is temporarily hosted in another workspace. */
export class PartHost extends Disposable implements ISerializableView {

	readonly element = $('.workbench-part-host', { style: 'width:100%;height:100%' });
	private embedded = false;
	private sashes: IBoundarySashes = {};
	private readonly change = this._register(new Emitter<IViewSize | undefined>());
	readonly onDidChange = this.change.event;

	constructor(private readonly part: Part & ISerializableView) {
		super();
		this.element.append(part.element);
		this._register(part.onDidChange(size => { if (!this.embedded) { this.change.fire(size); } }));
	}

	get minimumWidth(): number { return this.embedded ? 0 : this.part.minimumWidth; }
	get maximumWidth(): number { return this.embedded ? 0 : this.part.maximumWidth; }
	get minimumHeight(): number { return this.embedded ? 0 : this.part.minimumHeight; }
	get maximumHeight(): number { return this.embedded ? 0 : this.part.maximumHeight; }
	get priority() { return this.part.priority; }
	get snap() { return this.part.snap; }
	get preferredWidth() { return this.part.preferredWidth; }

	layout(width: number, height: number, top: number, left: number): void {
		if (!this.embedded) { this.part.layout(width, height, top, left); }
	}

	setVisible(visible: boolean): void {
		if (!this.embedded) { this.part.setVisible(visible); }
	}

	setBoundarySashes(sashes: IBoundarySashes): void {
		this.sashes = sashes;
		if (!this.embedded) { this.part.setBoundarySashes?.(sashes); }
	}

	mount(container: HTMLElement): IDisposable {
		if (this.embedded) { throw new Error('The native part already has an embedded host.'); }
		this.embedded = true;
		container.append(this.part.element);
		this.part.setBoundarySashes?.({});
		this.change.fire(undefined);
		return toDisposable(() => {
			this.element.append(this.part.element);
			this.embedded = false;
			this.part.setBoundarySashes?.(this.sashes);
			this.change.fire(undefined);
		});
	}

	toJSON(): object { return this.part.toJSON(); }
}
