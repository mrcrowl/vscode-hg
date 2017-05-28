/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { assign, uniqBy, groupBy, denodeify, IDisposable, toDisposable, dispose, mkdirp, asciiOnly, writeStringToTempFile } from "./util";
import { EventEmitter, Event, OutputChannel, workspace, Disposable } from "vscode";
import * as nls from 'vscode-nls';
import { HgCommandServer } from "./hgserve";

const localize = nls.loadMessageBundle();
const readdir = denodeify<string[]>(fs.readdir);
const readfile = denodeify<string>(fs.readFile);

export interface IHg {
	path: string;
	version: string;
}

export interface LogEntryRepositoryOptions extends LogEntryOptions {
	filePaths?: string[];
	follow?: boolean;
	limit?: number;
}

export interface LogEntryOptions {
	revQuery?: string;
	branch?: string;
}

export interface PushOptions extends SyncOptions {
	allowPushNewBranches?: boolean;
	branch: string | undefined;
}

export interface SyncOptions {
	branch: string | undefined;
}

export interface IMergeResult {
	unresolvedCount: number;
}

export interface IRepoStatus {
	isMerge: boolean;
}

export interface IFileStatus {
	status: string;
	path: string;
	rename?: string;
}

export interface ICommitDetails {
	message: string;
	affectedFiles: IFileStatus[];
}

export enum RefType {
	Branch,
	Tag,
	Bookmark
}

export interface Ref {
	type: RefType;
	name?: string;
	commit?: string;
}

export interface Path {
	name: string;
	url: string;
}

export interface Branch extends Ref {
	upstream?: string;
	ahead?: number;
	behind?: number;
}

function parseVersion(raw: string): string {
	let match = raw.match(/\(version ([^\)]+)\)/);
	if (match) {
		return match[1];
	}

	return "?";
}

export interface HgFindAttemptLogger {
	log(path: string);
}

export class HgFinder {
	constructor(private logger: HgFindAttemptLogger) { }

	private logAttempt(path: string) {
		this.logger.log(path);
	}

	public async find(hint?: string): Promise<IHg> {
		const first = hint ? this.findSpecificHg(hint) : Promise.reject<IHg>(null);

		return first.then(undefined, () => {
			switch (process.platform) {
				case 'darwin': return this.findHgDarwin();
				case 'win32': return this.findHgWin32();
				default: return this.findSpecificHg('hg');
			}
		});
	}

	private findHgDarwin(): Promise<IHg> {
		return this.findTortoiseHgDarwin("/Applications/TortoiseHg.app/Contents/Resources")
			.then(undefined, () => this.findHgDarwinUsingWhich());
	}

	private findTortoiseHgDarwin(base: string): Promise<IHg> {
		if (!base) {
			return Promise.reject<IHg>('Not found');
		}

		return this.findSpecificHg(path.join(base, 'lib', 'python2.7', 'hg'));
	}

	private findHgDarwinUsingWhich(): Promise<IHg> {
		return new Promise<IHg>((c, e) => {
			cp.exec('which hg', (err, hgPathBuffer) => {
				if (err) {
					return e('hg not found');
				}

				const path = hgPathBuffer.toString().replace(/^\s+|\s+$/g, '');

				const getVersion = (path: string) => {
					// make sure hg executes
					this.logAttempt(path);
					cp.exec('hg --version', (err, stdout: Buffer) => {
						if (err) {
							return e('hg not found');
						}

						return c({ path, version: parseVersion(stdout.toString('utf8').trim()) });
					});
				}

				return getVersion(path);
			});
		});
	}

	private findMercurialWin32(base: string): Promise<IHg> {
		if (!base) {
			return Promise.reject<IHg>('Not found');
		}

		return this.findSpecificHg(path.join(base, 'Mercurial', 'hg.exe'));
	}

	private findTortoiseHgWin32(base: string): Promise<IHg> {
		if (!base) {
			return Promise.reject<IHg>('Not found');
		}

		return this.findSpecificHg(path.join(base, 'TortoiseHg', 'hg.exe'));
	}

	private findHgWin32(): Promise<IHg> {
		return this.findMercurialWin32(process.env['ProgramW6432'])
			.then(undefined, () => this.findMercurialWin32(process.env['ProgramFiles(x86)']))
			.then(undefined, () => this.findTortoiseHgWin32(process.env['ProgramW6432']))
			.then(undefined, () => this.findTortoiseHgWin32(process.env['ProgramFiles(x86)']))
			.then(undefined, () => this.findSpecificHg('hg'))
	}

	private findSpecificHg(path: string): Promise<IHg> {
		return new Promise<IHg>((c, e) => {
			const buffers: Buffer[] = [];
			this.logAttempt(path);
			const child = cp.spawn(path, ['--version']);
			child.stdout.on('data', (b: Buffer) => buffers.push(b));
			child.on('error', e);
			child.on('exit', code => {
				if (!code) {
					const output = Buffer.concat(buffers).toString('utf8');
					return c({
						path,
						version: parseVersion(output)
					});
				}
				return e(new Error('Not found'))
			});
		});
	}
}

export interface IExecutionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function exec(child: cp.ChildProcess): Promise<IExecutionResult> {
	const disposables: IDisposable[] = [];

	const once = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
		ee.once(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	const on = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
		ee.on(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	const [exitCode, stdout, stderr] = await Promise.all<any>([
		new Promise<number>((c, e) => {
			once(child, 'error', e);
			once(child, 'exit', c);
		}),
		new Promise<string>(c => {
			const buffers: string[] = [];
			on(child.stdout, 'data', b => buffers.push(b));
			once(child.stdout, 'close', () => c(buffers.join('')));
		}),
		new Promise<string>(c => {
			const buffers: string[] = [];
			on(child.stderr, 'data', b => buffers.push(b));
			once(child.stderr, 'close', () => c(buffers.join('')));
		})
	]);

	dispose(disposables);

	return { exitCode, stdout, stderr };
}

export interface IHgErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	hgErrorCode?: string;
	hgCommand?: string;
}

export class HgRollbackDetails {
	revision: number;
	kind: string;
	commitDetails: ICommitDetails|undefined;
}

export class HgError {

	error?: Error;
	message: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	hgErrorCode?: string;
	hgCommand?: string;
	hgBranches?: string;
	hgFilenames?: string[];

	constructor(data: IHgErrorData) {
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		}
		else {
			this.error = void 0;
		}

		this.message = this.message || data.message || 'Hg error';
		this.stdout = data.stdout;
		this.stderr = data.stderr;
		this.exitCode = data.exitCode;
		this.hgErrorCode = data.hgErrorCode;
		this.hgCommand = data.hgCommand;
	}

	toString(): string {
		let result = this.message + ' ' + JSON.stringify({
			exitCode: this.exitCode,
			hgErrorCode: this.hgErrorCode,
			hgCommand: this.hgCommand,
			stdout: this.stdout,
			stderr: this.stderr
		}, [], 2);

		if (this.error) {
			result += (<any>this.error).stack;
		}

		return result;
	}
}

export interface IHgOptions {
	hgPath: string;
	version: string;
	env?: any;
	enableInstrumentation: boolean;
}

export const HgErrorCodes = {
	BadConfigFile: 'BadConfigFile',
	AuthenticationFailed: 'AuthenticationFailed',
	NoUserNameConfigured: 'NoUserNameConfigured',
	RepositoryDefaultNotFound: 'RepositoryDefaultNotFound',
	RepositoryIsUnrelated: 'RepositoryIsUnrelated',
	NotAnHgRepository: 'NotAnHgRepository',
	NotAtRepositoryRoot: 'NotAtRepositoryRoot',
	UnmergedChanges: 'UnmergedChanges',
	PushCreatesNewRemoteHead: 'PushCreatesNewRemoteHead',
	PushCreatesNewRemoteBranches: 'PushCreatesNewRemoteBranches',
	RemoteConnectionError: 'RemoteConnectionError',
	DirtyWorkingDirectory: 'DirtyWorkingDirectory',
	CantOpenResource: 'CantOpenResource',
	HgNotFound: 'HgNotFound',
	CantCreatePipe: 'CantCreatePipe',
	CantAccessRemote: 'CantAccessRemote',
	RepositoryNotFound: 'RepositoryNotFound',
	NoSuchFile: 'NoSuchFile',
	BranchAlreadyExists: 'BranchAlreadyExists',
	NoRollbackInformationAvailable: 'NoRollbackInformationAvailable',
	UntrackedFilesDiffer: 'UntrackedFilesDiffer',
	DefaultRepositoryNotConfigured: 'DefaultRepositoryNotConfigured'
};

export class Hg {

	private hgPath: string;
	private version: string;
	private server: HgCommandServer | undefined;
	private instrumentEnabled: boolean;
	private useServer: boolean;
	private disposables: Disposable[] = [];
	private openRepository: Repository | undefined;

	private _onOutput = new EventEmitter<string>();
	get onOutput(): Event<string> { return this._onOutput.event; }

	constructor(options: IHgOptions) {
		this.hgPath = options.hgPath;
		this.version = options.version;
		this.instrumentEnabled = options.enableInstrumentation;

		workspace.onDidChangeConfiguration(() => this.onConfigurationChange(), this, this.disposables);
		this.onConfigurationChange();
	}

	async onConfigurationChange(forceServerRestart?: boolean) {
		const hgConfig = workspace.getConfiguration('hg');
		const wasUsingServer = this.useServer;
		const useServer = hgConfig.get<string>('commandMode') === "server";
		this.useServer = useServer;

		if (this.server && (!useServer || forceServerRestart)) {
			this.server.stop();
			this.server = undefined;
			this.log("cmdserve stopped\n");
		}

		if (useServer && (!wasUsingServer || forceServerRestart)) {
			if (this.openRepository !== undefined) {
				this.server = await this.startServer(this.openRepository.root);
			}
		}
	}

	async startServer(repositoryRoot: string): Promise<HgCommandServer> {
		const hgFolderPath = path.dirname(this.hgPath);
		const logger = this.log.bind(this);
		const server = await HgCommandServer.start(hgFolderPath, repositoryRoot, logger);
		logger("cmdserve started\n")
		return server;
	}

	open(repository: string): Repository {
		if (this.useServer) {
			this.startServer(repository).then(server => this.server = server);
		}
		this.openRepository = new Repository(this, repository);
		return this.openRepository;
	}

	async init(repository: string): Promise<void> {
		await this.exec(repository, ['init']);
		return;
	}

	async clone(url: string, parentPath: string): Promise<string> {
		const folderName = url.replace(/^.*\//, '') || 'repository';
		const folderPath = path.join(parentPath, folderName);

		await mkdirp(parentPath);
		await this.exec(parentPath, ['clone', url, folderPath]);
		return folderPath;
	}

	async getRepositoryRoot(path: string): Promise<string> {
		const result = await this.exec(path, ['root']);
		return result.stdout.trim();
	}

	async exec(cwd: string, args: string[], options: any = {}): Promise<IExecutionResult> {
		options = { cwd, ...options };
		return await this._exec(args, options);
	}

	stream(cwd: string, args: string[], options: any = {}): cp.ChildProcess {
		options = assign({ cwd }, options || {});
		return this.spawn(args, options);
	}

	private async runServerCommand(server: HgCommandServer, args: string[], options: any = {}) {
		if (options.log !== false && !this.instrumentEnabled) {
			this.log(`hg ${args.join(' ')}\n`);
		}
		const result = await server.runcommand(...args);
		return result;
	}

	private async _exec(args: string[], options: any = {}): Promise<IExecutionResult> {
		const startTimeHR = process.hrtime();

		let result: IExecutionResult;
		if (this.server) {
			result = await this.runServerCommand(this.server, args, options);
		}
		else {
			const child = this.spawn(args, options);
			if (options.input) {
				child.stdin.end(options.input, 'utf8');
			}

			result = await exec(child);
		}

		if (this.instrumentEnabled) {
			const durationHR = process.hrtime(startTimeHR);
			this.log(`hg ${args.join(' ')}: ${Math.floor(msFromHighResTime(durationHR))}ms\n`);
		}


		if (result.exitCode) {
			let hgErrorCode: string | undefined = void 0;

			if (/Authentication failed/.test(result.stderr)) {
				hgErrorCode = HgErrorCodes.AuthenticationFailed;
			}
			else if (/no repository found/.test(result.stderr)) {
				hgErrorCode = HgErrorCodes.NotAnHgRepository;
			}
			else if (/no such file/.test(result.stderr)) {
				hgErrorCode = HgErrorCodes.NoSuchFile;
			}

			if (options.log !== false && result.stderr) {
				this.log(`${result.stderr}\n`);
			}

			return Promise.reject<IExecutionResult>(new HgError({
				message: 'Failed to execute hg',
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				hgErrorCode,
				hgCommand: args[0]
			}));
		}

		return result;
	}

	spawn(args: string[], options: any = {}): cp.ChildProcess {
		if (!this.hgPath) {
			throw new Error('hg could not be found in the system.');
		}

		if (!options) {
			options = {};
		}

		if (!options.stdio && !options.input) {
			options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
		}

		options.env = {
			HGENCODING: "utf-8", // allow user's env to overwrite this
			...process.env,
			...options.env,
			VSCODE_HG_COMMAND: args[0],
			LC_ALL: 'en_US',
			LANG: 'en_US.UTF-8'
		}

		if (!this.instrumentEnabled && options.log !== false) {
			this.log(`hg ${args.join(' ')}\n`);
		}

		return cp.spawn(this.hgPath, args, options);
	}

	private log(output: string): void {
		this._onOutput.fire(output);
	}
}

export interface Revision {
	revision: number;
	hash: string;
}

export interface Commit extends Revision {
	branch: string;
	message: string;
	author: string;
	date: Date;
}

export interface CommitDetails extends Commit {
	files: IFileStatus[];
	parent1: Commit;
	parent2: Commit | undefined;
}

export class Repository {

	constructor(
		private _hg: Hg,
		private repositoryRoot: string
	) { }

	get hg(): Hg {
		return this._hg;
	}

	get root(): string {
		return this.repositoryRoot;
	}

	// TODO@Joao: rename to exec
	async run(args: string[], options: any = {}): Promise<IExecutionResult> {
		return await this.hg.exec(this.repositoryRoot, args, options);
	}

	stream(args: string[], options: any = {}): cp.ChildProcess {
		return this.hg.stream(this.repositoryRoot, args, options);
	}

	spawn(args: string[], options: any = {}): cp.ChildProcess {
		return this.hg.spawn(args, options);
	}

	async config(scope: string, key: string, value: any, options: any): Promise<string> {
		const args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push(key);

		if (value) {
			args.push(value);
		}

		const result = await this.run(args, options);
		return result.stdout;
	}

	private async doBuffer(object: string): Promise<string> {
		const child = this.stream(['show', object]);
		const { exitCode, stdout } = await exec(child);

		if (exitCode) {
			return Promise.reject<string>(new HgError({
				message: 'Could not buffer object.',
				exitCode
			}));
		}

		return stdout;
	}

	async add(paths?: string[]): Promise<void> {
		const args = ['add'];

		if (paths && paths.length) {
			args.push.apply(args, paths);
		}
		else {
			// args.push('.'); 
		}

		await this.run(args);
	}

	async addRemove(paths: string[]): Promise<void> {
		const args = ['addremove', '-s', '50'];

		for (const path of paths) {
			args.push('-I', path);
		}

		await this.run(args);
	}

	async resolve(paths: string[], opts: { mark?: boolean } = {}): Promise<void> {
		const args = ['resolve'];

		if (opts.mark) {
			args.push('--mark')
		}

		args.push(...paths);

		try {
			await this.run(args);
		}
		catch (e) {
			if (e instanceof HgError && e.exitCode === 1 && !e.stderr) {
				return;
			}

			throw e;
		}
	}

	async unresolve(paths: string[]): Promise<void> {
		const args = ['resolve', '--unmark'];
		args.push.apply(args, paths);

		await this.run(args);
	}

	async update(treeish: string, opts?: { discard: boolean }): Promise<void> {
		const args = ['update', '-q'];

		if (treeish) {
			args.push(treeish);
		}

		if (opts && opts.discard) {
			args.push('--clean');
		}

		try {
			await this.run(args);
		}
		catch (err) {
			if (/uncommitted changes/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.DirtyWorkingDirectory;
			}

			throw err;
		}
	}

	async commit(message: string, opts: { addRemove?: boolean, fileList: string[] } = Object.create(null)): Promise<void> {
		const disposables: IDisposable[] = [];
		const args = ['commit'];

		if (opts.addRemove) {
			args.push('--addremove');
		}

		if (opts.fileList && opts.fileList.length) {
			args.push(...opts.fileList);
		}

		if (asciiOnly(message)) {
			args.push('-m', message || "");
		}
		else {
			const commitMessageFsPath = await writeStringToTempFile(message, disposables);
			args.push('-l', commitMessageFsPath);
		}

		try {
			await this.run(args);
		}
		catch (err) {
			if (/not possible because you have unmerged files/.test(err.stderr)) {
				err.hgErrorCode = HgErrorCodes.UnmergedChanges;
				throw err;
			}

			throw err;
		}
		finally {
			dispose(disposables);
		}
	}

	async branch(name: string, opts?: { force: boolean }): Promise<void> {
		const args = ['branch', '-q'];
		if (opts && opts.force) {
			args.push('-f');
		}
		args.push(name);

		try {
			await this.run(args);
		}
		catch (err) {
			if (err instanceof HgError && /a branch of the same name already exists/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.BranchAlreadyExists;
			}

			throw err;
		}
	}

	async revert(paths: string[]): Promise<void> {
		const pathsByGroup = groupBy(paths, p => path.dirname(p));
		const groups = Object.keys(pathsByGroup).map(k => pathsByGroup[k]);
		const tasks = groups.map(paths => () => this.run(['revert', '-C'].concat(paths))); // -C = no-backup

		for (let task of tasks) {
			await task();
		}
	}

	async forget(paths: string[]): Promise<void> {
		const pathsByGroup = groupBy(paths, p => path.dirname(p));
		const groups = Object.keys(pathsByGroup).map(k => pathsByGroup[k]);
		const tasks = groups.map(paths => () => this.run(['forget'].concat(paths)));

		for (let task of tasks) {
			await task();
		}
	}

	async undo(): Promise<void> {
		await this.run(['clean', '-fd']);

		try {
			await this.run(['checkout', '--', '.']);
		}
		catch (err) {
			if (/did not match any file\(s\) known to hg\./.test(err.stderr || '')) {
				return;
			}

			throw err;
		}
	}

	async rollback(dryRun?: boolean): Promise<HgRollbackDetails> {
		const args = ['rollback'];

		if (dryRun) {
			args.push('--dry-run');
		}

		try {
			const result = await this.run(args);
			const match = /back to revision (\d+) \(undo (.*)\)/.exec(result.stdout);

			if (!match) {
				throw new HgError({
					message: `Unexpected rollback result: ${JSON.stringify(result.stdout)}`,
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
					hgCommand: "rollback"
				})
			}

			const [_, revision, kind] = match;
			const commitDetails: ICommitDetails | undefined = (dryRun && kind === "commit") ? await this.tryGetLastCommitDetails() : undefined;

			return {
				revision: parseInt(revision),
				kind,
				commitDetails
			};
		}
		catch (error) {
			if (error instanceof HgError && /no rollback information available/.test(error.stderr || '')) {
				error.hgErrorCode = HgErrorCodes.NoRollbackInformationAvailable;
			}
			throw error;
		}
	}

	async tryGetLastCommitDetails(): Promise<ICommitDetails> {
		try {
			return {
				message: await this.getLastCommitMessage(),
				affectedFiles: await this.getStatus(".")
			}
		}
		catch (e) {
			return {
				message: "",
				affectedFiles: []
			};
		}
	}

	async revertFiles(treeish: string, paths: string[]): Promise<void> {
		const result = await this.run(['branch']);
		let args: string[];

		// In case there are no branches, we must use rm --cached
		if (!result.stdout) {
			args = ['rm', '--cached', '-r', '--'];
		}
		else {
			args = ['reset', '-q', treeish, '--'];
		}

		if (paths && paths.length) {
			args.push.apply(args, paths);
		}
		else {
			args.push('.');
		}

		try {
			await this.run(args);
		}
		catch (err) {
			// In case there are merge conflicts to be resolved, hg reset will output
			// some "needs merge" data. We try to get around that.
			if (/([^:]+: needs merge\n)+/m.test(err.stdout || '')) {
				return;
			}

			throw err;
		}
	}

	async countIncoming(options?: SyncOptions): Promise<number> {
		try {
			const args = ['incoming', '-q'];
			if (options && options.branch)
			{
				args.push('-b', options.branch);
			}	
			const incomingResult = await this.run(args);
			if (!incomingResult.stdout) {
				return 0;
			}

			const numIncoming = incomingResult.stdout.trim().split("\n").length;
			return numIncoming;
		}
		catch (err) {
			if (err instanceof HgError && err.exitCode === 1) { // expected result from hg when none
				return 0;
			}

			if (/repository default(\-push)? not found!/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.RepositoryDefaultNotFound;
			}
			else if (/repository is unrelated/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.RepositoryIsUnrelated;
			}
			else if (/abort/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.RemoteConnectionError;
			}

			throw err;
		}
	}

	async countOutgoing(options?: SyncOptions): Promise<number> {
		try {
			const args = ['outgoing', '-q'];
			if (options && options.branch)
			{
				args.push('-b', options.branch);
			}	
			const result = await this.run(args);

			if (!result.stdout) {
				return 0;
			}

			return result.stdout.trim().split("\n").length;
		}
		catch (err) {
			if (err instanceof HgError && err.exitCode === 1) // expected result from hg when none
			{
				return 0;
			}

			if (/repository default(\-push)? not found!/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.RepositoryDefaultNotFound;
			}
			else if (/abort/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.RemoteConnectionError;
			}

			throw err;
		}
	}

	async pull(options?: SyncOptions): Promise<void> {
		const args = ['pull'];

		if (options && options.branch)
		{
			args.push("-b", options.branch);
		}	

		try {
			await this.run(args);
		}
		catch (err) {
			if (err instanceof HgError && err.exitCode === 1) {
				return;
			}

			if (err instanceof HgError && err.stderr && /default repository not configured/.test(err.stderr)) {
				err.hgErrorCode = HgErrorCodes.DefaultRepositoryNotConfigured;
			}

			throw err;
		}
	}

	async push(path?: string, options?: PushOptions): Promise<void> {
		const args = ['push', '-q'];

		if (options && options.allowPushNewBranches) {
			args.push('--new-branch');
		}

		if (options && options.branch)
		{
			args.push("-b", options.branch);
		}	

		if (path) {
			args.push(path);
		}

		try {
			await this.run(args);
		}
		catch (err) {
			if (err instanceof HgError && err.exitCode === 1) {
				return;
			}

			if (err instanceof HgError && err.stderr && /default repository not configured/.test(err.stderr)) {
				err.hgErrorCode = HgErrorCodes.DefaultRepositoryNotConfigured;
			}
			else if (/push creates new remote head/.test(err.stderr || '')) {
				err.hgErrorCode = HgErrorCodes.PushCreatesNewRemoteHead;
			}
			else if (err instanceof HgError && err.stderr && /push creates new remote branches/.test(err.stderr)) {
				err.hgErrorCode = HgErrorCodes.PushCreatesNewRemoteBranches;
				const branchMatch = err.stderr.match(/: (.*)!/)
				if (branchMatch) {
					err.hgBranches = branchMatch[1];
				}
			}

			throw err;
		}
	}

	private parseUntrackedFilenames(stderr: string): string[] {
		const untrackedFilesPattern = /([^:]+): untracked file differs\n/g;
		let match: RegExpExecArray | null;
		const files: string[] = [];
		while (match = untrackedFilesPattern.exec(stderr)) {
			if (match !== null) {
				files.push(match[1]);
			}
		}
		return files;
	}

	async merge(revQuery): Promise<IMergeResult> {
		try {
			await this.run(['merge', '-r', revQuery]);
			return {
				unresolvedCount: 0
			}
		}
		catch (e) {
			if (e instanceof HgError && e.stderr && e.stderr.match(/untracked files in working directory differ/)) {
				e.hgErrorCode = HgErrorCodes.UntrackedFilesDiffer;
				e.hgFilenames = this.parseUntrackedFilenames(e.stderr);
			}

			if (e instanceof HgError && e.exitCode === 1) {
				const match = (e.stdout || "").match(/(\d+) files unresolved/);
				if (match) {
					return {
						unresolvedCount: parseInt(match[1])
					}
				}
			}

			throw e;
		}
	}

	async getSummary(): Promise<IRepoStatus> {
		const summaryResult = await this.run(['summary', '-q']);
		const summary = summaryResult.stdout;
		const lines = summary.trim().split('\n');
		// const parents = lines.filter(line => line.startsWith("parent:"))
		const commitLine = lines.filter(line => line.startsWith("commit:"))[0];
		if (commitLine) {
			const isMerge = /\bmerge\b/.test(commitLine);
			return { isMerge }
		}

		return { isMerge: false };
	}

	async getLastCommitMessage(): Promise<string> {
		const { stdout: message } = await this.run(['log', '-r', '.', '-T', '{desc}']);
		return message;
	}

	async getResolveList(): Promise<IFileStatus[]> {
		const resolveResult = await this.run(['resolve', '--list']);
		const resolve = resolveResult.stdout;
		return this.parseStatusLines(resolve);
	}

	async getStatus(revision?: string): Promise<IFileStatus[]> {
		const args = ['status', '-C'];

		if (revision) {
			args.push('--change', `${revision}`);
		}

		const executionResult = await this.run(args); // quiet, include renames/copies
		const status = executionResult.stdout;
		return this.parseStatusLines(status);
	}

	parseStatusLines(status: string): IFileStatus[] {
		const result: IFileStatus[] = [];
		let current: IFileStatus | undefined;
		let i = 0;

		function readName(): string {
			const start = i;
			let c: string = status.charAt(i);
			while (c !== '\n' && c !== '\r') {
				i++;
				c = status.charAt(i);
			}

			// was it a windows line-ending?
			if (status.charAt(i + 1) == '\n') {
				i++;
			}

			const name = status.substring(start, i++);
			return name.replace(/\\/g, '\/');
		}

		while (i < status.length) {
			const code = status.charAt(i++);
			const gap = status.charAt(i++);

			// copy/rename line?
			if (code === ' ' &&
				gap === ' ' &&
				current) {
				[current.path, current.rename] = [readName(), current.path];
				continue;
			}

			current = {
				status: code,
				path: ''
			};

			// message line: skip?
			if (gap !== ' ') {
				readName();
				continue;
			}

			current.path = readName();

			// if (current.path[current.path.length - 1] === '/') {
			// 	continue;
			// }

			result.push(current);
		}

		return result;
	}

	async getCurrentBranch(): Promise<Ref> {
		const branchResult = await this.run(['branch']);
		if (!branchResult.stdout) {
			throw new Error('Error parsing working directory branch result');
		}
		const branchName = branchResult.stdout.trim();
		// const logResult = await this.run(['identify'])
		// if (!logResult.stdout) {
		// 	throw new Error('Error parsing working directory identify result');
		// }

		return { name: branchName, commit: "", type: RefType.Branch };
	}

	async getLogEntries({ revQuery, branch, filePaths, follow, limit }: LogEntryRepositoryOptions = {}): Promise<Commit[]> {
		//                       0=rev|1=hash|2=date       |3=author     |4=brnch |5=commit message
		const templateFormat = `{rev}:{node}:{date|hgdate}:{author|person}:{branch}:{sub('[\\n\\r]+',' ',desc)}\\n`;
		const args = ['log', '-T', templateFormat]

		if (revQuery) {
			args.push('-r', revQuery);
		}

		if (branch) {
			args.push('-b', branch);
		}

		if (follow) {
			args.push('-f');
		}

		if (limit) {
			args.push('-l', `${limit}`);
		}

		if (filePaths) {
			args.push(...filePaths);
		}

		const result = await this.run(args);
		const logEntries = result.stdout.trim().split('\n')
			.filter(line => !!line)
			.map((line: string): Commit | null => {
				const [revision, hash, hgDate, author, branch, message] = line.split(":", 6);
				const [unixDateSeconds, _] = hgDate.split(' ').map(part => parseFloat(part));
				return {
					revision: parseInt(revision),
					date: new Date(unixDateSeconds * 1e3),
					hash, branch, message, author
				}
			})
			.filter(ref => !!ref) as Commit[];
		return logEntries;
	}

	async getParents(revision?: string): Promise<Commit[]> {
		return this.getLogEntries({ revQuery: `parents(${revision || ""})` });
	}

	async getHeads(branch?: string, excludeSelf?: boolean): Promise<Commit[]> {
		const except = excludeSelf ? " - ." : "";
		const revQuery = `head() and not closed()${except}`;
		return this.getLogEntries({ revQuery, branch });
	}

	async getTags(): Promise<Ref[]> {
		const tagsResult = await this.run(['tags']);
		const tagRefs = tagsResult.stdout.trim().split('\n')
			.filter(line => !!line)
			.map((line: string): Ref | null => {
				let match = line.match(/^(.*?)\s+(\d+):([A-Fa-f0-9]+)$/);
				if (match) {
					return { name: match[1], commit: match[3], type: RefType.Tag };
				}
				return null;
			})
			.filter(ref => !!ref) as Ref[]; 

		return tagRefs;
	}

	async getBranches(): Promise<Ref[]> {
		const branchesResult = await this.run(['branches']);
		const branchRefs = branchesResult.stdout.trim().split('\n')
			.filter(line => !!line)
			.map((line: string): Ref | null => {
				let match = line.match(/^(.*?)\s+(\d+):([A-Fa-f0-9]+)(\s+\(inactive\))?$/);
				if (match) {
					return { name: match[1], commit: match[3], type: RefType.Branch };
				}
				return null;
			})
			.filter(ref => !!ref) as Ref[];

		return branchRefs;
	}

	async getBookmarks(): Promise<Ref[]> {
		const bookmarksResult = await this.run(['bookmarks']);
		const bookmarkRefs = bookmarksResult.stdout.split('\n')
			.filter(line => !!line)
			.map((line: string): Ref | null => {
				let match = line.match(/^.(.).(.*?)\s+(\d+):([A-Fa-f0-9]+)$/);
				if (match) {
					return { name: match[2], commit: match[4], type: RefType.Bookmark };
				}
				return null;
			})
			.filter(ref => !!ref) as Ref[];

		return bookmarkRefs;
	}

	async getPaths(): Promise<Path[]> {
		const pathsResult = await this.run(['paths']);
		const trimmedOutput = pathsResult.stdout.trim();
		const paths = trimmedOutput.split('\n')
			.filter(line => !!line)
			.map((line: string): Path | null => {
				let match = line.match(/^(\S+)\s*=\s*(.*)$/);
				if (match) {
					return { name: match[1], url: match[2] };
				}
				return null;
			})
			.filter(ref => !!ref) as Path[];

		return paths;
	}

	async getBranch(name: string): Promise<Branch> {
		if (name === '.') {
			return this.getCurrentBranch();
		}

		const result = await this.run(['rev-parse', name]);

		if (!result.stdout) {
			return Promise.reject<Branch>(new Error('No such branch'));
		}

		const commit = result.stdout.trim();

		try {
			const res2 = await this.run(['rev-parse', '--symbolic-full-name', '--abbrev-ref', name + '@{u}']);
			const upstream = res2.stdout.trim();

			const res3 = await this.run(['rev-list', '--left-right', name + '...' + upstream]);

			let ahead = 0, behind = 0;
			let i = 0;

			while (i < res3.stdout.length) {
				switch (res3.stdout.charAt(i)) {
					case '<': ahead++; break;
					case '>': behind++; break;
					default: i++; break;
				}

				while (res3.stdout.charAt(i++) !== '\n') { /* no-op */ }
			}

			return { name, type: RefType.Branch, commit, upstream, ahead, behind };
		}
		catch (err) {
			return { name, type: RefType.Branch, commit };
		}
	}
}

function msFromHighResTime(hiResTime: [number, number]): number {
	const [seconds, nanoSeconds] = hiResTime;
	return seconds * 1e3 + nanoSeconds / 1e6;
}