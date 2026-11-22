/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderMarkdown } from '../../base/browser/markdownRenderer.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { picture, storeArtwork, StoreListing, StoreListingDetails, typeLabel } from './studioLaunchpadCards.js';
import { button, element, icon, LaunchpadLabel } from './studioLaunchpadPicker.js';
import { projectEntryList } from './studioLaunchpadProjectDetails.js';
import type { StoreActions } from './studioLaunchpadStore.js';

export class LaunchpadStoreDetails extends Disposable {
	readonly element = element('article', 'lp-store-content lp-store-details lp-scroll');
	readonly title = element('h1');
	private readonly mark = element('div', 'lp-listing-mark');
	private readonly summary = element('p', 'lp-listing-summary');
	private readonly content = element('div', 'lp-listing-body');
	private readonly status = element('div', 'lp-listing-status');
	private readonly acquire: HTMLButtonElement;

	constructor(private readonly t: LaunchpadLabel, private readonly listing: StoreListing, private readonly platform: boolean, private readonly actions: StoreActions, back: () => void) {
		super();
		const trail = element('div', 'lp-listing-trail');
		trail.append(button(platform ? t('Back to Store', '返回商店') : t('Back to catalog', '返回目录'), 'arrow-left', back), icon('chevron-right'), element('span', '', t('Project details', '项目详情')));
		this.title.tabIndex = -1; this.title.textContent = listing.name;
		this.mark.append(storeArtwork(listing));
		const identity = element('div', 'lp-listing-identity'); identity.append(this.title, this.summary);
		this.summary.hidden = !platform || !listing.description; this.summary.textContent = listing.description ?? '';
		this.acquire = button(platform ? t('Get agent', '获取 Agent') : t('Create from example', '从示例创建'), platform ? 'cloud-download' : 'add', () => actions.getListing(listing.id, platform), 'lp-primary');
		const head = element('header', 'lp-listing-head'); head.append(this.mark, identity, this.acquire);
		this.status.setAttribute('role', 'status'); this.element.append(trail, head, this.status, this.content);
		this.element.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); back(); } });
		void this.load();
	}

	private async load(): Promise<void> {
		this.acquire.disabled = true;
		this.status.textContent = this.t('Loading project details…', '正在加载项目详情…');
		this.content.setAttribute('aria-busy', 'true');
		try {
			const p = this.platform ? await this.actions.listingDetails(this.listing.id) : this.listing;
			if (this._store.isDisposed) { return; }
			if (p?.id !== this.listing.id) { throw new Error(); }
			this.render(p); this.status.textContent = ''; this.acquire.disabled = false;
		} catch {
			if (this._store.isDisposed) { return; }
			this.status.replaceChildren(this.t('Project details unavailable.', '暂时无法读取项目详情。'), button(this.t('Retry', '重试'), 'refresh', () => { this.title.focus(); void this.load(); }, 'lp-link'));
		} finally { this.content.setAttribute('aria-busy', 'false'); }
	}

	private render(p: StoreListingDetails): void {
		const t = this.t;
		this.title.textContent = p.name; this.mark.replaceChildren(storeArtwork(p));
		this.summary.textContent = p.summary ?? ''; this.summary.hidden = !p.summary || p.summary === p.description;
		const main = element('div', 'lp-listing-main'), about = element('section');
		about.append(element('h2', '', t('About this project', '项目介绍')));
		if (p.description || p.summary) {
			// Published prose is untrusted; only the separate, host-supplied screenshot gallery loads media.
			const prose = this._register(renderMarkdown({ value: p.description || p.summary || '' }, { sanitizerConfig: { allowedTags: { override: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td'] } } }));
			prose.element.className = 'lp-listing-prose'; about.append(prose.element);
		} else { about.append(element('p', 'lp-listing-empty', t('No description provided.', '暂无项目介绍。'))); }
		main.append(about);
		if (p.images?.length) { main.append(this.screenshots(p.name, p.images)); }
		const aside = element('aside', 'lp-listing-info'), facts = element('dl');
		const fact = (label: string, value: string) => { const row = element('div'); row.append(element('dt', '', label), element('dd', '', value)); facts.append(row); };
		if (p.projectType) { fact(t('Project type', '项目类型'), typeLabel(p.projectType, t)); }
		if (p.version) { fact(t('Version', '版本'), p.version); }
		if (p.updatedAt && Number.isFinite(Date.parse(p.updatedAt))) { fact(t('Updated', '更新日期'), new Date(p.updatedAt).toLocaleDateString(t('en', 'zh-CN'), { year: 'numeric', month: 'short', day: 'numeric' })); }
		if (facts.childElementCount) { aside.append(element('h2', '', t('Project information', '项目信息')), facts); }
		if (p.projectEntries?.length) { aside.append(projectEntryList(p.projectEntries, t)); }
		if (aside.childElementCount) { this.content.replaceChildren(main, aside); } else { this.content.replaceChildren(main); }
	}

	private screenshots(name: string, images: string[]): HTMLElement {
		const t = this.t, section = element('section', 'lp-listing-screens'), bar = element('header');
		bar.append(element('h2', '', t('Screenshots', '项目截图')));
		const frame = element('div', 'lp-listing-frame'), count = element('span'); let index = 0, revision = 0;
		const show = async () => {
			const current = ++revision; count.textContent = `${index + 1} / ${images.length}`;
			const unavailable = () => element('span', '', t('Screenshot unavailable.', '截图暂时无法显示。'));
			frame.replaceChildren(); const src = this.platform ? await this.actions.storeImage(images[index]).catch(() => undefined) : images[index];
			if (current !== revision || this._store.isDisposed) { return; }
			if (!src) { frame.replaceChildren(unavailable()); return; }
			const img = picture(src); img.alt = t(`${name}, screenshot ${index + 1}`, `${name}，截图 ${index + 1}`);
			img.addEventListener('error', () => img.replaceWith(unavailable()), { once: true }); frame.replaceChildren(img);
		};
		if (images.length > 1) {
			const controls = element('div', 'lp-screen-controls');
			const step = (n: number, glyph: string, label: string) => { const b = button('', glyph, () => { index = (index + n + images.length) % images.length; void show(); }); b.title = label; b.setAttribute('aria-label', label); return b; };
			count.setAttribute('aria-live', 'polite'); controls.append(step(-1, 'chevron-left', t('Previous screenshot', '上一张截图')), count, step(1, 'chevron-right', t('Next screenshot', '下一张截图'))); bar.append(controls);
		}
		void show(); section.append(bar, frame); return section;
	}

	override dispose(): void { this.element.remove(); super.dispose(); }
}
