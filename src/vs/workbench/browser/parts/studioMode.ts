/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/studioMode.css';
import { $, addDisposableListener, append, clearNode, getWindow } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { toAction } from '../../../base/common/actions.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { getDefaultHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';

export const studioSteamToolDefinitions = [
	{ id: 'kv', icon: 'database', view: 'studio.kv' },
	{ id: 'knowledge', icon: 'book', view: 'studio.knowledge' },
	{ id: 'info', icon: 'package', view: 'studio.projectInfo' },
	{ id: 'assistant', icon: 'hubot', view: 'studio.developerAssistant' },
	{ id: 'versions', icon: 'versions', view: 'studio.versions' },
	{ id: 'trace', icon: 'history', view: 'studio.trace' },
	{ id: 'terminal', icon: 'terminal', view: 'terminal' },
	{ id: 'browser', icon: 'globe', command: 'simpleBrowser.show' },
	{ id: 'project', icon: 'folder-opened', command: 'studio.openProjectInTab' },
] as const;

export interface StudioSteamTab { id: string; label: string; icon: string; dirty?: boolean }
const workspaceChange = new Emitter<void>();
export const studioSteamWorkspaceState = {
	tabs: [] as StudioSteamTab[], active: undefined as string | undefined,
	onDidChange: workspaceChange.event,
	update(tabs: StudioSteamTab[], active: string | undefined): void {
		this.tabs = tabs; this.active = active; workspaceChange.fire();
	},
};

export interface StudioModeState {
	available: boolean;
	projectUri?: string;
	ready?: boolean;
	labels: Record<string, string>;
}

const stateChange = new Emitter<StudioModeState>();
const modeChange = new Emitter<void>();
export const studioModeState = {
	state: { available: false, labels: {} } as StudioModeState,
	steam: false,
	busy: false,
	targetSteam: false,
	onDidChangeState: stateChange.event,
	onDidChangeMode: modeChange.event,
	setMode(steam: boolean, busy: boolean, targetSteam = steam): void {
		this.steam = steam;
		this.busy = busy;
		this.targetSteam = targetSteam;
		modeChange.fire();
	}
};

CommandsRegistry.registerCommand('studio.internalUpdateModeState', (_accessor, state: StudioModeState) => {
	studioModeState.state = state;
	stateChange.fire(state);
});

/** Title bar controls share the native window-control spacing and drag exclusion. */
export class StudioModeSwitcher extends Disposable {
	constructor(left: HTMLElement, right: HTMLElement,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		const element = append(left, $('.studio-mode-switcher', { role: 'group' }));
		const ide = append(element, $('button.studio-mode-ide', { type: 'button' })) as HTMLButtonElement;
		const ideIcon = append(ide, $('span.codicon.codicon-code', { 'aria-hidden': 'true' }));
		append(ide, $('span', undefined, 'IDE'));
		const steam = append(element, $('button.studio-mode-steam', { type: 'button' })) as HTMLButtonElement;
		const steamIcon = append(steam, $('span.codicon.codicon-rocket', { 'aria-hidden': 'true' }));
		append(steam, $('span', undefined, 'Steam'));
		const tools = append(right, $('button.studio-steam-tools-action', { type: 'button' })) as HTMLButtonElement;
		append(tools, $('span.codicon.codicon-tools', { 'aria-hidden': 'true' }));
		const toolsLabel = append(tools, $('span'));
		const toggle = append(right, $('button.studio-steam-toggle-tools', { type: 'button', 'aria-controls': Parts.AUXILIARYBAR_PART })) as HTMLButtonElement;
		const toggleIcon = append(toggle, $('span.codicon', { 'aria-hidden': 'true' }));
		const toggleHover = this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), toggle, ''));
		const update = () => {
			const { state, steam: active, busy, targetSteam } = studioModeState;
			element.setAttribute('aria-label', state.labels.mode ?? 'Workspace Mode');
			element.setAttribute('aria-busy', String(busy));
			ide.title = state.labels.switchToIde ?? 'Switch to IDE Mode';
			steam.title = state.labels[state.available ? 'switchToSteam' : 'unavailable'] ?? 'Steam Mode';
			ide.setAttribute('aria-pressed', String(!active));
			steam.setAttribute('aria-pressed', String(active));
			ideIcon.className = busy && !targetSteam ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-code';
			steamIcon.className = busy && targetSteam ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-rocket';
			ide.disabled = busy && !targetSteam;
			steam.disabled = !state.available || busy && targetSteam;
			tools.hidden = !active;
			tools.disabled = busy;
			tools.title = toolsLabel.textContent = state.labels.tools ?? 'Open Tools';
			const visible = layout.isVisible(Parts.AUXILIARYBAR_PART);
			toggle.hidden = !active;
			toggle.disabled = busy;
			toggle.setAttribute('aria-expanded', String(visible));
			const toggleLabel = visible ? state.labels.hideTools ?? 'Hide Tools' : state.labels.showTools ?? 'Show Tools';
			toggle.setAttribute('aria-label', toggleLabel);
			toggleHover.update(toggleLabel);
			toggleIcon.className = `codicon codicon-layout-sidebar-right${visible ? '' : '-off'}`;
		};
		for (const [button, command] of [[ide, 'studio.internalEnterIdeMode'], [steam, 'studio.internalEnterSteamMode'], [tools, 'studio.internalOpenSteamTools'], [toggle, 'workbench.action.toggleAuxiliaryBar']] as const) {
			this._register(addDisposableListener(button, 'click', () => {
				void this.commands.executeCommand(command).catch(error => this.notifications.error(error));
			}));
		}
		this._register(studioModeState.onDidChangeState(update));
		this._register(studioModeState.onDidChangeMode(update));
		this._register(layout.onDidChangePartVisibility(event => { if (event.partId === Parts.AUXILIARYBAR_PART) { update(); } }));
		update();
	}
}

/** Keep project startup visible without holding a frozen view-transition snapshot. */
export class StudioModeLoading extends Disposable {
	private readonly element: HTMLElement;
	private readonly label: HTMLElement;

	constructor(private readonly parent: HTMLElement, private readonly editor: HTMLElement | undefined) {
		super();
		this.element = append(parent, $('.studio-mode-loading', { role: 'status', 'aria-live': 'polite' }));
		this.element.hidden = true;
		append(this.element, $('span.codicon.codicon-loading.codicon-modifier-spin', { 'aria-hidden': 'true' }));
		this.label = append(this.element, $('span'));
		const observer = new (getWindow(parent).ResizeObserver)(() => this.layout());
		this._register(toDisposable(() => { observer.disconnect(); this.element.remove(); }));
		observer.observe(parent);
		if (editor) { observer.observe(editor); }
	}

	show(): void {
		this.label.textContent = studioModeState.state.labels.loading ?? 'Loading project...';
		this.element.hidden = false;
		this.layout();
	}

	hide(): void { this.element.hidden = true; }

	private layout(): void {
		if (this.element.hidden || !this.editor) { return; }
		const parent = this.parent.getBoundingClientRect();
		const editor = this.editor.getBoundingClientRect();
		Object.assign(this.element.style, {
			left: `${editor.left - parent.left - this.parent.clientLeft}px`, top: `${editor.top - parent.top - this.parent.clientTop}px`,
			width: `${editor.width}px`, height: `${editor.height}px`,
		});
	}
}

/** One tab strip for retained project tools and native editors in the Steam workspace. */
export class StudioSteamTabs extends Disposable {
	private readonly element: HTMLElement;
	private readonly list: HTMLElement;
	private readonly add: HTMLButtonElement;
	private readonly tabListeners = this._register(new DisposableStore());

	constructor(parent: HTMLElement,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
	) {
		super();
		this.element = append(parent, $('.studio-steam-tabs'));
		this.list = append(this.element, $('.studio-steam-tab-list', { role: 'tablist' }));
		this.add = append(this.element, $('button.studio-steam-add-tab.codicon.codicon-add', { type: 'button', 'aria-haspopup': 'menu' })) as HTMLButtonElement;
		this._register(addDisposableListener(this.add, 'click', () => this.contextMenu.showContextMenu({
			getAnchor: () => this.add,
			getActions: () => studioSteamToolDefinitions.map(tool => toAction({
				id: tool.id, label: studioModeState.state.labels[tool.id] ?? tool.id,
				class: `codicon codicon-${tool.icon}`,
				checked: 'view' in tool ? studioSteamWorkspaceState.tabs.some(tab => tab.id === tool.id) : undefined,
				run: () => this.run('studio.internalOpenSteamTool', tool.id),
			})),
		})));
		this._register(studioSteamWorkspaceState.onDidChange(() => this.render()));
		this._register(studioModeState.onDidChangeState(() => this.render()));
		this.render();
	}

	private async run(command: string, id?: string, focusTab = false): Promise<void> {
		try { await this.commands.executeCommand(command, id); } catch (error) { this.notifications.error(error); }
		if (focusTab) {
			(this.list.querySelector<HTMLButtonElement>('.active .studio-steam-tab-select') ?? this.add).focus();
		}
	}

	private render(): void {
		const focused = this.list.contains(getWindow(this.list).document.activeElement)
			? (getWindow(this.list).document.activeElement as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab : undefined;
		this.tabListeners.clear(); clearNode(this.list);
		const { tabs, active } = studioSteamWorkspaceState;
		const labels = studioModeState.state.labels;
		this.list.setAttribute('aria-label', labels.workspace ?? 'Tool Workspace');
		this.add.title = labels.addTool ?? 'Open Tool'; this.add.setAttribute('aria-label', this.add.title);
		if (!tabs.length) { append(this.list, $('span.studio-steam-empty-tabs', undefined, labels.tools ?? 'Open Tools')); }
		for (const [index, tab] of tabs.entries()) {
			const item = append(this.list, $('.studio-steam-tab', { 'data-tab': tab.id, 'data-icon': tab.icon }));
			item.classList.toggle('active', tab.id === active); item.classList.toggle('dirty', !!tab.dirty);
			const button = append(item, $('button.studio-steam-tab-select', { type: 'button', role: 'tab', 'aria-selected': String(tab.id === active), title: tab.label })) as HTMLButtonElement;
			button.tabIndex = tab.id === (active ?? tabs[0]?.id) ? 0 : -1;
			append(button, $(`span.codicon.codicon-${tab.icon}`, { 'aria-hidden': 'true' }));
			append(button, $('span.studio-steam-tab-label', undefined, tab.label));
			const closeLabel = (labels.closeTab ?? 'Close {0}').replace('{0}', tab.label);
			const close = append(item, $('button.studio-steam-tab-close.codicon.codicon-close-compact', { type: 'button', 'aria-label': closeLabel, title: closeLabel })) as HTMLButtonElement;
			this.tabListeners.add(addDisposableListener(button, 'click', () => { void this.run('studio.internalSelectSteamTab', tab.id); }));
			this.tabListeners.add(addDisposableListener(close, 'click', () => { void this.run('studio.internalCloseSteamTab', tab.id); }));
			this.tabListeners.add(addDisposableListener(item, 'auxclick', event => {
				if (event.button === 1) { event.preventDefault(); void this.run('studio.internalCloseSteamTab', tab.id); }
			}));
			this.tabListeners.add(addDisposableListener(button, 'keydown', event => {
				let next: number | undefined;
				if (event.key === 'ArrowRight') { next = (index + 1) % tabs.length; }
				else if (event.key === 'ArrowLeft') { next = (index + tabs.length - 1) % tabs.length; }
				else if (event.key === 'Home') { next = 0; } else if (event.key === 'End') { next = tabs.length - 1; }
				else if (event.key === 'Delete') { event.preventDefault(); void this.run('studio.internalCloseSteamTab', tab.id, true); }
				if (next !== undefined) { event.preventDefault(); void this.run('studio.internalSelectSteamTab', tabs[next].id, true); }
			}));
			if (tab.id === focused) { button.focus(); }
		}
		this.list.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
}

/** Native tool launcher; opening a card reveals the existing retained project view. */
export class StudioSteamTools extends Disposable {
	readonly element: HTMLElement;
	private readonly buttons = this._register(new DisposableStore());

	constructor(parent: HTMLElement,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService
	) {
		super();
		this.element = append(parent, $('.studio-steam-tools'));
		this._register(studioModeState.onDidChangeState(() => this.render()));
		this.render();
	}

	private render(): void {
		this.buttons.clear();
		clearNode(this.element);
		const labels = studioModeState.state.labels;
		const content = append(this.element, $('.studio-steam-tools-content'));
		append(content, $('span.studio-steam-tools-emblem.codicon.codicon-tools', { 'aria-hidden': 'true' }));
		append(content, $('h2', undefined, labels.tools ?? 'Open Tools'));
		append(content, $('p', undefined, labels.toolsHint ?? ''));
		const grid = append(content, $('.studio-steam-tools-grid'));
		for (const { id, icon } of studioSteamToolDefinitions) {
			const button = append(grid, $('button.studio-steam-tool', { type: 'button', 'data-tool': id, title: labels[`${id}Hint`] ?? '' }));
			append(button, $(`span.codicon.codicon-${icon}`, { 'aria-hidden': 'true' }));
			append(button, $('span.studio-steam-tool-label', undefined, labels[id] ?? id));
			append(button, $('span.studio-steam-tool-hint', undefined, labels[`${id}Hint`] ?? ''));
			this.buttons.add(addDisposableListener(button, 'click', () => {
				void this.commands.executeCommand('studio.internalOpenSteamTool', id).catch(error => this.notifications.error(error));
			}));
		}
	}
}
