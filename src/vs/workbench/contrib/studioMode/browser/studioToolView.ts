/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Orientation } from '../../../../base/browser/ui/splitview/splitview.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { studioModeState, studioSteamToolDefinitions } from '../../../browser/parts/studioMode.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { EditorExtensions, EditorInputCapabilities, IEditorFactoryRegistry, IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/** A native tab for the retained IDE view. Closing the tab leaves its controller alive. */
export class StudioToolViewInput extends EditorInput {
	static readonly ID = 'studio.toolView';
	override get typeId(): string { return StudioToolViewInput.ID; }
	readonly resource = undefined;
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton; }

	constructor(readonly toolId: string, readonly viewId: string) {
		super();
		let name = this.getName();
		this._register(studioModeState.onDidChangeState(() => {
			const next = this.getName();
			if (name !== next) { name = next; this._onDidChangeLabel.fire(); }
		}));
	}

	override getName(): string { return studioModeState.state.labels[this.toolId] ?? this.toolId; }
	override getIcon(): ThemeIcon { return ThemeIcon.fromId(studioSteamToolDefinitions.find(tool => tool.id === this.toolId)?.icon ?? 'tools'); }
	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof StudioToolViewInput ? other.viewId === this.viewId : super.matches(other);
	}
}

/** Move the live view DOM, including its webview, without resolving a second controller. */
class StudioToolViewEditor extends EditorPane {
	static readonly ID = 'studio.toolViewEditor';
	private viewHost: HTMLElement | undefined;
	private size = Dimension.None;
	private retained: { view: ViewPane; parent: Node; next: ChildNode | null; header: boolean } | undefined;
	private revision = 0;

	constructor(group: IEditorGroup,
		@ITelemetryService telemetry: ITelemetryService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IViewsService private readonly views: IViewsService,
	) {
		super(StudioToolViewEditor.ID, group, telemetry, theme, storage);
	}

	protected createEditor(parent: HTMLElement): void { this.viewHost = parent; parent.classList.add('monaco-pane-view'); }

	override async setInput(input: StudioToolViewInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.releaseView();
		await super.setInput(input, options, context, token);
		await this.attachView(input, token);
	}

	private async attachView(input: StudioToolViewInput, token: CancellationToken = CancellationToken.None): Promise<void> {
		const revision = ++this.revision;
		const view = await this.views.openView<ViewPane>(input.viewId, false);
		if (!view || token.isCancellationRequested || revision !== this.revision || this.input !== input || !this.isVisible() || !this.viewHost) { return; }
		const parent = view.element.parentNode;
		if (!parent) { return; }
		this.retained = { view, parent, next: view.element.nextSibling, header: view.headerVisible };
		view.headerVisible = false;
		this.viewHost.appendChild(view.element);
		view.setVisible(true);
		this.layout(this.size);
	}

	private releaseView(): void {
		++this.revision;
		const retained = this.retained;
		this.retained = undefined;
		if (!retained) { return; }
		const { view, parent, next, header } = retained;
		parent.insertBefore(view.element, next?.parentNode === parent ? next : null);
		view.headerVisible = header;
	}

	layout(size: Dimension): void {
		this.size = size;
		if (this.retained) {
			const view = this.retained.view;
			view.orthogonalSize = view.orientation === Orientation.VERTICAL ? size.width : size.height;
			view.layout(view.orientation === Orientation.VERTICAL ? size.height : size.width);
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (!visible) { this.releaseView(); }
		else if (!this.retained && this.input instanceof StudioToolViewInput) { void this.attachView(this.input).catch(onUnexpectedError); }
	}

	override clearInput(): void { this.releaseView(); super.clearInput(); }
	override focus(): void { this.retained?.view.focus(); }
	override dispose(): void { this.releaseView(); super.dispose(); }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(StudioToolViewInput.ID, class {
	canSerialize(input: StudioToolViewInput): boolean { return !input.isDisposed(); }
	serialize(input: StudioToolViewInput): string { return JSON.stringify({ toolId: input.toolId }); }
	deserialize(_instantiation: IInstantiationService, value: string): EditorInput | undefined {
		try {
			const tool = studioSteamToolDefinitions.find(tool => tool.id === JSON.parse(value).toolId);
			return tool && 'view' in tool && tool.id !== 'terminal' ? new StudioToolViewInput(tool.id, tool.view) : undefined;
		} catch { return undefined; }
	}
});
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(StudioToolViewEditor, StudioToolViewEditor.ID, 'Studio'), [new SyncDescriptor(StudioToolViewInput)]);
