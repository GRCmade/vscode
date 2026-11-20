/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { basenameOrAuthority } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { getNLSLanguage } from '../../nls.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IStudioStartService } from '../browser/parts/editor/studioStart.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { LaunchpadInbox, LaunchpadProject, StudioLaunchpadView } from './studioLaunchpadView.js';
import './media/studioLaunchpad.css';

export class StudioLaunchpad extends Disposable {
	private readonly view: StudioLaunchpadView;
	private readonly back: HTMLButtonElement;
	private readonly inertParts = new Set<HTMLElement>();
	private windows: LaunchpadProject[] = [];
	private recent: LaunchpadProject[] = [];
	private inbox?: LaunchpadInbox;
	private windowRevision = 0;
	private inboxRevision = 0;
	private readonly language = getNLSLanguage() ?? 'en';
	private readonly refreshInbox = this._register(new RunOnceScheduler(() => void this.readInbox(), 160));

	constructor(
		@IStudioStartService private readonly start: IStudioStartService,
		@INativeHostService private readonly native: INativeHostService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IFileDialogService dialogs: IFileDialogService,
		@INotificationService notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
	) {
		super();
		const run = (action: Promise<unknown>) => { void action.catch(error => notifications.error(error)); };
		this.view = new StudioLaunchpadView(this.language, {
			open: () => run(dialogs.pickFolderAndOpen({ forceNewWindow: true })),
			workspace: () => run(dialogs.pickWorkspaceAndOpen({ forceNewWindow: true })),
			create: () => run(commands.executeCommand('studio.createProject')),
			project: project => run(this.openProject(project)),
			inbox: () => { this.setHome(false); run(commands.executeCommand('studio.openLaunchpadInbox')); },
			store: id => run(commands.executeCommand('studio.openStartRecommendation', id)),
			resource: id => run(id === 'github' ? opener.open(URI.parse('https://github.com/steamharness/steamharness'), { openExternal: true }) : commands.executeCommand('studio.openLaunchpadResource', id)),
		});
		this.back = document.createElement('button');
		this.back.type = 'button';
		this.back.className = 'studio-launchpad-back';
		this.back.textContent = this.language.startsWith('zh') ? '‹ 返回启动台' : '‹ Back to Launchpad';
		this._register(addDisposableListener(this.back, 'click', () => this.setHome(true)));
		layout.mainContainer.append(this.view.element, this.back);
		const resize = () => {
			const top = layout.mainContainerOffset.top;
			this.view.element.style.top = `${top}px`;
			const statusBar = layout.getContainer(mainWindow, Parts.STATUSBAR_PART);
			this.view.element.style.bottom = `${statusBar?.offsetHeight ?? 0}px`;
			this.back.style.top = `${top + 6}px`;
		};
		resize();
		this._register(layout.onDidLayoutMainContainer(resize));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpad', () => this.setHome(true)));
		this._register(CommandsRegistry.registerCommand('studio.internalLaunchpadInboxChanged', (_accessor, reset?: boolean) => {
			++this.inboxRevision;
			if (reset) {
				this.inbox = undefined;
				this.paint();
			}
			this.refreshInbox.schedule();
		}));
		let platform = false;
		this._register(start.onDidChange(() => {
			if (platform !== !!start.state?.platform) {
				platform = !!start.state?.platform;
				this.refreshInbox.schedule();
			}
			this.paint();
		}));
		const refresh = this._register(new RunOnceScheduler(() => run(this.readProjects()), 100));
		const changed = () => { ++this.windowRevision; refresh.schedule(); };
		ipcRenderer.on('vscode:studioProjectWindowsChanged', changed);
		this._register(toDisposable(() => ipcRenderer.removeListener('vscode:studioProjectWindowsChanged', changed)));
		this._register(workspaces.onDidChangeRecentlyOpened(changed));
		this._register(addDisposableListener(mainWindow, 'focus', () => { changed(); this.refreshInbox.schedule(); }));
		this._register(addDisposableListener(document, 'visibilitychange', () => {
			start.setVisible('launchpad', !document.hidden && !this.view.element.hidden);
			if (!document.hidden) { changed(); this.refreshInbox.schedule(); }
		}));
		this._register(toDisposable(() => {
			++this.windowRevision; ++this.inboxRevision;
			this.start.setVisible('launchpad', false);
			this.releaseParts(); this.view.element.remove(); this.back.remove();
		}));
		this.setHome(true);
		this.paint();
		run(this.readProjects());
	}

	private releaseParts(): void {
		for (const part of this.inertParts) { part.inert = false; }
		this.inertParts.clear();
	}

	private setHome(home: boolean): void {
		this.view.element.hidden = !home;
		this.back.hidden = home;
		this.start.setVisible('launchpad', home && !document.hidden);
		this.releaseParts();
		if (home) {
			for (const part of this.layout.mainContainer.querySelectorAll<HTMLElement>('.part:not(.titlebar):not(.statusbar)')) {
				if (!part.inert) { part.inert = true; this.inertParts.add(part); }
			}
			this.view.element.focus({ preventScroll: true });
			this.refreshInbox.schedule();
		}
	}

	private async openProject(project: LaunchpadProject): Promise<void> {
		if (project.windowId !== undefined) {
			await this.native.focusWindow({ targetWindowId: project.windowId, mode: FocusMode.Force });
		} else {
			const uri = URI.parse(project.uri);
			await this.native.openWindow([project.kind === 'workspace' ? { workspaceUri: uri } : { folderUri: uri }], { forceNewWindow: true });
		}
	}

	private async readProjects(): Promise<void> {
		const revision = ++this.windowRevision;
		const [windows, recent] = await Promise.all([this.native.getWindows({ includeAuxiliaryWindows: false }), this.workspaces.getRecentlyOpened()]);
		if (this.windowRevision !== revision) { return; }
		const project = (raw: URI, kind: LaunchpadProject['kind'], label?: string): LaunchpadProject => {
			const uri = URI.revive(raw);
			return { kind, uri: uri.toString(), name: label || basenameOrAuthority(uri), path: uri.scheme === 'file' ? uri.fsPath : uri.toString(true) };
		};
		this.windows = windows.flatMap(window => {
			if (isSingleFolderWorkspaceIdentifier(window.workspace)) {
				return [{ ...project(window.workspace.uri, 'folder'), windowId: window.id }];
			}
			return isWorkspaceIdentifier(window.workspace) ? [{ ...project(window.workspace.configPath, 'workspace'), windowId: window.id }] : [];
		});
		this.recent = recent.workspaces.map(row => isRecentFolder(row) ? project(row.folderUri, 'folder', row.label) : project(row.workspace.configPath, 'workspace', row.label));
		this.paint();
	}

	private async readInbox(): Promise<void> {
		if (document.hidden || this.view.element.hidden || !this.start.state?.platform) { return; }
		const revision = ++this.inboxRevision;
		try {
			const inbox = await this.commands.executeCommand<LaunchpadInbox>('studio.getLaunchpadInbox');
			if (revision === this.inboxRevision) { this.inbox = inbox; this.paint(); }
		} catch {
			if (revision === this.inboxRevision) {
				this.inbox = { message: this.language.startsWith('zh') ? '暂时无法读取最近会话。' : 'Recent chats are unavailable.', items: [] };
				this.paint();
			}
		}
	}

	private paint(): void {
		const state = this.start.state;
		const metadata = new Map(state?.recent.map(row => [row.uri, row]));
		const live = new Map(this.windows.map(row => [row.uri, row.windowId]));
		const recent = this.recent.map(row => {
			const info = metadata.get(row.uri);
			return { ...row, name: info?.label || row.name, projectType: info?.projectType, avatarUrl: info?.avatarUrl,
				lastOpened: info?.lastOpened, windowId: live.get(row.uri) };
		});
		this.view.update({ windows: this.windows, recent, canCreate: !!state?.canCreate && !state.busy, platform: !!state?.platform, store: state?.recommendations, inbox: this.inbox });
	}
}
