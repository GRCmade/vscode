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
import { getNLSLanguage } from '../../nls.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../platform/dialogs/common/dialogs.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../platform/files/common/files.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { ILabelService } from '../../platform/label/common/label.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IStorageService, WillSaveStateReason } from '../../platform/storage/common/storage.js';
import { IWorkspacesService, isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { IWebviewService } from '../contrib/webview/browser/webview.js';
import { IWebviewViewService } from '../contrib/webviewView/browser/webviewViewService.js';
import { IHostService } from '../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../services/layout/browser/layoutService.js';
import { IStatusbarService, StatusbarAlignment } from '../services/statusbar/browser/statusbar.js';
import { IStudioStartService, StudioStartState } from './parts/editor/studioStart.js';
import { LaunchpadProject, StudioLaunchpadView } from './studioLaunchpadView.js';
import { StudioLaunchpadSettings } from './studioLaunchpadSettings.js';
import { CatalogPage } from './studioLaunchpadStore.js';
import { StoreListingDetails } from './studioLaunchpadCards.js';
import './media/studioLaunchpad.css';

function studioLabel(en: string, zh: string): string { return getNLSLanguage()?.startsWith('zh') ? zh : en; }

type RecentProject = StudioStartState['recent'][number];

export class StudioWebLaunchpadNavigation extends Disposable {

	constructor(@IStatusbarService statusbar: IStatusbarService, @IStorageService storage: IStorageService) {
		super();
		const title = studioLabel('Studio Launchpad', 'Studio 启动台');
		this._register(CommandsRegistry.registerCommand('studio.showLaunchpad', async () => {
			await storage.flush(WillSaveStateReason.SHUTDOWN);
			const home = new URL(mainWindow.location.href);
			home.search = '?launchpad=1';
			home.hash = '';
			mainWindow.location.assign(home);
		}));
		this._register(statusbar.addEntry({ name: title, text: '$(home) ' + title, ariaLabel: title, tooltip: title, command: 'studio.showLaunchpad' },
			'studio.showLaunchpad', StatusbarAlignment.LEFT, 100));
	}
}

export class StudioWebLaunchpad extends Disposable {

	private readonly view: StudioLaunchpadView;
	private readonly settings: StudioLaunchpadSettings;
	private projects: LaunchpadProject[] = [];
	private recent = new Map<string, RecentProject>();
	private builtinProjects?: LaunchpadProject[];
	private revision = 0;

	constructor(
		private readonly authority: string,
		@IStudioStartService private readonly start: IStudioStartService,
		@IWorkbenchLayoutService layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IHostService private readonly host: IHostService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
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
	) {
		super();
		const run = (operation: Promise<unknown>) => { void operation.catch(error => notifications.error(error)); };
		const openSettings = (section: string) => run(commands.executeCommand('studio.openSettings', { section, target: 'user' }));
		this.view = this._register(new StudioLaunchpadView(getNLSLanguage() ?? 'en', {
			open: () => run(this.pickAndOpen('folder')),
			workspace: () => run(this.pickAndOpen('workspace')),
			create: () => run(commands.executeCommand('studio.createProject')),
			importProjects: () => run(this.importFolders()),
			project: project => run(this.openProject(project)),
			remove: project => run(this.removeProject(project)),
			copyPath: project => run(clipboard.writeText(project.path)),
			// The browser opens the workbench first. Project entries can be run from there.
			canRunEntries: false,
			openLabel: () => studioLabel('Open in workbench', '在工作台打开'),
			contextMenu, hoverService,
			cover: async () => undefined,
			settings: () => openSettings('general'),
			account: () => openSettings('account'),
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
			start.setVisible('launchpad', false);
			for (const part of parts) { part.inert = false; }
			this.view.element.remove();
		}));

		const visible = () => start.setVisible('launchpad', !document.hidden && !this.view.element.hidden);
		const showHome = () => {
			this.settings.close();
			this.view.setVisible(true);
			this.view.focusSettings();
			visible();
		};
		this.settings = this._register(new StudioLaunchpadSettings(root, studioLabel, showHome, () => {
			this.view.closePicker();
			this.view.setVisible(false);
			visible();
		}, message => notifications.error(message), webviews, webviewViews));
		this._register(CommandsRegistry.registerCommand('studio.internalShowLaunchpadSettings', (_accessor, title: string) => this.settings.show(title, this.view.element.classList.contains('lp-pointer'))));
		this._register(CommandsRegistry.registerCommand('studio.internalCloseLaunchpadSettings', () => { if (this.settings.isOpen) { showHome(); } }));
		this._register(CommandsRegistry.registerCommand('studio.internalRevealStore', () => { showHome(); this.view.select('store'); return true; }));
		this._register(addDisposableListener(mainWindow, 'keydown', event => this.view.shortcut(event), true));
		this._register(addDisposableListener(document, 'visibilitychange', visible));

		const refresh = this._register(new RunOnceScheduler(() => run(this.refreshProjects()), 100));
		const changed = () => { ++this.revision; refresh.schedule(); };
		this._register(workspaces.onDidChangeRecentlyOpened(changed));
		this._register(start.onDidChange(changed));
		this._register(addDisposableListener(mainWindow, 'focus', changed));
		const builtins = this._register(new RunOnceScheduler(() => run(this.refreshBuiltins(builtins)), 100));
		const loadBuiltins = () => {
			if (start.state && !document.hidden && !builtins.isScheduled()) { builtins.schedule(); }
		};
		this._register(addDisposableListener(document, 'visibilitychange', loadBuiltins));
		this._register(start.onDidChange(() => { if (!this.builtinProjects) { loadBuiltins(); } }));
		this.view.element.focus({ preventScroll: true });
		this.paint();
		visible();
		loadBuiltins();
		changed();
	}

	private hostUri(uri: URI): URI | undefined {
		// A Node extension host can publish file: URI strings. Those paths live on the Studio host.
		if (uri.scheme === Schemas.file && !uri.authority) { return uri.with({ scheme: Schemas.vscodeRemote, authority: this.authority }); }
		if (uri.scheme === Schemas.vscodeRemote && uri.authority === this.authority) { return uri; }
		return undefined;
	}

	private async refreshProjects(): Promise<void> {
		const revision = this.revision;
		const history = await this.workspaces.getRecentlyOpened();
		if (revision !== this.revision || this._store.isDisposed) { return; }
		const projects = new Map<string, LaunchpadProject>();
		this.recent = new Map();
		for (const row of this.start.state?.recent ?? []) {
			if (row.kind !== 'folder' && row.kind !== 'workspace') { continue; }
			const uri = this.hostUri(URI.parse(row.uri));
			if (!uri) { continue; }
			const key = uri.toString();
			if (!projects.has(key)) {
				this.recent.set(key, row);
				projects.set(key, { ...row, uri: key, kind: row.kind, name: row.projectName ?? row.label, path: this.labels.getUriLabel(uri) });
			}
		}
		for (const row of history.workspaces) {
			const folder = isRecentFolder(row), uri = folder ? row.folderUri : row.workspace.configPath;
			if (uri.scheme === Schemas.vscodeRemote && uri.authority === this.authority && !projects.has(uri.toString())) {
				projects.set(uri.toString(), { uri: uri.toString(), kind: folder ? 'folder' : 'workspace', name: row.label ?? basenameOrAuthority(uri), path: this.labels.getUriLabel(uri) });
			}
		}
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
		this.view.update({ windows: [], recent: this.projects.filter(project => !builtins.has(project.uri)), builtinProjects: this.builtinProjects,
			platform: !!state?.platform, store: state?.recommendations, canCreate: !!state?.canCreate && !state.busy, notices: [], notificationUnread: false });
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
			await this.host.openWindow([folder ? { folderUri: uri } : { workspaceUri: uri }], { forceReuseWindow: true });
		}
	}

	private async openProject(project: LaunchpadProject): Promise<void> {
		const uri = URI.parse(project.uri);
		try {
			const stat = await this.files.stat(uri);
			if (!(project.kind === 'folder' ? stat.isDirectory : stat.isFile)) { throw new Error(studioLabel('The project path is no longer valid.', '项目路径已失效。')); }
		} catch (error) {
			if (!(error instanceof Error) || toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; }
			this.notifications.warn(studioLabel(`Project not found: ${project.path}`, `找不到项目：${project.path}`));
			return;
		}
		if (!this._store.isDisposed) { await this.host.openWindow([project.kind === 'folder' ? { folderUri: uri } : { workspaceUri: uri }], { forceReuseWindow: true }); }
	}

	private async removeProject(project: LaunchpadProject): Promise<void> {
		const record = this.recent.get(project.uri) ?? { uri: project.uri, kind: project.kind, label: project.name, lastOpened: 0 };
		if (await this.commands.executeCommand<boolean>('studio.removeRecentProject', record)) {
			await this.workspaces.removeRecentlyOpened([URI.parse(project.uri)]);
		}
	}
}
