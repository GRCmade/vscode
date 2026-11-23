/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IStudioTrayNotification {
	readonly title: string;
	readonly detail?: string;
}

export interface IStudioTrayNotifications {
	readonly count: number;
	readonly items: readonly IStudioTrayNotification[];
}

export const studioTrayPreviewLimit = 12;

export const emptyStudioTrayNotifications: IStudioTrayNotifications = { count: 0, items: [] };

export interface IStudioTrayPreview extends IStudioTrayNotifications {
	readonly language: string;
	readonly labels: {
		readonly title: string;
		readonly readAll: string;
		readonly reading: string;
		readonly noPreview: string;
		readonly failed: string;
	};
}
