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

interface StudioOverviewProject {
	uri: string;
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
	recent: { uri: string; label: string; kind: string; lastOpened: number; current?: boolean; projectType?: string; version?: string; avatarUrl?: string }[];
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
			if (state?.version !== 1 || !state.labels || typeof state.hasWorkspace !== 'boolean' || !Array.isArray(state.projects)
				|| !Array.isArray(state.recent) || !Array.isArray(state.pending)) {
				return;
			}
			this.state = state;
			this.change.fire();
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalGetStartVisibility', () => this.visible.has('launchpad')));
	}

	setVisible(id: string, visible: boolean): void {
		const wasVisible = this.visible.size > 0;
		const wasLaunchpadVisible = this.visible.has('launchpad');
		if (visible) { this.visible.add(id); } else { this.visible.delete(id); }
		const launchpadVisible = this.visible.has('launchpad');
		// The overview still activates the extension, but only the launchpad needs periodic refreshes.
		if (wasVisible !== (this.visible.size > 0) || wasLaunchpadVisible !== launchpadVisible) {
			void this.commands.executeCommand('studio.internalStartPageVisibility', launchpadVisible).catch(() => undefined);
		}
	}
}
registerSingleton(IStudioStartService, StudioStartService, InstantiationType.Delayed);

/** Project overview shared by empty editor groups and the Start editor. */
export class StudioStartView extends Disposable {
	readonly element: HTMLElement;
	private readonly id = generateUuid();
	private readonly content: HTMLElement;
	private readonly contentDisposables = this._register(new DisposableStore());
	private renderKey = '';
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
		this.service.setVisible(this.id, this.enabled && this.intersecting && !this.element.ownerDocument.hidden);
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

	private button(parent: HTMLElement, label: string, icon: string, command: string, arg: { uri: string; entryId?: string } | string): HTMLButtonElement {
		const button = append(parent, $<HTMLButtonElement>('button.studio-start-action', { type: 'button' }));
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

	private avatar(parent: HTMLElement, size: 'project' | 'entry', projectType: string, avatarUrl: string | undefined): void {
		const icon = append(parent, $(`span.studio-start-avatar.studio-start-avatar-${size}`, { 'aria-hidden': 'true' }));
		if (avatarUrl?.startsWith('data:image/svg+xml,')) {
			append(icon, $('img', { alt: '', src: avatarUrl }));
		} else {
			append(icon, $(`span.codicon.codicon-${studioProjectIcon(projectType) ?? 'root-folder'}`));
		}
	}

	private render(): void {
		const state = this.service.state;
		this.element.classList.toggle('loading', !state);
		this.element.setAttribute('aria-busy', String(!state));
		if (!state) { return; }
		const { hasWorkspace, projects, pending, platform, installing, busy, labels } = state;
		const key = JSON.stringify({ hasWorkspace, projects, pending, platform, installing, busy: pending.length ? busy : undefined, labels });
		if (key === this.renderKey) { return; }
		this.renderKey = key;
		this.contentDisposables.clear();
		clearNode(this.content);
		const text = (key: string): string => labels[key] ?? key;
		this.element.setAttribute('aria-label', text('overview'));
		append(this.content, $('h1', undefined, text('overview')));
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
			if (!active) { this.button(actions, text('retry'), 'refresh', 'studio.retryProjectSetup', project.id).disabled = busy; }
			this.button(actions, text('installationLog'), 'output', 'studio.showProjectSetupLog', project.id);
		}
		if (!projects.length && !pending.length) {
			const empty = append(this.content, $('.studio-start-empty'));
			append(empty, $('span.codicon.codicon-folder', { 'aria-hidden': 'true' }));
			append(empty, $('p', undefined, text(hasWorkspace ? 'noCurrent' : 'noWorkspace')));
			return;
		}
		const root = append(this.content, $('.studio-start-current'));
		for (const project of projects) { this.renderProject(root, project, !!platform, text); }
	}

	private renderProject(root: HTMLElement, project: StudioOverviewProject, platform: boolean, text: (key: string) => string): void {
		const section = append(root, $('section.studio-start-project-card'));
		const header = append(section, $('header.studio-start-project-heading'));
		this.avatar(header, 'project', project.projectType, project.avatarUrl);
		const identity = append(header, $('.studio-start-project-identity'));
		append(identity, $('h2', undefined, project.name));
		const meta = append(identity, $('.studio-start-project-meta'));
		append(meta, $('span.studio-start-project-type', undefined, text(`type.${project.projectType}`)));
		if (project.version) { append(meta, $('span', undefined, `${text('localVersion')} ${project.version}`)); }
		if (project.update?.serverVersion && project.update.status !== 'unavailable') {
			append(meta, $('span', undefined, `${text('serverVersion')} ${project.update.serverVersion}`));
		}
		const updateAvailable = project.update?.status === 'upgrade';
		if (updateAvailable || project.update?.status === 'current' || project.update?.status === 'ahead') {
			append(meta, $('span', undefined, text(updateAvailable ? 'updateAvailable' : project.update?.status === 'current' ? 'upToDate' : 'localNewer')));
		}
		const actions = append(header, $('.studio-start-project-actions'));
		const sourceEntry = project.entries.find(entry => entry.available && entry.entryId === project.defaultEntry) ?? project.entries.find(entry => entry.available);
		if (sourceEntry) {
			this.button(actions, text('source'), 'code', 'studio.openProjectSource', { uri: project.uri, entryId: sourceEntry.entryId });
		}
		if (platform) { this.button(actions, text('upload'), 'cloud-upload', 'studio.uploadProject', { uri: project.uri }); }
		if (updateAvailable) {
			const upgrade = this.button(actions, text('upgrade'), 'arrow-circle-up', 'studio.upgradeProject', { uri: project.uri });
			upgrade.disabled = !project.update?.canDownload || !!project.update?.busy;
			if (!project.update?.canDownload) { upgrade.title = text('downloadUnavailable'); }
		}
		if (project.description?.trim()) { append(section, $('p.studio-start-project-description', undefined, project.description)); }
		const details = append(section, $('dl.studio-start-project-details'));
		append(details, $('dt', undefined, text('projectFolder')));
		append(append(details, $('dd')), $('code.studio-start-project-path', undefined, project.folderPath));
		append(section, $('h3.studio-start-entries-title', undefined, text('entries')));
		const entries = append(section, $('ul.studio-start-entries'));
		for (const entry of project.entries) {
			const row = append(entries, $('li.studio-start-entry', { 'data-entry-id': entry.entryId }));
			const primary = entry.entryId === project.defaultEntry;
			this.avatar(row, 'entry', entry.projectType, entry.avatarUrl);
			const description = append(row, $('.studio-start-entry-description'));
			const title = append(description, $('.studio-start-entry-title'));
			append(title, $('span.studio-start-entry-name', undefined, entry.name));
			if (primary) { append(title, $('span.studio-start-entry-default', undefined, text('defaultEntry'))); }
			const entryMeta = append(description, $('.studio-start-entry-meta'));
			append(entryMeta, $('span', undefined, text(`type.${entry.projectType}`)));
			append(entryMeta, $('code', undefined, entry.entryId));
			if (entry.available) {
				const open = this.button(row, text('openEntry'), 'play', 'studio.openProject', { uri: project.uri, entryId: entry.entryId });
				open.setAttribute('aria-label', `${text('openEntry')}: ${entry.name}`);
				open.classList.toggle('studio-start-primary', primary);
			} else {
				append(row, $('span.studio-start-entry-unavailable', undefined, text('unavailable')));
			}
		}
	}

	override dispose(): void {
		this.service.setVisible(this.id, false);
		this.element.remove();
		super.dispose();
	}
}
