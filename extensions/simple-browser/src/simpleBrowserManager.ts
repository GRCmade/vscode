/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ShowOptions, SimpleBrowserView } from './simpleBrowserView';

export class SimpleBrowserManager {

	private _activeView?: SimpleBrowserView;
	private readonly _views = new Set<SimpleBrowserView>();

	constructor(
		private readonly extensionUri: vscode.Uri,
	) { }

	dispose() {
		for (const view of [...this._views]) { view.dispose(); }
		this._views.clear();
		this._activeView = undefined;
	}

	public show(inputUri: string | vscode.Uri, options?: ShowOptions & { forceNew?: boolean }): void {
		const url = typeof inputUri === 'string' ? inputUri : inputUri.toString(true);
		if (this._activeView && !options?.forceNew) {
			this._activeView.show(url, options);
		} else {
			const view = SimpleBrowserView.create(this.extensionUri, url, options);
			this.registerWebviewListeners(view);

			this._activeView = view;
		}
	}

	public restore(panel: vscode.WebviewPanel, state: any): void {
		const url = state?.url ?? '';
		const view = SimpleBrowserView.restore(this.extensionUri, url, panel);
		this.registerWebviewListeners(view);
		this._activeView ??= view;
	}

	private registerWebviewListeners(view: SimpleBrowserView) {
		this._views.add(view);
		const state = view.onDidChangeViewState(() => { if (view.active) { this._activeView = view; } });
		view.onDispose(() => {
			state.dispose();
			this._views.delete(view);
			if (this._activeView === view) {
				this._activeView = [...this._views].find(candidate => candidate.active) ?? [...this._views].at(-1);
			}
		});
	}

}
