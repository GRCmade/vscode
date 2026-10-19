/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/studioAccountMenu.css';
import { $, addDisposableListener, append, getWindow, isAncestor } from '../../../base/browser/dom.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Emitter } from '../../../base/common/event.js';
import { AnchorPosition } from '../../../base/common/layout.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextViewService, IOpenContextView } from '../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';

interface AccountMenuState {
	status: 'signed-out' | 'checking' | 'authenticated' | 'expired' | 'error';
	statusLabel: string;
	serverUrl: string;
	name: string;
	email?: string;
	avatarUrl?: string;
	hasAccount: boolean;
	error?: string;
	labels: Record<string, string>;
}

const accountMenuChange = new Emitter<AccountMenuState>();
CommandsRegistry.registerCommand('studio.internalUpdateAccountMenuState', (_accessor, state: AccountMenuState) => accountMenuChange.fire(state));

export class StudioAccountMenu extends Disposable {
	private view: IOpenContextView | undefined;
	private state: AccountMenuState | undefined;
	private updateView: (() => void) | undefined;
	private generation = 0;
	private updates = 0;
	private opening = false;

	constructor(
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(accountMenuChange.event(state => {
			this.updates++;
			this.state = state;
			this.updateView?.();
		}));
	}

	get isAvailable(): boolean { return this.contextKeys.getContextKeyValue('studio.accountAvailable') === true; }

	async toggle(anchor: HTMLElement, alignment?: { anchorAlignment: AnchorAlignment; anchorAxisAlignment: AnchorAxisAlignment }): Promise<void> {
		if (this.view || this.opening) {
			this.generation++;
			this.opening = false;
			this.view?.close();
			return;
		}
		const generation = ++this.generation;
		const updates = this.updates;
		this.opening = true;
		try {
			const state = await this.commands.executeCommand<AccountMenuState>('studio.internalGetAccountMenuState');
			if (generation !== this.generation || this._store.isDisposed || !anchor.isConnected) { return; }
			if (updates === this.updates || !this.state) { this.state = state; }
			let focus: (() => void) | undefined;
			anchor.setAttribute('aria-expanded', 'true');
			anchor.setAttribute('aria-haspopup', 'dialog');
			this.view = this.contextViews.showContextView({
				getAnchor: () => anchor,
				anchorPosition: AnchorPosition.ABOVE,
				...alignment,
				render: container => this.render(container, anchor, callback => { focus = callback; }),
				focus: () => focus?.(),
				onHide: () => {
					this.view = undefined;
					this.opening = false;
					this.updateView = undefined;
					anchor.setAttribute('aria-expanded', 'false');
					this.generation++;
				},
			});
		} catch (error) {
			if (generation === this.generation) { this.notifications.error(error); }
		} finally {
			if (generation === this.generation) { this.opening = false; }
		}
	}

	private render(container: HTMLElement, anchor: HTMLElement, setFocus: (callback: () => void) => void): DisposableStore {
		const disposables = new DisposableStore();
		const root = append(container, $('.studio-account-menu', { role: 'dialog', 'aria-label': this.state!.labels.title }));
		const heading = append(root, $('.studio-account-heading'));
		append(heading, $('span', undefined, 'SteamHarness'));
		const close = append(heading, $<HTMLButtonElement>('button.studio-account-close', { type: 'button', 'aria-label': this.state!.labels.close, title: this.state!.labels.close }));
		append(close, $('span', { class: ThemeIcon.asClassName(Codicon.close), 'aria-hidden': 'true' }));
		const identity = append(root, $('.studio-account-identity'));
		const avatar = append(identity, $('.studio-account-avatar'));
		const fallback = append(avatar, $('span', { class: ThemeIcon.asClassName(Codicon.account), 'aria-hidden': 'true' }));
		const image = append(avatar, $<HTMLImageElement>('img', { alt: '', 'aria-hidden': 'true', referrerpolicy: 'no-referrer', draggable: 'false' }));
		image.hidden = true;
		disposables.add(addDisposableListener(image, 'error', () => { image.hidden = true; fallback.hidden = false; }));
		const details = append(identity, $('.studio-account-details'));
		const name = append(details, $('.studio-account-name'));
		const email = append(details, $('.studio-account-email'));
		const status = append(details, $('.studio-account-status', { role: 'status', 'aria-live': 'polite' }));
		const server = append(root, $('.studio-account-server'));
		append(server, $('span', { class: ThemeIcon.asClassName(Codicon.server), 'aria-hidden': 'true' }));
		const serverText = append(server, $('span'));
		const error = append(root, $('.studio-account-error', { role: 'status' }));
		const actions = append(root, $('.studio-account-actions'));
		let refreshing = false;
		const hide = (restoreFocus: boolean) => {
			this.view?.close();
			if (restoreFocus && anchor.isConnected) { anchor.focus(); }
		};
		const button = (command: string, icon: ThemeIcon, footer = false): HTMLButtonElement => {
			const element = append(footer ? root : actions, $<HTMLButtonElement>('button.studio-account-action', { type: 'button', 'data-command': command }));
			if (footer) { element.classList.add('studio-account-signout'); }
			append(element, $('span', { class: ThemeIcon.asClassName(icon), 'aria-hidden': 'true' }));
			append(element, $('span.studio-account-action-label'));
			disposables.add(addDisposableListener(element, 'click', async () => {
				if (command === 'studio.refreshAccount') {
					if (refreshing || this.state?.status === 'checking') { return; }
					refreshing = true;
					update();
					try { await this.commands.executeCommand(command); }
					catch (error) { this.notifications.error(error); }
					finally {
						refreshing = false;
						if (!disposables.isDisposed) { update(); }
					}
				} else {
					hide(false);
					try { await this.commands.executeCommand(command); }
					catch (error) { this.notifications.error(error); }
				}
			}));
			return element;
		};
		const profile = button('studio.openAccount', Codicon.person);
		append(profile, $('span.studio-account-chevron', { class: `studio-account-chevron ${ThemeIcon.asClassName(Codicon.chevronRight)}`, 'aria-hidden': 'true' }));
		const refresh = button('studio.refreshAccount', Codicon.refresh);
		const signOut = button('studio.logout', Codicon.signOut, true);
		const text = (element: Element, value: string) => { if (element.textContent !== value) { element.textContent = value; } };
		let avatarUrl: string | undefined;
		const update = () => {
			const state = this.state!;
			const focused = root.contains(getWindow(root).document.activeElement);
			text(name, state.name);
			text(email, state.email ?? '');
			email.hidden = !state.email;
			text(status, state.statusLabel);
			status.dataset.status = state.status;
			text(serverText, state.serverUrl);
			server.setAttribute('aria-label', `${state.labels.server}: ${state.serverUrl}`);
			text(error, state.error ?? '');
			error.hidden = !state.error;
			text(profile.querySelector('.studio-account-action-label')!, state.hasAccount ? state.labels.profile : state.labels.signIn);
			text(refresh.querySelector('.studio-account-action-label')!, refreshing ? state.labels.refreshing : state.labels.refresh);
			text(signOut.querySelector('.studio-account-action-label')!, state.labels.signOut);
			refresh.hidden = signOut.hidden = !state.hasAccount;
			refresh.setAttribute('aria-disabled', String(refreshing || state.status === 'checking'));
			refresh.setAttribute('aria-busy', String(refreshing));
			refresh.firstElementChild?.classList.toggle('codicon-modifier-spin', refreshing);
			if (avatarUrl !== state.avatarUrl) {
				avatarUrl = state.avatarUrl;
				image.hidden = !avatarUrl;
				fallback.hidden = !!avatarUrl;
				if (avatarUrl) { image.src = FileAccess.uriToBrowserUri(URI.parse(avatarUrl)).toString(true); }
				else { image.removeAttribute('src'); }
			}
			if (refresh.hidden && focused) { profile.focus(); }
			this.contextViews.layout();
		};
		this.updateView = update;
		update();
		setFocus(() => profile.focus());
		disposables.add(addDisposableListener(close, 'click', () => hide(true)));
		disposables.add(addDisposableListener(root, 'mousedown', (event: MouseEvent) => {
			const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
			if (target && !target.disabled) { event.preventDefault(); target.focus(); }
		}));
		disposables.add(addDisposableListener(getWindow(root).document, 'mousedown', (event: MouseEvent) => {
			if (!isAncestor(event.target as Node, root) && !isAncestor(event.target as Node, anchor)) { hide(false); }
		}, true));
		disposables.add(addDisposableListener(root, 'focusout', () => {
			queueMicrotask(() => {
				if (!disposables.isDisposed && !root.contains(getWindow(root).document.activeElement)) { hide(false); }
			});
		}));
		disposables.add(addDisposableListener(root, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault(); event.stopPropagation(); hide(true);
			} else if (['Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
				const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(item => !item.hidden && !item.disabled);
				const current = buttons.indexOf(getWindow(root).document.activeElement as HTMLButtonElement);
				const backwards = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey);
				const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (backwards ? -1 : 1) + buttons.length) % buttons.length;
				event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
			}
		}));
		return disposables;
	}

	override dispose(): void {
		this.generation++;
		this.opening = false;
		this.view?.close();
		super.dispose();
	}
}
