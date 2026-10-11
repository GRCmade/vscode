/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import product from '../../../../../platform/product/common/product.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITunnelService, RemoteTunnel, TunnelPrivacyId } from '../../../../../platform/tunnel/common/tunnel.js';
import { IExternalUriOpenerService } from '../../../externalUriOpener/common/externalUriOpenerService.js';
import { Extensions, IViewContainersRegistry } from '../../../../common/views.js';
import { IActivityService } from '../../../../services/activity/common/activity.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { IRemoteExplorerService, TUNNEL_VIEW_CONTAINER_ID, TUNNEL_VIEW_ID } from '../../../../services/remote/common/remoteExplorerService.js';
import { forwardedPortsFeaturesEnabled, TunnelModel } from '../../../../services/remote/common/tunnelModel.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { ForwardedPortsView, isCandidateRemappedTunnelLocalEndpoint, OnAutoForwardedAction } from '../../browser/remoteExplorer.js';
import { TunnelPanel } from '../../browser/tunnelView.js';

suite('ForwardedPortsView', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('product-disabled Ports keeps forwarding enabled without creating an empty panel', async () => {
		const previous = product.disabledWorkbenchViews;
		const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
		const container = containers.get(TUNNEL_VIEW_CONTAINER_ID);
		const enablement: boolean[] = [];
		const contextKeys = store.add(new MockContextKeyService());
		contextKeys.createKey(forwardedPortsFeaturesEnabled.key, true);
		try {
			Object.assign(product, { disabledWorkbenchViews: [TUNNEL_VIEW_ID] });
			store.add(new ForwardedPortsView(
				contextKeys,
				new class extends mock<IWorkbenchEnvironmentService>() { },
				new class extends mock<IRemoteExplorerService>() {
					override enablePortsFeatures(viewOnly: boolean): void { enablement.push(viewOnly); }
				},
				new class extends mock<ITunnelService>() {
					override readonly onTunnelOpened = Event.None;
				},
				new class extends mock<IActivityService>() { },
				new class extends mock<IStatusbarService>() { },
			));
			await Promise.resolve();
			assert.deepStrictEqual({ enablement, container: containers.get(TUNNEL_VIEW_CONTAINER_ID) }, { enablement: [false], container });
		} finally {
			Object.assign(product, { disabledWorkbenchViews: previous });
		}
	});
});

suite('AutomaticPortForwarding', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves navigation links after elevating a port without interpreting its label', async () => {
		const label = '[Open](command:unexpected)';
		const tunnel: RemoteTunnel = {
			tunnelRemoteHost: 'localhost',
			tunnelRemotePort: 80,
			tunnelLocalPort: 8080,
			localAddress: 'localhost:8080',
			privacy: TunnelPrivacyId.Private,
			dispose: async () => { },
		};
		const elevatedTunnel: RemoteTunnel = { ...tunnel, tunnelLocalPort: 80, localAddress: 'localhost:80' };
		const prompts: Parameters<INotificationService['prompt']>[] = [];
		const notificationService = store.add(new class extends NotificationService {
			override prompt(...args: Parameters<INotificationService['prompt']>) {
				prompts.push(args);
				return super.prompt(...args);
			}
		}(store.add(new InMemoryStorageService())));
		store.add(toDisposable(() => {
			for (const notification of [...notificationService.model.notifications]) {
				notification.close();
			}
		}));
		const forwarded: Parameters<IRemoteExplorerService['forward']>[0][] = [];
		const action = store.add(new OnAutoForwardedAction(
			notificationService,
			new class extends mock<IRemoteExplorerService>() {
				override readonly tunnelModel = new class extends mock<TunnelModel>() {
					override async getAttributes() {
						return new Map([[80, { label, onAutoForward: undefined, elevateIfNeeded: undefined, requireLocalPort: undefined, protocol: undefined }]]);
					}
				};
				override async close(): Promise<void> { }
				override async forward(properties: Parameters<IRemoteExplorerService['forward']>[0]) {
					forwarded.push(properties);
					return elevatedTunnel;
				}
			},
			new class extends mock<IOpenerService>() { },
			new class extends mock<IExternalUriOpenerService>() { },
			new class extends mock<ITunnelService>() {
				override readonly canElevate = true;
				override isPortPrivileged(port: number): boolean { return port < 1024; }
			},
			new class extends mock<IHostService>() {
				override async hadLastFocus(): Promise<boolean> { return true; }
			},
			new NullLogService(),
			store.add(new MockContextKeyService()),
		));

		await action.doAction([tunnel]);
		const initial = notificationService.model.notifications[0].message;
		const elevateChoice = prompts[0][2].find(choice => choice.label === 'Use Port 80 as Sudo...');
		assert.ok(elevateChoice);
		await elevateChoice.run();
		const elevated = notificationService.model.notifications[0].message;

		assert.deepStrictEqual({
			notificationCount: notificationService.model.notifications.length,
			initialLinks: initial.linkedText.nodes.filter(node => typeof node !== 'string'),
			elevatedText: elevated.linkedText.toString(),
			elevatedLinks: elevated.linkedText.nodes.filter(node => typeof node !== 'string'),
			forwarded: forwarded.map(properties => ({ remote: properties.remote, local: properties.local, elevateIfNeeded: properties.elevateIfNeeded })),
		}, {
			notificationCount: 1,
			initialLinks: [{ label: 'See all forwarded ports', href: `command:${TunnelPanel.ID}.focus` }],
			elevatedText: `Your application (${label}) running on port 80 is available.  See all forwarded ports`,
			elevatedLinks: [{ label: 'See all forwarded ports', href: `command:${TunnelPanel.ID}.focus` }],
			forwarded: [{ remote: { host: 'localhost', port: 80 }, local: 80, elevateIfNeeded: true }],
		});
	});

	test('identifies remapped local tunnel ports', () => {
		const tunnels = [
			{ remotePort: 3000, localPort: 3001 },
			{ remotePort: 4000, localPort: 4000 },
			{ remotePort: 5000, localPort: undefined },
		];
		const candidates = [
			{ host: 'localhost', port: 3001 },
			{ host: '127.0.0.1', port: 3001 },
			{ host: '0.0.0.0', port: 3001 },
			{ host: 'example.com', port: 3001 },
			{ host: 'localhost', port: 3000 },
			{ host: 'localhost', port: 4000 },
			{ host: 'localhost', port: 5000 },
			{ host: 'localhost', port: 6000 },
		];

		assert.deepStrictEqual(candidates.map(candidate => isCandidateRemappedTunnelLocalEndpoint(candidate, tunnels)), [
			true,
			true,
			true,
			false,
			false,
			false,
			false,
			false,
		]);
	});
});
