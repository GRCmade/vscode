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
		place-items: center;
		box-sizing: border-box;
		padding: 20px;
		background: var(--studio-splash-background);
		color: var(--studio-splash-foreground);
		font: 13px/1.5 system-ui, sans-serif;
		user-select: text;
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
	@media (forced-colors: active) {
		#${splashId}::before { display: none; }
		#${splashId} .studio-splash-progress::after { background: CanvasText; }
	}
	@media (prefers-reduced-motion: no-preference) {
		#${splashId}:not(.reduce-motion) .studio-splash-progress::after {
			animation: studio-splash-progress 1.2s ease-in-out infinite alternate;
		}
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
}): void {
	const splash = targetDocument.createElement('div');
	splash.id = splashId;
	const light = options.baseTheme === 'vs' || options.baseTheme === 'hc-light';
	const highContrast = options.baseTheme === 'hc-light' || options.baseTheme === 'hc-black';
	splash.classList.toggle('high-contrast', highContrast);
	splash.classList.toggle('reduce-motion', !!options.reduceMotion);
	splash.style.setProperty('--studio-splash-background', options.background ?? (light ? '#ffffff' : '#181818'));
	splash.style.setProperty('--studio-splash-foreground', options.foreground ?? (light ? '#202020' : '#eeeeee'));

	const style = targetDocument.createElement('style');
	style.textContent = splashStyles;
	const identity = targetDocument.createElement('div');
	identity.className = 'studio-splash-identity';
	const logo = targetDocument.createElement('img');
	logo.alt = '';
	logo.width = logo.height = 80;
	logo.src = STEAMHARNESS_ICON_DATA_URI;
	const name = targetDocument.createElement('h1');
	name.textContent = 'SteamHarness Studio';
	const status = targetDocument.createElement('p');
	status.setAttribute('role', 'status');
	status.textContent = options.language?.toLowerCase() === 'zh-cn' ? '正在打开启动台…' : 'Opening Launchpad…';
	const progress = targetDocument.createElement('div');
	progress.className = 'studio-splash-progress';
	progress.setAttribute('aria-hidden', 'true');
	identity.append(logo, name, status, progress);
	splash.append(style, identity);
	targetDocument.body.append(splash);
}

export function removeStudioLaunchpadSplash(targetDocument: Document): void {
	// Bootstrap and workbench load independently, so hand off via the splash's DOM ID.
	// eslint-disable-next-line no-restricted-syntax
	targetDocument.getElementById(splashId)?.remove();
}
