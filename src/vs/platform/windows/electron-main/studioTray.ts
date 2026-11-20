/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Menu, nativeImage, Tray } from 'electron';
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { getNLSLanguage } from '../../../nls.js';

// 2x SteamHarness brand assets from docs/assets/brand, embedded for packaged builds.
// The macOS template frames the mark with viewBox="234 197 544 544" to fill the 18 pt canvas.
const templatePng = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAABmJLR0QA/wD/AP+gvaeTAAACB0lEQVRYhe3XT4hNYRjH8c/4U0ahjDKNPwuJmoiFhSxtWFmwo2HsKTtTLCSyUJaSBQ3Z2EipIbKxQFmIlIXE+LNRMgYxf1yL957cuc57zr3nnivp/upZ3Ps+z3O+5z3v+zvvoaOO/jN1tVDbg9XoxTIsyMkfwxvcw+cWrjtDqzCE+5hGpUD8wGWsbAVkKc5ioiBEWnzE1iIw+zBeIkhtfMGGRkG6cKxNILXxGLMagbn0F2CS2J5ceE4EaAgDedQ1GsdUTs48dEfGduBmrHCb/B30AaewGfMbhO7Gw0i/O7Gi2XiWAfITZ7CoQYh6nY/0fZAk1D+y/eiPNJvCIK5Ufy/BFiyXb4oEI90bGXsXK3ohPjsHqznrcL0KWNaiTnrP0PqMgpFqzqDgtGV7UW8a0NGMoo3YJayhsrf8kTQYuBUpeCKsl09tgLkqwxSfRopO42TJIN9xPA2mdpf1RUBf40DsLvBNWFd5GsMo7mIYr7KSuzAp/W72RP6v4IK42xdSMmUVPEoZn8bLjPph+a+Mwtrkz4V7WLD82AxdxNwyIeqPsH3YLTjviN+W/hxrIz0aXUP1msB7nBNeKU3phPK3fG0cahaoR3t8KIm3zQLBTu1x6orwyAt9AQ0IplY20O0iMIn6cU3ct5qNUaxJmrfyobhYOA+twMIC9ZPCOegGvrbA0VFH/7Z+AZAwycX4IlRmAAAAAElFTkSuQmCC';
const colorPng = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAE40lEQVRYhe2XS2yUVRTHf/d79DEdoJ2W8k5LoKgkBBDUpKRaCcZIV4LFjQYXhqUmujPEaEK6NTFs0JUSN1ZdqhGIhgRFQROJgjSgBBX7mjKdzvv77jkuZjrMq62yYcOZnJw797vf/f/Puefeez64L/dYzFLPVbUlD3sF2YhYB8AuMFhK1nFcEZw/lsMZY0we0P9NbFY1lpPwTKgShCraSIMltKASzElwKqHasZCzjTpNSrW7WeWyMSZmVSkgKKBolSsKqNb8L0+stBgX3ziEaDyJs3W1MVO10XDq4AcHXR85bYyJZdWS1JCcCjm1JVvUrJRULVm1ZEpabIek1DIlBZIS4mE62zQ8xeCgu1QETEH1MUf1uwAhpbZEV6u8U6UckUrPG44FYo5PCw5zxj7aZZouVkahOgLDw44VOYyBnErdhAr4OCx3PKRgmZpLMZ6cY2I2yeRskunZJK3WsMx4mIp3UhpiDHjCSwwPV2F6dSExug4MtsZDB0OzGD64McbJG79xfTaBioAV1AqIoNbiqHKwdwsj/YOkveIMYclfNWZDLV4dAS31VYK7GGayWV78/muuJRNFMJEGVrHW8vHYrwRBwDv7nmFGg3IkTAO8ug6paM8vVLYQ8Oy3XzGeSZfBoo5HbzSKq4qKggjWCr9MTWBF+PzqJUb6n4BWvyLthVqpI1C75lHj8eqlc4xnMiBCxHEZ2dHP871baHKqU0hUGRj9kCuTf9MZZJiejRNpXb3oKdSAQLX7Y3MJTo//CSJ4Yvho4Cl+mp5g7xejXJ2JE4QhiEVtMTLGCt1Bhq4wx/pYN/GKs6Pe/0UIKOAbw5f/3Cwn2cENmzh5/Qqf/H61mHzl9S8uAVaIBWliQYaXd+8haPZRDe8uAori4jCWTNDV1MTrD+3AV4fXzn8DotXJZ4skOsIcO6MRXtg2wN5HBpnUwpKXQKNdUGWtCD2RZWzv6GKylAcqwqGND3B8YB9eRR4oEKiS0pB4RfbfXQ4AWRXe2PowI5cucDkeZ4XfVPb44uQtjv98EQN4YmmzARHJE7EBEVugd9V62vu2c1uD8h3SiMiiORCiLG9r5d3+JwlQwnxAu+dzO8hy/fYMb50/i28Dugupks6V7bVCiudeOQ49m1HMgmGov4zKBIo/i5LUkIxaaPY48fjTrPB81ApGLLEgU9I0nUGGzpKNBWncIF+8LRdZg4YRqF27+XZeLdvWreHcocOcvXmDW/EJImGOqM0TtQWiYZ42WyBq86xZu4mgbycihYW9bERAjUnCnWvyDpkinawK2uyyp28z3pa+8phq8kpShIIUd4FjzPzD2Vq8OnKh6A8ATcapA6+MTICQUUu6VAek1ZJSS0pD0mIpVBxArSWYAHN+SQJ5xzshqrmo8XC4UwUtdOdXa7FQqOxzgQ7HxxrNiuO/vySBB4eGunIqb7rG6EqniRbjVnlfCz7fo2hFoVKUNuOwwW3FM0ZThEe3Dg2trMWrlyO7/PYD+3sSNn8sJzYsqNWcWE1LWNZUA52r0YwU38tIGE7Y/NvtB/b3cGSXXwvXuCw/sstvn161duzTz/wmcY45xtltoLXR0EY7TFFENRPChYwjR7cfPGATXRO3eO/H4L8RmCfx16q16rqL7aIlxVgrifWNwRcnADA8XFfF3pWMji70LXNf7r38C9J6fq1Ajt2mAAAAAElFTkSuQmCC';

export function createStudioTray(show: () => void, quit: () => void): IDisposable {
	const zh = getNLSLanguage()?.toLowerCase().startsWith('zh');
	const image = nativeImage.createFromBuffer(Buffer.from(isMacintosh ? templatePng : colorPng, 'base64'), { scaleFactor: 2 });
	if (isMacintosh) { image.setTemplateImage(true); }
	const tray = new Tray(image);
	const menu = Menu.buildFromTemplate([
		{ label: zh ? '显示启动台' : 'Show Launchpad', click: show },
		{ type: 'separator' },
		{ label: zh ? '退出 SteamHarness Studio' : 'Quit SteamHarness Studio', click: quit },
	]);
	tray.setToolTip('SteamHarness Studio');
	tray.on('click', show);
	if (isLinux) {
		tray.setContextMenu(menu);
	} else {
		tray.on('right-click', () => tray.popUpContextMenu(menu));
	}
	return toDisposable(() => tray.destroy());
}
