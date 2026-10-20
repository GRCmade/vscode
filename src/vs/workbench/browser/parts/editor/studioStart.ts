/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { studioProjectIcon } from '../../../common/studioProjectIcons.js';
import './media/studioStart.css';

/** Versioned, credential-free state supplied by the Studio extension host. */
export interface StudioStartState {
	version: 1;
	labels: Record<string, string>;
	templates: { id: string; projectType: string; kind: string; name: string; description: string }[];
	projects: { uri: string; name: string; version?: string; projectType: string; folderPath: string; avatarUrl?: string; update?: { status: string; serverVersion?: string; canDownload: boolean; busy?: boolean } }[];
	recent: { uri: string; label: string; kind: string; lastOpened: number; projectType?: string; version?: string; avatarUrl?: string }[];
	pending: { id: string; name: string; directory: string; status: string; error?: string }[];
	environment: { studio: string; vscode: string; node?: string; core?: string; cli?: string; account: string; server: string; error?: string };
	summary?: { projects: number; running: number; waiting: number; unavailable: number; generatedAt: number };
	error?: string;
	busy: boolean;
	installing?: string;
	canCreate: boolean;
}

export const IStudioStartService = createDecorator<IStudioStartService>('studioStartService');
export interface IStudioStartService {
	readonly _serviceBrand: undefined;
	readonly state: StudioStartState | undefined;
	readonly onDidChange: Event<void>;
	setVisible(id: string, visible: boolean): void;
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
			if (state?.version !== 1 || !state.labels || !Array.isArray(state.templates) || !Array.isArray(state.projects)
				|| !Array.isArray(state.recent) || !Array.isArray(state.pending) || !state.environment) {
				return;
			}
			this.state = state;
			this.change.fire();
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalGetStartVisibility', () => this.visible.size > 0));
	}

	setVisible(id: string, visible: boolean): void {
		const previous = this.visible.size > 0;
		if (visible) { this.visible.add(id); } else { this.visible.delete(id); }
		if (previous !== (this.visible.size > 0)) {
			void this.commands.executeCommand('studio.internalStartPageVisibility', this.visible.size > 0).catch(() => undefined);
		}
	}
}
registerSingleton(IStudioStartService, StudioStartService, InstantiationType.Delayed);

/** Shared native view for empty groups and the Start editor. */
export class StudioStartView extends Disposable {
	readonly element: HTMLElement;
	private readonly id = generateUuid();
	private readonly lists = new Map<string, { element: HTMLElement; key: string; disposables: DisposableStore }>();
	private readonly labels = new Map<string, HTMLElement>();
	private readonly stats = new Map<string, HTMLElement>();
	private readonly actions: { button: HTMLButtonElement; label: string; creation: boolean; iconOnly: boolean }[] = [];
	private readonly error: HTMLElement;
	private intersecting = false;
	private enabled = true;

	constructor(
		container: HTMLElement,
		@IStudioStartService private readonly service: IStudioStartService,
		@ICommandService private readonly commands: ICommandService
	) {
		super();
		this.element = append(container, $('main.studio-start.loading'));
		this.element.tabIndex = -1;
		this.element.setAttribute('aria-label', 'SteamHarness Studio');
		const inner = append(this.element, $('.studio-start-inner'));
		const header = append(inner, $('header.studio-start-header'));
		append(header, $('span.codicon.codicon-layout.studio-start-logo')).setAttribute('aria-hidden', 'true');
		append(header, $('h1', undefined, 'SteamHarness Studio'));
		append(header, $('span.codicon.codicon-loading.codicon-modifier-spin.studio-start-loading-indicator')).setAttribute('aria-hidden', 'true');
		const top = append(header, $('.studio-start-toolbar'));
		this.button(top, 'create', 'add', 'studio.createProject', undefined, true).classList.add('studio-start-primary');
		this.button(top, 'refresh', 'refresh', 'studio.refreshStart', undefined, false, true);
		this.createLoadingPlaceholder(inner);
		const grid = append(inner, $('.studio-start-grid'));
		this.section(grid, 'current');
		this.section(grid, 'recent');
		const system = this.section(grid, 'system');
		const details = append(system, $('dl.studio-start-stats'));
		for (const key of ['studio', 'vscode', 'node', 'core', 'cli', 'account', 'server', 'projects', 'running', 'waiting']) {
			this.labels.set(`stat.${key}`, append(details, $('dt')));
			this.stats.set(key, append(details, $('dd')));
		}
		this.button(system, 'analysis', 'graph', 'studio.openAnalysis');
		const quick = this.section(grid, 'quick');
		for (const [label, icon, command] of [
			['openFolder', 'folder-opened', 'studio.openFolder'], ['openWorkspace', 'file-submodule', 'studio.openWorkspace'],
			['download', 'cloud-download', 'studio.downloadProject'], ['versions', 'versions', 'studio.versions.focus'],
			['assistant', 'hubot', 'studio.openAssistant'], ['account', 'account', 'studio.openAccount'], ['settings', 'settings-gear', 'studio.openSettings'],
		]) { this.button(quick, label, icon, command); }
		this.error = append(inner, $('p.studio-start-error'));
		this.error.setAttribute('role', 'status');
		this.error.hidden = true;
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
		this.service.setVisible(this.id, this.enabled && this.intersecting && !this.element.ownerDocument.hidden);
	}

	setVisible(visible: boolean): void {
		this.enabled = visible;
		this.publishVisibility();
	}

	focus(): void { (this.element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? this.element).focus(); }

	private createLoadingPlaceholder(parent: HTMLElement): void {
		const loading = append(parent, $('.studio-start-loading', { role: 'progressbar', 'aria-label': 'SteamHarness Studio' }));
		const content = append(loading, $('div', { 'aria-hidden': 'true' }));
		append(content, $('.studio-start-skeleton.studio-start-skeleton-heading'));
		const projects = append(content, $('.studio-start-loading-projects'));
		for (let index = 0; index < 3; index++) {
			const card = append(projects, $('.studio-start-loading-card'));
			append(card, $('.studio-start-skeleton.studio-start-skeleton-heading'));
			append(card, $('.studio-start-skeleton.studio-start-skeleton-type'));
			append(card, $('.studio-start-skeleton.studio-start-skeleton-path'));
			append(card, $('.studio-start-skeleton.studio-start-skeleton-button'));
		}
		const grid = append(content, $('.studio-start-loading-grid'));
		for (const [key, count] of [['recent', 4], ['system', 10], ['quick', 5]] as const) {
			const section = append(grid, $(`div.studio-start-loading-${key}`));
			append(section, $('.studio-start-skeleton.studio-start-skeleton-heading'));
			for (let index = 0; index < count; index++) {
				const row = append(section, $('.studio-start-loading-row'));
				if (key !== 'recent') { append(row, $('.studio-start-skeleton.studio-start-skeleton-key')); }
				append(row, $('.studio-start-skeleton.studio-start-skeleton-value'));
			}
		}
	}

	private section(parent: HTMLElement, key: string): HTMLElement {
		const section = append(parent, $(`section.studio-start-${key}`));
		this.labels.set(key, append(section, $('h2')));
		if (['current', 'recent'].includes(key)) {
			this.lists.set(key, { element: append(section, $('.studio-start-list')), key: '', disposables: this._register(new DisposableStore()) });
		}
		return section;
	}

	private button(parent: HTMLElement, label: string, icon: string, command: string, arg?: object | string, creation = false, iconOnly = false, store?: DisposableStore): HTMLButtonElement {
		const button = append(parent, $('button.studio-start-action', { type: 'button' })) as HTMLButtonElement;
		button.classList.toggle('studio-start-action-icon', iconOnly);
		append(button, $(`span.codicon.codicon-${icon}`)).setAttribute('aria-hidden', 'true');
		if (!iconOnly) { append(button, $('span.studio-start-action-label')); }
		button.dataset.action = command;
		if (arg && typeof arg === 'object' && 'uri' in arg) { button.dataset.uri = String(arg.uri); }
		const disposable = addDisposableListener(button, 'click', event => {
			event.stopPropagation();
			void this.commands.executeCommand(command, arg).catch(() => undefined);
		});
		(store ?? this._store).add(disposable);
		if (!store) { this.actions.push({ button, label, creation, iconOnly }); }
		else { button.title = label; button.setAttribute('aria-label', label); if (!iconOnly) { button.lastElementChild!.textContent = label; } }
		return button;
	}

	private list(key: string, value: object, render: (root: HTMLElement, store: DisposableStore) => void): void {
		const list = this.lists.get(key)!;
		const signature = JSON.stringify(value);
		if (list.key === signature) { return; }
		list.key = signature;
		list.disposables.clear();
		clearNode(list.element);
		render(list.element, list.disposables);
	}

	private render(): void {
		const state = this.service.state;
		this.element.classList.toggle('loading', !state);
		this.element.setAttribute('aria-busy', String(!state));
		if (!state) {
			for (const action of this.actions) { action.button.disabled = true; }
			return;
		}
		const text = (key: string): string => state.labels[key] ?? key;
		for (const [key, element] of this.labels) { if (element.textContent !== text(key)) { element.textContent = text(key); } }
		for (const action of this.actions) {
			action.button.title = text(action.label);
			action.button.setAttribute('aria-label', text(action.label));
			if (!action.iconOnly && action.button.lastElementChild!.textContent !== text(action.label)) { action.button.lastElementChild!.textContent = text(action.label); }
			action.button.disabled = action.creation && (!state.canCreate || state.busy);
		}
		const listKey = { labels: state.labels, busy: state.busy, canCreate: state.canCreate };
		this.list('current', { projects: state.projects, pending: state.pending, installing: state.installing, ...listKey }, (root, store) => {
			if (!state.projects.length && !state.pending.length) { append(root, $('p.studio-start-muted', undefined, text('noCurrent'))); }
			for (const project of state.projects) {
				const card = append(root, $('article.studio-start-project-card'));
				const updateAvailable = project.update?.status === 'upgrade';
				card.classList.toggle('studio-start-project-update', updateAvailable);
				const heading = append(card, $('.studio-start-project-heading'));
				const avatar = this.button(heading, `${text('run')} \u00b7 ${project.name}`, studioProjectIcon(project.projectType) ?? 'folder', 'studio.openProject', { uri: project.uri }, false, true, store);
				avatar.classList.add('studio-start-project-avatar-button');
				if (project.avatarUrl?.startsWith('data:image/svg+xml,')) {
					avatar.firstElementChild?.replaceWith($('img.studio-start-project-avatar', { src: project.avatarUrl, alt: '' }));
				}
				append(heading, $('h3', undefined, project.name));
				append(card, $('p.studio-start-project-type', undefined, text(`type.${project.projectType}`)));
				const versions = append(card, $('.studio-start-project-versions'));
				append(versions, $('span', undefined, `${text('localVersion')} ${project.version ?? '\u2014'}`));
				if (project.update?.serverVersion && project.update.status !== 'unavailable') {
					append(versions, $('span.studio-start-project-server-version', undefined, `${text('serverVersion')} ${project.update.serverVersion}`));
				}
				if (updateAvailable) {
					const badge = append(card, $('.studio-start-project-version-state'));
					append(badge, $('span.codicon.codicon-arrow-circle-up')).setAttribute('aria-hidden', 'true');
					append(badge, $('span', undefined, text('updateAvailable')));
				} else if (project.update?.status === 'current' || project.update?.status === 'ahead') {
					append(card, $('p.studio-start-project-version-state', undefined, text(project.update.status === 'current' ? 'upToDate' : 'localNewer')));
				}
				append(card, $('p.studio-start-project-path', undefined, project.folderPath));
				const actions = append(card, $('.studio-start-project-actions'));
				if (updateAvailable) {
					const upgrade = this.button(actions, text('upgrade'), 'arrow-circle-up', 'studio.upgradeProject', { uri: project.uri }, false, false, store);
					upgrade.classList.add('studio-start-primary');
					upgrade.disabled = !project.update?.canDownload || !!project.update?.busy;
					if (!project.update?.canDownload) { upgrade.title = text('downloadUnavailable'); }
				}
				const run = this.button(actions, text('run'), 'play', 'studio.openProject', { uri: project.uri }, false, updateAvailable, store);
				if (!updateAvailable) { run.classList.add('studio-start-primary'); }
				this.button(actions, text('upload'), 'cloud-upload', 'studio.uploadProject', { uri: project.uri }, false, true, store);
				this.button(actions, text('source'), 'code', 'studio.openProjectSource', { uri: project.uri }, false, true, store);
			}
			for (const project of state.pending) {
				const row = append(root, $('.studio-start-pending'));
				append(row, $('span', undefined, project.name));
				append(row, $('small', undefined, text(state.installing === project.id ? 'installing' : project.status === 'cancelled' ? 'cancelled' : 'installFailed')));
				const retry = this.button(row, text('retry'), 'refresh', 'studio.retryProjectSetup', project.id, false, false, store);
				retry.disabled = state.busy;
				this.button(row, text('openSource'), 'folder-opened', 'studio.openCreatedProject', project.id, false, true, store);
			}
			if (state.pending.length) { this.button(root, text('installationLog'), 'output', 'studio.showProjectSetupLog', undefined, false, false, store); }
		});
		this.list('recent', { recent: state.recent, labels: state.labels }, (root, store) => {
			if (!state.recent.length) { append(root, $('p.studio-start-muted', undefined, text('noRecent'))); }
			for (const project of state.recent) {
				const row = append(root, $('.studio-start-project'));
				const label = [project.label, project.version].filter(Boolean).join(' \u00b7 ');
				const button = this.button(row, label, project.kind === 'workspace' ? 'file-submodule' : studioProjectIcon(project.projectType) ?? 'folder', 'studio.openRecentProject', project, false, false, store);
				if (project.avatarUrl?.startsWith('data:image/svg+xml,')) {
					button.firstElementChild?.replaceWith($('img.studio-start-recent-avatar', { src: project.avatarUrl, alt: '' }));
				}
				button.title = project.uri;
				this.button(row, text('removeRecent'), 'close', 'studio.removeRecentProject', project, false, true, store);
			}
		});
		const environment = state.environment;
		for (const [key, element] of this.stats) {
			const value = key === 'studio' ? environment.studio : key === 'vscode' ? environment.vscode
				: ['projects', 'running', 'waiting'].includes(key) ? state.summary && !state.summary.unavailable ? String(state.summary[key as 'projects']) : text('unavailable')
					: environment[key as 'node'] || text('unavailable');
			if (element.textContent !== value) { element.textContent = value; }
		}
		const error = [state.error, environment.error].filter(Boolean).join('\n');
		if (this.error.textContent !== error) { this.error.textContent = error; }
		this.error.hidden = !error;
	}

	override dispose(): void {
		this.service.setVisible(this.id, false);
		this.element.remove();
		super.dispose();
	}
}
