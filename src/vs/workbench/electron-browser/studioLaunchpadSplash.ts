/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { STEAMHARNESS_ICON_DATA_URI } from '../common/studioBranding.js';

const splashId = 'studio-launchpad-splash';

// Inline styles and the embedded logo are available before the workbench bundle loads.
const splashStyles = `
	#${splashId} {
		position: fixed;
		inset: 0;
		z-index: 2;
		isolation: isolate;
		display: grid;
		place-items: safe center;
		box-sizing: border-box;
		padding: 28px 20px;
		overflow: auto;
		scrollbar-color: transparent transparent;
		background: var(--studio-splash-background);
		color: var(--studio-splash-foreground);
		font: 13px/1.5 system-ui, sans-serif;
		user-select: text;
	}
	#${splashId}:hover { scrollbar-color: currentColor transparent; }
	#${splashId} .studio-splash-drag {
		position: absolute;
		inset: 0 0 auto;
		height: 28px;
		-webkit-app-region: drag;
	}
	#${splashId}:not(.high-contrast)::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		background: radial-gradient(circle, currentColor 1px, transparent 1px) center / 20px 20px;
		mask-image: radial-gradient(ellipse closest-side, #000, transparent);
		opacity: .16;
		pointer-events: none;
	}
	#${splashId} .studio-splash-identity {
		display: grid;
		justify-items: center;
		min-width: 0;
		text-align: center;
	}
	#${splashId} h1 {
		margin: 14px 0 4px;
		font-size: 22px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	#${splashId} p { margin: 0; }
	#${splashId}:not(.high-contrast) p {
		color: color-mix(in srgb, currentColor 78%, var(--studio-splash-background));
	}
	#${splashId} .studio-splash-progress {
		width: 92px;
		height: 3px;
		margin-top: 20px;
		border-radius: 2px;
		overflow: hidden;
		background: color-mix(in srgb, currentColor 18%, transparent);
	}
	#${splashId} .studio-splash-progress::after {
		content: '';
		display: block;
		width: 32px;
		height: 100%;
		margin-inline: auto;
		border-radius: inherit;
		background: currentColor;
		forced-color-adjust: none;
	}
	#${splashId}:not(.reduce-motion) .studio-splash-progress::after {
		animation: studio-splash-progress 1.2s ease-in-out infinite alternate;
	}
	#${splashId} [hidden] { display: none; }
	#${splashId} button {
		margin-top: 16px;
		padding: 4px 12px;
		border: 1px solid currentColor;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	#${splashId} button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
	#${splashId} button:focus:not(:focus-visible) { outline: none; }
	@media (forced-colors: active) {
		#${splashId}::before { display: none; }
		#${splashId} .studio-splash-progress::after { background: CanvasText; }
	}
	@keyframes studio-splash-progress {
		from { transform: translateX(-30px); }
		to { transform: translateX(30px); }
	}
`;

export function showStudioLaunchpadSplash(targetDocument: Document, options: {
	baseTheme?: string;
	background?: string;
	foreground?: string;
	language?: string;
	reduceMotion?: boolean;
	retry: () => void;
}): { readonly logoReady: Promise<void>; showError(slow: boolean): void } {
	const splash = targetDocument.createElement('div');
	splash.id = splashId;
	const light = options.baseTheme === 'vs' || options.baseTheme === 'hc-light';
	const highContrast = options.baseTheme === 'hc-light' || options.baseTheme === 'hc-black';
	splash.classList.toggle('high-contrast', highContrast);
	splash.classList.toggle('reduce-motion', options.reduceMotion ?? targetDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false);
	splash.style.setProperty('--studio-splash-background', options.background ?? (light ? '#ffffff' : '#181818'));
	splash.style.setProperty('--studio-splash-foreground', options.foreground ?? (light ? '#202020' : '#eeeeee'));

	const style = targetDocument.createElement('style');
	style.textContent = splashStyles;
	const drag = targetDocument.createElement('div');
	drag.className = 'studio-splash-drag';
	drag.setAttribute('aria-hidden', 'true');
	const identity = targetDocument.createElement('div');
	identity.className = 'studio-splash-identity';
	const logo = targetDocument.createElement('img');
	logo.alt = '';
	logo.width = logo.height = 80;
	logo.src = STEAMHARNESS_ICON_DATA_URI;
	const name = targetDocument.createElement('h1');
	name.textContent = 'SteamHarness Studio';
	const chinese = options.language?.toLowerCase() === 'zh-cn';
	const status = targetDocument.createElement('p');
	status.setAttribute('role', 'status');
	status.textContent = chinese ? '正在打开启动台…' : 'Opening Launchpad…';
	const progress = targetDocument.createElement('div');
	progress.className = 'studio-splash-progress';
	progress.setAttribute('aria-hidden', 'true');
	const retry = targetDocument.createElement('button');
	retry.type = 'button';
	retry.textContent = chinese ? '重试' : 'Retry';
	retry.hidden = true;
	retry.addEventListener('click', options.retry, { once: true });
	identity.append(logo, name, status, progress, retry);
	splash.append(style, drag, identity);
	targetDocument.body.append(splash);
	return {
		logoReady: logo.decode().catch(() => undefined),
		showError(slow) {
			if (!splash.isConnected) {
				return;
			}
			status.setAttribute('role', 'alert');
			status.textContent = slow
				? (chinese ? '启动台暂未就绪' : 'Launchpad is taking longer than expected')
				: (chinese ? '无法打开启动台' : 'Could not open Launchpad');
			progress.hidden = true;
			if (!slow) {
				// A failed workbench may already have mounted interactive controls behind the splash.
				// eslint-disable-next-line no-restricted-syntax
				const workbench = targetDocument.querySelector<HTMLElement>('.monaco-workbench.studio-launchpad-window');
				if (workbench) {
					workbench.inert = true;
				}
			}
			if (retry.hidden) {
				retry.hidden = false;
				retry.focus({ preventScroll: true });
			}
		},
	};
}

export function removeStudioLaunchpadSplash(targetDocument: Document): void {
	// Bootstrap and workbench load independently, so hand off via the splash's DOM ID.
	// eslint-disable-next-line no-restricted-syntax
	targetDocument.getElementById(splashId)?.remove();
}
