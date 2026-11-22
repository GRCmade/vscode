/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../base/browser/dnd.js';
import { addDisposableListener, DragAndDropObserver } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { encodeBase64 } from '../../base/common/buffer.js';
import { CancellationTokenSource } from '../../base/common/cancellation.js';
import { Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { basenameOrAuthority } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { ipcRenderer, webUtils } from '../../base/parts/sandbox/electron-browser/globals.js';
import { getNLSLanguage } from '../../nls.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { containsDragType } from '../../platform/dnd/browser/dnd.js';
import { IExtensionStorageService } from '../../platform/extensionManagement/common/extensionStorage.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../platform/files/common/files.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IStudioStartService } from '../browser/parts/editor/studioStart.js';
import { IOverlayWebview, IWebviewService } from '../contrib/webview/browser/webview.js';
import { IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import type { StudioNotificationInbox } from './studioNotificationInbox.js';
import { IWebviewViewService } from '../contrib/webviewView/browser/webviewViewService.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { removeStudioLaunchpadSplash } from './studioLaunchpadSplash.js';
import { LaunchpadAccount, LaunchpadInbox, LaunchpadProject, LaunchpadState, StudioLaunchpadView } from './studioLaunchpadView.js';
import { LaunchpadApp, LaunchpadAppView, StudioChatWindow } from './studioChatWindow.js';
import { InboxAction, LaunchpadDirectory, SocialResult } from './studioLaunchpadProfile.js';
import { CatalogPage } from './studioLaunchpadStore.js';
import { StoreListingDetails } from './studioLaunchpadCards.js';
import type { LibraryProjectCategory } from './studioLaunchpadLibrary.js';
import './media/studioLaunchpad.css';

type LibraryMetadata = Pick<LaunchpadProject, 'projectId' | 'projectType' | 'avatarUrl' | 'distribution' | 'artwork' | 'version' | 'entries' | 'description'> & { projectName?: string };
type LaunchpadMenuAccount = Omit<LaunchpadAccount, 'signedIn'> & { status: string };
const launchpadSettingsViewType = 'studio.launchpadSettings';

export class StudioLaunchpad extends Disposable {
	private readonly view: StudioLaunchpadView;
	private readonly chat: StudioChatWindow;
	private readonly covers = new Map<string, Promise<string | undefined>>();
	private readonly settings = this._register(new MutableDisposable<{ webview: IOverlayWebview; dispose(): void }>());
	private readonly appRequests = new Map<string, string>();
	private windows: LaunchpadProject[] = [];
	private recent: LaunchpadProject[] = [];
	private readonly savedProjects = new Map<string, LibraryMetadata & { name?: string; lastOpened?: number }>();
	private readonly missing = new Set<string>();
	private readonly editsSinceSnapshot = new Map<number, boolean>();
	private inbox?: LaunchpadInbox;
	private libraryCategory?: LibraryProjectCategory;
	private account?: LaunchpadState['account'];
	private windowRevision = 0;
	private libraryCategoryRevision = 0;
	private inboxRevision = 0;
	private noticeRevision = 0;
	private socialUnread = false;
	private readonly refreshNotices = this._register(new RunOnceScheduler(() => void this.readNotices(), 250));
	private readonly language = getNLSLanguage() ?? 'en';
	private readonly refreshInbox = this._register(new RunOnceScheduler(() => void this.readInbox(), 160));
	private readonly refreshLibraryCategory = this._register(new RunOnceScheduler(() => void this.readLibraryCategory(), 100));

	constructor(
		private readonly notices: StudioNotificationInbox,
		@IStudioStartService private readonly start: IStudioStartService,
		@INativeHostService private readonly native: INativeHostService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@INotificationService notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IFileService private readonly files: IFileService,
		@IExtensionStorageService extensionStorage: IExtensionStorageService,
		@IWebviewViewService private readonly webviewViews: IWebviewViewService,
		@IAuxiliaryWindowService auxiliaryWindows: IAuxiliaryWindowService,
		@IContextMenuService contextMenu: IContextMenuService,
		@IClipboardService clipboard: IClipboardService,
	) {
		super();
		this.chat = this._register(new StudioChatWindow(auxiliaryWindows, webviews, opener,
			(conversation, user) => this.openInbox(conversation, user).catch(error => { notifications.error(error); return false; })));
		// Read the extension's profile memento synchronously; native history still owns membership and ordering.
		const saved = extensionStorage.getExtensionState('studio.studio-workstation', true)?.['studio.recentProjects'];
		if (Array.isArray(saved)) {
			for (const row of saved.slice(0, 50)) {
				if (typeof row?.uri === 'string' && typeof row.label === 'string' && Number.isFinite(row.lastOpened)) {
					this.savedProjects.set(row.uri, { name: row.label, lastOpened: row.lastOpened,
						artwork: row.artwork, distribution: row.distribution, projectId: row.projectId, version: row.version, entries: row.entries,
						description: row.description, projectName: row.projectName,
						projectType: ['bot', 'workflow', 'kanban'].includes(row.projectType) ? row.projectType : undefined,
						avatarUrl: typeof row.avatarUrl === 'string' && row.avatarUrl.startsWith('data:image/svg+xml,') ? row.avatarUrl : undefined });
				}
			}
		}
		const run = (action: Promise<unknown>) => { void action.catch(error => notifications.error(error)); };
		this.view = this._register(new StudioLaunchpadView(this.language, {
			open: () => run(dialogs.pickFolderAndOpen({ forceNewWindow: true })),
			workspace: () => run(dialogs.pickWorkspaceAndOpen({ forceNewWindow: true })),
			create: () => run(commands.executeCommand('studio.createProject')),
			importProjects: () => run(this.pickProjectsToImport()),
			project: (project, entryId) => run(this.openProject(project, entryId)),
			remove: project => run(this.removeProject(project)),
			reveal: project => run(native.showItemInFolder(URI.parse(project.uri).fsPath)),
			copyPath: project => run(clipboard.writeText(project.path)), contextMenu,
			signIn: () => run(commands.executeCommand('studio.launchpadSignIn')),
			settings: () => run(commands.executeCommand('studio.openSettings', { section: 'account', target: 'user' })),
			inbox: (conversation, title) => run(this.openInbox(conversation, undefined, undefined, title)),
			cover: project => this.cover(project),
			detailActions: async project => this.start.state?.platform && !project.missing && project.uri.startsWith('file:') ? await commands.executeCommand<{ id: string; label: string }[]>('studio.listLibraryProjectActions', project) ?? [] : [],
			runDetailAction: async (project, id) => {
				if (!this.start.state?.platform) { return; }
				try {
					const result = await commands.executeCommand<{ chatUser?: string }>('studio.runLibraryProjectAction', project.uri, id);
					if (result?.chatUser) { await this.openInbox(undefined, result.chatUser, undefined, project.name); }
				} catch (error) { notifications.error(error); }
			},
			catalog: async (request, platform) => { const page = await commands.executeCommand<CatalogPage>(platform ? 'studio.getStoreCatalog' : 'studio.getLocalCatalog', request); if (!page) { throw new Error('Catalog unavailable'); } return page; },
			listingDetails: async id => { const item = await commands.executeCommand<StoreListingDetails>('studio.getStoreListingDetails', id); if (!item) { throw new Error('Project details unavailable'); } return item; },
			storeImage: async src => src.startsWith('http:') ? commands.executeCommand<string | undefined>('studio.readLocalStoreImage', src) : src,
			getListing: (id, platform) => run(commands.executeCommand(platform ? 'studio.getStoreListing' : 'studio.createExample', id)),
			social: async (query, includeDirectory) => {
				const [result, directory] = await Promise.all([
					commands.executeCommand<SocialResult>('studio.getSocialSnapshot', query),
					includeDirectory ? commands.executeCommand<LaunchpadDirectory>('studio.getLaunchpadDirectory').catch(() => undefined) : undefined,
				]);
				if (!result) { throw new Error('Social data unavailable'); }
				if ('unavailable' in result) { return directory ? { people: [], favorites: [], notices: [], directory } : result; }
				return { ...result, directory, directoryUnavailable: includeDirectory && !directory };
			},
			change: async action => { await commands.executeCommand('studio.changeSocial', action); this.refreshNotices.schedule(); },
			changeConversation: async action => {
				await commands.executeCommand('studio.changeLaunchpadConversation', action);
				this.refreshInbox.schedule(); this.view.refreshDirectory();
			},
			confirmRemoveFriend: async name => {
				const zh = this.language.startsWith('zh');
				const { response } = await native.showMessageBox({ type: 'question', message: zh ? `从好友中移除「${name}」？` : `Remove “${name}” from your friends?`,
					buttons: zh ? ['移除好友', '取消'] : ['Remove friend', 'Cancel'], cancelId: 1, defaultId: 1, noLink: true });
				return response === 0;
			},
			chatUser: (user, title) => run(this.openInbox(undefined, user, undefined, title)),
			addContact: () => run(this.openInbox(undefined, undefined, 'add-contact')),
			createGroup: () => run(this.openInbox(undefined, undefined, 'create-group')),
			readNotice: id => this.notices.read(id),
			readAllNotices: async () => {
				this.notices.readAll();
				if (this.start.state?.platform && this.account?.signedIn) {
					++this.noticeRevision;
					try { await commands.executeCommand('studio.markAllNoticesRead'); }
					finally { this.refreshNotices.schedule(); }
				}
			},
			resource: id => run(id === 'github' ? opener.open(URI.parse('https://github.com/steamharness/steamharness'), { openExternal: true }) : commands.executeCommand('studio.openLaunchpadResource', id)),
		}));
		const repaintNotices = this._register(new RunOnceScheduler(() => this.paint(), 100));
		this._register(notices.onDidChange(() => repaintNotices.schedule()));
		layout.mainContainer.append(this.view.element);
		const clearProjectDrop = () => this.view.setProjectDropActive(false);
		this._register(new DragAndDropObserver(this.view.element, {
			onDragOver: event => {
				const data = event.dataTransfer;
				if (!this.view.canDropProject || !data || !containsDragType(event, DataTransfers.FILES)) { return; }
				data.dropEffect = 'copy';
				this.view.setProjectDropActive(true);
			},
			onDragLeave: clearProjectDrop,
			onDragEnd: clearProjectDrop,
			onDrop: event => {
				clearProjectDrop();
				const data = event.dataTransfer;
				if (!this.view.canDropProject || !data || !containsDragType(event, DataTransfers.FILES)) { return; }
				event.preventDefault();
				event.stopPropagation();
				const paths = new Set(Array.from(data.files, file => webUtils.getPathForFile(file)).filter(Boolean));
				if (paths.size) { run(this.importFolders(Array.from(paths, path => URI.file(path)))); }
			},
		}));
		const resize = () => {
			const titlebar = layout.getContainer(mainWindow, Parts.TITLEBAR_PART);
			const root = layout.mainContainer;
			root.style.setProperty('--studio-launchpad-bar', `${titlebar?.offsetHeight || 44}px`);
			const width = (side: string) => titlebar?.querySelector<HTMLElement>(`.titlebar-${side} .window-controls-container`)?.getBoundingClientRect().width ?? 0;
			const right = width('right');
			const macInset = root.classList.contains('mac') && !root.classList.contains('fullscreen') && titlebar?.offsetHeight && !right ? 76 : 0;
			root.style.setProperty('--lp-controls-left', `${width('left') || macInset}px`);
			root.style.setProperty('--lp-controls-right', `${right}px`);
			root.classList.toggle('lp-no-native-bar', !titlebar?.offsetHeight);
		};
		resize();
		this._register(layout.onDidLayoutMainContainer(resize));
		this._register(addDisposableListener(mainWindow, 'keydown', event => this.view.shortcut(event), true));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpad', () => this.showHome()));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadSettings', (_accessor, title: string) => this.showSettings(title)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadSettings', () => { if (this.settings.value) { this.showHome(); } }));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenLaunchpadInbox', () => { this.showHome(); this.view.showSocial('activity'); }));
		this._register(CommandsRegistry.registerCommand('studio.internalPrepareLaunchpadApp', (_accessor, key: string, app: LaunchpadApp) => this.chat.prepare(key, app)));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadApp', (_accessor, key: string, requestId: string, view: LaunchpadAppView) => Array.from(this.appRequests.values()).includes(requestId) && this.chat.show(key, view)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadApp', (_accessor, key: string) => this.chat.clear(key)));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenStoreTab', () => { this.showHome(); this.view.select('store'); }));
		this._register(CommandsRegistry.registerCommand('studio.internalStudioSocialChanged', () => this.refreshSocialState()));
		this._register(CommandsRegistry.registerCommand('studio.internalLibraryProjectCategoryChanged', () => this.scheduleLibraryCategory()));
		this._register(CommandsRegistry.registerCommand('studio.internalLaunchpadInboxChanged', (_accessor, reset?: boolean) => {
			++this.inboxRevision;
			if (reset && !this.account?.hasAccount) {
				this.inbox = undefined;
				this.paint();
			}
			this.refreshInbox.schedule();
			this.view.refreshDirectory();
		}));
		let platform = false, accountRevision = 0;
		const setAccount = (state?: LaunchpadMenuAccount) => {
			const scopeChanged = state?.scopeKey !== this.account?.scopeKey || state?.status !== 'authenticated' || !this.account?.signedIn;
			if (scopeChanged) {
				this.appRequests.clear(); this.view.setInboxActionBusy('add-contact', false); this.view.setInboxActionBusy('create-group', false);
				++this.noticeRevision; this.socialUnread = false; this.refreshNotices.schedule();
				++this.inboxRevision; this.inbox = undefined; this.refreshInbox.schedule();
				this.libraryCategory = undefined;
			}
			this.account = state && { name: state.name, email: state.email, avatarUrl: state.avatarUrl, hasAccount: state.hasAccount,
				scopeKey: state.scopeKey, storeScopeKey: state.storeScopeKey, statusLabel: state.statusLabel, signedIn: state.status === 'authenticated' };
			if (scopeChanged) { this.scheduleLibraryCategory(); }
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
		this._register(addDisposableListener(mainWindow, 'focus', () => { changed(); this.refreshInbox.schedule(); this.refreshSocialState(); }));
		const poll = mainWindow.setInterval(() => this.refreshSocialState(), 60_000);
		this._register(toDisposable(() => { ++this.noticeRevision; mainWindow.clearInterval(poll); }));
		this._register(addDisposableListener(document, 'visibilitychange', () => {
			if (document.hidden) { clearProjectDrop(); }
			start.setVisible('launchpad', !document.hidden && !this.view.element.hidden);
			if (!document.hidden) { changed(); this.refreshInbox.schedule(); this.refreshSocialState(); }
		}));
		// The resident window never becomes an editor, including while an app is opening or closing.
		const parts = Array.from(layout.mainContainer.querySelectorAll<HTMLElement>('.part:not(.titlebar)')).filter(part => !part.inert);
		for (const part of parts) { part.inert = true; }
		this._register(toDisposable(() => {
			++this.windowRevision; ++this.inboxRevision; ++this.libraryCategoryRevision;
			this.appRequests.clear();
			this.start.setVisible('launchpad', false);
			for (const part of parts) { part.inert = false; }
			this.view.element.remove();
		}));
		this.showHome();
		updateStart();
		removeStudioLaunchpadSplash(mainWindow.document);
		run(this.readProjects());
	}

	private showHome(): void {
		const fromSettings = !!this.settings.value;
		this.settings.clear();
		this.view.closePicker();
		this.view.setVisible(true);
		this.start.setVisible('launchpad', !document.hidden);
		if (fromSettings) { this.view.focusSettings(); }
		else { this.view.element.focus({ preventScroll: true }); }
		this.refreshInbox.schedule();
		this.refreshSocialState();
	}

	private refreshSocialState(): void {
		if (!this.account?.signedIn || document.hidden || this.view.element.hidden) { return; }
		this.refreshNotices.schedule();
		this.view.refreshSocial();
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
			this.view.setVisible(false);
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

	private async openInbox(conversation?: string, user?: string, action?: InboxAction, title?: string): Promise<boolean> {
		const target = conversation ? `conversation:${conversation}` : user ? `user:${user}` : action;
		if (!target || this.appRequests.has(target)) { return false; }
		const id = generateUuid();
		this.appRequests.set(target, id);
		this.view.closePicker();
		const zh = this.language.startsWith('zh');
		if (action) {
			this.view.setInboxActionBusy(action, true);
			title = action === 'add-contact' ? (zh ? '添加好友' : 'Add friend') : (zh ? '发起群聊' : 'Start a group chat');
		}
		try {
			let reason: string | undefined; let opened = false;
			try {
				const result = await this.commands.executeCommand<string | true>('studio.openLaunchpadInbox', id, conversation, user, action, title);
				opened = result === true; reason = typeof result === 'string' ? result : undefined;
			} catch { /* An unavailable extension or webview gets the same modal, never an editor fallback. */ }
			if (!opened && id === this.appRequests.get(target)) {
				await this.native.showMessageBox({ type: 'warning', message: zh ? '无法打开 IM' : 'Could not open IM', detail: reason,
					buttons: [zh ? '确定' : 'OK'], noLink: true });
			}
			return opened && id === this.appRequests.get(target);
		} finally {
			if (id === this.appRequests.get(target)) {
				this.appRequests.delete(target);
				if (action) { this.view.setInboxActionBusy(action, false); }
			}
		}
	}

	private async cover(project: LaunchpadProject): Promise<string | undefined> {
		const cover = project.artwork?.cover;
		if (!cover || !/^studio-cover\.(webp|jpg|png)$/.test(cover.name)) { return undefined; }
		const key = JSON.stringify([project.uri, cover.name, cover.mtime]);
		let data = this.covers.get(key);
		if (!data) {
			const file = URI.joinPath(URI.parse(project.uri), cover.name);
			data = (async () => {
				const stat = await this.files.stat(file);
				if (!stat.isFile || stat.isSymbolicLink || stat.size > 2_000_000) { return undefined; }
				const bytes = await this.files.readFile(file, { limits: { size: 2_000_000 } });
				return `data:image/${cover.name.endsWith('.jpg') ? 'jpeg' : cover.name.split('.').pop()};base64,${encodeBase64(bytes.value)}`;
			})().catch(() => undefined);
			if (this.covers.size >= 24) { this.covers.delete(this.covers.keys().next().value!); }
			this.covers.set(key, data);
		}
		return data;
	}

	private async pickProjectsToImport(): Promise<void> {
		const zh = this.language.startsWith('zh');
		const uris = await this.dialogs.showOpenDialog({ title: zh ? '导入项目' : 'Import project', openLabel: zh ? '导入' : 'Import',
			canSelectFolders: true, canSelectFiles: false, canSelectMany: true, availableFileSystems: [Schemas.file] });
		if (uris?.length && !this._store.isDisposed) { await this.importFolders(uris); }
	}

	private async importFolders(uris: URI[]): Promise<void> {
		const folders = (await Promise.all(uris.map(async uri => {
			try {
				return (await this.files.stat(uri)).isDirectory ? { folderUri: uri } : undefined;
			} catch {
				return undefined; // The folder may have moved since the picker or drop.
			}
		}))).filter(folder => folder !== undefined);
		if (this._store.isDisposed) { return; }
		if (folders.length) {
			await this.workspaces.addRecentlyOpened(folders);
			if (this._store.isDisposed) { return; }
			for (const { folderUri } of folders) { this.missing.delete(folderUri.toString()); }
			this.paint();
			this.view.showImportedProjects(folders.length === 1 ? folders[0].folderUri.toString() : undefined);
		} else {
			const zh = this.language.startsWith('zh');
			await this.native.showMessageBox({ type: 'warning', message: zh ? '没有可导入的项目文件夹' : 'No project folders could be imported',
				buttons: [zh ? '确定' : 'OK'], noLink: true });
		}
	}

	private async openProject(project: LaunchpadProject, entryId?: string): Promise<void> {
		const uri = URI.parse(project.uri);
		if (uri.scheme === 'file') {
			let present: boolean;
			try { const stat = await this.files.stat(uri); present = project.kind === 'folder' ? stat.isDirectory : stat.isFile; }
			catch (error) { if (!(error instanceof Error) || toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; } present = false; }
			if (!present) { await this.locateProject(project); return; }
		}
		let distribution = project.distribution;
		if (!distribution && !project.artwork && project.kind === 'folder') {
			// A click can arrive before the asynchronous library scan populates this row.
			const [metadata] = await this.commands.executeCommand<LibraryMetadata[]>('studio.internalDetectProjectTypes', [project.uri]).catch(() => []) ?? [];
			distribution = metadata?.distribution;
		}
		if (this._store.isDisposed) { return; }
		const runEntry = project.kind === 'folder' && (!!distribution || entryId !== undefined);
		const live = this.windows.find(row => row.uri === project.uri && row.windowId === project.windowId) ?? this.windows.find(row => row.uri === project.uri);
		if (!runEntry && live?.windowId !== undefined) {
			await this.native.focusWindow({ targetWindowId: live.windowId, mode: FocusMode.Force }); return;
		}
		this.missing.delete(project.uri);
		await this.native.openWindow([project.kind === 'workspace' ? { workspaceUri: uri } : { folderUri: uri }], {
			forceNewWindow: true, ...(runEntry ? { studioProjectEntry: entryId === undefined ? {} : { entryId } } : {}),
		});
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
		this.scheduleLibraryCategory();
		this.paint();
		const known = new Set(this.start.state?.recent.filter(p => p.artwork).map(p => p.uri));
		const others = [...new Set([...this.recent, ...this.windows].filter(p => p.kind === 'folder' && !known.has(p.uri)).map(p => p.uri))];
		if (others.length) {
			const rows = await this.commands.executeCommand<(LibraryMetadata & { uri: string })[]>('studio.internalDetectProjectTypes', others).catch(() => undefined);
			if (revision === this.windowRevision && rows) { for (const { uri, ...metadata } of rows) { this.savedProjects.set(uri, { ...this.savedProjects.get(uri), ...metadata }); } this.paint(); }
		}
	}

	private scheduleLibraryCategory(): void {
		++this.libraryCategoryRevision;
		if (this.start.state?.platform && this.account?.signedIn) { this.refreshLibraryCategory.schedule(); }
		else { this.refreshLibraryCategory.cancel(); }
	}

	private async readLibraryCategory(): Promise<void> {
		const revision = this.libraryCategoryRevision;
		const uris = [...new Set([...this.recent, ...this.windows].filter(p => p.kind === 'folder' && p.uri.startsWith('file:')).map(p => p.uri))];
		const category = await this.commands.executeCommand<LibraryProjectCategory | null | undefined>('studio.getLibraryProjectCategory', uris).catch(() => undefined);
		// Undefined means temporarily unavailable; null explicitly removes the optional category.
		if (revision !== this.libraryCategoryRevision || category === undefined) { return; }
		if (JSON.stringify(category ?? undefined) !== JSON.stringify(this.libraryCategory)) {
			this.libraryCategory = category ?? undefined;
			this.paint();
		}
	}

	private async readInbox(): Promise<void> {
		if (document.hidden || this.view.element.hidden || !this.start.state?.platform || !this.account?.signedIn) { return; }
		const revision = ++this.inboxRevision;
		try {
			const inbox = await this.commands.executeCommand<LaunchpadInbox>('studio.getLaunchpadInbox');
			if (revision === this.inboxRevision && inbox) { this.inbox = (inbox.connection === 'offline' || inbox.connection === 'connecting') && this.account?.hasAccount && this.inbox?.items.length ? { ...inbox, items: this.inbox.items } : inbox; this.paint(); }
		} catch {
			if (revision === this.inboxRevision) {
				this.inbox = { connection: 'offline', message: this.language.startsWith('zh') ? '暂时无法读取最近会话。' : 'Recent chats are unavailable.', items: this.account?.hasAccount ? this.inbox?.items ?? [] : [] };
				this.paint();
			}
		}
	}
	private async readNotices(): Promise<void> {
		if (!this.account?.signedIn || document.hidden || this.view.element.hidden) { return; }
		const revision = ++this.noticeRevision;
		try {
			const unread = await this.commands.executeCommand<boolean>('studio.hasUnreadNotices');
			if (revision === this.noticeRevision && typeof unread === 'boolean' && unread !== this.socialUnread) { this.socialUnread = unread; this.paint(); }
		} catch { /* Keep the last known badge while the same account is offline. */ }
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
			const saved = this.savedProjects.get(row.uri);
			// Once inspected, an absent field is authoritative (e.g. a plain folder replacing a release).
			const details = info?.artwork ? info : { ...saved, ...info };
			return { ...row, projectId: details.projectId, projectType: details.projectType, distribution: details.distribution,
				artwork: details.artwork, entries: details.entries, avatarUrl: details.avatarUrl, version: details.version, description: details.description,
				name: details.projectName || info?.label || saved?.name || row.name, lastOpened: info?.lastOpened ?? saved?.lastOpened,
				windowId: row.windowId ?? window?.windowId, dirty: row.dirty ?? window?.dirty, missing: !window && row.windowId === undefined && this.missing.has(row.uri) };
		};
		this.view.update({ windows: this.windows.map(row => enrich(row)), recent: this.recent.map(row => enrich(row, live.get(row.uri))), canCreate: !!state?.canCreate && !state.busy,
			platform: !!state?.platform, account: this.account, store: state?.recommendations, inbox: this.inbox, notices: this.notices.list(), notificationUnread: this.socialUnread || this.notices.hasUnread(),
			libraryCategory: this.libraryCategory });
	}
}
