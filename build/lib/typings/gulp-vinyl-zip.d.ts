
declare module '@vscode/gulp-vinyl-zip' {
	export function src(): NodeJS.ReadWriteStream;
	export function zip(path: string): NodeJS.ReadWriteStream;
}
