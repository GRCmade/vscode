/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getNLSLanguage } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { projectDetails, type StudioProjectDetails } from '../../studioProjectDetails.js';
import { projectUsageBridge, projectUsageKey, StudioProjectUsage, type ProjectUsageBridge } from '../../studioProjectUsage.js';
import './media/studioStart.css';

interface StudioOverviewProject {
	uri: string;
	projectId?: string;
	distribution?: StudioProjectDetails['distribution'];
	defaultEntry: string;
	name: string;
	description?: string;
	version?: string;
	projectType: string;
	folderPath: string;
	avatarUrl?: string;
	entries: { entryId: string; name: string; projectType: string; avatarUrl?: string; available: boolean }[];
	update?: { status: string; serverVersion?: string; canDownload: boolean; busy?: boolean };
}

/** Versioned, credential-free state supplied by the Studio extension host. */
export interface StudioStartState {
	version: 1;
	platform?: boolean;
	labels: Record<string, string>;
	hasWorkspace: boolean;
	recommendations?: { title: string; openLabel: string; browseLabel: string; message?: string; items: { id: string; name: string; description?: string; projectType?: string; version?: string; avatarUrl?: string }[] };
	projects: StudioOverviewProject[];
	recent: { uri: string; label: string; kind: string; lastOpened: number; current?: boolean; projectId?: string; projectType?: string; version?: string; avatarUrl?: string;
		projectName?: string; description?: string;
		entries?: { entryId: string; name: string; type: string; primary: boolean }[];
		distribution?: 'source' | 'release' | 'download'; artwork?: { cover?: { name: string; mtime: number }; entries?: string[]; files?: string[] } }[];
	pending: { id: string; name: string; directory: string; status: string; stage?: string; error?: string }[];
	busy: boolean;
	installing?: string;
	canCreate: boolean;
}

export const IStudioStartService = createDecorator<IStudioStartService>('studioStartService');
export interface IStudioStartService {
	readonly _serviceBrand: undefined;
	readonly state: StudioStartState | undefined;
	readonly onDidChange: Event<void>;
	setVisible(id: string, visible: boolean): Promise<void> | void;
}

class StudioStartService extends Disposable implements IStudioStartService {
	declare readonly _serviceBrand: undefined;
	private readonly change = this._register(new Emitter<void>());
	readonly onDidChange = this.change.event;
	private readonly visible = new Set<string>();
	state: StudioStartState | undefined;

	constructor(@ICommandService private readonly commands: ICommandService) {
		super();
		this._register(CommandsRegistry.registerCommand('studio.internalUpdateStartState', (_accessor, state: StudioStartState) => {
			if (state?.version !== 1 || !state.labels || typeof state.hasWorkspace !== 'boolean' || !Array.isArray(state.projects)
				|| !Array.isArray(state.recent) || !Array.isArray(state.pending)) {
				return;
			}
			this.state = state;
			this.change.fire();
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalGetStartVisibility', () => this.visible.has('launchpad')));
	}

	setVisible(id: string, visible: boolean): Promise<void> | undefined {
		const wasVisible = this.visible.size > 0;
		const wasLaunchpadVisible = this.visible.has('launchpad');
		if (visible) { this.visible.add(id); } else { this.visible.delete(id); }
		const launchpadVisible = this.visible.has('launchpad');
		// The overview still activates the extension, but only the launchpad needs periodic refreshes.
		if (wasVisible !== (this.visible.size > 0) || wasLaunchpadVisible !== launchpadVisible) {
			return this.commands.executeCommand<void>('studio.internalStartPageVisibility', launchpadVisible).catch(() => undefined);
		}
		return undefined;
	}
}
registerSingleton(IStudioStartService, StudioStartService, InstantiationType.Delayed);

/** Project overview shared by empty editor groups and the Start editor. */
export class StudioStartView extends Disposable {
	readonly element: HTMLElement;
	private readonly id = generateUuid();
	private readonly content: HTMLElement;
	private readonly contentDisposables = this._register(new DisposableStore());
	private readonly zh = getNLSLanguage()?.toLowerCase().startsWith('zh');
	private readonly usageBridge: ProjectUsageBridge;
	private readonly usage = new Map<string, StudioProjectUsage>();
	private renderKey = '';
	private intersecting = false;
	private enabled = true;

	constructor(
		container: HTMLElement,
		@IStudioStartService private readonly service: IStudioStartService,
		@ICommandService private readonly commands: ICommandService,
		@IClipboardService clipboard: IClipboardService,
	) {
		super();
		this.usageBridge = projectUsageBridge(commands, clipboard);
		this.element = append(container, $('main.studio-start.loading'));
		this.element.tabIndex = -1;
		this.element.setAttribute('aria-label', 'SteamHarness');
		const inner = append(this.element, $('.studio-start-inner'));
		this.createLoadingPlaceholder(inner);
		this.content = append(inner, $('.studio-start-content'));
		const observer = new (getWindow(this.element).IntersectionObserver)(entries => {
			this.intersecting = entries.some(entry => entry.isIntersecting);
			this.publishVisibility();
		});
		observer.observe(this.element);
		this._register({ dispose: () => observer.disconnect() });
		this._register(addDisposableListener(this.element.ownerDocument, 'visibilitychange', () => this.publishVisibility()));
		this._register(service.onDidChange(() => this.render()));
		this.render();
	}

	private publishVisibility(): void {
		const visible = this.enabled && this.intersecting && !this.element.ownerDocument.hidden;
		this.service.setVisible(this.id, visible);
		for (const view of this.usage.values()) { view.setVisible(visible); }
	}

	private pruneUsage(keys: Set<string>): void {
		for (const [key, view] of this.usage) {
			if (!keys.has(key)) { view.dispose(); this.usage.delete(key); }
		}
	}

	setVisible(visible: boolean): void {
		this.enabled = visible;
		this.publishVisibility();
	}

	focus(): void { (this.element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? this.element).focus(); }

	private createLoadingPlaceholder(parent: HTMLElement): void {
		const loading = append(parent, $('.studio-start-loading', { role: 'progressbar', 'aria-label': 'SteamHarness' }));
		const skeleton = append(loading, $('div', { 'aria-hidden': 'true' }));
		append(skeleton, $('.studio-start-skeleton.studio-start-skeleton-label'));
		const heading = append(skeleton, $('.studio-start-skeleton-heading'));
		append(heading, $('.studio-start-skeleton.studio-start-skeleton-avatar'));
		const identity = append(heading, $('div'));
		append(identity, $('.studio-start-skeleton.studio-start-skeleton-name'));
		append(identity, $('.studio-start-skeleton.studio-start-skeleton-label'));
		append(skeleton, $('.studio-start-skeleton.studio-start-skeleton-path'));
		for (let index = 0; index < 3; index++) {
			const row = append(skeleton, $('.studio-start-skeleton-row'));
			append(row, $('.studio-start-skeleton'));
		}
	}

	private button(label: string, icon: string, command: string, arg: { uri: string; entryId?: string } | string, css = 'studio-start-action'): HTMLButtonElement {
		const button = $<HTMLButtonElement>('button', { type: 'button', class: css });
		append(button, $(`span.codicon.codicon-${icon}`, { 'aria-hidden': 'true' }));
		append(button, $('span.studio-start-action-label', undefined, label));
		button.dataset.action = command;
		if (typeof arg !== 'string') { button.dataset.uri = arg.uri; }
		this.contentDisposables.add(addDisposableListener(button, 'click', event => {
			event.stopPropagation();
			void this.commands.executeCommand(command, arg).catch(() => undefined);
		}));
		return button;
	}

	private render(): void {
		const state = this.service.state;
		this.element.classList.toggle('loading', !state);
		this.element.setAttribute('aria-busy', String(!state));
		if (!state) { this.pruneUsage(new Set()); return; }
		const { hasWorkspace, projects, pending, platform, installing, busy, labels } = state;
		const lastOpened = new Map(state.recent.map(row => [row.uri, row.lastOpened]));
		const details = projects.map(project => ({ ...project, lastOpened: lastOpened.get(project.uri) }));
		const key = JSON.stringify({ hasWorkspace, details, pending, platform, installing, busy: pending.length ? busy : undefined, labels });
		if (key === this.renderKey) { return; }
		this.renderKey = key;
		this.pruneUsage(new Set(details.map(projectUsageKey)));
		const active = this.element.ownerDocument.activeElement;
		const focusKey = this.content.contains(active) ? (active as HTMLElement | null)?.dataset.key : undefined;
		this.contentDisposables.clear();
		clearNode(this.content);
		const text = (key: string): string => labels[key] ?? key;
		this.element.setAttribute('aria-label', text('overview'));
		if (!projects.length) { append(this.content, $('h1.studio-start-heading', undefined, text('overview'))); }
		for (const project of pending) {
			const setup = append(this.content, $('.studio-start-setup'));
			const active = installing === project.id;
			const status = active ? project.stage === 'registration' ? 'registering' : project.stage === 'validation' ? 'validating' : 'installing'
				: project.status === 'cancelled' ? 'cancelled' : project.stage === 'registration' ? 'registrationFailed' : project.stage === 'validation' ? 'validationFailed' : 'installFailed';
			const statusLine = append(setup, $('p.studio-start-setup-status', { role: 'status' }));
			append(statusLine, $(active ? 'span.codicon.codicon-loading.codicon-modifier-spin' : 'span.codicon.codicon-warning', { 'aria-hidden': 'true' }));
			append(statusLine, $('span', undefined, `${project.name} · ${text(status)}`));
			if (project.error && !active) {
				const details = append(setup, $('details.studio-start-setup-error'));
				append(details, $('summary', undefined, text('details')));
				append(details, $('pre', undefined, project.error));
			}
			const actions = append(setup, $('.studio-start-project-actions'));
			if (!active) { append(actions, this.button(text('retry'), 'refresh', 'studio.retryProjectSetup', project.id)).disabled = busy; }
			append(actions, this.button(text('installationLog'), 'output', 'studio.showProjectSetupLog', project.id));
		}
		if (!projects.length && !pending.length) {
			const empty = append(this.content, $('.studio-start-empty'));
			append(empty, $('span.codicon.codicon-folder', { 'aria-hidden': 'true' }));
			append(empty, $('p', undefined, text(hasWorkspace ? 'noCurrent' : 'noWorkspace')));
			return;
		}
		const root = append(this.content, $('.studio-start-current'));
		for (const project of details) { this.renderProject(root, project, !!platform, text); }
		this.publishVisibility();
		if (focusKey) { Array.from(root.querySelectorAll<HTMLElement>('[data-key]')).find(node => node.dataset.key === focusKey)?.focus({ preventScroll: true }); }
	}

	private renderProject(root: HTMLElement, project: StudioOverviewProject & { lastOpened?: number }, platform: boolean, text: (key: string) => string): void {
		const t = (en: string, zh: string) => this.zh ? zh : en;
		const { uri, entries, defaultEntry, update, folderPath, distribution = 'source' } = project;
		const actions: HTMLButtonElement[] = [];
		const action = (label: string, icon: string, command: string, entryId?: string, css = 'lp-outline') => {
			const button = this.button(label, icon, command, entryId === undefined ? { uri } : { uri, entryId }, `studio-project-action ${css}`);
			button.dataset.key = `${command}:${uri}`;
			actions.push(button);
			return button;
		};
		const primary = entries.find(entry => entry.entryId === defaultEntry && entry.available);
		if (primary) { action(t('Run project', '运行项目'), 'play', 'studio.internalRunProjectEntry', primary.entryId, 'lp-primary'); }
		if (distribution === 'source') {
			const sourceEntry = primary ?? entries.find(entry => entry.available);
			if (sourceEntry) { action(text('source'), 'code', 'studio.openProjectSource', sourceEntry.entryId); }
			if (platform) { action(text('upload'), 'cloud-upload', 'studio.uploadProject'); }
		}
		if (update?.status === 'upgrade') {
			const upgrade = action(text('upgrade'), 'arrow-circle-up', 'studio.upgradeProject');
			upgrade.disabled = !update.canDownload || !!update.busy;
			if (!update.canDownload) { upgrade.title = text('downloadUnavailable'); }
		}
		const status = update?.status === 'upgrade' ? 'updateAvailable' : update?.status === 'current' ? 'upToDate' : update?.status === 'ahead' ? 'localNewer' : undefined;
		const extraFacts: [string, string | undefined][] = [[text('serverVersion'), update?.status !== 'unavailable' ? update?.serverVersion : undefined],
			[t('Update status', '更新状态'), status ? text(status) : undefined]];
		const key = projectUsageKey(project);
		let usage = this.usage.get(key);
		if (!usage) { usage = new StudioProjectUsage(project, t, this.usageBridge); this.usage.set(key, usage); }
		append(root, projectDetails({ ...project, kind: 'folder', path: folderPath, distribution,
			entries: entries.map(entry => ({ ...entry, type: entry.projectType, primary: entry.entryId === defaultEntry })),
		}, t, { actions, extraFacts, currentWindow: true, usage: usage.element,
			openEntry: entryId => { void this.commands.executeCommand('studio.internalRunProjectEntry', { uri, entryId }).catch(() => undefined); } }));
	}

	override dispose(): void {
		this.pruneUsage(new Set());
		this.service.setVisible(this.id, false);
		this.element.remove();
		super.dispose();
	}
}
