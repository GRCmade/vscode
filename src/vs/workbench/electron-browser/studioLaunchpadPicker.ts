/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { button, element, icon, type StudioLabel } from '../browser/studioUiElements.js';

export { button, element, icon } from '../browser/studioUiElements.js';

export interface LaunchpadOption { label: string; glyph: string; detail?: string; visible?(): boolean; run(): void }
export type LaunchpadLabel = StudioLabel;

/** Only launchpad actions are offered here; the workbench command palette belongs to project windows. */
export class LaunchpadPicker {
	readonly dialog = element('dialog', 'lp-dialog lp-scroll');
	private origin?: HTMLElement;
	private refresh?: () => void;
	private toggleMode?: (commands: boolean) => void;

	constructor(private readonly t: LaunchpadLabel) {
		this.dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
		this.dialog.addEventListener('click', e => {
			const r = this.dialog.getBoundingClientRect();
			if (e.target === this.dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) { this.close(); }
		});
	}

	close(): void {
		if (!this.dialog.open) { return; }
		this.dialog.close();
		this.refresh = this.toggleMode = undefined;
		this.origin?.setAttribute('aria-expanded', 'false');
		if (this.origin?.isConnected) { this.origin.focus({ preventScroll: true }); }
		this.origin = undefined;
	}

	update(): void { this.refresh?.(); }

	private open(title: string, origin: HTMLElement, quick: boolean): void {
		this.close();
		this.origin = origin;
		origin.setAttribute('aria-expanded', 'true');
		this.dialog.classList.toggle('lp-quick', quick);
		this.dialog.setAttribute('aria-label', title);
		this.dialog.replaceChildren();
		this.dialog.showModal();
	}

	choices(title: string, options: LaunchpadOption[], origin: HTMLElement, detail?: string | HTMLElement): void {
		this.open(title, origin, false);
		this.dialog.append(element('h2', '', title));
		if (detail) { this.dialog.append(typeof detail === 'string' ? element('p', 'lp-dialog-detail', detail) : detail); }
		const choices = options.map(item => button(item.label, item.glyph, () => { this.close(); item.run(); }, 'lp-choice'));
		this.dialog.append(...choices);
		const close = button(this.t('Close', '关闭'), 'close', () => this.close(), 'lp-dismiss');
		this.dialog.append(close);
		const first = () => choices.find(choice => !choice.hidden) ?? close;
		this.refresh = () => {
			const active = document.activeElement;
			for (const [index, choice] of choices.entries()) {
				choice.hidden = options[index].visible?.() === false;
			}
			if (choices.some(choice => choice === active && choice.hidden)) { first().focus({ preventScroll: true }); }
		};
		this.refresh();
		first().focus({ preventScroll: true });
	}

	search(commands: boolean, origin: HTMLElement, options: (commands: boolean) => LaunchpadOption[]): void {
		if (this.toggleMode) { this.toggleMode(commands); return; }
		const t = this.t;
		this.open(t('Command center', '命令中心'), origin, true);
		const input = element('input', 'lp-query');
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-controls', 'lp-results');
		input.setAttribute('aria-expanded', 'true');
		input.setAttribute('aria-autocomplete', 'list');
		input.autocomplete = 'off'; input.spellcheck = false;
		const filter = element('div', 'lp-filter');
		const close = button('', 'close', () => this.close(), 'lp-tool');
		close.title = t('Close command center', '关闭命令中心'); close.setAttribute('aria-label', close.title);
		filter.append(input, close);
		const heading = element('div', 'lp-quick-heading');
		heading.id = 'lp-quick-heading';
		const results = element('div', 'lp-results lp-scroll');
		results.id = 'lp-results'; results.setAttribute('role', 'listbox'); results.setAttribute('aria-labelledby', heading.id);
		const empty = element('p', 'lp-quick-empty'); empty.setAttribute('role', 'status');
		const foot = element('footer', 'lp-quick-foot');
		const swap = button('', '', () => this.toggleMode?.(!input.value.trimStart().startsWith('>')), 'lp-link');
		foot.append(swap);
		this.dialog.append(filter, heading, results, empty, foot);
		let items: LaunchpadOption[] = [], index = 0;
		const select = (scroll: boolean) => {
			for (let i = 0; i < results.children.length; ++i) { results.children[i].setAttribute('aria-selected', String(i === index)); }
			const active = results.children[index];
			if (!active) { input.removeAttribute('aria-activedescendant'); return; }
			input.setAttribute('aria-activedescendant', active.id);
			if (scroll) { active.scrollIntoView({ block: 'nearest' }); }
		};
		const choose = (i: number) => { const item = items[i]; if (item) { this.close(); item.run(); } };
		const render = () => {
			const value = input.value.trimStart();
			const mode = value.startsWith('>');
			const words = (mode ? value.slice(1) : value).trim().toLocaleLowerCase().split(/\s+/);
			input.placeholder = mode ? t('Find a command', '查找命令') : t('Search by project name or path', '按名称或路径搜索项目');
			input.setAttribute('aria-label', input.placeholder);
			heading.textContent = mode ? t('Commands', '命令') : value ? t('Matching projects', '匹配的项目') : t('Recently opened projects', '最近打开的项目');
			const candidates = options(mode);
			items = candidates.filter(item => words.every(word => `${item.label} ${item.detail ?? ''}`.toLocaleLowerCase().includes(word)));
			empty.hidden = !!items.length;
			empty.textContent = mode ? t('No matching commands.', '没有匹配的命令。') : candidates.length ? t('No projects match this name or path.', '没有匹配的项目，试试其他名称或路径。') : t('No open history yet.', '还没有打开记录。');
			swap.replaceChildren(icon(mode ? 'search' : 'terminal'), mode ? t('Search projects', '搜索项目') : t('Run a command', '运行命令'));
			results.replaceChildren(...items.map((item, i) => {
				const row = element('div', 'lp-option'); row.id = `lp-option-${i}`; row.setAttribute('role', 'option');
				row.append(icon(item.glyph), element('strong', 'lp-ellipsis', item.label), element('small', 'lp-ellipsis', item.detail));
				row.title = item.detail ?? item.label; row.addEventListener('click', () => choose(i));
				return row;
			}));
			index = Math.min(index, Math.max(0, items.length - 1)); select(false);
		};
		input.addEventListener('input', () => { index = 0; render(); results.scrollTop = 0; });
		input.addEventListener('keydown', event => {
			if (event.isComposing || event.keyCode === 229) { return; }
			if (event.key === 'Enter') { event.preventDefault(); choose(index); }
			if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				event.preventDefault(); index = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; select(true);
			}
		});
		this.refresh = render;
		this.toggleMode = mode => { input.value = mode ? '>' : ''; index = 0; render(); input.focus(); };
		this.toggleMode(commands);
	}
}
