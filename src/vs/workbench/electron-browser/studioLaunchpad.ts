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
import { FileOperationResult, IFileService, toFileOperationResult } from '../../platform/files/common/files.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IStudioStartService } from '../browser/parts/editor/studioStart.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { LaunchpadInbox, LaunchpadProject, LaunchpadState, StudioLaunchpadView } from './studioLaunchpadView.js';
import './media/studioLaunchpad.css';

interface LaunchpadApp { title: string; html: string; port: number; accountUrl?: string }
interface LaunchpadMenuAccount { status: string; name: string; avatarUrl?: string }

export class StudioLaunchpad extends Disposable {
	private readonly view: StudioLaunchpadView;
	private readonly app = this._register(new MutableDisposable<DisposableStore>());
	private requestId?: string;
	private windows: LaunchpadProject[] = [];
	private recent: LaunchpadProject[] = [];
	private readonly missing = new Set<string>();
	private inbox?: LaunchpadInbox;
	private account?: LaunchpadState['account'];
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
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@INotificationService notifications: INotificationService,
		@IOpenerService private readonly opener: IOpenerService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IFileService private readonly files: IFileService,
	) {
		super();
		const run = (action: Promise<unknown>) => { void action.catch(error => notifications.error(error)); };
		this.view = new StudioLaunchpadView(this.language, {
			open: () => run(dialogs.pickFolderAndOpen({ forceNewWindow: true })),
			workspace: () => run(dialogs.pickWorkspaceAndOpen({ forceNewWindow: true })),
			create: () => run(commands.executeCommand('studio.createProject')),
			project: project => run(this.openProject(project)),
			remove: project => run(this.removeProject(project)),
			signIn: () => run(commands.executeCommand('studio.launchpadSignIn')),
			inbox: conversation => run(this.openInbox(conversation)),
			store: id => run(commands.executeCommand('studio.openStartRecommendation', id)),
			resource: id => run(id === 'github' ? opener.open(URI.parse('https://github.com/steamharness/steamharness'), { openExternal: true }) : commands.executeCommand('studio.openLaunchpadResource', id)),
		});
		layout.mainContainer.append(this.view.element);
		const resize = () => {
			const titlebar = layout.getContainer(mainWindow, Parts.TITLEBAR_PART);
			const root = layout.mainContainer;
			root.style.setProperty('--studio-launchpad-bar', `${titlebar?.offsetHeight || 44}px`);
			const width = (side: string) => titlebar?.querySelector<HTMLElement>(`.titlebar-${side} .window-controls-container`)?.getBoundingClientRect().width ?? 0;
			const right = width('right');
			const macInset = root.classList.contains('mac') && !root.classList.contains('fullscreen') && titlebar?.offsetHeight && !right ? 76 : 0;
			root.style.setProperty('--lp-controls-left', `${width('left') || macInset}px`);
			root.style.setProperty('--lp-controls-right', `${right}px`);
			this.view.element.querySelector('.lp-titlebar')?.classList.toggle('lp-tight', (root.clientWidth - Math.min(root.clientWidth * 0.39, 464)) / 2 - right < 280);
			root.classList.toggle('lp-no-native-bar', !titlebar?.offsetHeight);
		};
		resize();
		this._register(layout.onDidLayoutMainContainer(resize));
		this._register(addDisposableListener(mainWindow, 'keydown', event => this.view.shortcut(event), true));
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
		let platform = false, accountRevision = 0;
		const setAccount = (state?: LaunchpadMenuAccount) => {
			this.account = state && { name: state.name, avatarUrl: state.avatarUrl, signedIn: state.status === 'authenticated' };
		};
		this._register(commands.onDidExecuteCommand(({ commandId, args }) => {
			if (commandId === 'studio.internalUpdateAccountMenuState' && platform) {
				++accountRevision;
				setAccount(args[0] as LaunchpadMenuAccount);
				this.paint();
			}
		}));
		const updateStart = () => {
			if (platform !== !!start.state?.platform) {
				platform = !!start.state?.platform;
				const revision = ++accountRevision;
				setAccount();
				if (platform) {
					void commands.executeCommand<LaunchpadMenuAccount>('studio.internalGetAccountMenuState').then(state => {
						if (revision === accountRevision && !this._store.isDisposed) { setAccount(state); this.paint(); }
					}, () => undefined);
				}
				this.refreshInbox.schedule();
			}
			this.paint();
		};
		this._register(start.onDidChange(updateStart));
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
		updateStart();
		run(this.readProjects());
	}

	private showHome(): void {
		const fromApp = this.view.element.hidden;
		this.view.closePicker();
		this.requestId = undefined;
		this.app.clear();
		this.view.element.hidden = false;
		this.view.setInboxBusy(false);
		this.start.setVisible('launchpad', !document.hidden);
		if (fromApp) { this.view.focusInbox(); } else { this.view.element.focus({ preventScroll: true }); }
		this.refreshInbox.schedule();
	}

	private async openInbox(conversation?: string): Promise<void> {
		if (this.requestId) { return; }
		const id = this.requestId = generateUuid();
		this.view.closePicker();
		this.view.setInboxBusy(true);
		const zh = this.language.startsWith('zh');
		try {
			let reason: string | undefined;
			try {
				reason = await this.commands.executeCommand<string | undefined>('studio.openLaunchpadInbox', id, conversation);
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
		close.className = 'studio-launchpad-app-close';
		const arrow = document.createElement('span'); arrow.className = 'codicon codicon-chevron-left';
		close.append(arrow, this.language.startsWith('zh') ? '返回启动台' : 'Back to Launchpad');
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
		const live = this.windows.find(row => row.uri === project.uri);
		if (live?.windowId !== undefined) {
			await this.native.focusWindow({ targetWindowId: live.windowId, mode: FocusMode.Force }); return;
		}
		const uri = URI.parse(project.uri);
		if (uri.scheme === 'file') {
			let present: boolean;
			try { const stat = await this.files.stat(uri); present = project.kind === 'folder' ? stat.isDirectory : stat.isFile; }
			catch (error) { if (!(error instanceof Error) || toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; } present = false; }
			if (!present) { await this.locateProject(project); return; }
		}
		this.missing.delete(project.uri);
		await this.native.openWindow([project.kind === 'workspace' ? { workspaceUri: uri } : { folderUri: uri }], { forceNewWindow: true });
	}

	private async removeProject(project: LaunchpadProject): Promise<void> {
		const zh = this.language.startsWith('zh');
		const { response } = await this.native.showMessageBox({ type: 'question', message: zh ? `移除「${project.name}」的打开记录？` : `Remove “${project.name}” from open history?`,
			detail: zh ? '仅移除记录，不会删除本机文件。' : 'This removes only the history entry, not the files on disk.',
			buttons: zh ? ['移除记录', '取消'] : ['Remove record', 'Cancel'], cancelId: 1, defaultId: 1, noLink: true });
		if (response === 0) { await this.workspaces.removeRecentlyOpened([URI.parse(project.uri)]); }
	}

	private async locateProject(project: LaunchpadProject): Promise<void> {
		const zh = this.language.startsWith('zh');
		this.missing.add(project.uri); this.paint();
		const { response } = await this.native.showMessageBox({ type: 'warning', message: zh ? '找不到项目' : 'Project not found', detail: project.path,
			buttons: zh ? ['重新定位…', '移除打开记录…', '取消'] : ['Locate…', 'Remove record…', 'Cancel'], cancelId: 2, noLink: true });
		if (response === 1) { await this.removeProject(project); return; }
		if (response !== 0) { return; }
		const folder = project.kind === 'folder';
		const [uri] = await this.dialogs.showOpenDialog({ title: zh ? '重新定位项目' : 'Locate project', canSelectFolders: folder, canSelectFiles: !folder,
			canSelectMany: false, filters: folder ? undefined : [{ name: zh ? '工作区' : 'Workspace', extensions: ['code-workspace'] }] }) ?? [];
		if (!uri) { return; }
		await this.native.openWindow([folder ? { folderUri: uri } : { workspaceUri: uri }], { forceNewWindow: true });
		this.missing.delete(project.uri);
		if (uri.toString() !== project.uri) { await this.workspaces.removeRecentlyOpened([URI.parse(project.uri)]); }
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
		for (const uri of this.missing) { if (!this.recent.some(row => row.uri === uri)) { this.missing.delete(uri); } }
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
				this.inbox = { connection: 'offline', message: this.language.startsWith('zh') ? '暂时无法读取最近会话。' : 'Recent chats are unavailable.', items: [] };
				this.paint();
			}
		}
	}

	private paint(): void {
		const state = this.start.state;
		const metadata = new Map(state?.recent.map(row => [row.uri, row]));
		const live = new Map(this.windows.map(row => [row.uri, row.windowId]));
		const enrich = (row: LaunchpadProject): LaunchpadProject => {
			const info = metadata.get(row.uri);
			return { ...row, name: info?.label || row.name, projectType: info?.projectType, avatarUrl: info?.avatarUrl,
				lastOpened: info?.lastOpened, windowId: row.windowId ?? live.get(row.uri), missing: this.missing.has(row.uri) };
		};
		this.view.update({ windows: this.windows.map(enrich), recent: this.recent.map(enrich), canCreate: !!state?.canCreate && !state.busy,
			platform: !!state?.platform, account: this.account, store: state?.recommendations, inbox: this.inbox });
	}
}
