/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, Command, EventEmitter, Event, SourceControlResourceState, SourceControlResourceDecorations, Disposable, window, workspace, commands } from "vscode";
import { Hg, Repository, Ref, Path, Branch, PushOptions, Commit, HgErrorCodes, HgError, IFileStatus, HgRollbackDetails, IRepoStatus, IMergeResult, LogEntryOptions, LogEntryRepositoryOptions, CommitDetails, Revision } from "./hg";
import { anyEvent, eventToPromise, filterEvent, mapEvent, EmptyDisposable, combinedDisposable, dispose, groupBy, partition } from "./util";
import { memoize, throttle, debounce } from "./decorators";
import { watch } from './watch';
import * as path from 'path';
import * as fs from 'fs';
import * as nls from 'vscode-nls';
import { groupStatuses, IStatusGroups, IGroupStatusesParams, createEmptyStatusGroups, ResourceGroup, MergeGroup, ConflictGroup, StagingGroup, WorkingDirectoryGroup, UntrackedGroup, ResourceGroupId } from "./resourceGroups";
import { interaction, PushCreatesNewHeadAction, DefaultRepoNotConfiguredAction } from "./interaction";
import { AutoInOutStatuses, AutoInOutState } from "./autoinout";

const timeout = (millis: number) => new Promise(c => setTimeout(c, millis));
const exists = (path: string) => new Promise(c => fs.exists(path, c));

const localize = nls.loadMessageBundle();
const iconsRootPath = path.join(path.dirname(__dirname), '..', 'resources', 'icons');

export interface LogEntriesOptions {
	file?: Uri;
	revQuery?: string;
	branch?: string;
	limit?: number;
}

function getIconUri(iconName: string, theme: string): Uri {
	return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

export enum State {
	Uninitialized,
	Idle,
	NotAnHgRepository
}

export enum Status {
	MODIFIED,
	ADDED,
	DELETED,
	UNTRACKED,
	IGNORED,
	MISSING,
	RENAMED,
	CLEAN
}

export enum MergeStatus {
	NONE,
	UNRESOLVED,
	RESOLVED
}

export class Resource implements SourceControlResourceState {
	@memoize
	get command(): Command {
		return {
			command: 'hg.openResource',
			title: localize('open', "Open"),
			arguments: [this]
		};
	}

	get isDirtyStatus(): boolean {
		switch (this._status) {
			case Status.UNTRACKED:
			case Status.IGNORED:
				return false;

			case Status.ADDED:
			case Status.DELETED:
			case Status.MISSING:
			case Status.MODIFIED:
			case Status.RENAMED:
			default:
				return true;
		}
	}

	get original(): Uri { return this._resourceUri; }
	get renameResourceUri(): Uri | undefined { return this._renameResourceUri; }
	@memoize
	get resourceUri(): Uri {
		if (this.renameResourceUri) {
			if (this._status === Status.MODIFIED ||
				this._status === Status.RENAMED ||
				this._status === Status.ADDED) {
				return this.renameResourceUri;
			}

			throw new Error(`Renamed resource with unexpected status: ${this._status}`);
		}
		return this._resourceUri;
	}
	get resourceGroup(): ResourceGroup { return this._resourceGroup; }
	get status(): Status { return this._status; }
	get mergeStatus(): MergeStatus { return this._mergeStatus; }

	private static Icons = {
		light: {
			Modified: getIconUri('status-modified', 'light'),
			Missing: getIconUri('status-missing', 'light'),
			Added: getIconUri('status-added', 'light'),
			Deleted: getIconUri('status-deleted', 'light'),
			Renamed: getIconUri('status-renamed', 'light'),
			Copied: getIconUri('status-copied', 'light'),
			Untracked: getIconUri('status-untracked', 'light'),
			Ignored: getIconUri('status-ignored', 'light'),
			Conflict: getIconUri('status-conflict', 'light'),
			Clean: getIconUri('status-clean', 'light'),
		},
		dark: {
			Modified: getIconUri('status-modified', 'dark'),
			Missing: getIconUri('status-missing', 'dark'),
			Added: getIconUri('status-added', 'dark'),
			Deleted: getIconUri('status-deleted', 'dark'),
			Renamed: getIconUri('status-renamed', 'dark'),
			Copied: getIconUri('status-copied', 'dark'),
			Untracked: getIconUri('status-untracked', 'dark'),
			Ignored: getIconUri('status-ignored', 'dark'),
			Conflict: getIconUri('status-conflict', 'dark'),
			Clean: getIconUri('status-clean', 'dark'),
		}
	};

	private getIconPath(theme: string): Uri | undefined {
		if (this.mergeStatus === MergeStatus.UNRESOLVED &&
			this.status !== Status.MISSING &&
			this.status !== Status.DELETED) {
			return Resource.Icons[theme].Conflict;
		}

		switch (this.status) {
			case Status.MISSING: return Resource.Icons[theme].Missing;
			case Status.MODIFIED: return Resource.Icons[theme].Modified;
			case Status.ADDED: return Resource.Icons[theme].Added;
			case Status.DELETED: return Resource.Icons[theme].Deleted;
			case Status.RENAMED: return Resource.Icons[theme].Renamed;
			case Status.UNTRACKED: return Resource.Icons[theme].Untracked;
			case Status.IGNORED: return Resource.Icons[theme].Ignored;
			case Status.CLEAN: return Resource.Icons[theme].Clean;
			default: return void 0;
		}
	}

	private get strikeThrough(): boolean {
		switch (this.status) {
			case Status.DELETED:
				return true;
			default:
				return false;
		}
	}

	get decorations(): SourceControlResourceDecorations {
		const light = { iconPath: this.getIconPath('light') };
		const dark = { iconPath: this.getIconPath('dark') };

		return { strikeThrough: this.strikeThrough, light, dark };
	}

	constructor(
		private _resourceGroup: ResourceGroup,
		private _resourceUri: Uri,
		private _status: Status,
		private _mergeStatus: MergeStatus,
		private _renameResourceUri?: Uri
	) { }
}

export enum Operation {
	Status = 1 << 0,
	Add = 1 << 1,
	RevertFiles = 1 << 2,
	Commit = 1 << 3,
	Clean = 1 << 4,
	Branch = 1 << 5,
	Update = 1 << 6,
	Rollback = 1 << 7,
	CountIncoming = 1 << 8,
	Pull = 1 << 9,
	Push = 1 << 10,
	Sync = 1 << 11,
	Init = 1 << 12,
	Show = 1 << 13,
	Stage = 1 << 14,
	GetCommitTemplate = 1 << 15,
	CountOutgoing = 1 << 16,
	Resolve = 1 << 17,
	Unresolve = 1 << 18,
	Parents = 1 << 19,
	Forget = 1 << 20,
	Merge = 1 << 21,
	AddRemove = 1 << 22,
}

function isReadOnly(operation: Operation): boolean {
	switch (operation) {
		case Operation.Show:
		case Operation.GetCommitTemplate:
			return true;
		default:
			return false;
	}
}

export interface Operations {
	isIdle(): boolean;
	isRunning(operation: Operation): boolean;
}

class OperationsImpl implements Operations {

	constructor(private readonly operations: number = 0) {
		// noop
	}

	start(operation: Operation): OperationsImpl {
		return new OperationsImpl(this.operations | operation);
	}

	end(operation: Operation): OperationsImpl {
		return new OperationsImpl(this.operations & ~operation);
	}

	isRunning(operation: Operation): boolean {
		return (this.operations & operation) !== 0;
	}

	isIdle(): boolean {
		return this.operations === 0;
	}
}

export const enum CommitScope {
	ALL,
	ALL_WITH_ADD_REMOVE,
	STAGED_CHANGES,
	CHANGES
}

export interface CommitOptions {
	scope: CommitScope;
}

export class Model implements Disposable {
	private _onDidChangeRepository = new EventEmitter<Uri>();
	readonly onDidChangeRepository: Event<Uri> = this._onDidChangeRepository.event;

	private _onDidChangeHgrc = new EventEmitter<void>();
	readonly onDidChangeHgrc: Event<void> = this._onDidChangeHgrc.event;

	private _onDidChangeState = new EventEmitter<State>();
	readonly onDidChangeState: Event<State> = this._onDidChangeState.event;

	private _onDidChangeRemoteState = new EventEmitter<void>();
	readonly onDidChangeInOutState: Event<void> = this._onDidChangeRemoteState.event;

	private _onDidChangeResources = new EventEmitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	@memoize
	get onDidChange(): Event<void> {
		return anyEvent<any>(this.onDidChangeState, this.onDidChangeResources, this.onDidChangeInOutState);
	}

	private _onRunOperation = new EventEmitter<Operation>();
	readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

	private _onDidRunOperation = new EventEmitter<Operation>();
	readonly onDidRunOperation: Event<Operation> = this._onDidRunOperation.event;

	@memoize
	get onDidChangeOperations(): Event<void> {
		return anyEvent(this.onRunOperation as Event<any>, this.onDidRunOperation as Event<any>);
	}

	private _groups: IStatusGroups = createEmptyStatusGroups();
	get mergeGroup(): MergeGroup { return this._groups.merge; }
	get conflictGroup(): ConflictGroup { return this._groups.conflict; }
	get stagingGroup(): StagingGroup { return this._groups.staging; }
	get workingDirectoryGroup(): WorkingDirectoryGroup { return this._groups.working; }
	get untrackedGroup(): UntrackedGroup { return this._groups.untracked; }

	private _currentBranch: Branch | undefined;
	get currentBranch(): Branch | undefined { return this._currentBranch; }

	private _repoStatus: IRepoStatus | undefined;
	get repoStatus(): IRepoStatus | undefined { return this._repoStatus; }

	private _refs: Ref[] = [];
	get refs(): Ref[] { return this._refs; }

	private _paths: Path[] = [];
	get paths(): Path[] { return this._paths; }

	private _operations = new OperationsImpl();
	get operations(): Operations { return this._operations; }

	private _syncCounts = { incoming: 0, outgoing: 0 };
	get syncCounts(): { incoming: number; outgoing: number } { return this._syncCounts; }

	private _autoInOutState: AutoInOutState = { status: AutoInOutStatuses.Disabled };
	get autoInOutState() { return this._autoInOutState; }

	public changeAutoInoutState(state: Partial<AutoInOutState>) {
		this._autoInOutState = {
			...this._autoInOutState,
			...state
		}
		this._onDidChangeRemoteState.fire();
	}

	private _numOutgoing: number;
	get numOutgoingCommits(): number { return this._numOutgoing; }

	get repoName(): string { return path.basename(this.repository.root); }

	get isClean() {
		const groups = [this.workingDirectoryGroup, this.mergeGroup, this.conflictGroup, this.stagingGroup];
		return groups.every(g => g.resources.length === 0);
	}

	toUri(rawPath: string): Uri {
		return Uri.file(path.join(this.repository.root, rawPath));
	}

	private repository: Repository;

	private _state = State.Uninitialized;
	get state(): State { return this._state; }
	set state(state: State) {
		this._state = state;
		this._onDidChangeState.fire(state);

		this._currentBranch = undefined;
		this._refs = [];
		this._syncCounts = { incoming: 0, outgoing: 0 };
		this._groups = createEmptyStatusGroups();
		this._onDidChangeResources.fire();
	}

	private onWorkspaceChange: Event<Uri>;
	private repositoryDisposable: Disposable = EmptyDisposable;
	private disposables: Disposable[] = [];

	constructor(
		private _hg: Hg,
		private workspaceRootPath: string
	) {
		const fsWatcher = workspace.createFileSystemWatcher('**');
		this.onWorkspaceChange = anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
		this.disposables.push(fsWatcher);

		this.status();
	}

	getResourceGroupById(id: ResourceGroupId): ResourceGroup
	{
		return this._groups[id];
	}

	async whenIdle(): Promise<void> {
		while (!this.operations.isIdle()) {
			await eventToPromise(this.onDidRunOperation);
		}
	}

	/**
	 * Returns promise which resolves when there is no `.hg/index.lock` file,
	 * or when it has attempted way too many times. Back off mechanism.
	 */
	async whenUnlocked(): Promise<void> {
		let millis = 100;
		let retries = 0;

		while (retries < 10 && await exists(path.join(this.repository.root, '.hg', 'index.lock'))) {
			retries += 1;
			millis *= 1.4;
			await timeout(millis);
		}
	}

	@throttle
	async init(): Promise<void> {
		if (this.state !== State.NotAnHgRepository) {
			return;
		}

		await this._hg.init(this.workspaceRootPath);
		await this.status();
	}

	async hgrcPathIfExists(): Promise<string | undefined> {
		const filePath: string = this.hgrcPath;
		const exists = await new Promise((c, e) => fs.exists(filePath, c));
		if (exists) {
			return filePath;
		}
	}

	async createHgrc(): Promise<string> {
		const filePath: string = this.hgrcPath;
		const fd = fs.openSync(filePath, 'w');
		fs.writeSync(fd, `[paths]
; Uncomment line below to add a remote path:
; default = https://bitbucket.org/<yourname>/<repo>
`, 0, 'utf-8');
		fs.closeSync(fd);
		return filePath;
	}

	private get hgrcPath(): string { return path.join(this.repository.root, ".hg", "hgrc"); }

	@throttle
	async status(): Promise<void> {
		await this.run(Operation.Status);
	}

	@throttle
	async add(...resources: Resource[]): Promise<void> {
		if (resources.length === 0) {
			resources = this._groups.untracked.resources;
		}
		const relativePaths: string[] = resources.map(r => this.mapResourceToRepoRelativePath(r));
		await this.run(Operation.Add, () => this.repository.add(relativePaths));
	}

	@throttle
	async forget(...resources: Resource[]): Promise<void> {
		const relativePaths: string[] = resources.map(r => this.mapResourceToRepoRelativePath(r));
		await this.run(Operation.Forget, () => this.repository.forget(relativePaths));
	}

	@throttle
	async stage(...resources: Resource[]): Promise<void> {
		await this.run(Operation.Stage, async () => {
			if (resources.length === 0) {
				resources = this._groups.working.resources;
			}

			const [missingAndAddedResources, otherResources] = partition(resources, r =>
				r.status === Status.MISSING || r.status === Status.ADDED);

			if (missingAndAddedResources.length) {
				const relativePaths: string[] = missingAndAddedResources.map(r => this.mapResourceToRepoRelativePath(r));
				await this.run(Operation.AddRemove, () => this.repository.addRemove(relativePaths));
			}

			this._groups.staging = this._groups.staging.intersect(resources);
			this._groups.working = this._groups.working.except(resources);
			this._onDidChangeResources.fire();
		});
	}

	// resource --> repo-relative path	
	public mapResourceToRepoRelativePath(resource: Resource): string {
		const relativePath = this.mapFileUriToRepoRelativePath(resource.resourceUri);
		return relativePath;
	}

	// file uri --> repo-relative path	
	private mapFileUriToRepoRelativePath(fileUri: Uri): string {
		const relativePath = path.relative(this.repository.root, fileUri.fsPath).replace(/\\/g, '/');
		return relativePath;
	}

	// resource --> workspace-relative path
	public mapResourceToWorkspaceRelativePath(resource: Resource): string {
		const relativePath = this.mapFileUriToWorkspaceRelativePath(resource.resourceUri);
		return relativePath;
	}

	// file uri --> workspace-relative path	
	public mapFileUriToWorkspaceRelativePath(fileUri: Uri): string {
		const relativePath = path.relative(this.workspaceRootPath, fileUri.fsPath).replace(/[\/\\]/g, path.sep);
		return relativePath;
	}

	// repo-relative path --> workspace-relative path	
	private mapRepositoryRelativePathToWorkspaceRelativePath(repoRelativeFilepath: string): string {
		const fsPath = path.join(this.repository.root, repoRelativeFilepath);
		const relativePath = path.relative(this.workspaceRootPath, fsPath).replace(/[\/\\]/g, path.sep);
		return relativePath;
	}

	@throttle
	async resolve(resources: Resource[], opts: { mark?: boolean } = {}): Promise<void> {
		const relativePaths: string[] = resources.map(r => this.mapResourceToRepoRelativePath(r));
		await this.run(Operation.Resolve, () => this.repository.resolve(relativePaths, opts));
	}

	@throttle
	async unresolve(resources: Resource[]): Promise<void> {
		const relativePaths: string[] = resources.map(r => this.mapResourceToRepoRelativePath(r));
		await this.run(Operation.Unresolve, () => this.repository.unresolve(relativePaths));
	}

	@throttle
	async unstage(...resources: Resource[]): Promise<void> {
		if (resources.length === 0) {
			resources = this._groups.staging.resources;
		}
		this._groups.staging = this._groups.staging.except(resources);
		this._groups.working = this._groups.working.intersect(resources);
		this._onDidChangeResources.fire();
	}

	@throttle
	async commit(message: string, opts: CommitOptions = Object.create(null)): Promise<void> {
		await this.run(Operation.Commit, async () => {
			let fileList: string[] = [];
			if (opts.scope === CommitScope.CHANGES ||
				opts.scope === CommitScope.STAGED_CHANGES) {
				let selectedResources = opts.scope === CommitScope.STAGED_CHANGES ?
					this.stagingGroup.resources :
					this.workingDirectoryGroup.resources;

				fileList = selectedResources.map(r => this.mapResourceToRepoRelativePath(r));
			}

			await this.repository.commit(message, { addRemove: opts.scope === CommitScope.ALL_WITH_ADD_REMOVE, fileList });
			this.countOutgoing(+1);
		});
	}

	async cleanOrUpdate(...resources) {
		const parents = await this.getParents();
		if (parents.length > 1) {
			return this.update(".", { discard: true });
		}

		return this.clean(...resources);
	}

	@throttle
	async clean(...resources: Resource[]): Promise<void> {
		await this.run(Operation.Clean, async () => {
			const toRevert: string[] = [];
			const toForget: string[] = [];

			for (let r of resources) {
				switch (r.status) {
					case Status.UNTRACKED:
					case Status.IGNORED:
						break;

					case Status.ADDED:
						toForget.push(this.mapResourceToRepoRelativePath(r));
						break;

					case Status.DELETED:
					case Status.MISSING:
					case Status.MODIFIED:
					default:
						toRevert.push(this.mapResourceToRepoRelativePath(r));
						break;
				}
			}

			const promises: Promise<void>[] = [];

			if (toRevert.length > 0) {
				promises.push(this.repository.revert(toRevert));
			}

			if (toForget.length > 0) {
				promises.push(this.repository.forget(toForget));
			}

			await Promise.all(promises);
		});
	}

	@throttle
	async branch(name: string, opts?: { allowBranchReuse: boolean }): Promise<void> {
		const hgOpts = opts && {
			force: opts && opts.allowBranchReuse
		};
		await this.run(Operation.Branch, () => this.repository.branch(name, hgOpts));
	}

	@throttle
	async update(treeish: string, opts?: { discard: boolean }): Promise<void> {
		await this.run(Operation.Update, () => this.repository.update(treeish, opts));
	}

	@throttle
	async rollback(dryRun?: boolean): Promise<HgRollbackDetails> {
		return await this.run(Operation.Rollback, async () => {
			const details = await this.repository.rollback(dryRun);
			if (!dryRun && details.kind === 'commit') {
				this.countOutgoing(-1);
			}
			return details;
		});
	}

	async countIncomingOutgoing(expectedDeltas?: { incoming: number, outgoing: number }) {
		try {
			await this.countIncoming(expectedDeltas && expectedDeltas.incoming);
			await this.countOutgoing(expectedDeltas && expectedDeltas.outgoing);
		}
		catch (err) {
			if (err instanceof HgError && (
				err.hgErrorCode === HgErrorCodes.AuthenticationFailed ||
				err.hgErrorCode === HgErrorCodes.RepositoryIsUnrelated ||
				err.hgErrorCode === HgErrorCodes.RepositoryDefaultNotFound)) {

				this.changeAutoInoutState({
					status: AutoInOutStatuses.Error,
					error: ((err.stderr || "").replace(/^abort:\s*/, '') || err.hgErrorCode || err.message).trim(),
				})
			}
			throw err;
		}
	}

	async countIncoming(expectedDelta: number = 0): Promise<void> {
		try {
			// immediate UI update with expected
			if (expectedDelta) {
				this._syncCounts.incoming = Math.max(0, this._syncCounts.incoming + expectedDelta);
				this._onDidChangeRemoteState.fire();
			}

			// then confirm
			await this.run(Operation.CountIncoming, async () => {
				this._syncCounts.incoming = await this.repository.countIncoming();
				this._onDidChangeRemoteState.fire();
			});
		}
		catch (e) {
			throw e;
		}
	}

	async countOutgoing(expectedDelta: number = 0): Promise<void> {
		try {
			// immediate UI update with expected
			if (expectedDelta) {
				this._syncCounts.outgoing = Math.max(0, this._syncCounts.outgoing + expectedDelta);
				this._onDidChangeRemoteState.fire();
			}

			// then confirm
			await this.run(Operation.CountOutgoing, async () => {
				this._syncCounts.outgoing = await this.repository.countOutgoing();
				this._onDidChangeRemoteState.fire();
			});
		}
		catch (e) {
			throw e;
		}
	}

	@throttle
	async pull(): Promise<void> {
		await this.run(Operation.Pull, async () => {
			try {
				await this.repository.pull()

				const delta = -this._syncCounts.incoming
				this.countIncoming(delta);
			}
			catch (e) {
				if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.DefaultRepositoryNotConfigured) {
					const action = await interaction.warnDefaultRepositoryNotConfigured();
					if (action === DefaultRepoNotConfiguredAction.OpenHGRC) {
						commands.executeCommand("hg.openhgrc");
					}
					return;
				}
				throw e;
			}
		});
	}

	@throttle
	async push(path?: string, options?: PushOptions): Promise<void> {
		return await this.run(Operation.Push, async () => {
			try {
				await this.repository.push(path, options);

				if (!path || path === "default" || path === "default-push") {
					this.countOutgoing(-this._syncCounts.outgoing);
				}
			}
			catch (e) {
				if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.DefaultRepositoryNotConfigured) {
					const action = await interaction.warnDefaultRepositoryNotConfigured();
					if (action === DefaultRepoNotConfiguredAction.OpenHGRC) {
						commands.executeCommand("hg.openhgrc");
					}
					return;
				}
				else if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.PushCreatesNewRemoteHead) {
					const action = await interaction.warnPushCreatesNewHead();
					if (action === PushCreatesNewHeadAction.Pull) {
						commands.executeCommand("hg.pull");
					}
					return;
				}
				else if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.PushCreatesNewRemoteBranches) {
					const allow = interaction.warnPushCreatesNewBranchesAllow();
					if (allow) {
						return this.push(path, { allowPushNewBranches: true })
					}

					return;
				}

				throw e;
			}
		});
	}

	@throttle
	merge(revQuery): Promise<IMergeResult> {
		return this.run(Operation.Merge, async () => {
			try {
				return await this.repository.merge(revQuery)
			}
			catch (e) {
				if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.UntrackedFilesDiffer && e.hgFilenames) {
					e.hgFilenames = e.hgFilenames.map(filename => this.mapRepositoryRelativePathToWorkspaceRelativePath(filename));
				}
				throw e;
			}
		});
	}

	async show(ref: string, uri: Uri): Promise<string> {
		// TODO@Joao: should we make this a general concept?
		await this.whenIdle();

		return await this.run(Operation.Show, async () => {
			const relativePath = path.relative(this.repository.root, uri.fsPath).replace(/\\/g, '/');
			const result = await this.repository.hg.exec(this.repository.root, ['cat', relativePath, '-r', ref], { log: false });

			if (result.exitCode !== 0) {
				throw new HgError({
					message: localize('cantshow', "Could not show object"),
					exitCode: result.exitCode
				});
			}

			return result.stdout;
		});
	}

	private async run<T>(operation: Operation, runOperation: () => Promise<T> = () => Promise.resolve<any>(null)): Promise<T> {
		return window.withScmProgress(async () => {
			this._operations = this._operations.start(operation);
			this._onRunOperation.fire(operation);

			try {
				await this.assertIdleState();
				await this.whenUnlocked();
				const result = await runOperation();

				if (!isReadOnly(operation)) {
					await this.refresh();
				}

				return result;
			}
			catch (err) {
				if (err.hgErrorCode === HgErrorCodes.NotAnHgRepository) {
					this.repositoryDisposable.dispose();

					const disposables: Disposable[] = [];
					this.onWorkspaceChange(this.onFSChange, this, disposables);
					this.repositoryDisposable = combinedDisposable(disposables);

					this.state = State.NotAnHgRepository;
				}

				throw err;
			} finally {
				this._operations = this._operations.end(operation);
				this._onDidRunOperation.fire(operation);
			}
		});
	}

	/* We use the native Node `watch` for faster, non debounced events.
	 * That way we hopefully get the events during the operations we're
	 * performing, thus sparing useless `hg status` calls to refresh
	 * the model's state.
	 */
	private async assertIdleState(): Promise<void> {
		if (this.state === State.Idle) {
			return;
		}

		this.repositoryDisposable.dispose();

		const disposables: Disposable[] = [];
		const repositoryRoot = await this._hg.getRepositoryRoot(this.workspaceRootPath);
		this.repository = this._hg.open(repositoryRoot);
		this.updateRepositoryPaths();

		const dotHgPath = path.join(repositoryRoot, '.hg');
		const { event: onRawHgChange, disposable: watcher } = watch(dotHgPath);
		disposables.push(watcher);

		const onHgChange = mapEvent(onRawHgChange, ({ filename }) => Uri.file(path.join(dotHgPath, filename)));
		const onRelevantHgChange = filterEvent(onHgChange, uri => !/\/\.hg\/index\.lock$/.test(uri.fsPath));
		const onHgrcChange = filterEvent(onHgChange, uri => /\/\.hg\/hgrc$/.test(uri.path));
		onRelevantHgChange(this.onFSChange, this, disposables);
		onRelevantHgChange(this._onDidChangeRepository.fire, this._onDidChangeRepository, disposables);
		onHgrcChange(this.onHgrcChange, this, disposables);

		const onNonHgChange = filterEvent(this.onWorkspaceChange, uri => !/\/\.hg\//.test(uri.fsPath));
		onNonHgChange(this.onFSChange, this, disposables);

		this.repositoryDisposable = combinedDisposable(disposables);
		this.state = State.Idle;
	}

	private async updateRepositoryPaths() {
		try {
			this._paths = await this.repository.getPaths();
		}
		catch (e) {
			// noop
		}
	}

	@throttle
	public async getPaths(): Promise<Path[]> {
		try {
			this._paths = await this.repository.getPaths();
			return this._paths;
		}
		catch (e) {
			// noop
		}

		return [];
	}

	@throttle
	public async getRefs(): Promise<Ref[]> {
		const [branches, tags] = await Promise.all([this.repository.getBranches(), this.repository.getTags()]);
		this._refs = [...branches, ...tags];
		return this._refs;
	}

	@throttle
	public getParents(revision?: string): Promise<Commit[]> {
		return this.repository.getParents(revision);
	}

	@throttle
	public async getBranchNamesWithMultipleHeads(): Promise<string[]> {
		const allHeads = await this.repository.getHeads();
		const multiHeadBranches: string[] = [];
		const headsPerBranch = groupBy(allHeads, h => h.branch)
		for (const branch in headsPerBranch) {
			const branchHeads = headsPerBranch[branch];
			if (branchHeads.length > 1) {
				multiHeadBranches.push(branch);
			}
		}
		return multiHeadBranches;
	}

	@throttle
	public getHeads(options: { branch?: string; excludeSelf?: boolean } = {}): Promise<Commit[]> {
		const { branch, excludeSelf } = options;
		return this.repository.getHeads(branch, excludeSelf);
	}

	@throttle
	public async getCommitDetails(revision: string): Promise<CommitDetails> {

		const commitPromise = this.getLogEntries({ revQuery: revision, limit: 1 });
		const fileStatusesPromise = this.repository.getStatus(revision);
		const parentsPromise = this.getParents(revision);

		const [[commit], fileStatuses, [parent1, parent2]] = await Promise.all([commitPromise, fileStatusesPromise, parentsPromise]);

		return {
			...commit,
			parent1,
			parent2,
			files: fileStatuses
		}
	}

	@throttle
	public getLogEntries(options: LogEntriesOptions = {}): Promise<Commit[]> {
		let filePaths: string[] | undefined = undefined;
		if (options.file) {
			filePaths = [this.mapFileUriToRepoRelativePath(options.file)];
		}

		const opts: LogEntryRepositoryOptions = {
			revQuery: options.revQuery || "tip:0",
			branch: options.branch,
			filePaths: filePaths,
			follow: true,
			limit: options.limit || 200
		};
		return this.repository.getLogEntries(opts)
	}

	@throttle
	private async refresh(): Promise<void> {
		this._repoStatus = await this.repository.getSummary();

		const [fileStatuses, currentBranch, resolveStatuses] = await Promise.all([
			this.repository.getStatus(),
			this.repository.getCurrentBranch(),
			this._repoStatus.isMerge ? this.repository.getResolveList() : Promise.resolve(undefined),
		]);
		this._currentBranch = currentBranch;

		const groupInput: IGroupStatusesParams = {
			respositoryRoot: this.repository.root,
			fileStatuses: fileStatuses,
			repoStatus: this._repoStatus,
			resolveStatuses: resolveStatuses,
			statusGroups: this._groups
		};

		this._groups = groupStatuses(groupInput);
		this._onDidChangeResources.fire();
	}

	private onFSChange(uri: Uri): void {
		const config = workspace.getConfiguration('hg');
		const autoRefresh = config.get<boolean>('autoRefresh');

		if (!autoRefresh) {
			return;
		}

		if (!this.operations.isIdle()) {
			return;
		}

		this.eventuallyUpdateWhenIdleAndWait();
	}

	@debounce(1000)
	private onHgrcChange(uri: Uri): void {
		this._onDidChangeHgrc.fire();

		const config = workspace.getConfiguration('hg');
		const usingServer = config.get<string>('commandMode') === "server";
		if (usingServer) {
			this._hg.onConfigurationChange(true);
		}
	}

	@debounce(1000)
	private eventuallyUpdateWhenIdleAndWait(): void {
		this.updateWhenIdleAndWait();
	}

	@throttle
	private async updateWhenIdleAndWait(): Promise<void> {
		await this.whenIdle();
		await this.status();
		await timeout(5000);
	}

	dispose(): void {
		this.repositoryDisposable.dispose();
		this.disposables = dispose(this.disposables);
	}
}