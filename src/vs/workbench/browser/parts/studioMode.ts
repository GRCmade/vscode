/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/studioMode.css';
import { $, addDisposableListener, append, clearNode } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';

export interface StudioModeState {
	available: boolean;
	labels: Record<string, string>;
}

const stateChange = new Emitter<StudioModeState>();
const modeChange = new Emitter<void>();
export const studioModeState = {
	state: { available: false, labels: {} } as StudioModeState,
	steam: false,
	busy: false,
	onDidChangeState: stateChange.event,
	onDidChangeMode: modeChange.event,
	setMode(steam: boolean, busy: boolean): void {
		this.steam = steam;
		this.busy = busy;
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
		append(ide, $('span.codicon.codicon-code', { 'aria-hidden': 'true' }));
		append(ide, $('span', undefined, 'IDE'));
		const steam = append(element, $('button.studio-mode-steam', { type: 'button' })) as HTMLButtonElement;
		append(steam, $('span.codicon.codicon-rocket', { 'aria-hidden': 'true' }));
		append(steam, $('span', undefined, 'Steam'));
		const tools = append(right, $('button.studio-steam-tools-action', { type: 'button' })) as HTMLButtonElement;
		append(tools, $('span.codicon.codicon-tools', { 'aria-hidden': 'true' }));
		const toolsLabel = append(tools, $('span'));
		const update = () => {
			const { state, steam: active, busy } = studioModeState;
			element.setAttribute('aria-label', state.labels.mode ?? 'Workspace Mode');
			ide.title = state.labels.switchToIde ?? 'Switch to IDE Mode';
			steam.title = state.labels[state.available ? 'switchToSteam' : 'unavailable'] ?? 'Steam Mode';
			ide.setAttribute('aria-pressed', String(!active));
			steam.setAttribute('aria-pressed', String(active));
			ide.disabled = busy;
			steam.disabled = busy || !state.available;
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
