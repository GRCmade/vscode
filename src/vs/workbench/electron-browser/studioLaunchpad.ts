/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { CancellationTokenSource } from '../../base/common/cancellation.js';
import { Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { basenameOrAuthority } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { getNLSLanguage } from '../../nls.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IExtensionStorageService } from '../../platform/extensionManagement/common/extensionStorage.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../platform/files/common/files.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IStudioStartService } from '../browser/parts/editor/studioStart.js';
import { IOverlayWebview, IWebviewElement, IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWebviewViewService } from '../contrib/webviewView/browser/webviewViewService.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { LaunchpadAccount, LaunchpadInbox, LaunchpadProject, LaunchpadState, StudioLaunchpadView } from './studioLaunchpadView.js';
import './media/studioLaunchpad.css';

interface LaunchpadApp { title: string; html: string; port: number; accountUrl?: string }
interface ResidentApp { key: string; surface: HTMLElement; back: HTMLButtonElement; webview: IWebviewElement; ready: DeferredPromise<boolean>; dispose(): void }
type LaunchpadMenuAccount = Omit<LaunchpadAccount, 'signedIn'> & { status: string };
const launchpadSettingsViewType = 'studio.launchpadSettings';

export class StudioLaunchpad extends Disposable {
	private readonly view: StudioLaunchpadView;
	private readonly app = this._register(new MutableDisposable<ResidentApp>());
	private readonly settings = this._register(new MutableDisposable<{ webview: IOverlayWebview; dispose(): void }>());
	private requestId?: string;
	private windows: LaunchpadProject[] = [];
	private recent: LaunchpadProject[] = [];
	private readonly savedProjects = new Map<string, Pick<LaunchpadProject, 'name' | 'projectType' | 'avatarUrl' | 'lastOpened'>>();
	private readonly missing = new Set<string>();
	private readonly editsSinceSnapshot = new Map<number, boolean>();
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
		@IExtensionStorageService extensionStorage: IExtensionStorageService,
		@IWebviewViewService private readonly webviewViews: IWebviewViewService,
	) {
		super();
		// Read the extension's profile memento synchronously; native history still owns membership and ordering.
		const saved = extensionStorage.getExtensionState('studio.studio-workstation', true)?.['studio.recentProjects'];
		if (Array.isArray(saved)) {
			for (const row of saved.slice(0, 50)) {
				if (typeof row?.uri === 'string' && typeof row.label === 'string' && Number.isFinite(row.lastOpened)) {
					this.savedProjects.set(row.uri, { name: row.label, lastOpened: row.lastOpened,
						projectType: ['bot', 'workflow', 'kanban'].includes(row.projectType) ? row.projectType : undefined,
						avatarUrl: typeof row.avatarUrl === 'string' && row.avatarUrl.startsWith('data:image/svg+xml,') ? row.avatarUrl : undefined });
				}
			}
		}
		const run = (action: Promise<unknown>) => { void action.catch(error => notifications.error(error)); };
		this.view = new StudioLaunchpadView(this.language, {
			open: () => run(dialogs.pickFolderAndOpen({ forceNewWindow: true })),
			workspace: () => run(dialogs.pickWorkspaceAndOpen({ forceNewWindow: true })),
			create: () => run(commands.executeCommand('studio.createProject')),
			project: project => run(this.openProject(project)),
			remove: project => run(this.removeProject(project)),
			signIn: () => run(commands.executeCommand('studio.launchpadSignIn')),
			settings: () => run(commands.executeCommand('studio.openSettings', { section: 'account', target: 'user' })),
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
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadSettings', (_accessor, title: string) => this.showSettings(title)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadSettings', () => { if (this.settings.value) { this.showHome(); } }));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenLaunchpadInbox', () => run(this.openInbox())));
		this._register(CommandsRegistry.registerCommand('studio.internalPrepareLaunchpadApp', (_accessor, key: string, app: LaunchpadApp) => this.prepareApp(key, app)));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadApp', (_accessor, key: string, requestId: string, conversation?: string) => this.showApp(key, requestId, conversation)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadApp', (_accessor, key: string) => {
			const app = this.app.value;
			if (app?.key === key) { if (!app.surface.inert) { this.showHome(); } this.app.clear(); }
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
			this.account = state && { name: state.name, email: state.email, avatarUrl: state.avatarUrl, hasAccount: state.hasAccount,
				serverUrl: state.serverUrl, statusLabel: state.statusLabel, signedIn: state.status === 'authenticated' };
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
		const repaintStatus = this._register(new RunOnceScheduler(() => this.paint(), 80));
		this._register(native.onDidChangeWindowDirty(({ windowId, dirty }) => {
			this.editsSinceSnapshot.set(windowId, dirty);
			const project = this.windows.find(row => row.windowId === windowId);
			if (project && project.dirty !== dirty) {
				project.dirty = dirty;
				repaintStatus.schedule();
			}
		}));
		const refresh = this._register(new RunOnceScheduler(() => run(this.readProjects()), 100));
		const changed = () => { ++this.windowRevision; refresh.schedule(); };
		ipcRenderer.on('vscode:studioProjectWindowsChanged', changed);
		this._register(toDisposable(() => ipcRenderer.removeListener('vscode:studioProjectWindowsChanged', changed)));
		this._register(workspaces.onDidChangeRecentlyOpened(changed));
		this._register(addDisposableListener(mainWindow, 'focus', () => { changed(); this.refreshInbox.schedule(); }));
		this._register(addDisposableListener(document, 'visibilitychange', () => {
			start.setVisible('launchpad', !document.hidden && !this.view.element.hidden);
			const app = this.app.value;
			if (app && !app.surface.inert) { void app.webview.postMessage({ type: 'studio-launchpad-view', visible: !document.hidden }); }
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
		const fromSettings = !!this.settings.value;
		this.settings.clear();
		this.view.closePicker();
		this.requestId = undefined;
		const app = this.app.value;
		const fromApp = !!app && !app.surface.inert;
		if (fromApp) {
			app.surface.inert = app.back.hidden = true;
			void app.webview.postMessage({ type: 'studio-launchpad-view', visible: false });
		}
		this.view.element.hidden = false;
		this.view.setInboxBusy(false);
		this.start.setVisible('launchpad', !document.hidden);
		if (fromSettings) { this.view.focusAccount(); }
		else if (fromApp) { this.view.focusInbox(); }
		else { this.view.element.focus({ preventScroll: true }); }
		this.refreshInbox.schedule();
	}

	private createBackButton(title: string, lifetime: DisposableStore): HTMLButtonElement {
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'studio-launchpad-app-close';
		const arrow = document.createElement('span'); arrow.className = 'codicon codicon-chevron-left'; arrow.setAttribute('aria-hidden', 'true');
		close.append(arrow, this.language.startsWith('zh') ? '返回启动台' : 'Back to Launchpad');
		close.title = this.language.startsWith('zh') ? `关闭 ${title}` : `Close ${title}`;
		close.setAttribute('aria-label', close.title);
		lifetime.add(addDisposableListener(close, 'click', () => this.showHome()));
		return close;
	}

	/** Mount the extension's Settings view without opening an editor or evicting the resident IM. */
	private async showSettings(title: string): Promise<void> {
		if (this.settings.value) { this.settings.value.webview.focus(); return; }
		this.showHome();
		const lifetime = new DisposableStore();
		const source = new CancellationTokenSource();
		lifetime.add(toDisposable(() => source.dispose(true)));
		const surface = document.createElement('div');
		surface.className = 'studio-launchpad-settings';
		surface.setAttribute('role', 'document');
		surface.setAttribute('aria-label', title);
		surface.tabIndex = 0;
		const back = this.createBackButton(title, lifetime);
		if (this.view.element.classList.contains('lp-pointer')) {
			back.classList.add('lp-pointer');
			const reset = () => back.classList.remove('lp-pointer');
			lifetime.add(addDisposableListener(back, 'blur', reset));
			lifetime.add(addDisposableListener(back, 'keydown', reset));
		}
		const failed = () => {
			if (lifetime.isDisposed) { return; }
			this.showHome();
			const zh = this.language.startsWith('zh');
			void this.native.showMessageBox({ type: 'warning', message: zh ? '无法打开 Studio 设置' : 'Could not open Studio Settings',
				buttons: [zh ? '确定' : 'OK'], noLink: true });
		};
		try {
			const webview = lifetime.add(this.webviews.createWebviewOverlay({ providedViewType: launchpadSettingsViewType, title, options: {}, contentOptions: {}, extension: undefined }));
			this.settings.value = { webview, dispose: () => lifetime.dispose() };
			this.layout.mainContainer.append(back, surface);
			lifetime.add(toDisposable(() => { surface.remove(); back.remove(); }));
			const deadline = lifetime.add(new RunOnceScheduler(failed, 15_000));
			lifetime.add(webview.onMessage(({ message }) => { if (message?.type === 'ready') { deadline.cancel(); } }));
			lifetime.add(webview.onFatalError(failed));
			lifetime.add(addDisposableListener(surface, 'focus', () => webview.focus()));
			this.view.element.hidden = true;
			this.start.setVisible('launchpad', false);
			webview.claim(surface, mainWindow, undefined);
			webview.setAnchorElement(surface);
			back.focus({ preventScroll: true });
			deadline.schedule();
			await this.webviewViews.resolve(launchpadSettingsViewType, {
				title, webview, onDidChangeVisibility: Event.None, onDispose: webview.onDidDispose,
				dispose: () => { if (!lifetime.isDisposed) { this.showHome(); } },
				show: preserveFocus => { if (!preserveFocus && !lifetime.isDisposed) { webview.focus(); } },
			}, source.token);
		} catch {
			failed();
			lifetime.dispose();
		}
	}

	private async openInbox(conversation?: string): Promise<void> {
		if (this.requestId || this.settings.value) { return; }
		const id = this.requestId = generateUuid();
		this.view.closePicker();
		this.view.setInboxBusy(true);
		const zh = this.language.startsWith('zh');
		try {
			let reason: string | undefined;
			try {
				reason = await this.commands.executeCommand<string | undefined>('studio.openLaunchpadInbox', id, conversation);
			} catch { /* An unavailable extension or webview gets the same modal, never an editor fallback. */ }
			if (id === this.requestId && !this.view.element.hidden) {
				await this.native.showMessageBox({ type: 'warning', message: zh ? '无法打开 IM' : 'Could not open IM', detail: reason,
					buttons: [zh ? '确定' : 'OK'], noLink: true });
			}
		} finally {
			if (id === this.requestId && !this.view.element.hidden) { this.showHome(); this.view.focusInbox(); }
		}
	}

	/** A hidden, full-size surface can initialize without stealing focus or mounting the editor. */
	private async prepareApp(key: string, app: LaunchpadApp): Promise<boolean> {
		if (this.app.value?.key === key) { return this.app.value.ready.p; }
		if (this.app.value && !this.app.value.surface.inert) { this.showHome(); }
		this.app.clear();
		const lifetime = new DisposableStore();
		const ready = new DeferredPromise<boolean>();
		lifetime.add(toDisposable(() => { void ready.complete(false); }));
		const surface = document.createElement('div');
		surface.className = 'studio-launchpad-app';
		surface.inert = true;
		const close = this.createBackButton(app.title, lifetime);
		close.hidden = true;
		this.layout.mainContainer.append(surface, close);
		lifetime.add(toDisposable(() => { surface.remove(); close.remove(); }));
		try {
			const webview = lifetime.add(this.webviews.createWebviewElement({ title: app.title, options: {}, extension: undefined,
				contentOptions: { allowScripts: true, localResourceRoots: [], portMapping: [{ webviewPort: app.port, extensionHostPort: app.port }] } }));
			this.app.value = { key, surface, back: close, webview, ready, dispose: () => lifetime.dispose() };
			const deadline = lifetime.add(new RunOnceScheduler(() => { void ready.complete(false); }, 20_000));
			lifetime.add(webview.onMessage(({ message }) => {
				if (message?.type === 'studio-launchpad-ready') {
					deadline.cancel();
					void webview.postMessage({ type: 'studio-launchpad-view', visible: !surface.inert && !document.hidden });
					void ready.complete(true);
				}
				if (message?.type === 'studio-sidebar-account' && !surface.inert && app.accountUrl) {
					const uri = URI.parse(app.accountUrl);
					if (uri.scheme === 'https' || uri.scheme === 'http') { void this.opener.open(uri, { openExternal: true }); }
				}
			}));
			lifetime.add(webview.onFatalError(() => {
				if (!surface.inert) { this.showHome(); }
				this.app.clear();
				void this.commands.executeCommand('studio.internalReleaseHostedLaunchpadApp', key).catch(() => undefined);
			}));
			webview.mountTo(surface, mainWindow);
			webview.setHtml(app.html);
			deadline.schedule();
			return await ready.p;
		} finally {
			if (!ready.value) {
				if (this.app.value?.key === key) { this.app.clear(); } else { lifetime.dispose(); }
			}
		}
	}

	private async showApp(key: string, requestId: string, conversation?: string): Promise<boolean> {
		const app = this.app.value;
		if (!app || !app.ready.value || app.key !== key || this.requestId !== requestId) { return false; }
		if (!await app.webview.postMessage({ type: 'studio-launchpad-view', visible: true, conversation })) { return false; }
		if (this.app.value !== app || this.requestId !== requestId) {
			if (this.app.value === app && !this.requestId) { void app.webview.postMessage({ type: 'studio-launchpad-view', visible: false }); }
			return false;
		}
		app.surface.inert = app.back.hidden = false;
		this.view.element.hidden = true;
		this.start.setVisible('launchpad', false);
		app.webview.focus();
		return true;
	}

	private async openProject(project: LaunchpadProject): Promise<void> {
		const live = this.windows.find(row => row.uri === project.uri && row.windowId === project.windowId) ?? this.windows.find(row => row.uri === project.uri);
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
		// An edit/save can arrive after getWindows takes its snapshot but before history returns.
		this.editsSinceSnapshot.clear();
		const [windows, recent] = await Promise.all([this.native.getWindows({ includeAuxiliaryWindows: false }), this.workspaces.getRecentlyOpened()]);
		if (this.windowRevision !== revision) { return; }
		const project = (raw: URI, kind: LaunchpadProject['kind'], label?: string): LaunchpadProject => {
			const uri = URI.revive(raw);
			return { kind, uri: uri.toString(), name: label || basenameOrAuthority(uri), path: uri.scheme === 'file' ? uri.fsPath : uri.toString(true) };
		};
		this.windows = windows.flatMap(window => {
			const dirty = this.editsSinceSnapshot.get(window.id) ?? window.dirty;
			if (isSingleFolderWorkspaceIdentifier(window.workspace)) {
				return [{ ...project(window.workspace.uri, 'folder'), windowId: window.id, dirty }];
			}
			return isWorkspaceIdentifier(window.workspace) ? [{ ...project(window.workspace.configPath, 'workspace'), windowId: window.id, dirty }] : [];
		});
		this.recent = recent.workspaces.map(row => isRecentFolder(row) ? project(row.folderUri, 'folder', row.label) : project(row.workspace.configPath, 'workspace', row.label));
		const members = new Set([...this.recent, ...this.windows].map(row => row.uri));
		for (const uri of this.savedProjects.keys()) { if (!members.has(uri)) { this.savedProjects.delete(uri); } }
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
		const live = new Map<string, LaunchpadProject>();
		for (const window of this.windows) {
			if (!live.has(window.uri) || window.dirty) { live.set(window.uri, window); }
		}
		const enrich = (row: LaunchpadProject, window?: LaunchpadProject): LaunchpadProject => {
			const info = metadata.get(row.uri);
			const details = info ? { name: info.label || row.name, projectType: info.projectType, avatarUrl: info.avatarUrl, lastOpened: info.lastOpened } : this.savedProjects.get(row.uri);
			return { ...row, ...details, windowId: row.windowId ?? window?.windowId, dirty: window?.dirty, missing: !window && this.missing.has(row.uri) };
		};
		this.view.update({ windows: this.windows.map(row => enrich(row)), recent: this.recent.map(row => enrich(row, live.get(row.uri))), canCreate: !!state?.canCreate && !state.busy,
			platform: !!state?.platform, account: this.account, store: state?.recommendations, inbox: this.inbox });
	}
}
