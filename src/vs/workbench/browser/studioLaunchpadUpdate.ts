/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../base/common/lifecycle.js';
import { StateType, type IUpdateService, type State } from '../../platform/update/common/update.js';
import { button, element, icon, type StudioLabel } from './studioUiElements.js';

type LaunchpadUpdater = Pick<IUpdateService, 'state' | 'onStateChange' | 'checkForUpdates' | 'downloadUpdate' | 'applyUpdate' | 'quitAndInstall'>;
type UpdateAction = 'check' | 'download' | 'apply' | 'restart';

export interface LaunchpadVersion {
	version: string;
	updater?: LaunchpadUpdater;
}

export class StudioLaunchpadUpdate extends Disposable {
	readonly element = element('div', 'lp-release');
	private readonly status = element('span', 'lp-update-status');
	private readonly progress = element('progress', 'lp-update-progress');
	private readonly action: HTMLButtonElement;
	private actionId?: UpdateAction;
	private running = false;
	private failed = false;

	constructor(private readonly t: StudioLabel, { version, updater }: LaunchpadVersion) {
		super();
		this.element.classList.toggle('lp-managed-release', !!updater);
		const label = element('span', 'lp-release-version', `v${version}`);
		label.title = `${t('Studio version', 'Studio 版本')} ${version}`;
		this.status.setAttribute('role', 'status');
		this.progress.max = 100;
		this.progress.setAttribute('aria-label', t('Update download progress', '更新下载进度'));
		this.action = button('', '', () => { if (updater) { void this.run(updater); } }, 'lp-update-action');
		this.element.append(label, this.action, this.status, this.progress);
		this.render(updater?.state);
		if (updater) {
			this._register(updater.onStateChange(state => { this.failed = false; this.render(state); }));
		}
	}

	private async run(updater: LaunchpadUpdater): Promise<void> {
		const action = this.actionId;
		if (!action || this.running) { return; }
		this.running = true;
		this.failed = false;
		this.render(updater.state);
		try {
			switch (action) {
				case 'check': await updater.checkForUpdates(true); break;
				case 'download': await updater.downloadUpdate(true); break;
				case 'apply': await updater.applyUpdate(); break;
				case 'restart': await updater.quitAndInstall(); break;
			}
		} catch {
			this.failed = true;
		} finally {
			this.running = false;
			this.render(updater.state);
		}
	}

	private render(state?: State): void {
		const t = this.t;
		const version = state && 'update' in state ? state.update?.productVersion : undefined;
		let message = '', actionLabel = '', glyph = '';
		let action: UpdateAction | undefined;
		switch (state?.type) {
			case StateType.Idle:
				action = 'check'; glyph = 'refresh'; actionLabel = t('Check for updates', '检查更新');
				if (state.error) { message = t('Update failed', '更新失败'); }
				else if (state.notAvailable) { message = t('Up to date', '已是最新版本'); }
				break;
			case StateType.CheckingForUpdates: message = t('Checking for updates…', '正在检查更新…'); break;
			case StateType.AvailableForDownload:
				action = 'download'; glyph = 'cloud-download';
				actionLabel = state.canInstall === false ? t('Open download', '打开下载页') : t('Download update', '下载更新');
				message = version ? `v${version}` : '';
				break;
			case StateType.Downloading: message = t('Downloading update…', '正在下载更新…'); break;
			case StateType.Downloaded:
				action = 'apply'; glyph = 'cloud-download'; actionLabel = t('Install update', '安装更新');
				message = version ? `v${version}` : '';
				break;
			case StateType.Updating: message = t('Preparing installation…', '正在准备安装…'); break;
			case StateType.Ready:
				action = 'restart'; glyph = 'debug-restart'; actionLabel = t('Restart to install', '重启并安装');
				message = version ? `v${version}` : '';
				break;
			case StateType.Restarting: message = t('Restarting…', '正在重启…'); break;
			case StateType.Overwriting: message = t('Downloading a newer update…', '正在下载较新的更新…'); break;
			case StateType.Cancelling: message = t('Cancelling update…', '正在取消更新…'); break;
			case StateType.Disabled: message = t('Updates unavailable', '当前无法更新'); break;
		}
		if (this.failed) { message = t('Update failed. Try again.', '更新失败，请重试'); }
		this.actionId = action;
		this.action.hidden = !action;
		this.action.disabled = this.running;
		if (this.action.title !== actionLabel) {
			this.action.title = actionLabel;
			this.action.replaceChildren(...(glyph ? [icon(glyph), element('span', '', actionLabel)] : []));
		}
		if (this.status.textContent !== message) {
			this.status.textContent = message;
			this.status.title = message;
		}
		this.progress.hidden = state?.type !== StateType.Downloading;
		if (state?.type === StateType.Downloading && state.totalBytes && state.downloadedBytes !== undefined) {
			this.progress.value = Math.min(100, Math.round(state.downloadedBytes / state.totalBytes * 100));
		} else {
			this.progress.removeAttribute('value');
		}
	}
}
