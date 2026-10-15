/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IStudioStartService, StudioStartView } from '../../../browser/parts/editor/studioStart.js';
import { EditorExtensions, IEditorFactoryRegistry, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

class StudioStartInput extends EditorInput {
	static readonly ID = 'studio.start';
	override get typeId(): string { return StudioStartInput.ID; }
	get resource(): URI { return URI.from({ scheme: 'studio-start', path: '/start' }); }
	constructor(@IStudioStartService private readonly start: IStudioStartService) {
		super();
		this._register(start.onDidChange(() => this._onDidChangeLabel.fire()));
	}
	override getName(): string { return this.start.state?.labels.start ?? 'Start'; }
	override matches(other: EditorInput | IUntypedEditorInput): boolean { return other instanceof StudioStartInput || super.matches(other); }
}

class StudioStartEditor extends EditorPane {
	static readonly ID = 'studio.startEditor';
	private view: StudioStartView | undefined;
	constructor(group: IEditorGroup,
		@ITelemetryService telemetry: ITelemetryService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IInstantiationService private readonly instantiation: IInstantiationService) {
		super(StudioStartEditor.ID, group, telemetry, theme, storage);
	}
	protected createEditor(parent: HTMLElement): void { this.view = this._register(this.instantiation.createInstance(StudioStartView, parent)); }
	layout(size: Dimension): void {
		if (this.view) { this.view.element.style.width = `${size.width}px`; this.view.element.style.height = `${size.height}px`; }
	}
	override setVisible(visible: boolean): void { super.setVisible(visible); this.view?.setVisible(visible); }
	override focus(): void { this.view?.focus(); }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(StudioStartInput.ID, class {
	canSerialize(): boolean { return true; }
	serialize(): string { return '{}'; }
	deserialize(instantiation: IInstantiationService): EditorInput { return instantiation.createInstance(StudioStartInput); }
});
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(StudioStartEditor, StudioStartEditor.ID, 'Studio'), [new SyncDescriptor(StudioStartInput)]);
CommandsRegistry.registerCommand('studio.openStart', accessor => accessor.get(IEditorService).openEditor(
	accessor.get(IInstantiationService).createInstance(StudioStartInput), { pinned: true, revealIfOpened: true }));
