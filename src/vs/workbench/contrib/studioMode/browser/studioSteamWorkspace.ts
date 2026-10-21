/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, getWindow } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { studioModeState, studioSteamToolDefinitions, studioSteamWorkspaceState, StudioSteamTab } from '../../../browser/parts/studioMode.js';
import { EditorsOrder, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEmbeddedEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import { registerEditorOpenTarget } from '../../../services/editor/common/editorOpenTarget.js';
import { PreferredGroup } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { ITerminalGroupService, ITerminalService } from '../../terminal/browser/terminal.js';

const TABS_KEY = 'studio.steamWorkspaceTabs';
const HOME_VIEW = 'studio.steamTools';
interface SavedTabs { tools: string[]; active?: string }
type ViewTool = Extract<typeof studioSteamToolDefinitions[number], { view: string }>;
interface WorkspaceTab { id: string; tool?: ViewTool; editor?: EditorInput; group?: IEditorGroup }

/**
 * The run surface belongs to the main editor part. All other editor inputs use a
 * separate, registered editor part inside the tool area, alongside retained views.
 * Routing happens before opening, including explicit groups and batched requests.
 */
export class StudioSteamWorkspace extends Disposable {
	private part: IEmbeddedEditorPart | undefined;
	private readonly partLifetime = this._register(new DisposableStore());
	private readonly modeLifetime = this._register(new DisposableStore());
	private readonly host: HTMLElement;
	private readonly refresh = this._register(new RunOnceScheduler(() => this.syncEditors(), 0));
	private tabs: WorkspaceTab[] = [];
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
	private visibilityRevision = 0;
	private readonly selectedInstances = new Map<string, string>();

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
	) {
		super();
		const saved = storage.getObject<SavedTabs>(TABS_KEY, StorageScope.WORKSPACE);
		this.tabs = [...new Set(saved?.tools ?? [])].flatMap(id => {
			const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
			return tool && 'view' in tool ? [{ id, tool }] : [];
		});
		this.savedActive = saved?.active;
		this.host = append(parent, $('.part.editor.studio-steam-editors'));
		this.host.hidden = true;
		this._register(studioModeState.onDidChangeState(() => this.publish()));
		this._register(this.views.onDidChangeViewVisibility(event => {
			if (!this.enabled || !event.visible) { return; }
			const tool = studioSteamToolDefinitions.find(tool => 'view' in tool && tool.view === event.id);
			if (tool && 'view' in tool) {
				if (!this.tabs.some(tab => tab.id === tool.id)) { this.tabs.push({ id: tool.id, tool }); }
				++this.visibilityRevision; this.active = tool.id; this.publish();
			}
		}));
		this._register(registerEditorOpenTarget((editor, preferred) => this.target(editor, preferred)));
		this._register(this.terminalGroups.onDidChangeInstances(() => this.publish()));
		this._register(this.terminalGroups.onDidChangeActiveInstance(() => this.publish()));
		this._register(this.terminals.onAnyInstanceTitleChange(() => this.refresh.schedule()));
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layoutEditors());
		observer.observe(parent);
		this._register(this.layout.onDidChangePartVisibility(() => this.layoutEditors()));
		this._register(toDisposable(() => { observer.disconnect(); this.host.remove(); studioSteamWorkspaceState.update([], undefined); }));
		// Restore saved inputs even if a removed project forces the next mode back to IDE.
		if (storage.get('studio.workbenchMode', StorageScope.WORKSPACE) === 'steam') { this.ensurePart(); }
	}

	private ensurePart(): IEmbeddedEditorPart {
		if (this.part) { return this.part; }
		clearNode(this.host);
		const part = this.part = this.partLifetime.add(this.groups.createEmbeddedEditorPart(this.host, 'workbench.parts.studioSteamEditors', studioModeState.state.labels.workspace ?? 'Tool Workspace'));
		this.partLifetime.add(part.enforcePartOptions({ showTabs: 'none', enablePreview: false, closeEmptyGroups: true, editorActionsLocation: 'hidden' }));
		const registerGroup = (group: IEditorGroup) => {
			let opening: { editor: EditorInput; revision: number } | undefined;
			this.partLifetime.add((group as IEditorGroupView).onWillOpenEditor(event => {
				if (this.enabled && group.activeEditor === event.editor) { this.revealEditor(event.editor, group); }
				opening = { editor: event.editor, revision: this.visibilityRevision };
			}));
			this.partLifetime.add(group.onDidModelChange(() => this.refresh.schedule()));
			this.partLifetime.add(group.onDidActiveEditorChange(() => {
				this.syncEditors();
				// Closing an input starts an asynchronous native fallback. A later tool
				// selection owns the surface and must not be replaced when it finishes.
				if (this.enabled && this.groups.activeGroup === group && group.activeEditor
					&& opening?.editor === group.activeEditor && opening.revision === this.visibilityRevision) { this.revealEditor(group.activeEditor, group); }
			}));
		};
		part.groups.forEach(registerGroup);
		this.partLifetime.add(part.onDidAddGroup(registerGroup));
		this.partLifetime.add(part.onDidRemoveGroup(() => this.refresh.schedule()));
		this.partLifetime.add(part.onDidActivateGroup(({ group }) => {
			if (this.enabled && group.activeEditor) { this.revealEditor(group.activeEditor, group); }
		}));
		void part.whenReady.then(() => { if (this.part === part) { this.syncEditors(); } });
		return part;
	}

	async activate(projectUri = studioModeState.state.projectUri): Promise<void> {
		if (this.enabled) { return; }
		this.projectUri = projectUri;
		const part = this.ensurePart();
		await part.whenReady;
		const restoreActive = this.savedActive;
		const restoredEditor = part.activeGroup.activeEditor;
		const restoredGroup = part.activeGroup;
		const projectGroup = this.projectGroup = this.groups.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE)[0];
		this.modeLifetime.add(this.groups.mainPart.enforceSingleGroup(projectGroup));
		this.setProject([...this.groups.mainPart.groups, ...part.groups].flatMap(group => group.editors).find(editor => this.matchesProject(editor)));
		this.modeLifetime.add(projectGroup.onDidCloseEditor(({ editor }) => {
			if (editor === this.project) { this.setProject(undefined); }
		}));
		// Retain IDE ownership for the return trip, but leave no source document
		// behind the runtime that native close/navigation could reveal on the left.
		const sourceEditors = projectGroup.getEditors(EditorsOrder.SEQUENTIAL).filter(editor => !this.matchesProject(editor));
		for (const editor of sourceEditors) { this.ideGroups.set(editor, projectGroup); }
		if (!projectGroup.moveEditors(sourceEditors.map(editor => ({ editor, options: { preserveFocus: true } })), part.activeGroup)) {
			throw new Error(studioModeState.state.labels.moveEditorsError ?? 'Unable to move tool workspace editors back to the IDE.');
		}
		// Repair restored sessions and projects that were previously opened in another group.
		for (const group of [...this.groups.mainPart.groups, ...part.groups]) {
			if (group === projectGroup) { continue; }
			group.moveEditors(group.getEditors(EditorsOrder.SEQUENTIAL).filter(editor => this.matchesProject(editor))
				.map(editor => ({ editor, options: { preserveFocus: true } })), projectGroup);
		}
		this.enabled = true;
		this.syncEditors();
		if (restoreActive === 'editor' && restoredEditor && restoredGroup.contains(restoredEditor)) {
			// Moving an IDE source into this group can change its active input.
			await this.select(this.id(restoredEditor, restoredGroup));
		} else if (restoreActive && this.tabs.some(tab => tab.tool && tab.id === restoreActive)) {
			await this.select(restoreActive);
		} else { await this.home(); }
	}

	async deactivate(target: IEditorGroup): Promise<void> {
		const part = this.part;
		if (!part) { return; }
		await part.whenReady;
		this.enabled = false; ++this.visibilityRevision;
		part.setVisible(false); this.host.hidden = true;
		// Move inputs, without closing or saving them, so IDE can access every new and dirty editor.
		for (const group of part.groups) {
			const destinations = new Map<IEditorGroup, EditorInput[]>();
			for (const editor of group.getEditors(EditorsOrder.SEQUENTIAL)) {
				const original = this.ideGroups.get(editor);
				const destination = original && this.groups.mainPart.getGroup(original.id) === original ? original : target;
				const editors = destinations.get(destination) ?? [];
				editors.push(editor); destinations.set(destination, editors);
			}
			for (const [destination, editors] of destinations) {
				if (!group.moveEditors(editors.map(editor => ({ editor, options: { preserveFocus: true } })), destination)) {
					this.enabled = true;
					this.syncEditors();
					throw new Error(studioModeState.state.labels.moveEditorsError ?? 'Unable to move tool workspace editors back to the IDE.');
				}
			}
		}
		this.modeLifetime.clear();
		this.part = undefined;
		this.partLifetime.clear();
		clearNode(this.host);
		this.projectGroup = undefined;
		this.projectUri = undefined;
		this.setProject(undefined);
		this.ideGroups.clear();
		this.syncEditors();
	}

	async home(): Promise<void> {
		if (!this.enabled) { return; }
		++this.visibilityRevision; this.active = undefined; this.publish();
		await this.views.openView(HOME_VIEW, true);
	}

	async openTool(id: string): Promise<void> {
		if (!this.enabled) { return; }
		const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
		if (!tool) { return; }
		if (this.tabs.some(tab => this.toolFor(tab)?.id === id)) { await this.select(id); return; }
		if ('command' in tool) { await this.commands.executeCommand(tool.command); return; }
		if (!this.descriptors.getViewContainerByViewId(tool.view)) { return; }
		if (!this.tabs.some(tab => tab.id === id)) { this.tabs.push({ id, tool }); }
		await this.select(id);
	}

	async newInstance(id: string | undefined): Promise<void> {
		if (!this.enabled) { return; }
		const tool = studioSteamToolDefinitions.find(tool => tool.id === id);
		if (!tool) { return; }
		if (tool.id === 'terminal') {
			const instance = await this.terminals.createTerminal({ location: TerminalLocation.Panel });
			if (instance && this.enabled) { await this.openTool('terminal'); await this.terminalGroups.focusInstance(instance); }
		} else if ('command' in tool) {
			await this.commands.executeCommand(tool.command, undefined, ...(tool.id === 'browser' ? [{ forceNew: true }] : []));
		} else { await this.commands.executeCommand('studio.createToolInstance', tool.id); }
	}

	async select(id: string, instance = false): Promise<void> {
		if (!this.enabled) { return; }
		if (id.startsWith('terminal:')) {
			const terminal = this.terminalGroups.instances.find(terminal => `terminal:${terminal.instanceId}` === id);
			if (terminal) {
				this.active = 'terminal';
				await this.views.openView('terminal', true);
				if (this.enabled && this.active === 'terminal' && this.terminalGroups.instances.includes(terminal)) { await this.terminalGroups.focusInstance(terminal); }
				this.publish();
			}
			return;
		}
		if (!instance) {
			const candidates = this.tabs.filter(tab => this.toolFor(tab)?.id === id);
			id = candidates.find(tab => tab.id === this.selectedInstances.get(id))?.id ?? candidates[0]?.id ?? id;
		}
		const tab = this.tabs.find(tab => tab.id === id);
		if (!tab) { return; }
		++this.visibilityRevision; this.active = id; this.publish();
		if (tab.tool) { await this.views.openView(tab.tool.view, true); }
		else if (tab.editor && tab.group) {
			this.revealEditor(tab.editor, tab.group);
			await tab.group.openEditor(tab.editor);
			if (this.enabled && this.active === id && this.part?.groups.includes(tab.group)) { tab.group.focus(); }
		}
	}

	async close(id: string, instance = false): Promise<void> {
		if (!this.enabled) { return; }
		if (id.startsWith('terminal:')) {
			const terminal = this.terminalGroups.instances.find(terminal => `terminal:${terminal.instanceId}` === id);
			if (terminal) { await this.terminals.safeDisposeTerminal(terminal); }
			if (!this.terminalGroups.instances.length && this.active === 'terminal') { await this.home(); }
			this.publish(); return;
		}
		if (!instance && studioSteamToolDefinitions.some(tool => tool.id === id)) {
			const category = this.tabs.filter(tab => this.toolFor(tab)?.id === id);
			const wasActive = this.toolFor(this.tabs.find(tab => tab.id === this.active))?.id === id;
			const part = this.part;
			for (const tab of category.filter(tab => tab.editor)) {
				if (!await tab.group!.closeEditor(tab.editor!, { preserveFocus: true })) { this.publish(); return; }
				if (!this.enabled || this.part !== part) { return; }
			}
			this.tabs = this.tabs.filter(tab => !category.some(closed => closed.id === tab.id));
			this.selectedInstances.delete(id);
			if (wasActive || !this.active || !this.tabs.some(tab => tab.id === this.active)) {
				if (this.tabs.length) { await this.select(this.tabs.at(-1)!.id, true); } else { await this.home(); }
			} else { this.publish(); }
			return;
		}
		const index = this.tabs.findIndex(tab => tab.id === id), tab = this.tabs[index];
		if (!tab) { return; }
		const wasActive = this.active === id;
		const tool = this.toolFor(tab);
		const siblings = tool ? this.tabs.filter(candidate => this.toolFor(candidate)?.id === tool.id) : [];
		const siblingIndex = siblings.indexOf(tab);
		const next = siblings[siblingIndex + 1]?.id ?? siblings[siblingIndex - 1]?.id ?? this.tabs[index + 1]?.id ?? this.tabs[index - 1]?.id;
		const part = this.part;
		if (tab.editor && tab.group && !await tab.group.closeEditor(tab.editor, { preserveFocus: true })) { return; }
		if (!this.enabled || this.part !== part) { return; }
		this.tabs = this.tabs.filter(tab => tab.id !== id);
		if (wasActive) {
			if (next && this.tabs.some(tab => tab.id === next)) { await this.select(next, true); } else { await this.home(); }
		} else { this.publish(); }
	}

	private setProject(editor: EditorInput | undefined): void {
		if (this.project === editor) { return; }
		this.project = editor;
		this.projectLifetime.value = editor?.onWillDispose(() => this.setProject(undefined));
	}

	private matchesProject(editor: EditorInput): boolean {
		if (editor.isDisposed() || !(editor instanceof WebviewInput) || editor.webview.providedViewType !== 'studio.project' && editor.webview.providedViewType !== 'studio.projectTool') { return false; }
		if (this.project && !this.project.isDisposed()) { return editor === this.project; }
		// New panels open before their frame can publish serialized state. Their
		// placement cannot depend on whether a previously closed input was cached.
		try {
			const uri = JSON.parse(editor.webview.state ?? '{}').projectUri;
			return uri ? uri === this.projectUri : editor.webview.providedViewType === 'studio.project';
		} catch { return false; }
	}

	private target(editor: EditorInput | IUntypedEditorInput, preferred: PreferredGroup | undefined): IEditorGroup | undefined {
		if (!this.enabled) { return undefined; }
		const explicit = typeof preferred === 'number' && preferred >= 0 ? this.groups.getGroup(preferred) : typeof preferred === 'object' ? preferred : undefined;
		if (editor instanceof EditorInput && this.matchesProject(editor)) {
			this.setProject(editor);
			return this.projectGroup;
		}
		// Existing auxiliary windows keep their own scoped editor services.
		if (explicit && this.groups.getPart(explicit).windowId !== this.groups.mainPart.windowId) { return undefined; }
		if (explicit && this.part?.groups.includes(explicit)) { return explicit; }
		return this.part?.activeGroup;
	}

	private id(editor: EditorInput, group: IEditorGroup): string {
		let id = this.editorIds.get(editor);
		if (!id) { id = `editor:${++this.editorId}`; this.editorIds.set(editor, id); }
		return `${id}:${group.id}`;
	}

	private syncEditors(): void {
		const editors = this.part?.groups.flatMap(group => group.getEditors(EditorsOrder.SEQUENTIAL).map(editor => ({ id: this.id(editor, group), editor, group }))) ?? [];
		const current = new Map(editors.map(tab => [tab.id, tab]));
		this.tabs = this.tabs.flatMap(tab => tab.tool ? [tab] : current.has(tab.id) ? [current.get(tab.id)!] : []);
		for (const tab of editors) { if (!this.tabs.some(entry => entry.id === tab.id)) { this.tabs.push(tab); } }
		if (this.active && !this.tabs.some(tab => tab.id === this.active)) {
			this.active = this.part?.activeGroup.activeEditor ? this.id(this.part.activeGroup.activeEditor, this.part.activeGroup) : undefined;
		}
		this.publish();
	}

	private revealEditor(editor: EditorInput, group: IEditorGroup): void {
		this.active = this.id(editor, group); this.publish();
		const revision = ++this.visibilityRevision;
		// Keep the native auxiliary part open underneath the embedded editor surface.
		void this.views.openView(HOME_VIEW, false).then(() => {
			if (revision === this.visibilityRevision) { this.layoutEditors(); }
		}, onUnexpectedError);
	}

	private publish(): void {
		const activeTool = this.toolFor(this.tabs.find(tab => tab.id === this.active));
		if (activeTool && this.active) { this.selectedInstances.set(activeTool.id, this.active); }
		const describe = (tab: WorkspaceTab): StudioSteamTab => ({ id: tab.id,
			label: tab.tool ? studioModeState.state.labels[tab.id] ?? tab.id : tab.editor!.getName(),
			icon: tab.tool?.icon ?? 'file', dirty: tab.editor?.isDirty(),
		});
		const tabs = new Map<string, StudioSteamTab>();
		for (const tab of this.tabs) {
			const tool = this.toolFor(tab);
			const id = tool?.id ?? tab.id;
			const previous = tabs.get(id);
			tabs.set(id, { ...(tool ? { id, label: studioModeState.state.labels[id] ?? id, icon: tool.icon } : describe(tab)), dirty: previous?.dirty || tab.editor?.isDirty() });
		}
		const instances = activeTool ? this.tabs.filter(tab => this.toolFor(tab)?.id === activeTool.id).flatMap(tab => tab.id === 'terminal'
			? this.terminalGroups.instances.map(terminal => ({ id: `terminal:${terminal.instanceId}`, label: terminal.title, icon: 'terminal' })) : [describe(tab)]) : [];
		let selected = this.active;
		if (activeTool?.id === 'terminal' && this.active === 'terminal') {
			selected = this.terminalGroups.activeInstance ? `terminal:${this.terminalGroups.activeInstance.instanceId}` : undefined;
		}
		studioSteamWorkspaceState.update([...tabs.values()], activeTool?.id ?? this.active, this.enabled ? instances : [], selected, activeTool?.id);
		if (this.enabled) {
			this.savedActive = this.active?.startsWith('editor:') ? 'editor' : this.active;
			this.storage.store(TABS_KEY, { tools: this.tabs.filter(tab => tab.tool).map(tab => tab.id), active: this.savedActive }, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.layoutEditors();
	}

	private toolFor(tab: WorkspaceTab | undefined): typeof studioSteamToolDefinitions[number] | undefined {
		if (tab?.tool) { return tab.tool; }
		const editor = tab?.editor;
		if (!editor) { return undefined; }
		let id: string | undefined;
		if (editor instanceof WebviewInput) {
			const type = editor.webview.providedViewType;
			id = type?.startsWith('studio.tool.') ? type.slice('studio.tool.'.length)
				: type === 'simpleBrowser.view' ? 'browser' : type === 'studio.projectTool' ? 'project' : undefined;
		} else if (editor.typeId === 'workbench.editors.terminal') { id = 'terminal'; }
		else if (editor.typeId === 'workbench.editorinputs.browser') { id = 'browser'; }
		return studioSteamToolDefinitions.find(tool => tool.id === id);
	}

	private layoutEditors(): void {
		const visible = this.enabled && !!this.active?.startsWith('editor:') && this.layout.isVisible(Parts.AUXILIARYBAR_PART);
		this.host.hidden = !visible;
		this.host.parentElement?.classList.toggle('studio-steam-editor-active', visible);
		if (visible) {
			const title = this.host.parentElement?.querySelector(':scope > .title');
			if (title) { this.host.style.top = `${title.getBoundingClientRect().height}px`; }
			const rect = this.host.getBoundingClientRect();
			this.part?.layout(rect.width, rect.height, 0, 0);
		}
		this.part?.setVisible(visible);
	}
}
