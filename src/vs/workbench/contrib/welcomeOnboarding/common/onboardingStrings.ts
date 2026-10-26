/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { language } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';

const defaults = {
	welcome: localize('studio.onboarding.welcome', "Welcome to SteamHarness Studio"),
	description: localize('studio.onboarding.description', "Sign in to your SteamHarness server to access your projects and account services."),
	signIn: localize('studio.onboarding.signIn', "Sign In to SteamHarness"),
	accountHint: localize('studio.onboarding.accountHint', "Choose your server and sign in on the Account page in Settings. You can also sign in later from the account menu."),
	signedIn: localize('studio.onboarding.signedIn', "You're signed in to SteamHarness. Continue to personalize your workspace."),
	openAccountError: localize('studio.onboarding.openAccountError', "Unable to open the account page. Try again from the account menu or Settings > Account."),
	close: localize('studio.onboarding.close', "Close"),
	back: localize('studio.onboarding.back', "Back"),
	continue: localize('studio.onboarding.continue', "Continue"),
	skipSignIn: localize('studio.onboarding.skipSignIn', "Continue without Signing In"),
	getStarted: localize('studio.onboarding.getStarted', "Get Started"),
	stepOf: localize('studio.onboarding.stepOf', "{0} of {1}"),
	stepAria: localize('studio.onboarding.stepAria', "Step {0} of {1}: {2}"),
	signInTitle: localize('studio.onboarding.signInTitle', "Sign In"),
	personalizeTitle: localize('studio.onboarding.personalizeTitle', "Make It Yours"),
	personalizeSubtitle: localize('studio.onboarding.personalizeSubtitle', "Choose your theme and keyboard mapping"),
	theme: localize('studio.onboarding.theme', "Color Theme"),
	themeHint: localize('studio.onboarding.themeHint', "You can browse and install more themes later from the Extensions view."),
	chooseTheme: localize('studio.onboarding.chooseTheme', "Choose a color theme"),
	themeSelected: localize('studio.onboarding.themeSelected', "{0} theme selected"),
	keymap: localize('studio.onboarding.keymap', "Keyboard Mapping"),
	keymapHint: localize('studio.onboarding.keymapHint', "Coming from another editor? Import your keyboard mapping to feel right at home."),
	chooseKeymap: localize('studio.onboarding.chooseKeymap', "Choose a keyboard mapping"),
	keymapSelected: localize('studio.onboarding.keymapSelected', "{0} keyboard mapping selected"),
	keymapInstallError: localize('studio.onboarding.keymapInstallError', "Could not install {0} keymap. You can install it later from Extensions."),
	commandHint: localize('studio.onboarding.commandHint', "Tip: Press {0} to access all SteamHarness Studio commands."),
};

// Studio strings are also available before a language pack has been installed.
const translations: Record<string, Partial<typeof defaults>> = {
	'zh-cn': {
		welcome: "欢迎使用 SteamHarness Studio",
		description: "登录你的 SteamHarness 服务器，访问项目和账号服务。",
		signIn: "登录 SteamHarness",
		accountHint: "在设置的“账号”页选择服务器并登录。你也可以稍后从账号菜单登录。",
		signedIn: "已登录 SteamHarness，继续设置你的工作区外观。",
		openAccountError: "无法打开账号页，请从账号菜单或“设置 > 账号”重试。",
		close: "关闭",
		back: "上一步",
		continue: "继续",
		skipSignIn: "暂不登录，继续",
		getStarted: "开始使用",
		stepOf: "第 {0} 步，共 {1} 步",
		stepAria: "第 {0} 步，共 {1} 步：{2}",
		signInTitle: "登录",
		personalizeTitle: "个性化设置",
		personalizeSubtitle: "选择主题和键盘映射",
		theme: "颜色主题",
		themeHint: "稍后可以在扩展视图中浏览和安装更多主题。",
		chooseTheme: "选择颜色主题",
		themeSelected: "已选择 {0} 主题",
		keymap: "键盘映射",
		keymapHint: "从其他编辑器迁移？导入熟悉的键盘映射。",
		chooseKeymap: "选择键盘映射",
		keymapSelected: "已选择 {0} 键盘映射",
		keymapInstallError: "无法安装 {0} 键盘映射，稍后可以从扩展视图安装。",
		commandHint: "提示：按 {0} 访问所有 SteamHarness Studio 命令。",
	},
};

export const onboardingStrings = { ...defaults, ...translations[language] };
