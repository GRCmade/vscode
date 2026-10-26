/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { SplitView, Orientation } from '../../../../base/browser/ui/splitview/splitview.js';
import { Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { studioModeState, studioSteamToolDefinitions, studioSteamWorkspaceState, StudioSteamTab } from '../../../browser/parts/studioMode.js';
import { EditorResourceAccessor, EditorsOrder, IUntypedEditorInput, SideBySideEditor } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEmbeddedEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import { registerEditorOpenTarget } from '../../../services/editor/common/editorOpenTarget.js';
import { IEditorService, PreferredGroup } from '../../../services/editor/common/editorService.js';
import { IEmbeddedSideBar, IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { CustomEditorInput } from '../../customEditor/browser/customEditorInput.js';
import { ITerminalGroupService, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../terminal/browser/terminalEditorInput.js';
import { StudioToolViewInput } from './studioToolView.js';

const TABS_KEY = 'studio.steamWorkspaceTabs';
const HOME_VIEW = 'studio.steamTools';
interface SavedTabs { tools: string[]; active?: string; emptyEditor?: boolean; parts?: string[]; defaultViews?: string[] }
type Tool = typeof studioSteamToolDefinitions[number];
interface WorkspaceTab { id: string; editor: EditorInput; group: IEditorGroup }
interface ToolPart { part: IEmbeddedEditorPart; host: HTMLElement }

/** Each category owns a real editor part, so native tab actions stay inside that category. */
export class StudioSteamWorkspace extends Disposable {
	private readonly parts = new Map<string, ToolPart>();
	private readonly partLifetime = this._register(new DisposableStore());
	private readonly modeLifetime = this._register(new DisposableStore());
	private readonly surface: HTMLElement;
	private readonly editorPane: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly emptyLabel: HTMLElement;
	private readonly openFile: HTMLButtonElement;
	private readonly split: SplitView;
	private readonly sidebarHost: HTMLElement;
	private readonly sidebar = this._register(new MutableDisposable<IEmbeddedSideBar>());
	private sidebarRequested = true;
	private sidebarOpened = false;
	private sidebarWidth: number;
	private readonly refresh = this._register(new RunOnceScheduler(() => this.syncEditors(), 0));
	private tabs: WorkspaceTab[] = [];
	private readonly tools = new Set<string>();
	private readonly defaultViews = new Set<string>();
	private active: string | undefined;
	private enabled = false;
	private projectGroup: IEditorGroup | undefined;
	private project: EditorInput | undefined;
	private projectUri: string | undefined;
	private readonly projectLifetime = this._register(new MutableDisposable());
	private readonly ideGroups = new Map<EditorInput, IEditorGroup>();
	private readonly editorIds = new WeakMap<EditorInput, string>();
	private editorId = 0;
	private savedActive: string | undefined;
	private savedEmptyEditor = false;
	private visibilityRevision = 0;
	private readonly selectedInstances = new Map<string, string>();
	private readonly selectedEditors = new Map<string, EditorInput>();
	private readonly pendingViews = new Map<string, Promise<void>>();
	private movingTerminals = 0;

	get hasProject(): boolean {
		return !!this.project && !this.project.isDisposed() && !!this.projectGroup?.contains(this.project);
	}

	constructor(parent: HTMLElement,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IViewsService private readonly views: IViewsService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@IStorageService private readonly storage: IStorageService,
		@ICommandService private readonly commands: ICommandService,
		@ITerminalService private readonly terminals: ITerminalService,
		@ITerminalGroupService private readonly terminalGroups: ITerminalGroupService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super();
		const saved = storage.getObject<SavedTabs>(TABS_KEY, StorageScope.WORKSPACE);
		for (const id of saved?.tools ?? []) { if (studioSteamToolDefinitions.some(tool => tool.id === id)) { this.tools.add(id); } }
		for (const id of saved?.defaultViews ?? saved?.tools ?? []) { this.defaultViews.add(id); }
		this.savedActive = saved?.active;
		this.savedEmptyEditor = saved?.emptyEditor ?? false;
		this.surface = append(parent, $('.studio-steam-editor-workspace'));
		this.surface.hidden = true;
		this.editorPane = $('.studio-steam-code-pane');
		this.empty = append(this.editorPane, $('.studio-steam-code-empty'));
		append(this.empty, $('span.codicon.codicon-code', { 'aria-hidden': 'true' }));
		this.emptyLabel = append(this.empty, $('p'));
		this.openFile = append(this.empty, $('button', { type: 'button' })) as HTMLButtonElement;
		this._register(addDisposableListener(this.openFile, 'click', () => { void this.commands.executeCommand('workbench.action.quickOpen').catch(onUnexpectedError); }));
		this.sidebarHost = $('.studio-steam-code-sidebar');
		this.sidebarWidth = storage.getNumber('studio.steamEditorSidebarWidth', StorageScope.WORKSPACE, 240);
		this.split = this._register(new SplitView(this.surface, { orientation: Orientation.HORIZONTAL, proportionalLayout: false }));
		this.split.addView({ element: this.editorPane, minimumSize: 120, maximumSize: Number.POSITIVE_INFINITY, onDidChange: Event.None,
			layout: width => { for (const { part, host } of this.parts.values()) { if (!host.hidden) { part.layout(width, this.surface.clientHeight, 0, 0); } } } }, 400);
		this.split.addView({ element: this.sidebarHost, minimumSize: 140, maximumSize: 600, onDidChange: Event.None,
			layout: width => this.sidebar.value?.layout(width, this.surface.clientHeight) }, this.sidebarWidth);
		this._register(this.split.onDidSashChange(() => {
			if (this.split.isViewVisible(1)) {
				this.sidebarWidth = this.split.getViewSize(1);
				this.storage.store('studio.steamEditorSidebarWidth', this.sidebarWidth, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		}));
		this._register(studioModeState.onDidChangeState(() => this.publish()));
		this._register(this.views.onDidChangeViewVisibility(event => {
			if (!this.enabled || !event.visible || this.movingTerminals) { return; }
			const tool = studioSteamToolDefinitions.find(tool => 'view' in tool && tool.view === event.id);
			if (!tool) { return; }
			const input = this.parts.get(tool.id)?.part.activeGroup.activeEditor;
			if (input instanceof StudioToolViewInput && input.viewId === event.id) { return; }
			void this.openTool(tool.id).catch(onUnexpectedError);
		}));
		this._register(registerEditorOpenTarget((editor, preferred) => this.target(editor, preferred)));
		this._register(this.terminalGroups.onDidChangeInstances(() => {
			if (this.enabled && !this.movingTerminals && this.tools.has('terminal') && this.terminalGroups.instances.length) { this.retainTerminals(); }
		}));
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layoutEditors());
		observer.observe(parent);
		this._register(this.layout.onDidChangePartVisibility(() => this.layoutEditors()));
		this._register(toDisposable(() => { observer.disconnect(); this.surface.remove(); studioSteamWorkspaceState.update([], undefined); }));
		// Restore every native part even if a removed project forces the next mode back to IDE.
		if (storage.get('studio.workbenchMode', StorageScope.WORKSPACE) === 'steam') {
			for (const id of saved?.parts ?? ['editor']) { this.ensurePart(id); }
		}
	}

	private ensurePart(id = 'editor'): IEmbeddedEditorPart {
		const existing = this.parts.get(id);
		if (existing) { return existing.part; }
		const host = append(this.editorPane, $('.part.editor.studio-steam-editors', { 'data-tool': id }));
		host.hidden = true;
		const key = `workbench.parts.studioSteamEditors${id === 'editor' ? '' : `.${id}`}`;
		const part = this.partLifetime.add(this.groups.createEmbeddedEditorPart(host, key, studioModeState.state.labels[id] ?? studioModeState.state.labels.workspace ?? 'Tool Workspace'));
		this.parts.set(id, { part, host });
		this.partLifetime.add(part.enforcePartOptions({ showTabs: 'multiple', tabHeight: 'compact', enablePreview: true, closeEmptyGroups: true, editorActionsLocation: 'default' }));
		const registerGroup = (group: IEditorGroup) => {
			group.scopedContextKeyService.createKey('studio.steamTool', studioSteamToolDefinitions.some(tool => tool.id === id) ? id : '');
			let opening: { editor: EditorInput; revision: number } | undefined;
			this.partLifetime.add((group as IEditorGroupView).onWillOpenEditor(event => {
				if (this.enabled && group.activeEditor === event.editor) { this.revealEditor(event.editor, group); }
				opening = { editor: event.editor, revision: this.visibilityRevision };
			}));
			this.partLifetime.add(group.onDidModelChange(() => this.refresh.schedule()));
			this.partLifetime.add(group.onDidActiveEditorChange(() => {
				this.syncEditors();
				const codePreview = (this.active === 'editor' || this.category(this.tabs.find(tab => tab.id === this.active)) === 'editor') && id === 'editor';
				if (this.enabled && (this.groups.activeGroup === group || codePreview) && group.activeEditor
					&& opening?.editor === group.activeEditor && opening.revision === this.visibilityRevision) { this.revealEditor(group.activeEditor, group); }
			}));
		};
		part.groups.forEach(registerGroup);
		this.partLifetime.add(part.onDidAddGroup(registerGroup));
		this.partLifetime.add(part.onDidRemoveGroup(() => this.refresh.schedule()));
		this.partLifetime.add(part.onDidActivateGroup(({ group }) => {
			if (this.enabled && group.activeEditor) { this.revealEditor(group.activeEditor, group); }
		}));
		void part.whenReady.then(() => { if (this.parts.get(id)?.part === part) { this.syncEditors(); } }, onUnexpectedError);
		return part;
	}

	private get nativeGroups(): IEditorGroup[] { return [...this.parts.values()].flatMap(({ part }) => part.groups); }

	async activate(projectUri = studioModeState.state.projectUri): Promise<void> {
		if (this.enabled) { return; }
		this.projectUri = projectUri;
		const part = this.ensurePart();
		await Promise.all([...this.parts.values()].map(({ part }) => part.whenReady));
		const restoreActive = this.savedActive;
		const restoreEmptyEditor = this.savedEmptyEditor;
		const restoreDefaultViews = [...this.defaultViews];
		const restoredEditor = part.activeGroup.activeEditor;
		const restoredGroup = part.activeGroup;
		const projectGroup = this.projectGroup = this.groups.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE)[0];
		this.modeLifetime.add(this.groups.mainPart.enforceSingleGroup(projectGroup));
		this.setProject([...this.groups.mainPart.groups, ...this.nativeGroups].flatMap(group => group.editors).find(editor => this.matchesProject(editor)));
		this.modeLifetime.add(projectGroup.onDidCloseEditor(({ editor }) => { if (editor === this.project) { this.setProject(undefined); } }));
		for (const editor of projectGroup.getEditors(EditorsOrder.SEQUENTIAL).filter(editor => !this.matchesProject(editor))) {
			this.ideGroups.set(editor, projectGroup);
			const target = this.ensurePart(this.editorCategory(editor));
			await target.whenReady;
			if (!projectGroup.moveEditors([{ editor, options: { preserveFocus: true } }], target.activeGroup)) { throw this.moveError(); }
		}
		// Split the old mixed tool part on first entry, retaining the actual input objects.
		for (const [id, { part }] of this.parts) {
			for (const group of [...part.groups]) {
				for (const editor of group.getEditors(EditorsOrder.SEQUENTIAL)) {
					if (this.matchesProject(editor)) { group.moveEditors([{ editor, options: { preserveFocus: true } }], projectGroup); }
					else if (this.editorCategory(editor) !== id) {
						const destination = this.ensurePart(this.editorCategory(editor));
						await destination.whenReady;
						if (!group.moveEditors([{ editor, options: { preserveFocus: true } }], destination.activeGroup)) { throw this.moveError(); }
					}
				}
			}
		}
		this.enabled = true;
		this.sidebarRequested = true;
		this.sidebarOpened = false;
		this.sidebar.value = this.layout.createEmbeddedSideBar(this.sidebarHost, visible => {
			this.sidebarRequested = visible;
			if (visible) { void this.openTool('editor', true).catch(onUnexpectedError); } else { this.layoutEditors(); }
		});
		for (const id of restoreDefaultViews) {
			const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
			if (tool && 'view' in tool && id !== 'terminal' && !this.nativeGroups.some(group => group.editors.some(editor => editor instanceof StudioToolViewInput && editor.toolId === id))) {
				const target = this.ensurePart(id);
				await target.whenReady;
				await this.editors.openEditor(new StudioToolViewInput(id, tool.view), { pinned: true, index: 0, inactive: true, preserveFocus: true }, target.activeGroup);
			}
		}
		this.syncEditors();
		if (restoreActive === 'editor' && !restoreEmptyEditor && restoredEditor && restoredGroup.contains(restoredEditor)) {
			await this.select(this.id(restoredEditor, restoredGroup), true);
		} else if (restoreActive && (this.tools.has(restoreActive) || this.parts.has(restoreActive))) { await this.openTool(restoreActive); }
		else { await this.home(); }
	}

	private moveError(): Error { return new Error(studioModeState.state.labels.moveEditorsError ?? 'Unable to move tool workspace editors back to the IDE.'); }

	async deactivate(target: IEditorGroup): Promise<void> {
		await Promise.all([...this.parts.values()].map(({ part }) => part.whenReady));
		this.enabled = false; ++this.visibilityRevision;
		for (const { part, host } of this.parts.values()) { part.setVisible(false); host.hidden = true; }
		this.surface.hidden = true;
		this.sidebar.value?.setVisible(false);
		for (const group of this.nativeGroups) {
			for (const editor of [...group.getEditors(EditorsOrder.SEQUENTIAL)]) {
				if (editor instanceof StudioToolViewInput) { await group.closeEditor(editor, { preserveFocus: true }); continue; }
				if (editor instanceof TerminalEditorInput && editor.terminalInstance && !this.ideGroups.has(editor)) {
					await this.terminals.moveToTerminalView(editor.terminalInstance); continue;
				}
				const original = this.ideGroups.get(editor);
				const destination = original && this.groups.mainPart.getGroup(original.id) === original ? original : target;
				if (!group.moveEditors([{ editor, options: { preserveFocus: true } }], destination)) { this.enabled = true; this.syncEditors(); throw this.moveError(); }
			}
		}
		this.sidebar.clear(); this.modeLifetime.clear();
		this.parts.clear(); this.partLifetime.clear();
		for (const element of this.editorPane.querySelectorAll('.studio-steam-editors')) { element.remove(); }
		this.projectGroup = undefined; this.projectUri = undefined; this.setProject(undefined); this.ideGroups.clear();
		this.syncEditors();
	}

	async home(): Promise<void> {
		if (!this.enabled) { return; }
		++this.visibilityRevision; this.active = undefined; this.publish();
		await this.views.openView(HOME_VIEW, true);
	}

	async openTool(id: string, preserveFocus = false): Promise<void> {
		if (!this.enabled) { return; }
		const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
		if (!tool && !this.parts.has(id)) { return; }
		const candidates = this.tabs.filter(tab => this.category(tab) === id);
		if (candidates.length) {
			this.tools.add(id);
			const selectedEditor = this.selectedEditors.get(id);
			const selected = candidates.find(tab => tab.id === this.selectedInstances.get(id))
				?? candidates.find(tab => selectedEditor && tab.editor.matches(selectedEditor))
				?? candidates.find(tab => tab.group.activeEditor === tab.editor) ?? candidates[0];
			await this.select(selected.id, true, preserveFocus); return;
		}
		if (tool && 'command' in tool) { await this.commands.executeCommand(tool.command); return; }
		if (tool && 'view' in tool && !this.descriptors.getViewContainerByViewId(tool.view)) { return; }
		this.tools.add(id);
		if (tool?.id === 'terminal') {
			const hasTerminals = this.terminals.instances.length > 0;
			this.retainTerminals();
			if (!hasTerminals) { await this.newInstance('terminal'); }
			return;
		}
		if (tool && 'view' in tool) {
			const revision = ++this.visibilityRevision;
			let opening = this.pendingViews.get(id);
			if (!opening) {
				opening = (async () => {
					const part = this.ensurePart(id);
					await part.whenReady;
					if (this.enabled && this.tools.has(id) && this.parts.get(id)?.part === part) {
						await this.editors.openEditor(new StudioToolViewInput(id, tool.view), { pinned: true, preserveFocus, inactive: revision !== this.visibilityRevision }, part.activeGroup);
					}
				})();
				this.pendingViews.set(id, opening);
			}
			try { await opening; } finally { if (this.pendingViews.get(id) === opening) { this.pendingViews.delete(id); } }
			return;
		}
		++this.visibilityRevision; this.active = id; this.publish();
		await this.views.openView(HOME_VIEW, false);
	}

	private retainTerminals(): void {
		const part = this.ensurePart('terminal');
		++this.movingTerminals;
		try {
			for (const terminal of [...this.terminalGroups.instances]) { this.terminals.moveToEditor(terminal, part.activeGroup.id); }
		} finally { --this.movingTerminals; }
	}

	async newInstance(id: string | undefined = studioSteamWorkspaceState.tool, groupId?: number): Promise<void> {
		if (!this.enabled) { return; }
		if (groupId !== undefined) {
			const group = this.groups.getGroup(groupId);
			const owner = [...this.parts].find(([, { part }]) => group && part.groups.includes(group));
			if (!group || !owner) { return; }
			this.groups.activateGroup(group); id = owner[0];
		}
		const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
		if (!tool) { return; }
		this.tools.add(tool.id);
		if (tool.id === 'editor') { await this.commands.executeCommand('workbench.action.files.newUntitledFile'); }
		else if (tool.id === 'terminal') { await this.terminals.createTerminal({ location: { viewColumn: this.ensurePart('terminal').activeGroup.id } }); }
		else if ('command' in tool) { await this.commands.executeCommand(tool.command, undefined, ...(tool.id === 'browser' ? [{ forceNew: true }] : [])); }
		else { await this.commands.executeCommand('studio.createToolInstance', tool.id); }
	}

	async select(id: string, instance = false, preserveFocus = false): Promise<void> {
		if (!this.enabled) { return; }
		if (!instance && (this.tools.has(id) || this.parts.has(id))) { await this.openTool(id, preserveFocus); return; }
		const tab = this.tabs.find(tab => tab.id === id);
		if (!tab) { return; }
		this.revealEditor(tab.editor, tab.group);
		await this.editors.openEditor(tab.editor, { preserveFocus }, tab.group);
		if (!preserveFocus && this.enabled && this.active === id && this.nativeGroups.includes(tab.group)) { tab.group.focus(); }
	}

	async close(id: string, instance = false): Promise<boolean> {
		if (!this.enabled) { return false; }
		const category = !instance && (this.tools.has(id) || this.parts.has(id));
		const closing = this.tabs.filter(tab => category ? this.category(tab) === id : tab.id === id);
		const wasActive = category ? this.category(this.tabs.find(tab => tab.id === this.active)) === id || this.active === id : this.active === id;
		if (category && id === 'terminal') { ++this.movingTerminals; }
		try {
			for (const tab of closing) {
				if (category && tab.editor instanceof TerminalEditorInput && tab.editor.terminalInstance) { await this.terminals.moveToTerminalView(tab.editor.terminalInstance); }
				else if (!await tab.group.closeEditor(tab.editor, { preserveFocus: true })) { this.syncEditors(); return false; }
				if (!this.enabled || !this.nativeGroups.includes(tab.group)) { return false; }
			}
		} finally { if (category && id === 'terminal') { --this.movingTerminals; } }
		if (category) { this.tools.delete(id); this.selectedInstances.delete(id); this.selectedEditors.delete(id); }
		this.syncEditors();
		if (wasActive) {
			const remaining = this.tabs.find(tab => tab.id === this.active) ?? this.tabs.find(tab => this.category(tab) === id) ?? this.tabs.at(-1);
			if (remaining) { await this.select(remaining.id, true); }
			else if (!category && this.tools.has('editor') && this.active === 'editor') { await this.openTool('editor'); }
			else { await this.home(); }
		} else { this.publish(); }
		return true;
	}

	async closeTabs(id: string, mode: 'others' | 'all'): Promise<void> {
		const categories = studioSteamWorkspaceState.tabs.map(tab => tab.id).filter(candidate => mode === 'all' || candidate !== id);
		for (const category of categories) { if (!await this.close(category)) { break; } }
	}

	async selectProject(groupId?: number): Promise<void> {
		const group = groupId === undefined ? undefined : this.nativeGroups.find(group => group.id === groupId);
		const tab = group ? this.tabs.find(tab => tab.group === group && tab.editor === group.activeEditor) : this.tabs.find(tab => tab.id === this.active);
		if (tab && group) { await this.select(tab.id, true); }
		const kind = this.category(tab);
		const command = tab?.editor instanceof StudioToolViewInput ? kind === 'versions' ? 'studio.selectVersionsProject' : 'studio.selectInfoProject' : 'studio.selectToolInstanceProject';
		await this.commands.executeCommand(command, kind);
	}

	private setProject(editor: EditorInput | undefined): void {
		if (this.project === editor) { return; }
		this.project = editor;
		this.projectLifetime.value = editor?.onWillDispose(() => this.setProject(undefined));
	}

	private matchesProject(editor: EditorInput): boolean {
		if (editor.isDisposed() || !(editor instanceof WebviewInput) || editor.webview.providedViewType !== 'studio.project' && editor.webview.providedViewType !== 'studio.projectTool') { return false; }
		if (this.project && !this.project.isDisposed()) { return editor === this.project; }
		try { const uri = JSON.parse(editor.webview.state ?? '{}').projectUri; return uri ? uri === this.projectUri : editor.webview.providedViewType === 'studio.project'; }
		catch { return false; }
	}

	private target(editor: EditorInput | IUntypedEditorInput, preferred: PreferredGroup | undefined): IEditorGroup | undefined {
		if (!this.enabled) { return undefined; }
		const explicit = typeof preferred === 'number' && preferred >= 0 ? this.groups.getGroup(preferred) : typeof preferred === 'object' ? preferred : undefined;
		if (editor instanceof EditorInput && this.matchesProject(editor)) { this.setProject(editor); return this.projectGroup; }
		if (explicit && this.groups.getPart(explicit).windowId !== this.groups.mainPart.windowId) { return undefined; }
		const category = this.editorCategory(editor);
		const part = this.ensurePart(category);
		return explicit && part.groups.includes(explicit) ? explicit : part.activeGroup;
	}

	private id(editor: EditorInput, group: IEditorGroup): string {
		let id = this.editorIds.get(editor);
		if (!id) { id = `editor:${++this.editorId}`; this.editorIds.set(editor, id); }
		return `${id}:${group.id}`;
	}

	private syncEditors(): void {
		const previous = this.tabs.find(tab => tab.id === this.active);
		let revealHome = false;
		const previousCategories = new Set(this.tabs.map(tab => this.category(tab)));
		this.tabs = this.nativeGroups.flatMap(group => group.getEditors(EditorsOrder.SEQUENTIAL).map(editor => ({ id: this.id(editor, group), editor, group })));
		for (const tab of this.tabs) { this.tools.add(this.category(tab)); }
		if (this.enabled) {
			for (const id of previousCategories) {
				if (id !== 'editor' && !this.tabs.some(tab => this.category(tab) === id)) { this.tools.delete(id); }
			}
		}
		if (this.active && !this.tabs.some(tab => tab.id === this.active) && this.active !== 'editor') {
			const id = this.category(previous);
			const group = previous?.group;
			const next = this.tabs.find(tab => tab.group === group && tab.editor === group?.activeEditor)
				?? this.tabs.find(tab => this.category(tab) === id) ?? (id !== 'editor' ? this.tabs.at(-1) : undefined);
			this.active = next?.id ?? (id === 'editor' && this.tools.has('editor') ? 'editor' : undefined);
			revealHome = this.enabled && !!previous && !this.active;
		}
		this.publish();
		if (revealHome) { void this.views.openView(HOME_VIEW, false).catch(onUnexpectedError); }
	}

	private revealEditor(editor: EditorInput, group: IEditorGroup): void {
		this.active = this.id(editor, group); this.tools.add(this.editorCategory(editor)); this.publish();
		const revision = ++this.visibilityRevision;
		if (!(editor instanceof StudioToolViewInput)) {
			void this.views.openView(HOME_VIEW, false).then(() => { if (revision === this.visibilityRevision) { this.layoutEditors(); } }, onUnexpectedError);
		}
	}

	private publish(): void {
		const labels = studioModeState.state.labels;
		this.emptyLabel.textContent = labels.editorEmpty ?? 'Open a file from Explorer or Quick Open to start editing.';
		this.openFile.textContent = labels.openFile ?? 'Open File';
		const activeTab = this.tabs.find(tab => tab.id === this.active);
		const category = activeTab ? this.category(activeTab) : this.active;
		if (this.enabled && category && this.active) {
			this.selectedInstances.set(category, this.active);
			if (activeTab) { this.selectedEditors.set(category, activeTab.editor); }
		}
		const describe = (tab: WorkspaceTab): StudioSteamTab => ({ id: tab.id, label: tab.editor.getName(), icon: this.toolFor(tab.editor)?.icon ?? 'file', dirty: tab.editor.isDirty() });
		const tabs: StudioSteamTab[] = [];
		for (const id of this.tools) {
			const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
			const children = this.tabs.filter(tab => this.category(tab) === id);
			if (!children.length && id !== 'editor') { continue; }
			tabs.push({ id, label: tool ? labels[id] ?? id : children[0].editor.getName(), icon: tool?.icon ?? 'file', dirty: children.some(tab => tab.editor.isDirty()) });
		}
		studioSteamWorkspaceState.update(tabs, category, this.enabled ? this.tabs.filter(tab => this.category(tab) === category).map(describe) : [], this.active, category);
		if (this.enabled) {
			this.savedActive = category;
			this.savedEmptyEditor = this.active === 'editor';
			this.defaultViews.clear();
			for (const tab of this.tabs) { if (tab.editor instanceof StudioToolViewInput) { this.defaultViews.add(tab.editor.toolId); } }
			this.storage.store(TABS_KEY, { tools: [...this.tools], active: category, emptyEditor: this.savedEmptyEditor, parts: [...this.parts.keys()], defaultViews: [...this.defaultViews] }, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.layoutEditors();
	}

	private category(tab: WorkspaceTab | undefined): string { return tab ? this.editorCategory(tab.editor) : ''; }
	private editorCategory(editor: EditorInput | IUntypedEditorInput): string { return this.toolFor(editor)?.id ?? (editor instanceof EditorInput ? editor.typeId : undefined) ?? 'editor'; }

	private toolFor(editor: EditorInput | IUntypedEditorInput): Tool | undefined {
		let id: string | undefined;
		if (editor instanceof StudioToolViewInput) { id = editor.toolId; }
		else if (editor instanceof WebviewInput) {
			const type = editor.webview.providedViewType;
			id = type === 'studio.settings' ? 'settings' : type === 'studio.login' ? 'login' : type?.startsWith('studio.tool.') ? type.slice('studio.tool.'.length) : type === 'simpleBrowser.view' ? 'browser' : type === 'studio.projectTool' ? 'project' : editor instanceof CustomEditorInput ? 'editor' : undefined;
		} else if (editor instanceof EditorInput && editor.typeId === 'workbench.editors.terminal') { id = 'terminal'; }
		else if (editor instanceof EditorInput && editor.typeId === 'workbench.editorinputs.browser') { id = 'browser'; }
		else if (EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY })) { id = 'editor'; }
		return studioSteamToolDefinitions.find(tool => tool.id === id);
	}

	private layoutEditors(): void {
		const category = this.category(this.tabs.find(tab => tab.id === this.active)) || this.active;
		const code = category === 'editor';
		const visible = this.enabled && !!category && this.layout.isVisible(Parts.AUXILIARYBAR_PART);
		const hasInput = !!this.tabs.find(tab => tab.id === this.active);
		this.surface.hidden = !visible;
		this.empty.hidden = !visible || hasInput;
		this.surface.parentElement?.classList.toggle('studio-steam-editor-active', visible);
		for (const [id, { part, host }] of this.parts) { host.hidden = !visible || id !== category || !hasInput; part.setVisible(!host.hidden); }
		this.sidebar.value?.setVisible(visible && code && this.sidebarRequested);
		if (visible && code && this.sidebarRequested && !this.sidebarOpened) {
			this.sidebarOpened = true;
			void this.views.openViewContainer('workbench.view.explorer', false).catch(onUnexpectedError);
		}
		this.split.setViewVisible(1, visible && code && this.sidebarRequested);
		if (visible) {
			const title = this.surface.parentElement?.querySelector(':scope > .title');
			if (title) { this.surface.style.top = `${title.getBoundingClientRect().height}px`; }
			this.split.layout(this.surface.clientWidth);
			if (this.split.isViewVisible(1)) { this.split.resizeView(1, Math.min(this.sidebarWidth, Math.max(140, this.surface.clientWidth - 120))); }
		}
	}
}
