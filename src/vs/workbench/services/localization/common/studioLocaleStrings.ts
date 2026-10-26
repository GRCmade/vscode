/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { language } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';

const defaults = {
	writeFailed: localize('studio.locale.writeFailed', "Unable to save display language."),
	unsupported: localize('studio.locale.unsupported', "Unsupported display language."),
	unavailable: localize('studio.locale.unavailable', "The selected language pack is unavailable. Please try again."),
	system: localize('studio.locale.system', "System Language"),
	restart: localize('studio.locale.restart', "&&Restart"),
	restartMessage: localize('studio.locale.restartMessage', "Restart {0} to switch to {1}?"),
	restartDetail: localize('studio.locale.restartDetail', "To change the display language to {0}, {1} needs to restart."),
};

// Studio-specific messages are not included in upstream language packs.
const chinese: typeof defaults = {
	writeFailed: "无法保存显示语言。",
	unsupported: "不支持此显示语言。",
	unavailable: "所选语言包暂不可用，请重试。",
	system: "系统语言",
	restart: "重启(&&R)",
	restartMessage: "是否重启 {0} 以切换为{1}？",
	restartDetail: "需要重启 {1} 才能将显示语言切换为{0}。",
};

export const studioLocaleStrings = language === 'zh-cn' ? chinese : defaults;
