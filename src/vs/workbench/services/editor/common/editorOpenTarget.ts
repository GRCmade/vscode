/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from './editorGroupsService.js';
import { PreferredGroup } from './editorService.js';

/** A workbench layout can reserve an editor surface before group selection or model mutation. */
type EditorOpenTarget = (editor: EditorInput | IUntypedEditorInput, preferredGroup: PreferredGroup | undefined) => IEditorGroup | undefined;
const targets = new Set<EditorOpenTarget>();

export function registerEditorOpenTarget(target: EditorOpenTarget): IDisposable {
	targets.add(target);
	return toDisposable(() => targets.delete(target));
}

export function getEditorOpenTarget(editor: EditorInput | IUntypedEditorInput, preferredGroup: PreferredGroup | undefined): IEditorGroup | undefined {
	for (const target of targets) {
		const group = target(editor, preferredGroup);
		if (group) { return group; }
	}
	return undefined;
}
