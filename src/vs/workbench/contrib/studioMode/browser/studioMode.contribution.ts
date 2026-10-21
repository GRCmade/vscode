/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { Sequencer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { StudioModeLoading, StudioSteamTools, studioModeState } from '../../../browser/parts/studioMode.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Extensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { EditorGroupLayout, GroupsArrangement, GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { StudioSteamWorkspace } from './studioSteamWorkspace.js';

const TOOLS_CONTAINER = 'studio-steam-tools';
const TOOLS_VIEW = 'studio.steamTools';
const MODE_KEY = 'studio.workbenchMode';
const SNAPSHOT_KEY = 'studio.ideLayout';
const STEAM_WIDTH_KEY = 'studio.steamToolsWidth';
const toolsTitle = localize2('studioSteamTools', "Open Tools");
const sideParts = [Parts.ACTIVITYBAR_PART, Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART] as const;
const toolViews: Record<string, string> = {
	kv: 'studio.kv', knowledge: 'studio.knowledge', info: 'studio.projectInfo',
	assistant: 'studio.developerAssistant', versions: 'studio.versions', trace: 'studio.trace',
};

interface IdeLayout {
	visible: boolean[];
	sizes: { width: number; height: number }[];
	containers: (string | undefined)[];
	auxiliaryMaximized: boolean;
	panelMaximized: boolean;
	editorMaximized: boolean;
	activeGroup: number;
	sideBarMemoryLocation?: string;
	editorLayout: EditorGroupLayout;
	groups: number[];
}

class SteamToolsPane extends ViewPane {
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._register(this.instantiationService.createInstance(StudioSteamTools, container));
		const update = () => this.updateTitle(studioModeState.state.labels.tools ?? 'Open Tools');
		this._register(studioModeState.onDidChangeState(update));
		update();
	}
}

const toolsContainer = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
	id: TOOLS_CONTAINER,
	title: toolsTitle,
	icon: Codicon.tools,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [TOOLS_CONTAINER, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: TOOLS_CONTAINER,
	hideIfEmpty: true,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });
Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
	id: TOOLS_VIEW,
	name: toolsTitle,
	ctorDescriptor: new SyncDescriptor(SteamToolsPane),
	when: ContextKeyExpr.has('studio.steamMode'),
	canToggleVisibility: false,
	canMoveView: false,
}], toolsContainer);

/** Switch layouts without replacing project editors or writing user settings. */
export class StudioModeContribution extends Disposable {
	static readonly ID = 'workbench.contrib.studioMode';
	private readonly sequencer = new Sequencer();
	private readonly editorOptions = this._register(new MutableDisposable<IDisposable>());
	private readonly toolLocations = this._register(new DisposableStore());
	private readonly loading: StudioModeLoading;
	private readonly workspace: StudioSteamWorkspace;
	private snapshot: IdeLayout | undefined;
	private ideEditor: { group: IEditorGroup; editor: EditorInput } | undefined;
	private steam = false;
	private projectReady = false;
	private requested: boolean;
	private initialized = false;
	private revision = 0;

	constructor(
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IEditorService private readonly editors: IEditorService,
		@IViewsService private readonly views: IViewsService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.loading = this._register(new StudioModeLoading(layout.mainContainer, layout.getContainer(getWindow(layout.mainContainer), Parts.EDITOR_PART)));
		this.workspace = this._register(instantiation.createInstance(StudioSteamWorkspace, layout.getContainer(getWindow(layout.mainContainer), Parts.AUXILIARYBAR_PART)!));
		toolsTitle.value = studioModeState.state.labels.tools ?? toolsTitle.original;
		this.snapshot = storage.getObject<IdeLayout>(SNAPSHOT_KEY, StorageScope.WORKSPACE);
		this.requested = storage.get(MODE_KEY, StorageScope.WORKSPACE) === 'steam';
		this._register(CommandsRegistry.registerCommand('studio.internalToggleMode', () => this.request(!this.requested)));
		this._register(CommandsRegistry.registerCommand('studio.internalEnterIdeMode', () => this.request(false)));
		this._register(CommandsRegistry.registerCommand('studio.internalEnterSteamMode', () => this.request(true)));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenSteamTools', () => this.sequencer.queue(() => this.openTools())));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenSteamTool', (_accessor, id: string) => this.sequencer.queue(() => this.openTool(id))));
		this._register(CommandsRegistry.registerCommand('studio.internalSelectSteamTab', (_accessor, id: string) => this.workspace.select(id)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseSteamTab', (_accessor, id: string) => this.workspace.close(id)));
		this._register(studioModeState.onDidChangeState(state => {
			toolsTitle.value = state.labels.tools ?? toolsTitle.original;
			if (!this.initialized || !state.available) {
				this.initialized = true;
				void this.request(this.requested && state.available).catch(error => notifications.error(error));
			}
		}));
		if (studioModeState.state.labels.mode) {
			this.initialized = true;
			void this.request(this.requested && studioModeState.state.available).catch(error => notifications.error(error));
		}
	}

	private request(steam: boolean): Promise<void> {
		this.requested = steam && studioModeState.state.available;
		const revision = ++this.revision;
		if (!this.requested && studioModeState.busy) {
			void this.commands.executeCommand('studio.internalCancelSteamPreparation').catch(() => undefined);
		}
		return this.sequencer.queue(async () => {
			if (revision !== this.revision || this._store.isDisposed) { return; }
			const next = this.requested;
			const projectUri = studioModeState.state.projectUri;
			if (next === this.steam && (next ? this.projectReady && this.workspace.hasProject : !this.snapshot)) {
				if (!next) { await this.workspace.deactivate(this.groups.mainPart.activeGroup); }
				return;
			}
			studioModeState.setMode(this.steam, true, next);
			try {
				if (next) {
					const group = this.groups.mainPart.activeGroup;
					if (!this.snapshot && group.activeEditor) { this.ideEditor = { group, editor: group.activeEditor }; }
					this.captureIde();
					let prepared: boolean | undefined;
					const prepare = async () => {
						try { return await this.commands.executeCommand<boolean>('studio.internalPrepareSteamProject', projectUri); }
						catch (error) {
							if (revision !== this.revision || this._store.isDisposed) { return undefined; }
							throw error;
						}
					};
					if (!this.steam) {
						await this.transition(true, async () => {
							await this.enterSteam();
							this.loading.show();
							studioModeState.setMode(true, true, true);
							// A retained frame can be revealed in the snapshot without a loading flash.
							if (studioModeState.state.ready && revision === this.revision) {
								prepared = await prepare();
								if (prepared) { this.loading.hide(); }
							}
						});
					} else {
						this.loading.show();
					}
					if (revision !== this.revision || this._store.isDisposed) { return; }
					// Cold startup runs after the live loading layout, outside the frozen snapshot.
					prepared ??= await prepare();
					if (revision !== this.revision || !studioModeState.state.available || this._store.isDisposed) { return; }
					if (!prepared) {
						this.requested = false;
						if (this.snapshot) { await this.restoreIde(); }
						await this.rememberMode(false);
						return;
					}
					this.projectReady = true;
				} else {
					await this.transition(false, async () => { this.loading.hide(); await this.restoreIde(); });
				}
				await this.rememberMode(next);
			} catch (error) {
				if (this._store.isDisposed) { return; }
				if (revision === this.revision) { this.requested = false; }
				await this.restoreIde();
				await this.rememberMode(false);
				if (revision === this.revision) { throw error; }
			} finally {
				if (revision === this.revision || !this.steam) { this.loading.hide(); }
				studioModeState.setMode(this.steam, false);
			}
		});
	}

	private async rememberMode(steam: boolean): Promise<void> {
		this.storage.store(MODE_KEY, steam ? 'steam' : 'ide', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		// Browser refresh can happen before the normal delayed storage write.
		await this.storage.flush();
	}

	private saveSnapshot(): void {
		this.storage.store(SNAPSHOT_KEY, this.snapshot, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private captureIde(): void {
		if (!this.snapshot) {
			this.snapshot = {
				visible: sideParts.map(part => this.layout.isVisible(part)),
				sizes: sideParts.map(part => this.layout.getSize(part)),
				containers: [ViewContainerLocation.Sidebar, ViewContainerLocation.Panel, ViewContainerLocation.AuxiliaryBar].map(location => this.views.getVisibleViewContainer(location)?.id),
				auxiliaryMaximized: this.layout.isAuxiliaryBarMaximized(),
				panelMaximized: this.layout.isPanelMaximized(),
				editorMaximized: this.groups.mainPart.hasMaximizedGroup(),
				activeGroup: this.groups.mainPart.activeGroup.id,
				sideBarMemoryLocation: this.configuration.inspect<string>('workbench.sideBar.location').memoryValue,
				editorLayout: this.groups.mainPart.getLayout(), groups: this.groups.mainPart.groups.map(group => group.id),
			};
			this.saveSnapshot();
		}
	}

	private async enterSteam(): Promise<void> {
		// The secondary sidebar is opposite the primary sidebar. Override only memory,
		// so Steam tools stay on the right even when the user's IDE sidebar is on the right.
		await this.configuration.updateValue('workbench.sideBar.location', 'left', ConfigurationTarget.MEMORY);
		this.steam = true;
		this.contextKeys.createKey<boolean>('studio.steamMode', false).set(true);
		this.layout.mainContainer.classList.add('studio-steam-mode');
		this.layout.setAuxiliaryBarMaximized(false);
		this.editorOptions.value = this.groups.mainPart.enforcePartOptions({ showTabs: 'none' });
		const containers = new Set([toolsContainer, ...Object.values(toolViews).map(id => this.descriptors.getViewContainerByViewId(id))]);
		for (const container of containers) {
			if (container) { this.toolLocations.add(this.descriptors.overrideViewContainerLocation(container, ViewContainerLocation.AuxiliaryBar)); }
		}
		// The project opens in ViewColumn.One. Maximize that group before revealing it,
		// otherwise activating the first group would unmaximize a different source group.
		this.groups.mainPart.arrangeGroups(GroupsArrangement.MAXIMIZE, this.groups.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE)[0]);
		for (const part of [Parts.ACTIVITYBAR_PART, Parts.SIDEBAR_PART, Parts.PANEL_PART]) { this.layout.setPartHidden(true, part); }
		this.layout.setPartHidden(false, Parts.EDITOR_PART);
		await this.workspace.activate();
		const width = this.storage.getNumber(STEAM_WIDTH_KEY, StorageScope.WORKSPACE, Math.round(this.layout.mainContainerDimension.width * .45));
		this.layout.setSize(Parts.AUXILIARYBAR_PART, { width: Math.min(Math.max(280, width), Math.max(170, this.layout.mainContainerDimension.width - 320)), height: this.layout.getSize(Parts.AUXILIARYBAR_PART).height });
	}

	private async openTools(): Promise<void> {
		if (!this.steam) { return; }
		await this.workspace.home();
	}

	private async openTool(id: string): Promise<void> {
		if (!this.steam || !Object.hasOwn(toolViews, id)) { return; }
		await this.workspace.openTool(id);
	}

	private async restoreIde(): Promise<void> {
		const snapshot = this.snapshot;
		if (!snapshot) { return; }
		if (this.steam) { this.storage.store(STEAM_WIDTH_KEY, this.layout.getSize(Parts.AUXILIARYBAR_PART).width, StorageScope.WORKSPACE, StorageTarget.MACHINE); }
		await this.workspace.deactivate(this.groups.mainPart.getGroup(snapshot.activeGroup) ?? this.groups.mainPart.activeGroup);
		this.steam = false;
		this.projectReady = false;
		this.contextKeys.createKey('studio.steamMode', false).set(false);
		this.layout.mainContainer.classList.remove('studio-steam-mode');
		this.editorOptions.clear();
		this.toolLocations.clear();
		await this.configuration.updateValue('workbench.sideBar.location', snapshot.sideBarMemoryLocation, ConfigurationTarget.MEMORY);
		this.views.closeViewContainer(TOOLS_CONTAINER);
		for (const id of snapshot.containers) { if (id) { await this.views.openViewContainer(id, false); } }
		for (const [index, part] of sideParts.entries()) {
			this.layout.setPartHidden(!snapshot.visible[index], part);
			if (snapshot.visible[index]) { this.layout.setSize(part, snapshot.sizes[index]); }
		}
		const mainPart = this.groups.mainPart;
		// A maximized grid serializes its expanded size alongside cached hidden sizes.
		// Reapplying that layout would shrink the hidden groups on every switch.
		if (!snapshot.editorMaximized && snapshot.groups.length === mainPart.groups.length && snapshot.groups.every(id => mainPart.getGroup(id))) {
			mainPart.applyLayout(snapshot.editorLayout);
		}
		const previous = this.ideEditor;
		if (previous && mainPart.getGroup(previous.group.id)?.contains(previous.editor)) { await this.editors.openEditor(previous.editor, undefined, previous.group); }
		// Opening an editor can unmaximize a group or the panel, so restore these states last.
		if (snapshot.editorMaximized && mainPart.getGroup(snapshot.activeGroup)) {
			mainPart.arrangeGroups(GroupsArrangement.MAXIMIZE, snapshot.activeGroup);
		}
		if (snapshot.visible[2] && this.layout.isPanelMaximized() !== !!snapshot.panelMaximized) { this.layout.toggleMaximizedPanel(); }
		this.layout.setAuxiliaryBarMaximized(snapshot.auxiliaryMaximized);
		this.ideEditor = undefined;
		this.snapshot = undefined;
		this.storage.remove(SNAPSHOT_KEY, StorageScope.WORKSPACE);
	}

	private async transition(steam: boolean, change: () => Promise<void>): Promise<void> {
		const win = getWindow(this.layout.mainContainer);
		const document = win.document;
		if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) { await change(); return; }
		if (document.startViewTransition) {
			const direction = steam ? 'studio-mode-enter-steam' : 'studio-mode-enter-ide';
			document.documentElement.classList.add('studio-mode-transition', direction);
			try {
				const transition = document.startViewTransition(async () => {
					// Slow view restoration must not freeze the workbench behind a captured image.
					const timeout = win.setTimeout(() => transition.skipTransition(), 120);
					try { await change(); } finally { win.clearTimeout(timeout); }
				});
				// A background tab or skipped animation can reject ready even when the layout succeeds.
				void transition.ready.catch(() => undefined);
				const finished = transition.finished.catch(() => undefined);
				await transition.updateCallbackDone;
				await finished;
			} finally { document.documentElement.classList.remove('studio-mode-transition', direction); }
		} else {
			await change();
			const animations: Animation[] = [];
			for (const part of [Parts.EDITOR_PART, Parts.AUXILIARYBAR_PART]) {
				const animation = this.layout.getContainer(win, part)?.animate([{ opacity: .7, transform: `translateX(${steam ? 48 : -48}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
				if (animation) { animations.push(animation); }
			}
			await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
		}
	}
}

registerWorkbenchContribution2(StudioModeContribution.ID, StudioModeContribution, WorkbenchPhase.AfterRestored);
