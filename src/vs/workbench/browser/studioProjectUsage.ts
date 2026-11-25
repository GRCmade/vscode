/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../base/common/async.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { generateUuid } from '../../base/common/uuid.js';
import type { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { button, element, type StudioLabel } from './studioUiElements.js';

type Part = 'directory' | 'runtime';
type State = 'ok' | 'partial' | 'unavailable';
interface Size { state: State; bytes?: number }
interface DirectoryUsage extends Size {
	path?: string;
	files?: number;
	directories?: number;
	folders: Array<Size & { name: string }>;
	omittedFolders?: number;
}
interface ConversationUsage extends Size { sessions?: number; messages?: number }
interface MemoryUsage extends Size { records?: number; location?: string; created?: boolean }
interface WorkflowUsage extends Size { runs?: number; lastRunAt?: number }
interface KanbanUsage { state: State | 'unbuilt' | 'shared' | 'hosted'; bytes?: number; location?: string }
type Entry = { entryId: string; name: string } & (
	| { type: 'bot'; conversation: ConversationUsage; memory: MemoryUsage }
	| { type: 'workflow'; workflow: WorkflowUsage }
	| { type: 'kanban'; kanban: KanbanUsage }
);
interface RuntimeUsage { state: State | 'not-project'; size: Size; location?: string; entries: Entry[] }
type Snapshot = { measuredAt: number } & ({ part: 'directory'; usage: DirectoryUsage } | { part: 'runtime'; usage: RuntimeUsage });
type Snapshots = Partial<Record<Part, Snapshot>>;

interface UsageTarget { uri: string; projectId?: string; distribution?: string; managed?: boolean; missing?: boolean; kind?: 'folder' | 'workspace' }
export interface ProjectUsageBridge {
	cached(target: UsageTarget): Snapshots;
	remember(target: UsageTarget, snapshot: Snapshot): void;
	read(target: UsageTarget, part: Part, id: string): Promise<Snapshot | undefined>;
	cancel(id: string): void;
	copy(path: string): void;
}

const cachePrefix = 'studio.projectUsage.v1:';
const cacheLimit = 32;
const cacheSizeLimit = 1_000_000;

export function projectUsageBridge(commands: ICommandService, clipboard: IClipboardService, storage: IStorageService): ProjectUsageBridge {
	const command = 'studio.internalProjectUsage';
	const cacheKey = (target: UsageTarget, part: Part) => `${cachePrefix}${projectUsageKey(target)}:${part}`;
	const readCache = (key: string) => {
		try { return storage.getObject<Snapshot>(key, StorageScope.PROFILE); }
		catch { return undefined; }
	};
	return {
		cached: target => {
			const directory = readCache(cacheKey(target, 'directory')), runtime = readCache(cacheKey(target, 'runtime'));
			return {
				directory: directory?.part === 'directory' && Array.isArray(directory.usage?.folders) ? directory : undefined,
				runtime: runtime?.part === 'runtime' && runtime.usage?.size && Array.isArray(runtime.usage.entries) ? runtime : undefined,
			};
		},
		remember: (target, snapshot) => {
			const key = cacheKey(target, snapshot.part);
			if ((readCache(key)?.measuredAt ?? 0) > snapshot.measuredAt) { return; }
			const encoded = JSON.stringify(snapshot);
			if (encoded.length > cacheSizeLimit) { return; }
			// Usage includes local paths. Keep it in the current profile, off Settings Sync.
			storage.store(key, encoded, StorageScope.PROFILE, StorageTarget.MACHINE);
			const entries = storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE).filter(key => key.startsWith(cachePrefix))
				.map(key => ({ key, length: storage.get(key, StorageScope.PROFILE, '').length }));
			let count = entries.length, length = entries.reduce((total, entry) => total + entry.length, 0);
			if (count > cacheLimit || length > cacheSizeLimit) {
				const oldest = entries.filter(entry => entry.key !== key).map(entry => ({ ...entry, time: readCache(entry.key)?.measuredAt ?? 0 }))
					.sort((a, b) => a.time - b.time);
				for (const entry of oldest) {
					if (count <= cacheLimit && length <= cacheSizeLimit) { break; }
					storage.remove(entry.key, StorageScope.PROFILE);
					count--;
					length -= entry.length;
				}
			}
		},
		read: ({ uri, projectId, distribution, managed }, part, id) => commands.executeCommand<Snapshot | undefined>(command,
			{ uri, managed, part, id, refresh: true, identity: [projectId, distribution].join(':') }),
		cancel: id => { void commands.executeCommand(command, { id, cancel: true }).catch(() => undefined); },
		copy: path => { void clipboard.writeText(path).catch(() => undefined); },
	};
}

export function projectUsageKey(target: UsageTarget): string {
	return JSON.stringify([target.uri, target.projectId, target.distribution, !!target.managed, !!target.missing, target.kind ?? 'folder']);
}

const parts: Part[] = ['directory', 'runtime'];
const ranks = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

function usable(snapshot: Snapshot): boolean {
	const { usage } = snapshot;
	if (usage.state === 'unavailable') { return false; }
	// A scan that could not inspect any of the directory should not replace a previous result.
	return snapshot.part !== 'directory' || snapshot.usage.state === 'ok' || Boolean(snapshot.usage.files || snapshot.usage.directories);
}

interface Reading { snapshot?: Snapshot; id?: string; failed?: boolean }

/** Owns the repeated measurements independently of the existing detail and entry buttons. */
export class StudioProjectUsage extends Disposable {
	readonly element = element('section', 'lp-project-usage');
	private readonly metrics = element('dl', 'lp-usage-metrics');
	private readonly status = element('span', 'lp-usage-status');
	private readonly refresh: HTMLButtonElement;
	private readonly folders = element('details', 'lp-usage-details');
	private readonly folderBody = element('div');
	private readonly entries = element('details', 'lp-usage-details');
	private readonly entryBody = element('div');
	private readonly readings: Record<Part, Reading>;
	private readonly revalidate = this._register(new RunOnceScheduler(() => this.load(), 100));
	private readonly enabled: boolean;
	private readonly locale: string;
	private readonly number: Intl.NumberFormat;
	private readonly keyPrefix: string;
	private visible = false;
	private allFolders = false;

	constructor(private readonly target: UsageTarget, private readonly t: StudioLabel, private readonly bridge: ProjectUsageBridge) {
		super();
		this.enabled = target.uri.startsWith('file:') && !target.missing && (target.managed === true || target.kind !== 'workspace');
		const cached = this.enabled ? bridge.cached(target) : {};
		this.readings = { directory: { snapshot: cached.directory }, runtime: { snapshot: cached.runtime } };
		this.locale = t('en', 'zh-CN');
		this.number = new Intl.NumberFormat(this.locale, { maximumFractionDigits: 1 });
		this.keyPrefix = 'usage:' + target.uri + ':';
		const header = element('header', 'lp-usage-head');
		this.refresh = button('', 'refresh', () => this.load(), 'studio-project-action lp-usage-tool');
		this.refresh.title = t('Refresh usage', '刷新用量');
		this.refresh.setAttribute('aria-label', this.refresh.title);
		this.refresh.dataset.key = this.keyPrefix + 'refresh';
		this.status.setAttribute('role', 'status');
		header.append(element('h2', '', t('Local usage', '本机用量')), this.status, this.refresh);
		const details = (node: HTMLDetailsElement, body: HTMLElement, key: string, label: string) => {
			const summary = element('summary', '', label);
			summary.dataset.key = this.keyPrefix + key;
			node.append(summary, body);
		};
		details(this.folders, this.folderBody, 'folders', t('Folder sizes', '文件夹大小'));
		details(this.entries, this.entryBody, 'entries', t('Entry usage and storage locations', '入口用量与存储位置'));
		this.element.append(header, this.metrics, this.folders, this.entries);
		this.render();
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (!visible) { this.cancel(); }
		else if (this.enabled) {
			this.revalidate.schedule();
			this.renderStatus();
		}
	}

	override dispose(): void { this.setVisible(false); super.dispose(); }

	private cancel(): void {
		this.revalidate.cancel();
		for (const reading of Object.values(this.readings)) {
			const id = reading.id;
			reading.id = undefined;
			if (id) { this.bridge.cancel(id); }
		}
	}

	private load(): void {
		if (!this.visible || !this.enabled || parts.some(part => this.readings[part].id)) { return; }
		this.revalidate.cancel();
		for (const part of parts) {
			const reading = this.readings[part];
			const id = reading.id = generateUuid();
			void this.bridge.read(this.target, part, id).catch(() => undefined).then(snapshot => {
				if (reading.id !== id) { return; }
				reading.id = undefined;
				if (snapshot?.part === part && usable(snapshot)) {
					reading.snapshot = snapshot;
					reading.failed = false;
					this.bridge.remember(this.target, snapshot);
				} else { reading.failed = true; }
				this.render();
			});
		}
		this.renderStatus();
	}

	private size(metric: Size): string {
		if (metric.bytes === undefined || (metric.bytes === 0 && metric.state === 'partial')) { return this.t('Unavailable', '无法读取'); }
		let bytes = metric.bytes, index = 0;
		while (bytes >= 1024 && index < ranks.length - 1) { bytes /= 1024; index++; }
		return `${metric.state === 'partial' ? '≥ ' : ''}${this.number.format(bytes)} ${ranks[index]}`;
	}

	private count(value: number | undefined): string { return value === undefined ? '—' : this.number.format(value); }

	private time(value: number): string {
		return new Date(value).toLocaleString(this.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	private metric(label: string, value: string, hint?: string, title?: string): void {
		const row = element('div', 'lp-usage-metric'), caption = element('dt', '', label), info = element('dd');
		if (title) { caption.title = title; }
		info.append(element('span', 'lp-usage-value', value));
		if (hint) { info.append(element('small', '', hint)); }
		row.append(caption, info); this.metrics.append(row);
	}

	private pathRow(parent: HTMLElement, label: string, value: string, key: string): void {
		const row = element('div', 'lp-usage-path');
		const copy = button('', 'copy', () => this.bridge.copy(value), 'studio-project-action lp-usage-tool');
		copy.title = this.t('Copy path', '复制路径');
		copy.setAttribute('aria-label', `${copy.title}: ${label}`);
		copy.dataset.key = this.keyPrefix + key;
		row.append(element('span', '', label), element('code', '', value), copy);
		parent.append(row);
	}

	private renderFolders(directory: DirectoryUsage | undefined): void {
		if (!directory?.path) { this.folders.hidden = true; return; }
		this.folders.hidden = false;
		this.folderBody.replaceChildren();
		this.pathRow(this.folderBody, this.t('Working directory', '工作目录'), directory.path, 'workdir');
		const list = element('dl', 'lp-usage-folders');
		for (const folder of directory.folders.slice(0, this.allFolders ? undefined : 8)) {
			const row = element('div');
			row.append(element('dt', '', folder.name), element('dd', '', this.size(folder)));
			list.append(row);
		}
		this.folderBody.append(list);
		if (!directory.folders.length) { this.folderBody.append(element('small', 'lp-usage-muted', directory.state === 'ok' ? this.t('No subfolders', '无子目录') : this.t('Folder sizes unavailable', '目录明细不可用'))); }
		if (directory.folders.length > 8) {
			const toggle = button(this.allFolders ? this.t('Show largest 8', '仅显示前 8 项') : this.t('Show all', '显示全部'),
				this.allFolders ? 'chevron-up' : 'chevron-down', () => {
					this.allFolders = !this.allFolders;
					this.renderFolders(directory);
					this.folderBody.querySelector<HTMLButtonElement>('.lp-usage-show-all')?.focus({ preventScroll: true });
				}, 'studio-project-action lp-usage-show-all');
			toggle.setAttribute('aria-expanded', String(this.allFolders));
			toggle.dataset.key = this.keyPrefix + 'show-all';
			this.folderBody.append(toggle);
		}
		if (directory.omittedFolders) { this.folderBody.append(element('small', 'lp-usage-muted', `${this.count(directory.omittedFolders)} ${this.t('additional folders not listed', '个目录未列出')}`)); }
	}

	private kanbanSize(kanban: KanbanUsage): string {
		switch (kanban.state) {
			case 'hosted': return this.t('Hosted data excluded', '托管数据未统计');
			case 'shared': return this.t('Shared directory', '共用目录');
			case 'unbuilt': return this.t('Not built', '未构建');
			default: return this.size(kanban as Size);
		}
	}

	private sum(values: readonly Size[]): Size {
		const known = values.filter(value => value.bytes !== undefined);
		return !known.length ? { state: 'unavailable' } : {
			state: values.some(value => value.state !== 'ok') ? 'partial' : 'ok',
			bytes: known.reduce((total, value) => total + (value.bytes ?? 0), 0),
		};
	}

	private sumCount(values: Array<number | undefined>): string {
		const counts = values.filter(value => value !== undefined);
		return !counts.length ? this.count(undefined) : `${counts.length < values.length ? '≥ ' : ''}${this.count(counts.reduce((a, b) => a + b, 0))}`;
	}

	private renderRuntime(runtime: RuntimeUsage): void {
		const t = this.t;
		if (!runtime.entries.length && runtime.state === 'not-project') { return; }
		this.metric(t('Studio data', 'Studio 运行数据'), this.size(runtime.size));
		const bots = runtime.entries.filter(entry => entry.type === 'bot');
		const workflows = runtime.entries.filter(entry => entry.type === 'workflow');
		const boards = runtime.entries.filter(entry => entry.type === 'kanban');
		const sessionText = (count: string) => this.locale === 'zh-CN' ? `${count} 个会话` : `${count} sessions`;
		const messageText = (count: string) => this.locale === 'zh-CN' ? `${count} 条消息` : `${count} messages`;
		const memoryText = (count: string) => this.locale === 'zh-CN' ? `${count} 条记忆` : `${count} records`;
		const recent = (stamp: number) => `${t('Last run', '最近运行')} ${this.time(stamp)}`;
		if (bots.length) {
			this.metric(t('Bot conversations', 'Bot 对话'), this.size(this.sum(bots.map(entry => entry.conversation))),
				`${sessionText(this.sumCount(bots.map(entry => entry.conversation.sessions)))} · ${messageText(this.sumCount(bots.map(entry => entry.conversation.messages)))}`);
			this.metric(t('Bot memory', 'Bot 记忆'), this.size(this.sum(bots.map(entry => entry.memory))),
				bots.every(entry => entry.memory.created === false) ? t('Not created', '尚未创建') : memoryText(this.sumCount(bots.map(entry => entry.memory.records))));
		}
		if (workflows.length) {
			const count = this.sumCount(workflows.map(entry => entry.workflow.runs));
			const last = Math.max(0, ...workflows.map(entry => entry.workflow.lastRunAt ?? 0));
			this.metric(t('Saved Workflow runs', '已保存工作流运行'), count, last ? recent(last) : undefined);
		}
		if (boards.length) {
			const sizes = boards.map(entry => entry.kanban).filter((item): item is Size => item.bytes !== undefined);
			const excluded = boards.length - sizes.length;
			const value = sizes.length ? this.size(this.sum(sizes)) : boards.length === 1 ? this.kanbanSize(boards[0].kanban) : t('Not measured', '未单列统计');
			this.metric(t('Kanban assets', '看板产物'), value, sizes.length ? (excluded ? t('Some entries not measured', '部分入口未单列') : t('Included in working directory', '已计入工作目录')) : undefined);
		}
		if (!runtime.entries.length) { return; }
		this.entries.hidden = false;
		if (runtime.location && (runtime.size.bytes ?? 0) > 0) { this.pathRow(this.entryBody, t('Studio data', 'Studio 运行数据'), runtime.location, 'runtime'); }
		const list = element('ul', 'lp-usage-entries');
		for (const entry of runtime.entries) {
			const row = element('li'), head = element('div', 'lp-usage-entry-head');
			const label = entry.type === 'bot' ? 'Bot' : entry.type === 'workflow' ? t('Workflow', '工作流') : t('Kanban', '看板');
			head.append(element('strong', '', entry.name), element('small', '', label)); row.append(head);
			if (entry.type === 'bot') {
				const { conversation, memory } = entry;
				row.append(element('small', '', `${t('Conversations', '对话')} ${this.size(conversation)} · ${sessionText(this.count(conversation.sessions))} · ${messageText(this.count(conversation.messages))}`));
				row.append(element('small', '', `${t('Memory', '记忆')} ${memory.created === false ? t('Not created', '尚未创建') : this.size(memory) + ' · ' + memoryText(this.count(memory.records))}`));
				if (memory.location) { this.pathRow(row, t('Memory database', '记忆数据库'), memory.location, `memory:${entry.entryId}`); }
			} else if (entry.type === 'workflow') {
				const stats = entry.workflow;
				const when = stats.lastRunAt ? ` · ${recent(stats.lastRunAt)}` : '';
				row.append(element('small', '', `${t('Saved runs', '已保存运行')} ${this.count(stats.runs)} · ${t('History and outputs', '历史与输出')} ${this.size(stats)}${when}`));
			} else {
				row.append(element('small', '', this.kanbanSize(entry.kanban)));
				if (entry.kanban.location) { this.pathRow(row, t('Local assets', '本地产物'), entry.kanban.location, `kanban:${entry.entryId}`); }
			}
			list.append(row);
		}
		this.entryBody.append(list);
	}

	private renderStatus(): void {
		const { directory, runtime } = this.readings;
		const directoryState = directory.snapshot?.usage.state;
		const runtimeState = runtime.snapshot?.usage.state;
		const hasData = directoryState === 'ok' || directoryState === 'partial' || runtimeState === 'ok' || runtimeState === 'partial';
		const showingPrevious = (directory.failed && directory.snapshot) || (runtime.failed && runtime.snapshot && runtimeState !== 'not-project');
		const busy = this.revalidate.isScheduled() || Boolean(directory.id || runtime.id);
		const t = this.t;
		this.refresh.hidden = !this.enabled;
		this.refresh.setAttribute('aria-disabled', String(busy));
		let label: string;
		if (!this.enabled) { label = t('Unavailable for this location', '此位置无法统计'); }
		else if (busy) { label = hasData ? t('Updating…', '正在更新…') : t('Measuring…', '正在统计…'); }
		else if (showingPrevious) { label = t('Update failed; showing previous data', '更新失败，显示上次结果'); }
		else if (directory.failed || runtime.failed) { label = hasData ? t('Some measurements unavailable', '部分统计不可用') : t('Unable to measure', '无法读取用量'); }
		else if (directoryState === 'partial' || runtimeState === 'partial') { label = t('Partial measurement', '仅部分统计'); }
		else {
			const measuredAt = Math.max(directory.snapshot?.measuredAt ?? 0, runtime.snapshot?.measuredAt ?? 0);
			label = measuredAt ? `${t('Measured', '统计于')} ${this.time(measuredAt)}` : '';
		}
		if (this.status.textContent !== label) { this.status.textContent = label; }
	}

	private render(): void {
		this.renderStatus();
		const active = this.element.ownerDocument.activeElement as HTMLElement | null;
		const focus = this.element.contains(active) ? active?.dataset.key : undefined;
		const { directory, runtime } = this.readings;
		const t = this.t;
		this.metrics.replaceChildren();
		this.folders.hidden = this.entries.hidden = true;
		this.entryBody.replaceChildren();
		if (this.enabled) {
			const stat = directory.snapshot?.part === 'directory' ? directory.snapshot.usage : undefined;
			const count = (value?: number) => `${stat?.state === 'partial' ? '≥ ' : ''}${this.count(value)}`;
			const hint = stat?.files === undefined ? undefined : t(`${count(stat.files)} files · ${count(stat.directories)} folders`, `${count(stat.files)} 个文件 · ${count(stat.directories)} 个目录`);
			this.metric(t('Working directory', '工作目录'), stat ? this.size(stat) : directory.failed ? t('Unavailable', '无法读取') : '—', hint,
				t('Logical file sizes, including hidden files and dependencies; links are not followed.', '文件逻辑大小，含隐藏文件和依赖；不跟随符号链接。'));
			this.renderFolders(stat);
			if (runtime.snapshot?.part === 'runtime') { this.renderRuntime(runtime.snapshot.usage); }
			else if (runtime.failed) { this.metric(t('Studio data', 'Studio 运行数据'), t('Unavailable', '无法读取')); }
		}
		if (focus) { Array.from(this.element.querySelectorAll<HTMLElement>('[data-key]')).find(node => node.dataset.key === focus)?.focus({ preventScroll: true }); }
	}
}
