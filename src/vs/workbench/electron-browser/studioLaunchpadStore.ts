/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { artwork, StoreListing, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';

export interface CatalogRequest { query: string; type: string; page: number }
export interface CatalogPage { items: StoreListing[]; total: number; pageSize: number }

export class LaunchpadStore extends Disposable {
	readonly element = element('div', 'lp-store-page lp-scroll');
	private readonly gallery = element('section', 'lp-store-feature');
	private readonly results = element('div', 'lp-store-grid');
	private readonly status = element('div', 'lp-store-status');
	private readonly pager = element('div', 'lp-pager');
	private readonly search = element('input', 'lp-query');
	private readonly categories = element('div', 'lp-filters');
	private readonly heading = element('h1');
	private readonly debounce = this._register(new RunOnceScheduler(() => void this.load(), 220));
	private type = '';
	private page = 1;
	private generation = 0;
	private scope?: string;
	private platform = false;
	private loaded = false;
	private featured = 0;
	private data?: CatalogPage;
	private recommendations: StoreListing[] = [];
	private detail?: StoreListing;

	constructor(private readonly t: LaunchpadLabel, private readonly fetchPage: (request: CatalogRequest, platform: boolean) => Promise<CatalogPage>, private readonly open: (id: string, platform: boolean) => void) {
		super();
		this.search.type = 'search'; this.search.placeholder = t('Search agents', '搜索 Agent'); this.search.setAttribute('aria-label', this.search.placeholder);
		this.search.addEventListener('input', () => { ++this.generation; this.page = 1; this.detail = undefined; this.debounce.schedule(); });
		for (const [id, label] of [['', t('All items', '全部')], ['bot', 'Bot'], ['workflow', t('Workflows', '工作流')], ['kanban', t('Kanban', '看板')]]) {
			const b = button(label, '', () => { this.type = id; this.page = 1; this.detail = undefined; void this.load(); }, 'lp-filter-btn'); b.dataset.id = id; this.categories.append(b);
		}
		const field = element('label', 'lp-search-field'); field.append(icon('search'), this.search);
		const bar = element('header', 'lp-store-toolbar'); bar.append(this.categories, field);
		this.status.setAttribute('role', 'status');
		this.element.append(bar, this.heading, this.gallery, this.status, this.results, this.pager);
	}

	update(visible: boolean, platform: boolean, server: string | undefined, recommendations: StoreListing[]): void {
		const key = `${platform}:${server ?? ''}`;
		if (this.scope !== key) {
			++this.generation; this.scope = key; this.platform = platform; this.loaded = false; this.data = this.detail = undefined; this.page = 1; this.featured = 0;
			this.results.replaceChildren(); this.gallery.replaceChildren(); this.pager.replaceChildren();
		}
		if (JSON.stringify(recommendations) !== JSON.stringify(this.recommendations)) { this.recommendations = recommendations; this.renderFeature(); }
		if (visible && !this.loaded) { void this.load(); }
	}

	private async load(): Promise<void> {
		this.debounce.cancel(); const generation = ++this.generation; this.loaded = true;
		const t = this.t;
		this.heading.textContent = this.platform ? t('Agent Store', 'Agent 商店') : t('Built-in catalog', '内置目录');
		for (const b of this.categories.querySelectorAll('button')) { b.setAttribute('aria-pressed', String(b.dataset.id === this.type)); }
		this.element.setAttribute('aria-busy', 'true'); this.status.textContent = this.data ? '' : t('Loading catalog…', '正在读取目录…');
		try {
			const data = await this.fetchPage({ query: this.search.value.trim(), type: this.type, page: this.page }, this.platform);
			if (generation !== this.generation) { return; }
			if (!data || !Array.isArray(data.items) || !(data.pageSize > 0)) { throw new Error(); }
			this.data = data; this.render();
		} catch {
			if (generation !== this.generation) { return; }
			this.status.replaceChildren(t('Catalog unavailable.', '暂时无法读取目录。'), button(t('Retry', '重试'), 'refresh', () => void this.load(), 'lp-link'));
		} finally { if (generation === this.generation) { this.element.setAttribute('aria-busy', 'false'); } }
	}

	private cover(p: StoreListing, index = 0): HTMLElement {
		return artwork(p.id, { entries: p.entries?.length ? p.entries : p.avatarUrl ? [p.avatarUrl] : [], entryTypes: p.entryTypes }, icon('extensions'), p.images?.[index]);
	}

	private renderFeature(): void {
		const t = this.t;
		const offers = this.recommendations.length ? this.recommendations.map(item => this.data?.items.find(p => p.id === item.id) ?? item) : this.data?.items ?? [];
		const p = this.detail ?? offers[this.featured % (offers.length || 1)];
		this.gallery.hidden = !p || !this.detail && (!!this.search.value || !!this.type || this.page !== 1);
		if (!p || this.gallery.hidden) { this.gallery.replaceChildren(); return; }
		const art = this.cover(p), body = element('div', 'lp-feature-info');
		body.append(element('small', 'lp-section-kicker', this.detail ? t('Project details', '项目详情') : t('Featured selection', '精选推荐')), element('h2', '', p.name),
			element('span', 'lp-feature-meta', [typeLabel(p.projectType, t), p.version].filter(Boolean).join(' · ')), element('p', '', p.description ?? ''));
		const controls = element('div', 'lp-feature-controls');
		controls.append(button(this.platform ? t('Get agent', '获取 Agent') : t('Create from example', '从示例创建'), this.platform ? 'cloud-download' : 'add', () => this.open(p.id, this.platform), 'lp-primary'));
		if (this.detail) { controls.append(button(t('Back to catalog', '返回目录'), 'arrow-left', () => { this.detail = undefined; this.renderFeature(); }, 'lp-link')); }
		else if (offers.length > 1) {
			for (const step of [-1, 1]) {
				const b = button('', step < 0 ? 'chevron-left' : 'chevron-right', () => { this.featured = (this.featured + step + offers.length) % offers.length; this.renderFeature(); }, 'lp-tool');
				b.title = step < 0 ? t('Previous item', '上一个') : t('Next item', '下一个'); b.setAttribute('aria-label', b.title); controls.append(b);
			}
		}
		body.append(controls); this.gallery.replaceChildren(art, body);
	}

	private render(): void {
		const t = this.t, data = this.data!; this.renderFeature();
		this.status.textContent = data.items.length ? t(`Catalog · ${data.total}`, `目录 · ${data.total}`) : t('No matching items.', '没有匹配的内容。');
		this.results.replaceChildren(...data.items.map(p => {
			const b = button('', '', () => { this.detail = p; this.renderFeature(); this.element.scrollTop = 0; this.gallery.querySelector('button')?.focus({ preventScroll: true }); }, 'lp-library-card');
			const caption = element('span', 'lp-caption'); caption.append(element('strong', '', p.name), element('small', '', [typeLabel(p.projectType, t), p.version].filter(Boolean).join(' · ')));
			b.append(this.cover(p), caption); return b;
		}));
		const pages = Math.ceil(data.total / data.pageSize); this.pager.replaceChildren();
		if (pages > 1) {
			const prev = button(t('Previous', '上一页'), 'chevron-left', () => { --this.page; void this.load(); }); prev.disabled = this.page <= 1;
			const next = button(t('Next', '下一页'), 'chevron-right', () => { ++this.page; void this.load(); }); next.disabled = this.page >= pages;
			this.pager.append(prev, `${this.page} / ${pages}`, next);
		}
	}

	override dispose(): void { ++this.generation; super.dispose(); }
}
