/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { basenameOrAuthority } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
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
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { LaunchpadInbox, LaunchpadProject, StudioLaunchpadView } from './studioLaunchpadView.js';
import './media/studioLaunchpad.css';

interface LaunchpadApp { title: string; html: string; port: number; accountUrl?: string }

export class StudioLaunchpad extends Disposable {
	private readonly view: StudioLaunchpadView;
	private readonly app = this._register(new MutableDisposable<DisposableStore>());
	private requestId?: string;
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
		@IOpenerService private readonly opener: IOpenerService,
		@IWebviewService private readonly webviews: IWebviewService,
	) {
		super();
		const run = (action: Promise<unknown>) => { void action.catch(error => notifications.error(error)); };
		this.view = new StudioLaunchpadView(this.language, {
			open: () => run(dialogs.pickFolderAndOpen({ forceNewWindow: true })),
			workspace: () => run(dialogs.pickWorkspaceAndOpen({ forceNewWindow: true })),
			create: () => run(commands.executeCommand('studio.createProject')),
			project: project => run(this.openProject(project)),
			inbox: () => run(this.openInbox()),
			store: id => run(commands.executeCommand('studio.openStartRecommendation', id)),
			resource: id => run(id === 'github' ? opener.open(URI.parse('https://github.com/steamharness/steamharness'), { openExternal: true }) : commands.executeCommand('studio.openLaunchpadResource', id)),
		});
		layout.mainContainer.append(this.view.element);
		const resize = () => {
			const titlebar = layout.getContainer(mainWindow, Parts.TITLEBAR_PART);
			layout.mainContainer.style.setProperty('--studio-launchpad-title-height', `${titlebar?.offsetHeight ?? 0}px`);
		};
		resize();
		this._register(layout.onDidLayoutMainContainer(resize));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpad', () => this.showHome()));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenLaunchpadInbox', () => run(this.openInbox())));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadApp', (_accessor, id: string, app: LaunchpadApp) => this.showApp(id, app)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadApp', (_accessor, id: string) => {
			if (id === this.requestId) { this.showHome(); }
		}));
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
		// The resident window never becomes an editor, including while an app is opening or closing.
		const parts = Array.from(layout.mainContainer.querySelectorAll<HTMLElement>('.part:not(.titlebar)')).filter(part => !part.inert);
		for (const part of parts) { part.inert = true; }
		this._register(toDisposable(() => {
			++this.windowRevision; ++this.inboxRevision;
			this.requestId = undefined;
			this.start.setVisible('launchpad', false);
			for (const part of parts) { part.inert = false; }
			this.view.element.remove();
		}));
		this.showHome();
		this.paint();
		run(this.readProjects());
	}

	private showHome(): void {
		const fromApp = this.view.element.hidden;
		this.requestId = undefined;
		this.app.clear();
		this.view.element.hidden = false;
		this.view.setInboxBusy(false);
		this.start.setVisible('launchpad', !document.hidden);
		if (fromApp) { this.view.focusInbox(); } else { this.view.element.focus({ preventScroll: true }); }
		this.refreshInbox.schedule();
	}

	private async openInbox(): Promise<void> {
		if (this.requestId) { return; }
		const id = this.requestId = generateUuid();
		this.view.setInboxBusy(true);
		const zh = this.language.startsWith('zh');
		try {
			let reason: string | undefined;
			try {
				reason = await this.commands.executeCommand<string | undefined>('studio.openLaunchpadInbox', id);
			} catch { /* An unavailable extension or webview gets the same modal, never an editor fallback. */ }
			if (id === this.requestId) {
				await this.native.showMessageBox({ type: 'warning', message: zh ? '无法打开 IM' : 'Could not open IM', detail: reason,
					buttons: [zh ? '确定' : 'OK'], noLink: true });
			}
		} finally {
			if (id === this.requestId) { this.showHome(); this.view.focusInbox(); }
		}
	}

	/** The extension holds the hosted preview until this surface is dismissed. */
	private async showApp(id: string, app: LaunchpadApp): Promise<void> {
		if (!this.requestId || this.requestId !== id || this.app.value) { return; }
		const lifetime = this.app.value = new DisposableStore();
		const closed = new DeferredPromise<void>();
		lifetime.add(toDisposable(() => { void closed.complete(); }));
		const surface = document.createElement('div');
		surface.className = 'studio-launchpad-app';
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'studio-launchpad-app-close codicon codicon-close';
		close.title = this.language.startsWith('zh') ? `关闭 ${app.title}` : `Close ${app.title}`;
		close.setAttribute('aria-label', close.title);
		lifetime.add(addDisposableListener(close, 'click', () => this.showHome()));
		this.layout.mainContainer.append(surface, close);
		lifetime.add(toDisposable(() => { surface.remove(); close.remove(); }));
		try {
			const webview = lifetime.add(this.webviews.createWebviewElement({ title: app.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: app.port, extensionHostPort: app.port }] } }));
			lifetime.add(webview.onMessage(({ message }) => {
				if (message?.type === 'studio-sidebar-account' && app.accountUrl) {
					const uri = URI.parse(app.accountUrl);
					if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }); }
				}
			}));
			lifetime.add(webview.onFatalError(() => { void closed.error(new Error('Webview unavailable')); }));
			webview.mountTo(surface, mainWindow);
			webview.setHtml(app.html);
			this.view.element.hidden = true;
			this.start.setVisible('launchpad', false);
			webview.focus();
			await closed.p;
		} finally {
			if (this.app.value === lifetime) {
				this.app.clear();
				this.view.element.hidden = false;
				this.start.setVisible('launchpad', !document.hidden);
			}
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
