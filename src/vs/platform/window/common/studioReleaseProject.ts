/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IStudioReleaseProject {
	readonly projectUri: string;
	readonly name: string;
	readonly avatarUrl: string;
}

/** The legacy catalog also contains locally created sources. Only downloads recorded an installed version. */
export function hasStudioDownloadRecord(imports: unknown, uri: string, project?: { id: string; version: string }): boolean {
	return Array.isArray(imports) && imports.some(row => row?.uri === uri && typeof row.version === 'string' && !!row.version.trim()
		&& (!project || row.id === project.id.toLowerCase() && row.version === project.version));
}

/** A downloaded source snapshot has normal source bytes. Match the installation record to the current folder and identity. */
export function downloadedStudioProject(uri: string, document: string, imports: unknown, receipt?: string): IStudioReleaseProject | undefined {
	try {
		const project = JSON.parse(document);
		if (typeof project?.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(project.id) || typeof project.version !== 'string' || !project.version.trim() || project.distribution !== undefined || typeof project.name !== 'string' || !project.name.trim() || !Array.isArray(project.entries) || !project.entries.some((entry: { entryId?: string }) => entry?.entryId === project.defaultEntry)) { return undefined; }
		const saved = hasStudioDownloadRecord(imports, uri, project);
		const mark = !saved && receipt && JSON.parse(receipt);
		return saved || (mark?.kind === 'steamharness.download' && mark.version === 1 && mark.projectId === project.id.toLowerCase() && mark.projectVersion === project.version) ? { projectUri: uri, name: project.name, avatarUrl: '' } : undefined;
	} catch { return undefined; }
}

/** Read only the release identity needed before the workbench restores any views. */
export function parseStudioReleaseProject(projectUri: string, projectJson: string, releaseJson: string, locale = 'en'): IStudioReleaseProject | undefined {
	try {
		const project = JSON.parse(projectJson);
		const release = JSON.parse(releaseJson);
		if (project?.distribution?.kind !== 'release' || project.distribution.version !== 1 || release?.kind !== 'steamharness.project.release' || release.version !== 1
			|| typeof project.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(project.id)
			|| release.projectId !== project.id || typeof project.version !== 'string' || release.projectVersion !== project.version || typeof project.name !== 'string' || !project.name.trim()
			|| typeof project.defaultEntry !== 'string' || !project.defaultEntry
			|| !Array.isArray(release.entries) || !release.entries.some((entry: { entryId?: string }) => entry?.entryId === project.defaultEntry)) {
			return undefined;
		}
		const avatar = project.projectCard?.avatarUrl;
		const language = locale.toLowerCase().replace(/_/g, '-');
		const names = Object.entries(project.projectInfo?.localizedNames ?? {});
		const localized = names.find(([key]) => key.toLowerCase() === language)?.[1] ?? names.find(([key]) => key.toLowerCase() === language.split('-')[0])?.[1] ?? names.find(([key]) => key.toLowerCase() === 'en')?.[1];
		return { projectUri, name: typeof localized === 'string' && localized.trim() ? localized : project.name,
			avatarUrl: typeof avatar === 'string' && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(avatar) ? avatar : '' };
	} catch { return undefined; }
}
