/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../base/browser/dom.js';
import { mainWindow } from '../../base/browser/window.js';
import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { Schemas } from '../../base/common/network.js';
import { basenameOrAuthority } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { getNLSLanguage } from '../../nls.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../platform/files/common/files.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { ILabelService } from '../../platform/label/common/label.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWebviewViewService } from '../contrib/webviewView/browser/webviewViewService.js';
import { IAuxiliaryWindowService } from '../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../services/layout/browser/layoutService.js';
import { IStatusbarService, StatusbarAlignment } from '../services/statusbar/browser/statusbar.js';
import { IStudioStartService, StudioStartState } from './parts/editor/studioStart.js';
import { LaunchpadProject, StudioLaunchpadView } from './studioLaunchpadView.js';
import { InboxAction, LaunchpadAccount, LaunchpadDirectory, LaunchpadInbox, LaunchpadMenuAccount, SocialResult } from './studioLaunchpadProfile.js';
import { StudioLaunchpadSettings } from './studioLaunchpadSettings.js';
import { CatalogPage } from './studioLaunchpadStore.js';
import { LaunchpadProjectMetadata, StoreListingDetails } from './studioLaunchpadCards.js';
import { StudioNotificationInbox } from './studioNotificationInbox.js';
import { StudioWebLaunchpadApp } from './studioWebLaunchpadApp.js';
import './media/studioLaunchpad.css';

function studioLabel(en: string, zh: string): string { return getNLSLanguage()?.startsWith('zh') ? zh : en; }

type RecentProject = StudioStartState['recent'][number];

export class StudioWebLaunchpadNavigation extends Disposable {

	constructor(@IStatusbarService statusbar: IStatusbarService, @INotificationService notifications: INotificationService) {
		super();
		const title = studioLabel('Studio Launchpad', 'Studio 启动台');
		this._register(CommandsRegistry.registerCommand('studio.showLaunchpad', () => {
			try {
				const launchpad: Window | null = mainWindow.opener;
				if (launchpad && !launchpad.closed && launchpad.document.querySelector('.studio-web-launchpad-window')) {
					launchpad.focus();
					return;
				}
			} catch { /* The opener may have navigated away. */ }
			const home = new URL(mainWindow.location.href);
			home.search = '?launchpad=1';
			home.hash = '';
			if (!mainWindow.open(home.href, '_blank')) {
				notifications.warn(studioLabel('The browser blocked the Launchpad tab. Allow pop-ups for this site and try again.', '浏览器拦截了启动台标签页。请允许此站点打开弹出式窗口后重试。'));
			}
		}));
		this._register(statusbar.addEntry({ name: title, text: '$(home) ' + title, ariaLabel: title, tooltip: title, command: 'studio.showLaunchpad' },
			'studio.showLaunchpad', StatusbarAlignment.LEFT, 100));
	}
}

export class StudioWebLaunchpad extends Disposable {

	private readonly view: StudioLaunchpadView;
	private readonly settings: StudioLaunchpadSettings;
	private readonly app: StudioWebLaunchpadApp;
	private readonly refreshInbox = this._register(new RunOnceScheduler(() => void this.readInbox(), 160));
	private readonly refreshNotices = this._register(new RunOnceScheduler(() => void this.readNotices(), 160));
	private account?: LaunchpadAccount;
	private accountRevision = 0;
	private inbox?: LaunchpadInbox;
	private inboxRevision = 0;
	private readonly inboxRequests = new Map<string, string>();
	private socialUnread = false;
	private noticeRevision = 0;
	private projects?: LaunchpadProject[];
	private startVisibilitySettled = false;
	private recent = new Map<string, RecentProject>();
	private builtinProjects?: LaunchpadProject[];
	private revision = 0;

	constructor(
		private readonly authority: string,
		private readonly notices: StudioNotificationInbox,
		@IStudioStartService private readonly start: IStudioStartService,
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IHostService private readonly host: IHostService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IDialogService dialogService: IDialogService,
		@IFileService private readonly files: IFileService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@ILabelService private readonly labels: ILabelService,
		@INotificationService private readonly notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
		@IClipboardService clipboard: IClipboardService,
		@IContextMenuService contextMenu: IContextMenuService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService webviews: IWebviewService,
		@IWebviewViewService webviewViews: IWebviewViewService,
		@IAuxiliaryWindowService windows: IAuxiliaryWindowService,
	) {
		super();
		const run = (operation: Promise<unknown>) => { void operation.catch(error => notifications.error(error)); };
		this.view = this._register(new StudioLaunchpadView(getNLSLanguage() ?? 'en', {
			open: () => run(this.pickAndOpen('folder')),
			workspace: () => run(this.pickAndOpen('workspace')),
			create: () => run(commands.executeCommand('studio.createProject')),
			importProjects: () => run(this.importFolders()),
			project: project => run(this.openProject(project, project.builtin ? {} : undefined)),
			runProject: (project, entryId) => run(this.openProject(project, { entryId })),
			remove: project => run(this.removeProject(project)),
			copyPath: project => run(clipboard.writeText(project.path)),
			openLabel: project => project.builtin ? studioLabel('Open in new tab', '在新标签页打开') : studioLabel('Open in workbench', '在工作台打开'),
			contextMenu, hoverService,
			cover: async () => undefined,
			settings: () => run(commands.executeCommand('studio.openSettings', { section: 'general', target: 'user' })),
			profile: {
				contextMenu,
				signIn: () => run(commands.executeCommand('studio.launchpadSignIn')),
				inbox: (id, title) => run(this.openInbox(id, undefined, undefined, title)),
				chatUser: (id, title) => run(this.openInbox(undefined, id, undefined, title)),
				addContact: () => run(this.openInbox(undefined, undefined, 'add-contact', studioLabel('Add friend', '添加好友'))),
				createGroup: () => run(this.openInbox(undefined, undefined, 'create-group', studioLabel('Start a group chat', '发起群聊'))),
				confirmRemoveFriend: async name => (await dialogService.confirm({
					message: studioLabel(`Remove “${name}” from your friends?`, `从好友中移除「${name}」？`),
					primaryButton: studioLabel('Remove friend', '移除好友'),
				})).confirmed,
				social: (query, directory) => this.readSocial(query, directory),
				change: async action => { await commands.executeCommand('studio.changeSocial', action); this.refreshNotices.schedule(); },
				changeConversation: async action => {
					await commands.executeCommand('studio.changeLaunchpadConversation', action);
					this.refreshInbox.schedule(); this.view.refreshDirectory();
				},
				readNotice: id => notices.read(id),
				readAllNotices: async () => {
					notices.readAll();
					if (this.account?.signedIn) { await commands.executeCommand('studio.markAllNoticesRead', this.account.scopeKey); }
					this.refreshNotices.schedule();
				},
			},
			resource: id => run(id === 'github' ? opener.open(URI.parse('https://github.com/steamharness/steamharness'), { openExternal: true }) : commands.executeCommand('studio.openLaunchpadResource', id)),
			openStore: () => this.view.select('store'),
			catalog: async (request, platform) => {
				const page = await commands.executeCommand<CatalogPage>(platform ? 'studio.getStoreCatalog' : 'studio.getLocalCatalog', request);
				if (!page) { throw new Error('Catalog unavailable'); }
				return page;
			},
			listingDetails: async id => {
				const item = await commands.executeCommand<StoreListingDetails>('studio.getStoreListingDetails', id);
				if (!item) { throw new Error('Project details unavailable'); }
				return item;
			},
			storeImage: async src => src.startsWith('http:') ? commands.executeCommand<string | undefined>('studio.readLocalStoreImage', src) : src,
			getListing: (id, platform) => run(commands.executeCommand(platform ? 'studio.getStoreListing' : 'studio.createExample', id)),
		}));

		const root = layout.mainContainer;
		root.append(this.view.element);
		const parts = Array.from(root.querySelectorAll<HTMLElement>('.part')).filter(part => !part.inert);
		for (const part of parts) { part.inert = true; }
		this._register(toDisposable(() => {
			++this.revision;
			++this.accountRevision; ++this.inboxRevision; ++this.noticeRevision;
			this.inboxRequests.clear();
			start.setVisible('launchpad', false);
			for (const part of parts) { part.inert = false; }
			this.view.element.remove();
		}));

		const refresh = this._register(new RunOnceScheduler(() => run(this.refreshProjects()), 100));
		const changed = () => { ++this.revision; refresh.schedule(); };
		const visible = () => {
			const isVisible = !document.hidden && !this.view.element.hidden;
			const activation = start.setVisible('launchpad', isVisible);
			if (isVisible && !start.state && !this.startVisibilitySettled && activation) {
				void activation.then(() => {
					this.startVisibilitySettled = true;
					// If the extension failed to publish its state, fall back to browser history.
					if (!start.state && !this._store.isDisposed) { changed(); }
				});
			}
		};
		const hideHome = () => { this.view.closePicker(); this.view.setVisible(false); visible(); };
		const showHome = () => {
			const fromSettings = this.settings.isOpen;
			this.settings.close();
			this.view.setVisible(true);
			if (fromSettings) { this.view.focusSettings(); } else { this.view.element.focus({ preventScroll: true }); }
			visible();
			this.refreshProfile();
		};
		this.settings = this._register(new StudioLaunchpadSettings(root, studioLabel, showHome, hideHome, message => notifications.error(message), webviews, webviewViews));
		this.app = this._register(new StudioWebLaunchpadApp(windows, studioLabel, webviews, opener, clipboard,
			(conversation, user) => run(this.openInbox(conversation, user))));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadSettings', (_accessor, title: string) =>
			this.settings.show(title, this.view.element.classList.contains('lp-pointer'))));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadSettings', () => { if (this.settings.isOpen) { showHome(); } }));
		this._register(CommandsRegistry.registerCommand('studio.internalRevealStore', () => {
			showHome(); this.view.select('store'); return true;
		}));
		this._register(CommandsRegistry.registerCommand('studio.internalPrepareLaunchpadApp', (_accessor, key: string, app: { accountUrl?: string }) =>
			!!this.account?.signedIn && this.app.prepare(key, app?.accountUrl)));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadApp', (_accessor, key: string, id: string, view: Parameters<StudioWebLaunchpadApp['show']>[2]) =>
			this.app.show(key, id, view)));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadApp', (_accessor, key: string) => this.app.clear(key)));
		this._register(CommandsRegistry.registerCommand('studio.internalStudioSocialChanged', () => this.refreshProfile()));
		this._register(CommandsRegistry.registerCommand('studio.internalLaunchpadInboxChanged', () => {
			this.refreshInbox.schedule(); this.view.refreshDirectory();
		}));
		this._register(commands.onDidExecuteCommand(({ commandId, args }) => {
			if (commandId === 'studio.internalUpdateAccountMenuState' && start.state?.platform) {
				++this.accountRevision;
				this.setAccount(args[0] as LaunchpadMenuAccount);
			}
		}));
		let platform = false;
		const updatePlatform = () => {
			if (platform !== !!start.state?.platform) {
				platform = !!start.state?.platform;
				const revision = ++this.accountRevision;
				if (platform) {
					void commands.executeCommand<LaunchpadMenuAccount>('studio.internalGetAccountMenuState').then(account => {
						if (revision === this.accountRevision && !this._store.isDisposed) { this.setAccount(account); }
					}, () => undefined);
				} else { this.setAccount(); }
			}
			this.paint();
		};
		this._register(start.onDidChange(updatePlatform));
		const repaintNotices = this._register(new RunOnceScheduler(() => this.paint(), 100));
		this._register(notices.onDidChange(() => repaintNotices.schedule()));
		this._register(addDisposableListener(mainWindow, 'keydown', event => this.view.shortcut(event), true));
		this._register(addDisposableListener(document, 'visibilitychange', () => { visible(); this.refreshProfile(); }));
		const poll = mainWindow.setInterval(() => this.refreshProfile(), 60_000);
		this._register(toDisposable(() => mainWindow.clearInterval(poll)));

		this._register(workspaces.onDidChangeRecentlyOpened(changed));
		this._register(start.onDidChange(changed));
		this._register(addDisposableListener(mainWindow, 'focus', () => { changed(); this.refreshProfile(); }));
		const builtins = this._register(new RunOnceScheduler(() => run(this.refreshBuiltins(builtins)), 100));
		const loadBuiltins = () => {
			if (start.state && !document.hidden && !builtins.isScheduled()) { builtins.schedule(); }
		};
		this._register(addDisposableListener(document, 'visibilitychange', loadBuiltins));
		this._register(start.onDidChange(() => { if (!this.builtinProjects) { loadBuiltins(); } }));
		this.view.element.focus({ preventScroll: true });
		updatePlatform();
		visible();
		loadBuiltins();
		changed();
	}

	private setAccount(state?: LaunchpadMenuAccount): void {
		const account = state && { name: state.hasAccount ? state.name : '', email: state.email, avatarUrl: state.avatarUrl, hasAccount: state.hasAccount,
			scopeKey: state.scopeKey, storeScopeKey: state.storeScopeKey, statusLabel: state.statusLabel, signedIn: state.status === 'authenticated' };
		const changed = this.account?.signedIn !== account?.signedIn || this.account?.scopeKey !== account?.scopeKey;
		this.account = account;
		if (changed) {
			++this.inboxRevision; ++this.noticeRevision;
			this.inbox = undefined; this.socialUnread = false;
			this.inboxRequests.clear();
			this.view.setInboxActionBusy('add-contact', false);
			this.view.setInboxActionBusy('create-group', false);
			this.app.reset(); this.refreshProfile();
		}
		this.paint();
	}

	private refreshProfile(): void {
		if (!this.account?.signedIn || document.hidden || this.view.element.hidden || this._store.isDisposed) { return; }
		this.refreshInbox.schedule(); this.refreshNotices.schedule(); this.view.refreshSocial();
	}

	private async readSocial(query: string, includeDirectory: boolean): Promise<SocialResult> {
		const [result, directory] = await Promise.all([
			this.commands.executeCommand<SocialResult>('studio.getSocialSnapshot', query, undefined, this.account?.scopeKey),
			includeDirectory ? this.commands.executeCommand<LaunchpadDirectory>('studio.getLaunchpadDirectory').catch(() => undefined) : undefined,
		]);
		if (!result) { throw new Error('Social data unavailable'); }
		if ('unavailable' in result) { return directory ? { people: [], favorites: [], notices: [], directory } : result; }
		return { ...result, directory, directoryUnavailable: includeDirectory && !directory };
	}

	private async readInbox(): Promise<void> {
		if (!this.account?.signedIn || document.hidden || this._store.isDisposed) { return; }
		const revision = ++this.inboxRevision;
		const inbox = await this.commands.executeCommand<LaunchpadInbox>('studio.getLaunchpadInbox').catch(() => undefined);
		if (revision !== this.inboxRevision || this._store.isDisposed) { return; }
		const snapshot: LaunchpadInbox = inbox ?? { connection: 'offline', items: [], message: studioLabel('Recent chats are unavailable.', '暂时无法读取最近会话。') };
		const next = (snapshot.connection === 'offline' || snapshot.connection === 'connecting') && this.inbox?.items.length ? { ...snapshot, items: this.inbox.items } : snapshot;
		if (JSON.stringify(next) !== JSON.stringify(this.inbox)) { this.inbox = next; this.paint(); }
	}

	private async readNotices(): Promise<void> {
		if (!this.account?.signedIn || document.hidden || this._store.isDisposed) { return; }
		const revision = ++this.noticeRevision;
		const unread = await this.commands.executeCommand<boolean>('studio.hasUnreadNotices', this.account.scopeKey).catch(() => undefined);
		if (revision === this.noticeRevision && !this._store.isDisposed && typeof unread === 'boolean' && unread !== this.socialUnread) {
			this.socialUnread = unread;
			this.paint();
		}
	}

	private async openInbox(conversation?: string, user?: string, action?: InboxAction, title?: string): Promise<void> {
		const target = conversation ? `conversation:${conversation}` : user ? `user:${user}` : action;
		if (!this.account?.signedIn || !target || this.inboxRequests.has(target)) { return; }
		const id = generateUuid();
		this.inboxRequests.set(target, id);
		this.view.closePicker();
		if (action) { this.view.setInboxActionBusy(action, true); }
		let opened = false;
		try {
			// Open the tab while the click still has user activation, not after the gateway round trip.
			if (!await this.app.open(id, title)) { return; }
			const result = await this.commands.executeCommand<true | string>('studio.openLaunchpadInbox', id, conversation, user, action, title).catch(() => undefined);
			opened = result === true;
			if (!opened && this.app.isOpen(id)) {
				this.notifications.warn(typeof result === 'string' ? result : studioLabel('Could not open IM', '无法打开 IM'));
			}
		} finally {
			if (!opened) { this.app.close(id); }
			if (this.inboxRequests.get(target) === id) {
				this.inboxRequests.delete(target);
				if (action) { this.view.setInboxActionBusy(action, false); }
			}
		}
	}

	private hostUri(uri: URI): URI | undefined {
		// A Node extension host can publish file: URI strings. Those paths live on the Studio host.
		if (uri.scheme === Schemas.file && !uri.authority) { return uri.with({ scheme: Schemas.vscodeRemote, authority: this.authority }); }
		if (uri.scheme === Schemas.vscodeRemote && uri.authority === this.authority) { return uri; }
		return undefined;
	}

	private async refreshProjects(): Promise<void> {
		const state = this.start.state;
		if (!state && !this.startVisibilitySettled) { return; }
		const revision = this.revision;
		const history = await this.workspaces.getRecentlyOpened();
		if (revision !== this.revision || this._store.isDisposed) { return; }
		const projects = new Map<string, LaunchpadProject>();
		const recent = new Map<string, RecentProject>();
		for (const row of state?.recent ?? []) {
			if (row.kind !== 'folder' && row.kind !== 'workspace') { continue; }
			const uri = this.hostUri(URI.parse(row.uri));
			if (!uri) { continue; }
			const key = uri.toString();
			if (!projects.has(key)) {
				recent.set(key, row);
				projects.set(key, { ...row, uri: key, kind: row.kind, name: row.projectName ?? row.label, path: this.labels.getUriLabel(uri) });
			}
		}
		for (const row of history.workspaces) {
			const folder = isRecentFolder(row), uri = folder ? row.folderUri : row.workspace.configPath;
			if (uri.scheme === Schemas.vscodeRemote && uri.authority === this.authority && !projects.has(uri.toString())) {
				projects.set(uri.toString(), { uri: uri.toString(), kind: folder ? 'folder' : 'workspace', name: row.label ?? basenameOrAuthority(uri), path: this.labels.getUriLabel(uri) });
			}
		}
		// Browser history keeps paths only. Use the host's file URIs so the desktop reader also matches installed-project records.
		const uninspected = new Map<string, LaunchpadProject>();
		for (const project of projects.values()) {
			if (project.kind === 'folder' && (!this.projects || !project.artwork)) {
				uninspected.set(URI.parse(project.uri).with({ scheme: Schemas.file, authority: '' }).toString(), project);
			}
		}
		if (state && uninspected.size) {
			const detected = await this.commands.executeCommand<(LaunchpadProjectMetadata & { uri: string })[]>('studio.internalDetectProjectTypes', [...uninspected.keys()]).catch(() => undefined);
			if (revision !== this.revision || this._store.isDisposed) { return; }
			for (const { uri, projectName, ...metadata } of detected ?? []) {
				const project = uninspected.get(uri);
				if (project) {
					projects.set(project.uri, { ...project, ...metadata, name: projectName ?? project.name });
				}
			}
		}
		this.recent = recent;
		this.projects = [...projects.values()];
		this.paint();
	}

	private async refreshBuiltins(scheduler: RunOnceScheduler): Promise<void> {
		const result = await this.commands.executeCommand<{ projects: LaunchpadProject[]; pending?: boolean }>('studio.internalListBuiltinProjects').catch(() => undefined);
		if (this._store.isDisposed || !result) { return; }
		this.builtinProjects = result.projects.flatMap(project => {
			const uri = this.hostUri(URI.parse(project.uri));
			return uri ? [{ ...project, uri: uri.toString(), builtin: true as const }] : [];
		});
		this.paint();
		if (result.pending && !document.hidden) { scheduler.schedule(1500); }
	}

	private paint(): void {
		const state = this.start.state;
		const builtins = new Set(this.builtinProjects?.map(project => project.uri));
		this.view.update({ windows: [], recent: this.projects?.filter(project => !builtins.has(project.uri)) ?? [], builtinProjects: this.builtinProjects,
			libraryLoading: this.projects === undefined,
			platform: !!state?.platform, account: this.account, inbox: this.inbox, store: state?.recommendations, canCreate: !!state?.canCreate && !state.busy,
			notices: this.notices.list(), notificationUnread: this.socialUnread || this.notices.hasUnread() });
	}

	private async importFolders(): Promise<void> {
		const uris = await this.dialogs.showOpenDialog({ title: studioLabel('Import project', '导入项目'), openLabel: studioLabel('Import', '导入'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: true, availableFileSystems: [Schemas.vscodeRemote] });
		if (!uris?.length || this._store.isDisposed) { return; }
		await this.workspaces.addRecentlyOpened(uris.map(folderUri => ({ folderUri })));
		if (!this._store.isDisposed) { this.view.showImportedProjects(uris.length === 1 ? uris[0].toString() : undefined); }
	}

	private async pickAndOpen(kind: 'folder' | 'workspace'): Promise<void> {
		const folder = kind === 'folder';
		const selection = await this.dialogs.showOpenDialog({
			title: folder ? studioLabel('Open folder', '打开文件夹') : studioLabel('Open workspace', '打开工作区'),
			canSelectFolders: folder, canSelectFiles: !folder, canSelectMany: false, availableFileSystems: [Schemas.vscodeRemote],
			filters: folder ? undefined : [{ name: studioLabel('Workspace', '工作区'), extensions: ['code-workspace'] }],
		});
		const uri = selection?.[0];
		if (uri?.scheme === Schemas.vscodeRemote && uri.authority === this.authority && !this._store.isDisposed) {
			await this.host.openWindow([folder ? { folderUri: uri } : { workspaceUri: uri }], { forceNewWindow: true });
		}
	}

	private async openProject(project: LaunchpadProject, entry?: { entryId?: string }): Promise<void> {
		const uri = URI.parse(project.uri);
		try {
			const stat = await this.files.stat(uri);
			if (!(project.kind === 'folder' ? stat.isDirectory : stat.isFile)) { throw new Error(studioLabel('The project path is no longer valid.', '项目路径已失效。')); }
		} catch (error) {
			if (!(error instanceof Error) || toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; }
			this.notifications.warn(studioLabel(`Project not found: ${project.path}`, `找不到项目：${project.path}`));
			return;
		}
		if (!this._store.isDisposed) {
			await this.host.openWindow([project.kind === 'folder' ? { folderUri: uri } : { workspaceUri: uri }], { forceNewWindow: true, studioProjectEntry: entry });
		}
	}

	private async removeProject(project: LaunchpadProject): Promise<void> {
		const record = this.recent.get(project.uri) ?? { uri: project.uri, kind: project.kind, label: project.name, lastOpened: 0 };
		if (await this.commands.executeCommand<boolean>('studio.removeRecentProject', record)) {
			await this.workspaces.removeRecentlyOpened([URI.parse(project.uri)]);
		}
	}
}
