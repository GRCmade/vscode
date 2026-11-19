/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface Frame {
	url: string;
	parent: Frame | null;
	framesInSubtree: Frame[];
}
interface Contents { mainFrame: Frame; isDestroyed(): boolean }
interface MediaDetails { requestingUrl?: string; mediaTypes?: string[]; mediaType?: string }

/** Consent belongs to one live, nonce-scoped application frame, never all localhost pages. */
export class StudioWebAppMicrophone {
	private readonly approved = new WeakMap<Frame, string>();
	private readonly pending = new WeakMap<Frame, Promise<boolean>>();

	private frame(contents: Contents | null, requestingUrl: string | undefined): { frame: Frame; scope: string } | undefined {
		if (!contents || contents.isDestroyed() || !requestingUrl) { return; }
		try {
			const request = new URL(requestingUrl);
			if (request.protocol !== 'http:' || request.hostname !== '127.0.0.1' || !request.port || request.username || request.password) { return; }
			for (const frame of contents.mainFrame.framesInSubtree) {
				const url = new URL(frame.url);
				if (url.origin !== request.origin || !/^\/[\w-]{32}\/[^?#]+\.html$/.test(url.pathname) ||
					(request.pathname !== '/' && request.pathname !== url.pathname)) { continue; }
				let webview = false, window = false;
				for (let parent = frame.parent; parent; parent = parent.parent) {
					const ancestor = new URL(parent.url);
					webview ||= ancestor.protocol === 'vscode-webview:' || ancestor.protocol === 'https:' && /\.vscode-(?:cdn|webview)\.net$/.test(ancestor.hostname);
					window ||= ancestor.protocol === 'vscode-file:' && ancestor.hostname === 'vscode-app';
				}
				if (webview && window) { return { frame, scope: url.origin + url.pathname }; }
			}
		} catch { /* Reject malformed URLs and detached frames. */ }
		return;
	}

	check(contents: Contents | null, details: MediaDetails): boolean {
		const candidate = this.frame(contents, details.requestingUrl);
		return details.mediaType === 'audio' && !!candidate && this.approved.get(candidate.frame) === candidate.scope;
	}

	async request(contents: Contents | null, details: MediaDetails, ask: () => Promise<boolean>): Promise<boolean> {
		const candidate = this.frame(contents, details.requestingUrl);
		if (!candidate || !details.mediaTypes?.length || details.mediaTypes.some(type => type !== 'audio')) { return false; }
		if (this.approved.get(candidate.frame) === candidate.scope) { return true; }
		let pending = this.pending.get(candidate.frame);
		if (!pending) {
			pending = (async () => {
				if (!await ask()) { return false; }
				const current = this.frame(contents, details.requestingUrl);
				if (!current || current.frame !== candidate.frame || current.scope !== candidate.scope) { return false; }
				this.approved.set(candidate.frame, candidate.scope);
				return true;
			})();
			this.pending.set(candidate.frame, pending);
		}
		try { return await pending; }
		finally { if (this.pending.get(candidate.frame) === pending) { this.pending.delete(candidate.frame); } }
	}
}
