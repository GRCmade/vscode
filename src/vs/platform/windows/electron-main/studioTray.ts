/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Menu, type NativeImage, nativeImage, Tray } from 'electron';
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { getNLSLanguage } from '../../../nls.js';
import { emptyStudioTrayNotifications, IStudioTrayNotifications } from '../common/studioTrayNotifications.js';
import { StudioTrayPreview } from './studioTrayPreview.js';

// 2x SteamHarness brand assets from docs/assets/brand, embedded for packaged builds.
// The macOS template frames the mark with viewBox="234 197 544 544" to fill the 18 pt canvas.
const templatePng = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAABmJLR0QA/wD/AP+gvaeTAAACB0lEQVRYhe3XT4hNYRjH8c/4U0ahjDKNPwuJmoiFhSxtWFmwo2HsKTtTLCSyUJaSBQ3Z2EipIbKxQFmIlIXE+LNRMgYxf1yL957cuc57zr3nnivp/upZ3Ps+z3O+5z3v+zvvoaOO/jN1tVDbg9XoxTIsyMkfwxvcw+cWrjtDqzCE+5hGpUD8wGWsbAVkKc5ioiBEWnzE1iIw+zBeIkhtfMGGRkG6cKxNILXxGLMagbn0F2CS2J5ceE4EaAgDedQ1GsdUTs48dEfGduBmrHCb/B30AaewGfMbhO7Gw0i/O7Gi2XiWAfITZ7CoQYh6nY/0fZAk1D+y/eiPNJvCIK5Ufy/BFiyXb4oEI90bGXsXK3ohPjsHqznrcL0KWNaiTnrP0PqMgpFqzqDgtGV7UW8a0NGMoo3YJayhsrf8kTQYuBUpeCKsl09tgLkqwxSfRopO42TJIN9xPA2mdpf1RUBf40DsLvBNWFd5GsMo7mIYr7KSuzAp/W72RP6v4IK42xdSMmUVPEoZn8bLjPph+a+Mwtrkz4V7WLD82AxdxNwyIeqPsH3YLTjviN+W/hxrIz0aXUP1msB7nBNeKU3phPK3fG0cahaoR3t8KIm3zQLBTu1x6orwyAt9AQ0IplY20O0iMIn6cU3ct5qNUaxJmrfyobhYOA+twMIC9ZPCOegGvrbA0VFH/7Z+AZAwycX4IlRmAAAAAElFTkSuQmCC';
const colorPng = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAE40lEQVRYhe2XS2yUVRTHf/d79DEdoJ2W8k5LoKgkBBDUpKRaCcZIV4LFjQYXhqUmujPEaEK6NTFs0JUSN1ZdqhGIhgRFQROJgjSgBBX7mjKdzvv77jkuZjrMq62yYcOZnJw797vf/f/Puefeez64L/dYzFLPVbUlD3sF2YhYB8AuMFhK1nFcEZw/lsMZY0we0P9NbFY1lpPwTKgShCraSIMltKASzElwKqHasZCzjTpNSrW7WeWyMSZmVSkgKKBolSsKqNb8L0+stBgX3ziEaDyJs3W1MVO10XDq4AcHXR85bYyJZdWS1JCcCjm1JVvUrJRULVm1ZEpabIek1DIlBZIS4mE62zQ8xeCgu1QETEH1MUf1uwAhpbZEV6u8U6UckUrPG44FYo5PCw5zxj7aZZouVkahOgLDw44VOYyBnErdhAr4OCx3PKRgmZpLMZ6cY2I2yeRskunZJK3WsMx4mIp3UhpiDHjCSwwPV2F6dSExug4MtsZDB0OzGD64McbJG79xfTaBioAV1AqIoNbiqHKwdwsj/YOkveIMYclfNWZDLV4dAS31VYK7GGayWV78/muuJRNFMJEGVrHW8vHYrwRBwDv7nmFGg3IkTAO8ug6paM8vVLYQ8Oy3XzGeSZfBoo5HbzSKq4qKggjWCr9MTWBF+PzqJUb6n4BWvyLthVqpI1C75lHj8eqlc4xnMiBCxHEZ2dHP871baHKqU0hUGRj9kCuTf9MZZJiejRNpXb3oKdSAQLX7Y3MJTo//CSJ4Yvho4Cl+mp5g7xejXJ2JE4QhiEVtMTLGCt1Bhq4wx/pYN/GKs6Pe/0UIKOAbw5f/3Cwn2cENmzh5/Qqf/H61mHzl9S8uAVaIBWliQYaXd+8haPZRDe8uAori4jCWTNDV1MTrD+3AV4fXzn8DotXJZ4skOsIcO6MRXtg2wN5HBpnUwpKXQKNdUGWtCD2RZWzv6GKylAcqwqGND3B8YB9eRR4oEKiS0pB4RfbfXQ4AWRXe2PowI5cucDkeZ4XfVPb44uQtjv98EQN4YmmzARHJE7EBEVugd9V62vu2c1uD8h3SiMiiORCiLG9r5d3+JwlQwnxAu+dzO8hy/fYMb50/i28Dugupks6V7bVCiudeOQ49m1HMgmGov4zKBIo/i5LUkIxaaPY48fjTrPB81ApGLLEgU9I0nUGGzpKNBWncIF+8LRdZg4YRqF27+XZeLdvWreHcocOcvXmDW/EJImGOqM0TtQWiYZ42WyBq86xZu4mgbycihYW9bERAjUnCnWvyDpkinawK2uyyp28z3pa+8phq8kpShIIUd4FjzPzD2Vq8OnKh6A8ATcapA6+MTICQUUu6VAek1ZJSS0pD0mIpVBxArSWYAHN+SQJ5xzshqrmo8XC4UwUtdOdXa7FQqOxzgQ7HxxrNiuO/vySBB4eGunIqb7rG6EqniRbjVnlfCz7fo2hFoVKUNuOwwW3FM0ZThEe3Dg2trMWrlyO7/PYD+3sSNn8sJzYsqNWcWE1LWNZUA52r0YwU38tIGE7Y/NvtB/b3cGSXXwvXuCw/sstvn161duzTz/wmcY45xtltoLXR0EY7TFFENRPChYwjR7cfPGATXRO3eO/H4L8RmCfx16q16rqL7aIlxVgrifWNwRcnADA8XFfF3pWMji70LXNf7r38C9J6fq1Ajt2mAAAAAElFTkSuQmCC';

// Windows and Linux trays do not support a separate title. Render the count at
// the icon's native 2x resolution without depending on installed font metrics.
const badgeGlyphs = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111', '000010111010000'];

function withBadge(image: NativeImage, label: string): NativeImage {
	const scaleFactor = 2;
	const size = image.getSize(scaleFactor); // Logical size; the bitmap is in physical pixels.
	const width = size.width * scaleFactor;
	const height = size.height * scaleFactor;
	const pixels = image.toBitmap({ scaleFactor });
	const left = width - label.length * 8 - 2;
	const top = height - 14;
	if (left < 0 || top < 0 || pixels.length !== width * height * 4) { return image; }
	const put = (x: number, y: number, rgb: number) => pixels.writeUInt32LE(0xff000000 + rgb, (y * width + x) * 4);
	for (let y = top; y < height; y++) {
		for (let x = left; x < width; x++) {
			// Bitmap bytes are BGRA; paint fully opaque pixels over the original icon.
			const dx = Math.max(left + 3 - x, x - (width - 4), 0);
			const dy = Math.max(top + 3 - y, y - (height - 4), 0);
			if (dx * dx + dy * dy <= 9) { put(x, y, 0xb42332); }
		}
	}
	for (let i = 0; i < label.length; i++) {
		const glyph = badgeGlyphs[label[i] === '+' ? 10 : Number(label[i])];
		for (let cell = 0; cell < glyph.length; cell++) {
			if (glyph[cell] === '0') { continue; }
			const x = left + 2 + i * 8 + (cell % 3) * 2;
			const y = top + 2 + Math.floor(cell / 3) * 2;
			put(x, y, 0xffffff); put(x + 1, y, 0xffffff);
			put(x, y + 1, 0xffffff); put(x + 1, y + 1, 0xffffff);
		}
	}
	return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor });
}

export interface IStudioTray extends IDisposable {
	setNotifications(notices: IStudioTrayNotifications, reset?: boolean): void;
}

export function createStudioTray(show: () => void, quit: () => void, markAll: () => Promise<boolean>, onError: (error: unknown) => void): IStudioTray {
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
	let notices = emptyStudioTrayNotifications;
	let preview: StudioTrayPreview | undefined;
	tray.on('click', (_event, bounds) => {
		if (preview) { preview.close(); return; }
		if (!notices.count) { show(); return; }
		try {
			preview = new StudioTrayPreview(bounds, notices, markAll, () => { preview = undefined; }, onError);
		} catch (error) { onError(error); }
	});
	if (isLinux) {
		tray.setContextMenu(menu);
	} else {
		tray.on('right-click', () => { preview?.close(); tray.popUpContextMenu(menu); });
	}
	const lifetime = toDisposable(() => { preview?.close(); tray.destroy(); });
	return {
		dispose: () => lifetime.dispose(),
		setNotifications(next, reset) {
			if (tray.isDestroyed()) { return; }
			const previousCount = notices.count;
			notices = next;
			if (reset) { preview?.close(); }
			else { preview?.update(next); }
			const count = next.count;
			if (previousCount === count) { return; }
			const label = count > 99 ? '99+' : count ? String(count) : '';
			const previous = previousCount > 99 ? '99+' : previousCount ? String(previousCount) : '';
			if (label !== previous) {
				if (isMacintosh) { tray.setTitle(label ? ` ${label}` : ''); }
				else { tray.setImage(label ? withBadge(image, label) : image); }
			}
			tray.setToolTip(count ? zh ? `SteamHarness Studio · ${count} 条未读消息` : `SteamHarness Studio · ${count} unread` : 'SteamHarness Studio');
		},
	};
}
