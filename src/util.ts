/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/



import { Event } from 'vscode';
import { dirname } from 'path';
import * as fs from 'fs';
import * as tmp from 'tmp';

export function log(...args: any[]): void {
	console.log.apply(console, ['hg:', ...args]);
}

export interface IDisposable {
	dispose(): void;
}

export function dispose<T extends IDisposable>(disposables: T[]): T[] {
	disposables.forEach(d => d.dispose());
	return [];
}

export function toDisposable(dispose: () => void): IDisposable {
	return { dispose };
}

export function combinedDisposable(disposables: IDisposable[]): IDisposable {
	return toDisposable(() => dispose(disposables));
}

export const EmptyDisposable = toDisposable(() => null);

export function mapEvent<I, O>(event: Event<I>, map: (i: I) => O): Event<O> {
	return (listener, thisArgs = null, disposables?) => event(i => listener.call(thisArgs, map(i)), null, disposables);
}

export function filterEvent<T>(event: Event<T>, filter: (e: T) => boolean): Event<T> {
	return (listener, thisArgs = null, disposables?) => event(e => filter(e) && listener.call(thisArgs, e), null, disposables);
}

export function anyEvent<T>(...events: Event<T>[]): Event<T> {
	return (listener, thisArgs = null, disposables?) => {
		const result = combinedDisposable(events.map(event => event(i => listener.call(thisArgs, i))));

		if (disposables) {
			disposables.push(result);
		}

		return result;
	};
}

export function done<T>(promise: Promise<T>): Promise<void> {
	return promise.then<void>(() => void 0, <any>(() => void 0));
}

export function once<T>(event: Event<T>): Event<T> {
	return (listener, thisArgs = null, disposables?) => {
		const result = event(e => {
			result.dispose();
			return listener.call(thisArgs, e);
		}, null, disposables);

		return result;
	};
}

export function eventToPromise<T>(event: Event<T>): Promise<T> {
	return new Promise(c => once(event)(c));
}

// TODO@Joao: replace with Object.assign
export function assign<T>(destination: T, ...sources: any[]): T {
	for (const source of sources) {
		Object.keys(source).forEach(key => destination[key] = source[key]);
	}

	return destination;
}

export function uniqBy<T>(arr: T[], fn: (el: T) => string): T[] {
	const seen = Object.create(null);

	return arr.filter(el => {
		const key = fn(el);

		if (seen[key]) {
			return false;
		}

		seen[key] = true;
		return true;
	});
}

export function groupBy<T>(arr: T[], fn: (el: T) => string): { [key: string]: T[] } {
	return arr.reduce((result, el) => {
		const key = fn(el);
		result[key] = [...(result[key] || []), el];
		return result;
	}, Object.create(null));
}

export function partition<T>(array: T[], fn: (el: T, i: number, ary: T[]) => boolean): [T[], T[]] {
	return array.reduce((result: [T[], T[]], element: T, i: number) => {
		if (fn(element, i, array)) {
			result[0].push(element)
		}
		else {
			result[1].push(element);
		}
		return result;
	}, <[T[], T[]]>[[], []]);
};

export function denodeify<R>(fn: Function): (...args) => Promise<R> {
	return (...args) => new Promise((c, e) => fn(...args, (err, r) => err ? e(err) : c(r)));
}

export function nfcall<R>(fn: Function, ...args): Promise<R> {
	return new Promise((c, e) => fn(...args, (err, r) => err ? e(err) : c(r)));
}

export async function mkdirp(path: string, mode?: number): Promise<boolean> {
	const mkdir = async () => {
		try {
			await nfcall(fs.mkdir, path, mode);
		}
		catch (err) {
			if (err.code === 'EEXIST') {
				const stat = await nfcall<fs.Stats>(fs.stat, path);

				if (stat.isDirectory()) {
					return;
				}

				throw new Error(`'${path}' exists and is not a directory.`);
			}

			throw err;
		}
	};

	// is root?
	if (path === dirname(path)) {
		return true;
	}

	try {
		await mkdir();
	}
	catch (err) {
		if (err.code !== 'ENOENT') {
			throw err;
		}

		await mkdirp(dirname(path), mode);
		await mkdir();
	}

	return true;
}

export function uniqueFilter<T>(keyFn: (t: T) => string): (t: T) => boolean {
	const seen: { [key: string]: boolean; } = Object.create(null);

	return element => {
		const key = keyFn(element);

		if (seen[key]) {
			return false;
		}

		seen[key] = true;
		return true;
	};
}

export async function writeStringToTempFile(contents: string, disposables?: IDisposable[]): Promise<string> {
	const tempFile = await createTempFile();
	await new Promise<void>((c, e) => fs.writeFile(tempFile.fsPath, contents, (err) => err ? e(err) : c()));
	if (disposables) {
		disposables.push(tempFile);
	}
	return tempFile.fsPath;
}

async function createTempFile(): Promise<{ fsPath: string, dispose: () => void }> {
	const [fsPath, dispose] = await new Promise<[string, () => void]>((c, e) => {
		tmp.file({ discardDescriptor: true }, (err, path, _, cleanupCallback) => {
			if (err) {
				return e(err);
			}

			c([path, cleanupCallback]);
		})
	})

	return { fsPath, dispose };
}

export function asciiOnly(text: string): boolean {
	return [...text].every(c => c.charCodeAt(0) < 0x80);
}

export async function delay(millis: number): Promise<any> {
	return new Promise((c, e) => setTimeout(c, millis));
}