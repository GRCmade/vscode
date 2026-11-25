/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from '../../base/browser/dnd.js';
import { addDisposableListener, DragAndDropObserver } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { RunOnceScheduler, Throttler } from '../../base/common/async.js';
import { encodeBase64 } from '../../base/common/buffer.js';
import { Event } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { ResourceSet } from '../../base/common/map.js';
import { Schemas } from '../../base/common/network.js';
import { basenameOrAuthority, extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { MicrotaskDelay } from '../../base/common/symbols.js';
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
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { FocusMode, INativeHostService } from '../../platform/native/common/native.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { IUpdateService } from '../../platform/update/common/update.js';
import { IUserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfile.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { parseStudioReleaseProject } from '../../platform/window/common/studioReleaseProject.js';
import { emptyStudioTrayNotifications, IStudioTrayNotifications, studioTrayPreviewLimit } from '../../platform/windows/common/studioTrayNotifications.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IStudioStartService } from '../browser/parts/editor/studioStart.js';
import { projectUsageBridge } from '../browser/studioProjectUsage.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import type { StudioNotificationInbox } from '../browser/studioNotificationInbox.js';
import { IWebviewViewService } from '../contrib/webviewView/browser/webviewViewService.js';
import { IWorkbenchLayoutService, Parts } from '../services/layout/browser/layoutService.js';
import { removeStudioLaunchpadSplash } from './studioLaunchpadSplash.js';
import { LaunchpadInbox, LaunchpadProject, LaunchpadState, StudioLaunchpadView } from '../browser/studioLaunchpadView.js';
import { LaunchpadApp, LaunchpadAppView, StudioChatWindow } from './studioChatWindow.js';
import { InboxAction, LaunchpadDirectory, LaunchpadMenuAccount, SocialResult, StudioNotice, studioNoticeTitle } from '../browser/studioLaunchpadProfile.js';
import { CatalogPage } from '../browser/studioLaunchpadStore.js';
import { LaunchpadProjectMetadata, StoreListingDetails } from '../browser/studioLaunchpadCards.js';
import type { LibraryDetailAction, LibraryProjectCategory } from '../browser/studioLaunchpadLibrary.js';
import { StudioLaunchpadSettings } from '../browser/studioLaunchpadSettings.js';
import '../browser/media/studioLaunchpad.css';

type LibraryExtras = { projects: LaunchpadProject[]; hiddenUris: string[] };
type BuiltinLibrary = { projects: LaunchpadProject[]; pending?: boolean };
const workstationExtensionId = 'studio.studio-workstation';

export class StudioLaunchpad extends Disposable {
	private readonly view: StudioLaunchpadView;
	private readonly chat: StudioChatWindow;
	private readonly covers = new Map<string, Promise<string | undefined>>();
	private readonly settings: StudioLaunchpadSettings;
	private readonly appRequests = new Map<string, string>();
	private windows: LaunchpadProject[] = [];
	private recent: LaunchpadProject[] = [];
	private hasProjectSnapshot = false;
	private managedWorkspaceUris = new Set<string>();
	private builtinWorkspaceUris = new Set<string>();
	private readonly savedProjects = new Map<string, LaunchpadProjectMetadata & { name?: string; lastOpened?: number }>();
	private readonly missing = new Set<string>();
	private readonly editsSinceSnapshot = new Map<number, boolean>();
	private inbox?: LaunchpadInbox;
	private libraryCategory?: LibraryProjectCategory;
	private libraryExtras?: LibraryExtras;
	private builtinProjects?: LaunchpadProject[];
	private readonly openingManaged = new Set<string>();
	private readonly openingBuiltins = new Set<string>();
	private account?: LaunchpadState['account'];
	private windowRevision = 0;
	private libraryCategoryRevision = 0;
	private inboxRevision = 0;
	private noticeRevision = 0;
	private socialUnread = false;
	private socialTrayNotices: StudioNotice[] = [];
	private imTrayNotices?: IStudioTrayNotifications;
	private imTrayRevision = 0;
	private trayScope = generateUuid();
	private trayPublished?: string;
	private readonly noticeReads = this._register(new Throttler());
	private readonly language = getNLSLanguage() ?? 'en';
	private readonly refreshInbox = this._register(new RunOnceScheduler(() => void this.readInbox(), 160));
	private readonly refreshLibraryCategory = this._register(new RunOnceScheduler(() => void this.readLibraryProducts(), 100));
	private readonly refreshBuiltins = this._register(new RunOnceScheduler(() => void this.readBuiltins(), 100));
	private readonly builtinReads = this._register(new Throttler());

	constructor(
		private readonly notices: StudioNotificationInbox,
		@IStudioStartService private readonly start: IStudioStartService,
		@INativeHostService private readonly native: INativeHostService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@INotificationService notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
		@IWebviewService webviews: IWebviewService,
		@IFileService private readonly files: IFileService,
		@IExtensionStorageService extensionStorage: IExtensionStorageService,
		@IWebviewViewService webviewViews: IWebviewViewService,
		@IAuxiliaryWindowService auxiliaryWindows: IAuxiliaryWindowService,
		@IContextMenuService contextMenu: IContextMenuService,
		@IHoverService hoverService: IHoverService,
		@IClipboardService clipboard: IClipboardService,
		@IUserDataProfilesService private readonly profiles: IUserDataProfilesService,
		@IStorageService storage: IStorageService,
		@IProductService product: IProductService,
		@IUpdateService updates: IUpdateService,
	) {
		super();
		this.chat = this._register(new StudioChatWindow(auxiliaryWindows, webviews, opener, native, contextMenu,
			(conversation, user) => this.openInbox(conversation, user).catch(error => { notifications.error(error); return false; }),
			(key, link, isCurrent) => this.openProjectLink(key, link, isCurrent)));
		// Read the extension's profile memento synchronously; native history still owns membership and ordering.
		const saved = extensionStorage.getExtensionState(workstationExtensionId, true)?.['studio.recentProjects'];
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
			openBotArtifacts: (project, entryId) => run(this.openProject(project, entryId, undefined, true)),
			openBotMemory: (project, entryId) => run(this.openProject(project, entryId, undefined, undefined, true)),
			readBotCredentials: (project, entryId) => commands.executeCommand('studio.internalReadBotCredentialList', { uri: project.uri, projectId: project.projectId, entryId }),
			remove: project => run(this.removeProject(project)),
			reveal: project => run(native.showItemInFolder(project.managed ? project.path : URI.parse(project.uri).fsPath)),
			copyPath: project => run(clipboard.writeText(project.path)), contextMenu, hoverService,
			usage: projectUsageBridge(commands, clipboard, storage),
			openProjectSchedules: (project, entryId) => run(commands.executeCommand('studio.internalOpenProjectSchedules', { uri: project.uri, entryId })),
			settings: () => run(commands.executeCommand('studio.openSettings', { section: 'account', target: 'user' })),
			cover: project => this.cover(project),
			readActivity: projects => commands.executeCommand<string[] | undefined>('studio.internalReadLibraryActivity', projects),
			detailActions: async (project, source) => {
				if (!this.start.state?.platform || !project.uri.startsWith('file:') || (project.missing && !project.managed)) { return []; }
				return commands.executeCommand<LibraryDetailAction[] | undefined>(source === 'local' ? 'studio.listFolderBotActions' : 'studio.listLibraryProjectActions', project);
			},
			runDetailAction: async (project, id) => {
				if (!this.start.state?.platform) { return; }
				try {
					if (['create-folder-bot', 'edit-folder-bot-profile', 'copy-folder-bot', 'export-folder-bot-template', 'import-folder-bot-template'].includes(id)) {
						const local = await commands.executeCommand<{ workspace?: string } | undefined>('studio.runFolderBotAction', project.uri, id);
						if (local?.workspace) { await this.openManagedWorkspace(local.workspace); }
						return;
					}
					const result = await commands.executeCommand<{ chatUser?: string }>('studio.runLibraryProjectAction', project.uri, id);
					if (result?.chatUser) { await this.openInbox(undefined, result.chatUser, undefined, project.name); }
				} catch (error) { notifications.error(error); }
			},
			catalog: async (request, platform) => { const page = await commands.executeCommand<CatalogPage>(platform ? 'studio.getStoreCatalog' : 'studio.getLocalCatalog', request); if (!page) { throw new Error('Catalog unavailable'); } return page; },
			listingDetails: async id => { const item = await commands.executeCommand<StoreListingDetails>('studio.getStoreListingDetails', id); if (!item) { throw new Error('Project details unavailable'); } return item; },
			storeImage: async src => src.startsWith('http:') ? commands.executeCommand<string | undefined>('studio.readLocalStoreImage', src) : src,
			getListing: (id, platform) => run(commands.executeCommand(platform ? 'studio.getStoreListing' : 'studio.createExample', id)),
			profile: {
				contextMenu,
				signIn: () => run(commands.executeCommand('studio.launchpadSignIn')),
				inbox: (conversation, title) => run(this.openInbox(conversation, undefined, undefined, title)),
				social: async (query, includeDirectory) => {
					const [result, directory] = await Promise.all([
						commands.executeCommand<SocialResult>('studio.getSocialSnapshot', query),
						includeDirectory ? commands.executeCommand<LaunchpadDirectory>('studio.getLaunchpadDirectory').catch(() => undefined) : undefined,
					]);
					if (!result) { throw new Error('Social data unavailable'); }
					if ('unavailable' in result) { return directory ? { people: [], favorites: [], notices: [], directory } : result; }
					return { ...result, directory, directoryUnavailable: includeDirectory && !directory };
				},
				change: async action => { await commands.executeCommand('studio.changeSocial', action); this.queueNoticeRefresh(); },
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
				readAllNotices: () => this.markAllNoticesRead(),
			},
			resource: id => run(id === 'github' ? opener.open(URI.parse('https://github.com/steamharness/steamharness'), { openExternal: true }) : commands.executeCommand('studio.openLaunchpadResource', id)),
			openStore: () => run(commands.executeCommand('studio.openStore')),
		}, { version: product.studioVersion ?? product.version, updater: product.updateUrl ? updates : undefined }));
		const zh = this.language.startsWith('zh');
		this.settings = this._register(new StudioLaunchpadSettings(layout.mainContainer, (en, cn) => zh ? cn : en, () => this.showHome(), () => {
			this.view.closePicker();
			this.view.setVisible(false);
			this.start.setVisible('launchpad', false);
		}, message => { void native.showMessageBox({ type: 'warning', message, buttons: [zh ? '确定' : 'OK'], noLink: true }); }, webviews, webviewViews));
		const repaintNotices = this._register(new RunOnceScheduler(() => this.paint(), 100));
		this._register(Event.debounce(notices.onDidChange, () => undefined, MicrotaskDelay)(() => {
			repaintNotices.schedule();
			void this.publishTrayNotifications();
		}));
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
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadSettings', (_accessor, title: string) => this.settings.show(title, this.view.element.classList.contains('lp-pointer'))));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadSettings', () => { if (this.settings.isOpen) { this.showHome(); } }));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenLaunchpadInbox', () => { this.showHome(); this.view.showSocial('activity'); }));
		this._register(CommandsRegistry.registerCommand('studio.internalPrepareLaunchpadApp', (_accessor, key: string, app: LaunchpadApp) => this.chat.prepare(key, app)));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadApp', (_accessor, key: string, requestId: string, view: LaunchpadAppView) => Array.from(this.appRequests.values()).includes(requestId) && this.chat.show(key, view)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadApp', (_accessor, key: string) => this.chat.clear(key)));
		this._register(CommandsRegistry.registerCommand('studio.internalOpenStoreTab', () => { this.showHome(); this.view.select('store'); }));
		const socialChanged = () => this.refreshSocialState();
		ipcRenderer.on('vscode:studioSocialChanged', socialChanged);
		this._register(toDisposable(() => ipcRenderer.removeListener('vscode:studioSocialChanged', socialChanged)));
		this._register(CommandsRegistry.registerCommand('studio.internalLibraryProjectCategoryChanged', () => this.scheduleLibraryCategory()));
		this._register(CommandsRegistry.registerCommand('studio.internalForgetFolderBotWindow', (_accessor, uri: string) => this.workspaces.removeRecentlyOpened([URI.parse(uri)])));
		this._register(CommandsRegistry.registerCommand('studio.internalLaunchpadInboxChanged', (_accessor, reset?: boolean) => {
			++this.inboxRevision;
			if (reset && !this.account?.hasAccount) {
				this.inbox = undefined;
				this.paint();
			}
			this.refreshInbox.schedule();
			// The IM listener already debounces pushes. Don't wait on throttled timers in the hidden Launchpad.
			void this.readImTrayNotices();
			this.view.refreshDirectory();
		}));
		const onTrayNotificationAction = async (_event: unknown, requestId: unknown, scope: unknown, action: unknown) => {
			if (typeof requestId !== 'string') { return; }
			let success = false;
			try {
				if (scope === this.trayScope && !this._store.isDisposed && (action === 'markAllRead' || action === 'clearRead')) {
					if (action === 'markAllRead') { await this.markAllNoticesRead(true); }
					else { await this.clearReadNotices(); }
					success = scope === this.trayScope && !this._store.isDisposed;
				}
			} catch { /* The tray reports a retryable error without generating another notification. */ }
			await native.finishStudioTrayNotificationAction(requestId, success).catch(() => undefined);
		};
		ipcRenderer.on('vscode:studioTrayNotificationAction', onTrayNotificationAction);
		this._register(toDisposable(() => ipcRenderer.removeListener('vscode:studioTrayNotificationAction', onTrayNotificationAction)));
		let platform = false, accountRevision = 0;
		const setAccount = (state?: LaunchpadMenuAccount) => {
			const scopeChanged = state?.scopeKey !== this.account?.scopeKey || state?.status !== 'authenticated' || !this.account?.signedIn;
			if (scopeChanged) {
				this.appRequests.clear(); this.view.setInboxActionBusy('add-contact', false); this.view.setInboxActionBusy('create-group', false);
				++this.noticeRevision; this.socialUnread = false; this.socialTrayNotices = [];
				++this.imTrayRevision; this.imTrayNotices = undefined;
				this.trayScope = generateUuid();
				++this.inboxRevision; this.inbox = undefined; this.refreshInbox.schedule();
				this.libraryCategory = undefined;
			}
			this.account = state && { name: state.name, email: state.email, avatarUrl: state.avatarUrl, hasAccount: state.hasAccount,
				scopeKey: state.scopeKey, storeScopeKey: state.storeScopeKey, statusLabel: state.statusLabel, signedIn: state.status === 'authenticated' };
			if (scopeChanged) {
				this.scheduleLibraryCategory();
				void this.publishTrayNotifications();
				void this.readImTrayNotices();
				this.queueNoticeRefresh();
			}
		};
		this._register(commands.onDidExecuteCommand(({ commandId, args }) => {
			if (commandId === 'studio.internalUpdateAccountMenuState' && platform) {
				++accountRevision;
				setAccount(args[0] as LaunchpadMenuAccount);
				this.paint();
			}
		}));
		const updateStart = () => {
			if (start.state && !this.builtinProjects && !this.refreshBuiltins.isScheduled()) { this.refreshBuiltins.schedule(); }
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
		const activityPoll = mainWindow.setInterval(() => this.view.refreshLibraryActivity(), 1000);
		this._register(toDisposable(() => mainWindow.clearInterval(activityPoll)));
		this._register(addDisposableListener(document, 'visibilitychange', () => {
			if (document.hidden) { clearProjectDrop(); }
			start.setVisible('launchpad', !document.hidden && !this.view.element.hidden);
			if (!document.hidden) { changed(); this.refreshInbox.schedule(); this.refreshSocialState(); if (!this.refreshBuiltins.isScheduled()) { this.refreshBuiltins.schedule(); } }
		}));
		// The resident window never becomes an editor, including while an app is opening or closing.
		const parts = Array.from(layout.mainContainer.querySelectorAll<HTMLElement>('.part:not(.titlebar)')).filter(part => !part.inert);
		for (const part of parts) { part.inert = true; }
		this._register(toDisposable(() => {
			++this.windowRevision; ++this.inboxRevision; ++this.libraryCategoryRevision; ++this.imTrayRevision;
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
		const fromSettings = this.settings.isOpen;
		this.settings.close();
		this.view.closePicker();
		this.view.setVisible(true);
		this.start.setVisible('launchpad', !document.hidden);
		if (fromSettings) { this.view.focusSettings(); }
		else { this.view.element.focus({ preventScroll: true }); }
		this.refreshInbox.schedule();
		this.refreshSocialState();
	}

	private refreshSocialState(): void {
		if (!this.account?.signedIn) { return; }
		this.queueNoticeRefresh();
		if (!document.hidden && !this.view.element.hidden) { this.view.refreshSocial(); }
	}

	private queueNoticeRefresh(): void {
		// Hidden renderers throttle timers; coalesce concurrent refreshes without waiting on one.
		if (this.account?.signedIn && !this._store.isDisposed) { void this.noticeReads.queue(() => this.readNotices()); }
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

	private async openProjectLink(key: string, link: string, isCurrent: () => boolean): Promise<boolean> {
		const target = await this.commands.executeCommand<{ uri: string; conversationId: string; managed?: boolean } | undefined>('studio.internalResolveHostedProjectLink', key, link);
		if (!target || !isCurrent() || this._store.isDisposed) { return false; }
		const uri = URI.parse(target.uri);
		if (uri.scheme !== 'file' || uri.query || uri.fragment || target.managed && !uri.path.endsWith('.code-workspace')) { return false; }
		if (target.managed) {
			await this.openManagedWorkspace(target.uri, target.conversationId);
		} else {
			await this.openProject({ uri: target.uri, kind: 'folder', path: uri.fsPath, name: uri.path.split('/').pop() || '' }, undefined, target.conversationId);
		}
		return true;
	}

	private async openProject(project: LaunchpadProject, entryId?: string, conversationId?: string, botArtifacts?: true, botMemory?: true): Promise<void> {
		if (project.builtin) {
			await this.openBuiltinProject(project, entryId, botArtifacts, botMemory);
			return;
		}
		if (project.managed) {
			const result = await this.commands.executeCommand<{ workspace?: string } | undefined>('studio.runFolderBotAction', project.uri, 'open-folder-bot');
			if (result?.workspace) { await this.openManagedWorkspace(result.workspace, undefined, botArtifacts, botMemory); }
			return;
		}
		const uri = URI.parse(project.uri);
		if (uri.scheme === 'file') {
			let present: boolean;
			try { const stat = await this.files.stat(uri); present = project.kind === 'folder' ? stat.isDirectory : stat.isFile; }
			catch (error) { if (!(error instanceof Error) || toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; } present = false; }
			if (!present) { await this.locateProject(project); return; }
		}
		let distribution = project.distribution;
		if (!conversationId && !distribution && !project.artwork && project.kind === 'folder') {
			// A click can arrive before the asynchronous library scan populates this row.
			const [metadata] = await this.commands.executeCommand<LaunchpadProjectMetadata[]>('studio.internalDetectProjectTypes', [project.uri]).catch(() => []) ?? [];
			distribution = metadata?.distribution;
		}
		if (this._store.isDisposed) { return; }
		const runEntry = project.kind === 'folder' && (!!distribution || entryId !== undefined || !!conversationId || !!botArtifacts || !!botMemory);
		const live = this.windows.find(row => row.uri === project.uri && row.windowId === project.windowId) ?? this.windows.find(row => row.uri === project.uri);
		if (!runEntry && live?.windowId !== undefined) {
			await this.native.focusWindow({ targetWindowId: live.windowId, mode: FocusMode.Force }); return;
		}
		this.missing.delete(project.uri);
		await this.native.openWindow([project.kind === 'workspace' ? { workspaceUri: uri } : { folderUri: uri }], {
			forceNewWindow: true, ...(runEntry ? { studioProjectEntry: { entryId, conversationId, botArtifacts, botMemory } } : {}),
		});
	}

	private async openBuiltinProject(project: LaunchpadProject, entryId?: string, botArtifacts?: true, botMemory?: true): Promise<void> {
		if (this.openingBuiltins.has(project.uri)) { return; }
		this.openingBuiltins.add(project.uri);
		try {
			const uri = URI.parse(project.uri);
			const read = (name: string) => this.files.readFile(URI.joinPath(uri, name), { limits: { size: 2_000_000 } }).then(file => file.value.toString());
			const release = await Promise.all([read('steamharness.json'), read('steamharness.release.json')])
				.then(([declaration, manifest]) => parseStudioReleaseProject(project.uri, declaration, manifest, this.language), () => undefined);
			if (this._store.isDisposed) { return; }
			if (!release) { throw new Error(this.language.startsWith('zh') ? '内置项目的发行文件不可用，请重新构建或修复 Studio。' : 'The built-in project release is unavailable. Rebuild or repair Studio.'); }
			const windows = entryId === undefined && !botArtifacts && !botMemory ? await this.native.getWindows({ includeAuxiliaryWindows: false }) : [];
			if (this._store.isDisposed) { return; }
			const live = windows.find(window => isSingleFolderWorkspaceIdentifier(window.workspace) && extUriBiasedIgnorePathCase.isEqual(URI.revive(window.workspace.uri), uri));
			if (live) { await this.native.focusWindow({ targetWindowId: live.id, mode: FocusMode.Force }); }
			else { await this.native.openWindow([{ folderUri: uri }], { forceNewWindow: true, noRecentEntry: true, studioProjectEntry: { entryId, botArtifacts, botMemory } }); }
		} finally { this.openingBuiltins.delete(project.uri); }
	}

	private async openManagedWorkspace(value: string, conversationId?: string, botArtifacts?: true, botMemory?: true): Promise<void> {
		const uri = URI.parse(value);
		if (uri.scheme !== 'file' || uri.query || uri.fragment || !uri.path.endsWith('.code-workspace') || this.openingManaged.has(value)) { return; }
		this.openingManaged.add(value);
		try {
			if (conversationId || botArtifacts || botMemory) {
				await this.native.openWindow([{ workspaceUri: uri }], { forceNewWindow: true, studioProjectEntry: { conversationId, botArtifacts, botMemory } });
				return;
			}
			const windows = await this.native.getWindows({ includeAuxiliaryWindows: false });
			const live = windows.find(window => isWorkspaceIdentifier(window.workspace) && URI.revive(window.workspace.configPath).toString() === value);
			if (live) { await this.native.focusWindow({ targetWindowId: live.id, mode: FocusMode.Force }); }
			else { await this.native.openWindow([{ workspaceUri: uri }], { forceNewWindow: true }); }
		} finally { this.openingManaged.delete(value); }
	}

	private async removeProject(project: LaunchpadProject): Promise<void> {
		if (project.builtin || this.builtinWorkspaceUris.has(project.uri) || this.builtinProjects?.some(row => row.uri === project.uri)) { return; }
		if (project.managed) { await this.commands.executeCommand('studio.runFolderBotAction', project.uri, 'remove-folder-bot'); return; }
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

	private async readManagedWorkspaceRoots(): Promise<URI[]> {
		const roots = new ResourceSet(uri => extUriBiasedIgnorePathCase.getComparisonKey(uri));
		for (const profile of this.profiles.profiles) {
			roots.add(URI.joinPath(profile.globalStorageHome.with({ scheme: Schemas.file }), workstationExtensionId));
		}
		// Generated workspaces can use canonical paths even when the profile uses an alias.
		const canonical = await Promise.all([...roots].map(root => this.files.realpath(root).catch(() => undefined)));
		for (const root of canonical) {
			if (root) { roots.add(URI.file(root.fsPath)); }
		}
		return [...roots];
	}

	private async readProjects(): Promise<void> {
		const revision = ++this.windowRevision;
		// An edit/save can arrive after getWindows takes its snapshot but before history returns.
		this.editsSinceSnapshot.clear();
		const [windows, recent, managedRoots] = await Promise.all([
			this.native.getWindows({ includeAuxiliaryWindows: false }), this.workspaces.getRecentlyOpened(), this.readManagedWorkspaceRoots(),
		]);
		if (this.windowRevision !== revision) { return; }
		const managedUris = new Set<string>();
		const builtinUris = new Set<string>();
		const builtinRoots = managedRoots.map(root => URI.joinPath(root, 'workflow', 'builtin-apps'));
		const project = (raw: URI, kind: LaunchpadProject['kind'], label?: string): LaunchpadProject => {
			const uri = URI.revive(raw);
			const key = uri.toString();
			if (kind === 'workspace' && managedRoots.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(uri, root))) {
				managedUris.add(key);
			}
			if (kind === 'folder' && builtinRoots.some(root => /^[a-f0-9]{24}(?:\/project)?$/.test(extUriBiasedIgnorePathCase.relativePath(root, uri) ?? ''))) {
				builtinUris.add(key);
			}
			return { kind, uri: key, name: label || basenameOrAuthority(uri), path: uri.scheme === Schemas.file ? uri.fsPath : uri.toString(true) };
		};
		this.windows = windows.flatMap(window => {
			const dirty = this.editsSinceSnapshot.get(window.id) ?? window.dirty;
			if (isSingleFolderWorkspaceIdentifier(window.workspace)) {
				return [{ ...project(window.workspace.uri, 'folder'), windowId: window.id, dirty }];
			}
			return isWorkspaceIdentifier(window.workspace) ? [{ ...project(window.workspace.configPath, 'workspace'), windowId: window.id, dirty }] : [];
		});
		this.recent = recent.workspaces.map(row => isRecentFolder(row) ? project(row.folderUri, 'folder', row.label) : project(row.workspace.configPath, 'workspace', row.label));
		this.managedWorkspaceUris = managedUris;
		this.builtinWorkspaceUris = builtinUris;
		this.hasProjectSnapshot = true;
		const members = new Set([...this.recent, ...this.windows].map(row => row.uri));
		for (const uri of this.savedProjects.keys()) { if (!members.has(uri)) { this.savedProjects.delete(uri); } }
		for (const uri of this.missing) { if (!this.recent.some(row => row.uri === uri)) { this.missing.delete(uri); } }
		this.scheduleLibraryCategory();
		this.paint();
		const known = new Set(this.start.state?.recent.filter(p => p.artwork).map(p => p.uri));
		const others = [...new Set([...this.recent, ...this.windows].filter(p => p.kind === 'folder' && !known.has(p.uri)).map(p => p.uri))];
		if (others.length) {
			const rows = await this.commands.executeCommand<(LaunchpadProjectMetadata & { uri: string })[]>('studio.internalDetectProjectTypes', others).catch(() => undefined);
			if (revision === this.windowRevision && rows) { for (const { uri, ...metadata } of rows) { this.savedProjects.set(uri, { ...this.savedProjects.get(uri), ...metadata }); } this.paint(); }
		}
	}

	private scheduleLibraryCategory(): void {
		++this.libraryCategoryRevision;
		// Resolve parent aliases against the first native snapshot before showing managed projects.
		if (this.hasProjectSnapshot && this.start.state?.platform) { this.refreshLibraryCategory.schedule(this.libraryExtras ? undefined : 0); }
		else { this.refreshLibraryCategory.cancel(); }
	}

	private async readBuiltins(): Promise<void> {
		await this.builtinReads.queue(async () => {
			const result = await this.commands.executeCommand<BuiltinLibrary | undefined>('studio.internalListBuiltinProjects').catch(() => undefined);
			if (!result || this._store.isDisposed) { return; }
			const projects = result.projects.filter(p => p.kind === 'folder' && p.distribution === 'release' && p.uri.startsWith('file:'))
				.map(p => ({ ...p, builtin: true as const }));
			if (JSON.stringify(projects) !== JSON.stringify(this.builtinProjects)) { this.builtinProjects = projects; this.paint(); }
			if (result.pending && !document.hidden) { this.refreshBuiltins.schedule(1500); }
		});
	}

	private async readLibraryProducts(): Promise<void> {
		const revision = this.libraryCategoryRevision;
		const folders = [...new Set([...this.recent, ...this.windows].filter(p => p.kind === 'folder' && p.uri.startsWith('file:')).map(p => p.uri))];
		const extra = await this.commands.executeCommand<LibraryExtras>('studio.listLibraryExtraProjects', folders).catch(() => undefined);
		if (revision !== this.libraryCategoryRevision) { return; }
		if (extra && JSON.stringify(extra) !== JSON.stringify(this.libraryExtras)) { this.libraryExtras = extra; this.paint(); }
		if (!this.account?.signedIn) { return; }
		const uris = [...new Set([...folders, ...(this.libraryExtras?.projects ?? []).map(p => p.uri).filter(uri => uri.startsWith('file:'))])];
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
		const account = this.account?.signedIn ? this.account.scopeKey : undefined;
		if (!account) { return; }
		const revision = ++this.noticeRevision;
		try {
			const unread = await this.commands.executeCommand<boolean>('studio.hasUnreadNotices', account);
			if (revision !== this.noticeRevision || typeof unread !== 'boolean') { return; }
			const feed = unread ? await this.commands.executeCommand<SocialResult>('studio.getSocialSnapshot', '', 'notices', account).catch(() => undefined) : undefined;
			if (revision !== this.noticeRevision) { return; }
			const changed = unread !== this.socialUnread;
			this.socialUnread = unread;
			if (!unread) { this.socialTrayNotices = []; }
			else if (feed && 'notices' in feed) { this.socialTrayNotices = feed.notices.filter(notice => !notice.read); }
			if (changed) { this.paint(); }
			await this.publishTrayNotifications();
		} catch { /* Keep the last known badge while the same account is offline. */ }
	}

	private async readImTrayNotices(): Promise<void> {
		const account = this.account?.signedIn ? this.account.scopeKey : undefined;
		if (!account) { return; }
		const revision = ++this.imTrayRevision;
		try {
			const notices = await this.commands.executeCommand<IStudioTrayNotifications | undefined>('studio.getTrayImNotices', account);
			if (revision === this.imTrayRevision) {
				this.imTrayNotices = notices;
				await this.publishTrayNotifications();
			}
		} catch { /* Preserve the last confirmed snapshot on a transient failure. */ }
	}

	private async publishTrayNotifications(): Promise<void> {
		const scope = this.trayScope;
		const im = this.imTrayNotices ?? emptyStudioTrayNotifications;
		const local = this.notices.unread();
		// The hosted unread summary describes the same chats as the live IM preview.
		const social = this.socialTrayNotices.filter(notice => !this.imTrayNotices || !notice.id.startsWith('im-unread:'));
		const t = (en: string, zh: string) => this.language.startsWith('zh') ? zh : en;
		const items = [...im.items, ...[...local, ...social].map(notice => ({ title: studioNoticeTitle(notice, t), detail: notice.detail }))].slice(0, studioTrayPreviewLimit);
		const count = Math.min(1e9, im.count + local.length + (social.length || Number(this.socialUnread && !this.socialTrayNotices.length)));
		const snapshot = JSON.stringify([scope, count, items]);
		if (snapshot === this.trayPublished) { return; }
		this.trayPublished = snapshot;
		await this.native.setStudioTrayNotifications({ count, items }, scope).catch(() => {
			if (this.trayPublished === snapshot) { this.trayPublished = undefined; }
		});
	}

	private async markAllNoticesRead(includeIm = false): Promise<void> {
		const scope = this.trayScope;
		const checkScope = () => { if (scope !== this.trayScope || this._store.isDisposed) { throw new Error('The notification account changed'); } };
		try {
			this.notices.readAll();
			if (!this.start.state?.platform || !this.account?.signedIn) { return; }
			const account = this.account.scopeKey;
			if (!account) { throw new Error('The notification account is unavailable'); }
			// The hosted summary may be the only IM notice until the first live snapshot arrives.
			const hasImUnread = this.imTrayNotices ? this.imTrayNotices.count > 0 : this.socialTrayNotices.some(notice => notice.id.startsWith('im-unread:'));
			if (includeIm && hasImUnread && await this.commands.executeCommand<boolean>('studio.markAllImMessagesRead', account) !== true) {
				throw new Error('IM unread messages could not be marked as read');
			}
			checkScope();
			// Run this after IM so a pending hosted summary can't be posted after read-all.
			await this.commands.executeCommand('studio.markAllNoticesRead', account);
			checkScope();
			++this.noticeRevision;
			this.socialUnread = false;
			this.socialTrayNotices = [];
		} finally {
			if (scope === this.trayScope && !this._store.isDisposed) {
				await this.readImTrayNotices();
				await this.publishTrayNotifications();
				this.paint();
				this.refreshInbox.schedule();
				this.refreshSocialState();
			}
		}
	}

	private async clearReadNotices(): Promise<void> {
		const scope = this.trayScope;
		this.notices.clearRead();
		if (!this.start.state?.platform || !this.account?.signedIn) { return; }
		const account = this.account.scopeKey;
		if (!account) { throw new Error('The notification account is unavailable'); }
		const feed = await this.commands.executeCommand<SocialResult>('studio.getSocialSnapshot', '', 'notices', account);
		if (scope !== this.trayScope || this._store.isDisposed) { return; }
		if (!feed) { throw new Error('Social data unavailable'); }
		if ('notices' in feed) { this.notices.dismissReadSocialNotices(account, feed.notices); }
		if (!document.hidden && !this.view.element.hidden) { this.view.refreshSocial(); }
	}

	private paint(): void {
		const state = this.start.state;
		const projects = this.libraryExtras?.projects ?? [];
		const extra = new Map(projects.map(project => [project.uri, project]));
		const hidden = new Set(this.libraryExtras?.hiddenUris);
		const builtinUris = new Set(this.builtinProjects?.map(p => p.uri));
		// Extension-owned workspaces need their library record, not a filename fallback.
		const visible = (row: LaunchpadProject) => !builtinUris.has(row.uri) && !this.builtinWorkspaceUris.has(row.uri) && !hidden.has(row.uri) && (extra.has(row.uri) || !this.managedWorkspaceUris.has(row.uri));
		const metadata = new Map(state?.recent.map(row => [row.uri, row]));
		const live = new Map<string, LaunchpadProject>();
		for (const window of this.windows) {
			if (!live.has(window.uri) || window.dirty) { live.set(window.uri, window); }
		}
		const enrich = (row: LaunchpadProject, window?: LaunchpadProject): LaunchpadProject => {
			const managed = extra.get(row.uri);
			if (managed) { return { ...managed, windowId: row.windowId ?? window?.windowId, dirty: row.dirty ?? window?.dirty }; }
			const info = metadata.get(row.uri);
			const saved = this.savedProjects.get(row.uri);
			// Once inspected, an absent field is authoritative (e.g. a plain folder replacing a release).
			const details = info?.artwork ? info : { ...saved, ...info };
			return { ...row, projectId: details.projectId, projectType: details.projectType, distribution: details.distribution,
				artwork: details.artwork, entries: details.entries, avatarUrl: details.avatarUrl, version: details.version, description: details.description,
				name: details.projectName || info?.label || saved?.name || row.name, lastOpened: info?.lastOpened ?? saved?.lastOpened,
				windowId: row.windowId ?? window?.windowId, dirty: row.dirty ?? window?.dirty, missing: !window && row.windowId === undefined && this.missing.has(row.uri) };
		};
		const history = new Map(this.recent.filter(visible).map(row => [row.uri, row]));
		for (const row of projects) { if (!history.has(row.uri)) { history.set(row.uri, row); } }
		const builtinProjects = this.builtinProjects?.map(row => ({ ...row, windowId: live.get(row.uri)?.windowId }));
		this.view.update({ windows: this.windows.filter(visible).map(row => enrich(row)), recent: [...history.values()].map(row => enrich(row, live.get(row.uri))), canCreate: !!state?.canCreate && !state.busy,
			platform: !!state?.platform, account: this.account, store: state?.recommendations, inbox: this.inbox, notices: this.notices.list(), notificationUnread: this.socialUnread || this.notices.hasUnread(),
			dismissedSocialNoticeIds: this.notices.dismissedSocialNoticeIds,
			libraryCategory: this.libraryCategory, builtinProjects });
	}
}
