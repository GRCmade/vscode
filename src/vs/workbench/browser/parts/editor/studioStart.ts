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

const STEAMHARNESS_ICON_DATA_URI = 'data:image/png;base64,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';

/** Versioned, credential-free state supplied by the Studio extension host. */
export interface StudioStartState {
	version: 1;
	labels: Record<string, string>;
	badge?: string;
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
	private readonly badge: HTMLElement;
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
		const logo = append(header, $('img.studio-start-logo', { alt: '', 'aria-hidden': 'true' })) as HTMLImageElement;
		logo.src = STEAMHARNESS_ICON_DATA_URI;
		append(header, $('h1', undefined, 'SteamHarness Studio'));
		append(header, $('span.codicon.codicon-loading.codicon-modifier-spin.studio-start-loading-indicator')).setAttribute('aria-hidden', 'true');
		const top = append(header, $('.studio-start-toolbar'));
		this.badge = append(top, $('span.studio-start-badge'));
		this.badge.hidden = true;
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
		const badge = state.badge?.trim();
		this.badge.textContent = badge ?? '';
		this.badge.hidden = !badge;
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
