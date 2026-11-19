/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { Event } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspacesService, isRecentFolder, isStoredWorkspaceFolder, toWorkspaceFolders } from '../../../../platform/workspaces/common/workspaces.js';
import * as json from '../../../../base/common/json.js';
import { isStudioSidebarTab, setStudioSidebarOrder } from '../../../common/studioSidebar.js';
import { Extensions, ICustomViewDescriptor, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { WebviewViewPane } from '../../../contrib/webviewView/browser/webviewViewPane.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewPaneContainer } from '../views/viewPaneContainer.js';

interface SidebarTab {
	id: string;
	viewId: string;
	title: string;
	icon: string;
}

const registered = new Map<string, { tab: SidebarTab; container: ViewContainer }>();
let watchingTrust = false;

CommandsRegistry.registerCommand('studio.internalSyncSidebarTabs', (accessor, tabs: readonly SidebarTab[]) => {
	// Instantiate the service before registrations so the native containers and focus commands are ready.
	const viewsService = accessor.get(IViewsService);
	const layout = accessor.get(IWorkbenchLayoutService);
	const panes = accessor.get(IPaneCompositePartService);
	const location = ViewContainerLocation.AuxiliaryBar;
	const lastActive = panes.getLastActivePaneCompositeId(location);
	const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
	const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
	const next = new Map<string, SidebarTab>();
	const viewIds = new Set<string>();
	for (const tab of Array.isArray(tabs) ? tabs : []) {
		if (tab && typeof tab.id === 'string' && isStudioSidebarTab(tab.id) && typeof tab.viewId === 'string' &&
			/^studio\.[\w.-]{1,100}$/.test(tab.viewId) && typeof tab.title === 'string' && tab.title.trim() &&
			tab.title.length <= 256 && typeof tab.icon === 'string' && /^[a-z-]+$/.test(tab.icon) && !next.has(tab.id) && !viewIds.has(tab.viewId)) {
			next.set(tab.id, tab);
			viewIds.add(tab.viewId);
		}
	}
	for (const [id, { tab, container }] of registered) {
		const descriptor = next.get(id);
		if (!descriptor || tab.viewId !== descriptor.viewId || tab.title !== descriptor.title || tab.icon !== descriptor.icon) {
			views.deregisterViews(views.getViews(container), container);
			containers.deregisterViewContainer(container);
			registered.delete(id);
		}
	}
	for (const tab of next.values()) {
		if (registered.has(tab.id) || views.getView(tab.viewId) || containers.get(tab.id)) { continue; }
		const title = { value: tab.title, original: tab.title };
		const icon = ThemeIcon.fromId(tab.icon);
		const extensionId = new ExtensionIdentifier('studio.studio-workstation');
		const container = containers.registerViewContainer({
			id: tab.id, title, icon, extensionId, rejectAddedViews: true, alwaysUseContainerInfo: true,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [tab.id, { mergeViewWithContainerWhenSingleView: true }]),
			...(tab.id === 'studio-assistant' ? { openCommandActionDescriptor: { id: 'workbench.view.extension.studio-assistant' } } : {}),
		}, location);
		registered.set(tab.id, { tab, container });
		const view: ICustomViewDescriptor = {
			id: tab.viewId, type: 'webview', name: title, containerIcon: icon, extensionId,
			originalContainerId: tab.id,
			ctorDescriptor: new SyncDescriptor(WebviewViewPane), canToggleVisibility: false, canMoveView: false,
		};
		views.registerViews([view], container);
	}
	setStudioSidebarOrder([...next.keys()].filter(id => registered.has(id)));
	// Restore an already visible sidebar without revealing a collapsed one or taking editor focus.
	if (layout.isVisible(Parts.AUXILIARYBAR_PART) && !panes.getActivePaneComposite(location)) {
		const restore = registered.has(lastActive) ? lastActive : 'studio-assistant';
		if (registered.has(restore)) { void viewsService.openViewContainer(restore, false).catch(() => undefined); }
	}
});

CommandsRegistry.registerCommand('studio.internalSidebarHistory', async accessor => {
	const workspaces = accessor.get(IWorkspacesService);
	const files = accessor.get(IFileService);
	const extUri = accessor.get(IUriIdentityService).extUri;
	const recent = (await workspaces.getRecentlyOpened()).workspaces.filter(item => !item.remoteAuthority);
	const folders = new Set<string>();
	// Workspace files are data only. Do not open a workspace or activate any of its projects here.
	for (let i = 0; i < recent.length; i += 12) {
		const batch = await Promise.all(recent.slice(i, i + 12).map(async item => {
			if (isRecentFolder(item)) { return [item.folderUri]; }
			const file = item.workspace.configPath;
			if (file.scheme !== 'file') { return []; }
			try {
				const contents = await files.readFile(file, { limits: { size: 1024 * 1024 } });
				const stored = json.parse(contents.value.toString());
				return Array.isArray(stored?.folders) ? toWorkspaceFolders(stored.folders.filter(isStoredWorkspaceFolder), file, extUri).map(folder => folder.uri) : [];
			} catch { return []; }
		}));
		for (const folder of batch.flat()) {
			if (folder.scheme === 'file' && !folder.query && !folder.fragment) { folders.add(folder.toString()); }
		}
	}
	return [...folders];
});

CommandsRegistry.registerCommand('studio.internalSidebarProjectTrust', async (accessor, resource: string, interactive?: boolean) => {
	const enablement = accessor.get(IWorkspaceTrustEnablementService);
	const trust = accessor.get(IWorkspaceTrustManagementService);
	const request = accessor.get(IWorkspaceTrustRequestService);
	const uri = URI.parse(resource);
	if (uri.scheme !== 'file' || uri.query || uri.fragment) { return false; }
	await trust.workspaceTrustInitialized;
	return !enablement.isWorkspaceTrustEnabled() || (await trust.getUriTrustInfo(uri)).trusted ||
		(interactive === true && await request.requestResourcesTrust({ uri, message: localize('studio.sidebarTrust', "Trust this project folder before running it in the secondary side bar.") }) === true);
});

CommandsRegistry.registerCommand('studio.internalWatchSidebarTrust', accessor => {
	if (watchingTrust) { return; }
	watchingTrust = true;
	const commands = accessor.get(ICommandService);
	const trust = accessor.get(IWorkspaceTrustManagementService);
	Event.any(trust.onDidChangeTrustedFolders, trust.onDidChangeTrust)(() => void commands.executeCommand('studio.internalSidebarTrustChanged').catch(() => undefined));
});
