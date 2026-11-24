/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type StudioWebImTarget =
	| { kind: 'conversation' | 'user'; id: string }
	| { kind: 'add-contact' | 'create-group' };

export function studioWebImTarget(conversation?: string, user?: string, action?: 'add-contact' | 'create-group'): StudioWebImTarget | undefined {
	if (action) { return { kind: action }; }
	if (user && /^[\w.-]{1,100}$/.test(user)) { return { kind: 'user', id: user }; }
	if (conversation && conversation.length <= 256 && !/^(user|action):|[\u0000-\u001f\u007f]/u.test(conversation)) {
		return { kind: 'conversation', id: conversation };
	}
	return undefined;
}

export function readStudioWebImRoute(query: URLSearchParams): StudioWebImTarget | 'invalid' | undefined {
	const route = query.get('im');
	if (route === null) { return undefined; }
	if (query.getAll('im').length === 1) {
		const conversations = query.getAll('conversation_id'), users = query.getAll('user_id');
		if (route === 'chat' && conversations.length + users.length === 1) {
			return studioWebImTarget(conversations[0], users[0]) ?? 'invalid';
		}
		if ((route === 'add-contact' || route === 'create-group') && !conversations.length && !users.length) {
			return { kind: route };
		}
	}
	return 'invalid';
}

export function studioWebImUrl(workbench: URL, target: StudioWebImTarget): URL {
	const url = new URL(workbench.href);
	url.search = '';
	url.hash = '';
	if ('id' in target) {
		url.searchParams.set('im', 'chat');
		url.searchParams.set(target.kind === 'user' ? 'user_id' : 'conversation_id', target.id);
	} else {
		url.searchParams.set('im', target.kind);
	}
	return url;
}
