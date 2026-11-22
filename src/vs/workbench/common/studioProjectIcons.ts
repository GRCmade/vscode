/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Shared project glyphs for native Studio surfaces. */
export function studioProjectIcon(projectType: string | undefined): string | undefined {
	switch (projectType) {
		case 'workflow': return 'run-all';
		case 'bot': return 'hubot';
		case 'kanban': return 'layout';
		default: return undefined;
	}
}

/**
 * The project card identity is shared by every Studio surface that can render an
 * image. Keep the Lucide glyphs in sync with the platform project type defaults:
 * workflow -> Workflow, bot -> Bot, kanban -> Boxes.
 */
const projectCardGlyphs: Record<string, { background: string; paths: readonly string[] }> = Object.assign(Object.create(null) as Record<string, { background: string; paths: readonly string[] }>, {
	workflow: { background: '#2563eb', paths: ['<rect width="8" height="8" x="3" y="3" rx="2"/>', '<path d="M7 11v4a2 2 0 0 0 2 2h4"/>', '<rect width="8" height="8" x="13" y="13" rx="2"/>'] },
	bot: { background: '#0f766e', paths: ['<path d="M12 8V4H8"/>', '<rect width="16" height="12" x="4" y="8" rx="2"/>', '<path d="M2 14h2"/>', '<path d="M20 14h2"/>', '<path d="M15 13v2"/>', '<path d="M9 13v2"/>'] },
	kanban: { background: '#b45309', paths: [
		'<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/>',
		'<path d="m7 16.5-4.74-2.85"/>', '<path d="m7 16.5 5-3"/>', '<path d="M7 16.5v5.17"/>',
		'<path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/>',
		'<path d="m17 16.5-5-3"/>', '<path d="m17 16.5 4.74-2.85"/>', '<path d="M17 16.5v5.17"/>',
		'<path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/>',
		'<path d="M12 8 7.26 5.15"/>', '<path d="m12 8 4.74-2.85"/>', '<path d="M12 13.5V8"/>',
	] },
});

/** Self-contained Lucide project glyph as a data URI, shared by native image surfaces. */
export function studioProjectCardIcon(projectType: string | undefined): string | undefined {
	const glyph = projectType ? projectCardGlyphs[projectType] : undefined;
	if (!glyph) { return undefined; }
	return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="${glyph.background}"/><g transform="translate(14 14) scale(1.5)" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyph.paths.join('')}</g></svg>`)}`;
}
