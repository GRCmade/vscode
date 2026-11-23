/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This sandboxed preload uses the DOM without exposing any IPC bridge to the page.
(() => {
	type IStudioTrayPreview = import('../common/studioTrayNotifications.js').IStudioTrayPreview;
	const { ipcRenderer } = require('electron') as typeof import('electron');
	window.addEventListener('DOMContentLoaded', () => {
		const heading = document.getElementById('heading')!;
		const list = document.getElementById('notices')!;
		const button = document.getElementById('read-all') as HTMLButtonElement;
		const status = document.getElementById('status')!;
		let preview: IStudioTrayPreview | undefined;
		let pending = false;
		let failed = false;
		const renderButton = () => {
			if (!preview) { return; }
			button.disabled = pending || !preview.count;
			button.textContent = pending ? preview.labels.reading : preview.labels.readAll;
			status.hidden = !failed;
			status.textContent = failed ? preview.labels.failed : '';
		};
		ipcRenderer.on('vscode:studioTray:preview', (_event, state: IStudioTrayPreview) => {
			document.documentElement.lang = state.language;
			heading.textContent = state.labels.title;
			// Keep the current selection and scroll position if only the badge changed.
			if (!preview || JSON.stringify(preview.items) !== JSON.stringify(state.items)) {
				const rows = (state.items.length ? state.items : [{ title: state.labels.noPreview }]).map(item => {
					const row = document.createElement('li');
					const title = document.createElement('strong');
					title.textContent = item.title;
					row.append(title);
					if (item.detail) {
						const detail = document.createElement('p');
						detail.textContent = item.detail;
						row.append(detail);
					}
					return row;
				});
				list.replaceChildren(...rows);
			}
			preview = state;
			renderButton();
		});
		button.addEventListener('click', async () => {
			if (pending || !preview?.count) { return; }
			pending = true;
			failed = false;
			renderButton();
			try { failed = !await ipcRenderer.invoke('vscode:studioTray:readAll'); }
			catch { failed = true; }
			finally { pending = false; renderButton(); }
		});
	});
})();
