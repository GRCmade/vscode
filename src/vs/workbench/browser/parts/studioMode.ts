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
		@INotificationService private readonly notifications: INotificationService
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
		};
		for (const [button, command] of [[ide, 'studio.internalEnterIdeMode'], [steam, 'studio.internalEnterSteamMode'], [tools, 'studio.internalOpenSteamTools']] as const) {
			this._register(addDisposableListener(button, 'click', () => {
				void this.commands.executeCommand(command).catch(error => this.notifications.error(error));
			}));
		}
		this._register(studioModeState.onDidChangeState(update));
		this._register(studioModeState.onDidChangeMode(update));
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
		for (const [id, icon] of [['kv', 'database'], ['knowledge', 'book'], ['info', 'package'], ['assistant', 'hubot'], ['versions', 'versions'], ['trace', 'history']] as const) {
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
