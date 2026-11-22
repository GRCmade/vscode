/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type StudioLabel = (en: string, zh: string) => string;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text;
	return node;
}

export function icon(name: string): HTMLElement {
	const node = element('span', `codicon codicon-${name}`);
	node.setAttribute('aria-hidden', 'true');
	return node;
}

export function button(text: string, glyph: string, action: () => void, className = ''): HTMLButtonElement {
	const node = element('button', className);
	node.type = 'button';
	if (glyph) { node.append(icon(glyph)); }
	node.append(text);
	node.addEventListener('click', action);
	return node;
}

export function picture(src: string, className = ''): HTMLImageElement {
	const img = element('img', className);
	img.alt = ''; img.draggable = false; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.src = src;
	return img;
}
