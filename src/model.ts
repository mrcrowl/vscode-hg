/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Uri, Command, EventEmitter, Event, SourceControlResourceState, SourceControlResourceDecorations, Disposable, window, workspace } from 'vscode';
import { Hg, Repository, Ref, Path, Branch, PushOptions, Commit, HgErrorCodes, HgError } from './hg';
import { anyEvent, eventToPromise, filterEvent, mapEvent, EmptyDisposable, combinedDisposable, dispose } from './util';
import { memoize, throttle, debounce } from "./decorators";
import { watch } from './watch';
import * as path from 'path';
import * as fs from 'fs';
import * as nls from 'vscode-nls';

const timeout = (millis: number) => new Promise(c => setTimeout(c, millis));
const exists = (path: string) => new Promise(c => fs.exists(path, c));

const localize = nls.loadMessageBundle();
const iconsRootPath = path.join(path.dirname(__dirname), '..', 'resources', 'icons');

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
	CONFLICT
}

export class Resource implements SourceControlResourceState {

	@memoize
	get resourceUri(): Uri {
		if (this.renameResourceUri && (this._type === Status.MODIFIED || this._type === Status.DELETED)) {
			return this.renameResourceUri;
		}

		return this._resourceUri;
	}

	@memoize
	get command(): Command {
		return {
			command: 'hg.openResource',
			title: localize('open', "Open"),
			arguments: [this]
		};
	}

	get isDirtyStatus(): boolean {
		switch (this._type) {
			case Status.ADDED:
			case Status.CONFLICT:
			case Status.DELETED:
			case Status.MISSING:
			case Status.MODIFIED:
				return true;

			case Status.UNTRACKED:
			case Status.IGNORED:
			default:
				return false
		}
	}
	get resourceGroup(): ResourceGroup { return this._resourceGroup; }
	get status(): Status { return this._type; }
	get original(): Uri { return this._resourceUri; }
	get renameResourceUri(): Uri | undefined { return this._renameResourceUri; }

	private static Icons = {
		light: {
			Modified: getIconUri('status-modified', 'light'),
			Added: getIconUri('status-added', 'light'),
			Deleted: getIconUri('status-deleted', 'light'),
			Renamed: getIconUri('status-renamed', 'light'),
			Copied: getIconUri('status-copied', 'light'),
			Untracked: getIconUri('status-untracked', 'light'),
			Ignored: getIconUri('status-ignored', 'light'),
			Conflict: getIconUri('status-conflict', 'light'),
		},
		dark: {
			Modified: getIconUri('status-modified', 'dark'),
			Added: getIconUri('status-added', 'dark'),
			Deleted: getIconUri('status-deleted', 'dark'),
			Renamed: getIconUri('status-renamed', 'dark'),
			Copied: getIconUri('status-copied', 'dark'),
			Untracked: getIconUri('status-untracked', 'dark'),
			Ignored: getIconUri('status-ignored', 'dark'),
			Conflict: getIconUri('status-conflict', 'dark')
		}
	};

	private getIconPath(theme: string): Uri | undefined {
		switch (this.status) {
			case Status.MODIFIED: return Resource.Icons[theme].Modified;
			case Status.ADDED: return Resource.Icons[theme].Added;
			case Status.DELETED: return Resource.Icons[theme].Deleted;
			// case Status.RENAMED: return Resource.Icons[theme].Renamed;
			case Status.UNTRACKED: return Resource.Icons[theme].Untracked;
			case Status.IGNORED: return Resource.Icons[theme].Ignored;
			case Status.CONFLICT: return Resource.Icons[theme].Conflict;
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
		private _type: Status,
		private _renameResourceUri?: Uri
	) { }
}

export abstract class ResourceGroup {

	get id(): string { return this._id; }
	get contextKey(): string { return this._id; }
	get label(): string { return this._label; }
	get resources(): Resource[] { return this._resources; }

	private _resourceUriIndex: Map<string, boolean>;

	constructor(
		private _id: string,
		private _label: string,
		private _resources: Resource[]) {
		this._resourceUriIndex = ResourceGroup.indexResources(_resources);
	}

	private static indexResources(resources: Resource[]): Map<string, boolean> {
		const index = new Map<string, boolean>();
		resources.forEach(r => index.set(r.resourceUri.toString(), true));
		return index;
	}

	getResource(uri: Uri): Resource | undefined {
		const uriString = uri.toString();
		return this.resources.filter(r => r.resourceUri.toString() === uriString)[0];
	}

	includes(resource: Resource): boolean {
		return this.includesUri(resource.resourceUri);
	}

	includesUri(uri: Uri): boolean {
		return this._resourceUriIndex.has(uri.toString());
	}

	intersect(resources: Resource[]): this {
		const newUniqueResources = resources.filter(r => !this.includes(r)).map(r => new Resource(this, r.resourceUri, r.status));
		const intersectionResources: Resource[] = [...this.resources, ...newUniqueResources];
		return this.newResourceGroup(intersectionResources);
	}

	except(resources: Resource[]): this {
		const excludeIndex = StagingGroup.indexResources(resources);
		const remainingResources = this.resources.filter(r => !excludeIndex.has(r.resourceUri.toString()));
		return this.newResourceGroup(remainingResources);
	}

	private newResourceGroup(resources: Resource[]): this {
		const SubClassConstructor = Object.getPrototypeOf(this).constructor;
		return new SubClassConstructor(resources);
	}
}

export class MergeGroup extends ResourceGroup {

	static readonly ID = 'merge';

	constructor(resources: Resource[] = []) {
		super(MergeGroup.ID, localize('merge changes', "Merge Changes"), resources);
	}
}

export class StagingGroup extends ResourceGroup {

	static readonly ID = 'staging';

	constructor(resources: Resource[] = []) {
		super(StagingGroup.ID, localize('staged changes', "Staged Changes"), resources);
	}
}

export class UntrackedGroup extends ResourceGroup {

	static readonly ID = 'untracked';

	constructor(resources: Resource[] = []) {
		super(UntrackedGroup.ID, localize('untracked files', "Untracked Files"), resources);
	}
}

export class WorkingDirectoryGroup extends ResourceGroup {

	static readonly ID = 'working';

	constructor(resources: Resource[] = []) {
		super(WorkingDirectoryGroup.ID, localize('changes', "Changes"), resources);
	}
}

export enum Operation {
	Status = 1 << 0,
	Add = 1 << 1,
	RevertFiles = 1 << 2,
	Commit = 1 << 3,
	Clean = 1 << 4,
	Branch = 1 << 5,
	Update = 1 << 6,
	Reset = 1 << 7,
	CountIncoming = 1 << 8,
	Pull = 1 << 9,
	Push = 1 << 10,
	Sync = 1 << 11,
	Init = 1 << 12,
	Show = 1 << 13,
	Stage = 1 << 14,
	GetCommitTemplate = 1 << 15,
	CountOutgoing = 1 << 16
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
	STAGED_CHANGES,
	CHANGES
}

export interface CommitOptions {
	scope: CommitScope;
}

export class Model implements Disposable {

	private _onDidChangeRepository = new EventEmitter<Uri>();
	readonly onDidChangeRepository: Event<Uri> = this._onDidChangeRepository.event;

	private _onDidChangeState = new EventEmitter<State>();
	readonly onDidChangeState: Event<State> = this._onDidChangeState.event;

	private _onDidChangeResources = new EventEmitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	@memoize
	get onDidChange(): Event<void> {
		return anyEvent<any>(this.onDidChangeState, this.onDidChangeResources);
	}

	private _onRunOperation = new EventEmitter<Operation>();
	readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

	private _onDidRunOperation = new EventEmitter<Operation>();
	readonly onDidRunOperation: Event<Operation> = this._onDidRunOperation.event;

	@memoize
	get onDidChangeOperations(): Event<void> {
		return anyEvent(this.onRunOperation as Event<any>, this.onDidRunOperation as Event<any>);
	}

	private _mergeGroup = new MergeGroup([]);
	get mergeGroup(): MergeGroup { return this._mergeGroup; }

	private _stagingGroup = new StagingGroup([]);
	get stagingGroup(): StagingGroup { return this._stagingGroup; }

	private _workingDirectory = new WorkingDirectoryGroup([]);
	get workingDirectoryGroup(): WorkingDirectoryGroup { return this._workingDirectory; }

	private _untrackedGroup = new UntrackedGroup([]);
	get untrackedGroup(): UntrackedGroup { return this._untrackedGroup; }

	private _parent: Branch | undefined;
	get parent(): Branch | undefined { return this._parent; }

	private _refs: Ref[] = [];
	get refs(): Ref[] { return this._refs; }

	private _paths: Path[] = [];
	get paths(): Path[] { return this._paths; }

	private _operations = new OperationsImpl();
	get operations(): Operations { return this._operations; }

	private _syncCounts: { incoming: number; outgoing: number };
	get syncCounts(): { incoming: number; outgoing: number } { return this._syncCounts; }

	private _numOutgoing: number;
	get numOutgoingCommits(): number { return this._numOutgoing; }

	private repository: Repository;

	private _state = State.Uninitialized;
	get state(): State { return this._state; }
	set state(state: State) {
		this._state = state;
		this._onDidChangeState.fire(state);

		this._parent = undefined;
		this._refs = [];
		this._syncCounts = { incoming: 0, outgoing: 0 };
		this._mergeGroup = new MergeGroup();
		this._stagingGroup = new StagingGroup();
		this._workingDirectory = new WorkingDirectoryGroup();
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

	@throttle
	async status(): Promise<void> {
		await this.run(Operation.Status);
	}

	@throttle
	async add(...resources: Resource[]): Promise<void> {
		if (resources.length === 0) {
			resources = this._untrackedGroup.resources;
		}
		await this.run(Operation.Add, () => this.repository.add(resources.map(r => r.resourceUri.fsPath)));
	}

	@throttle
	async stage(...resources: Resource[]): Promise<void> {
		if (resources.length === 0) {
			resources = this._workingDirectory.resources;
		}
		this._stagingGroup = this._stagingGroup.intersect(resources);
		this._workingDirectory = this._workingDirectory.except(resources);
		this._onDidChangeResources.fire();
	}

	@throttle
	async unstage(...resources: Resource[]): Promise<void> {
		if (resources.length === 0) {
			resources = this._stagingGroup.resources;
		}
		this._stagingGroup = this._stagingGroup.except(resources);
		this._workingDirectory = this._workingDirectory.intersect(resources);
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

				for (let resource of selectedResources) {
					const relativePath = path.relative(this.repository.root, resource.resourceUri.fsPath).replace(/\\/g, '/');
					fileList.push(relativePath);
				}
			}

			await this.repository.commit(message, { all: opts.scope === CommitScope.ALL, fileList });
			try {
				this._syncCounts.outgoing++;
				this._onDidChangeResources.fire();
				this.countOutgoing();
			} catch (e) {
				// noop
			}
		});
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
						toForget.push(r.resourceUri.fsPath);
						break;

					case Status.DELETED:
					case Status.MISSING:
					case Status.MODIFIED:
					default:
						toRevert.push(r.resourceUri.fsPath);
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
	async branch(name: string): Promise<void> {
		await this.run(Operation.Branch, () => this.repository.branch(name, true));
	}

	@throttle
	async update(treeish: string): Promise<void> {
		await this.run(Operation.Update, () => this.repository.update(treeish, []));
	}

	@throttle
	async getCommit(ref: string): Promise<Commit> {
		let commit = await this.repository.getCommit(ref);
		return commit;
	}

	@throttle
	async reset(treeish: string, hard?: boolean): Promise<void> {
		await this.run(Operation.Reset, () => this.repository.reset(treeish, hard));
	}

	async countIncomingOutgoing() {
		await Promise.all([this.countIncoming(), this.countOutgoing()]);
	}

	@throttle
	async countIncoming(): Promise<void> {
		this._syncCounts.incoming = await this.run(Operation.CountIncoming, () => this.repository.countIncoming());
		this._onDidChangeResources.fire();
	}

	@throttle
	async countOutgoing(): Promise<void> {
		this._syncCounts.outgoing = await this.run(Operation.CountOutgoing, () => this.repository.countOutgoing());
		this._onDidChangeResources.fire();
	}

	@throttle
	async pull(): Promise<void> {
		await this.run(Operation.Pull, () => this.repository.pull());
		this.countIncomingOutgoing();
	}

	@throttle
	async push(path?: string, options?: PushOptions): Promise<void> {
		await this.run(Operation.Push, () => this.repository.push(path, options));
		if (!path || path === "default") {
			this._syncCounts.outgoing = 0;
			this._onDidChangeResources.fire();
			this.countIncomingOutgoing();
		}
	}

	async show(ref: string, uri: Uri): Promise<string> {
		// TODO@Joao: should we make this a general concept?
		await this.whenIdle();

		return await this.run(Operation.Show, async () => {
			const relativePath = path.relative(this.repository.root, uri.fsPath).replace(/\\/g, '/');
			const result = await this.repository.hg.exec(this.repository.root, ['cat', relativePath, '-r', ref]);

			if (result.exitCode !== 0) {
				throw new HgError({
					message: localize('cantshow', "Could not show object"),
					exitCode: result.exitCode
				});
			}

			return result.stdout;
		});
	}

	async getCommitTemplate(): Promise<string> {
		return await this.run(Operation.GetCommitTemplate, async () => this.repository.getCommitTemplate());
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
			} catch (err) {
				if (err.hgErrorCode === HgErrorCodes.NoRespositoryFound) {
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
		onRelevantHgChange(this.onFSChange, this, disposables);
		onRelevantHgChange(this._onDidChangeRepository.fire, this._onDidChangeRepository, disposables);

		const onNonHgChange = filterEvent(this.onWorkspaceChange, uri => !/\/\.hg\//.test(uri.fsPath));
		onNonHgChange(this.onFSChange, this, disposables);

		this.repositoryDisposable = combinedDisposable(disposables);
		this.state = State.Idle;
	}

	private async updateRepositoryPaths() {
		let paths: Path[] | undefined;
		try {
			paths = await this.repository.getPaths();
			this._paths = paths;
		}
		catch (e) {
			console.log("I'm in the updatePaths catch:", e);
			// noop
		}
	}

	@throttle
	public async getRefs(): Promise<Ref[]> {
		const [branches, tags] = await Promise.all([this.repository.getBranches(), this.repository.getTags()]);
		this._refs = [...branches, ...tags];
		return this._refs;
	}

	@throttle
	private async refresh(): Promise<void> {
		const [status, branch] = await Promise.all([this.repository.getStatus(), this.repository.getParent()])
		this._parent = branch;

		const workingDirectory: Resource[] = [];
		const staging: Resource[] = [];
		const merge: Resource[] = [];
		const untracked: Resource[] = [];

		status.forEach(raw => {
			const uri = Uri.file(path.join(this.repository.root, raw.path));
			const uriString = uri.toString();
			const renameUri = raw.rename ? Uri.file(path.join(this.repository.root, raw.rename)) : undefined;

			switch (raw.status) {
				case 'I': return workingDirectory.push(new Resource(this.workingDirectoryGroup, uri, Status.IGNORED));
				case '!': return workingDirectory.push(new Resource(this.workingDirectoryGroup, uri, Status.MISSING));
			}

			const isStaged = this._stagingGroup.resources.some(resource => resource.resourceUri.toString() === uriString);
			const targetResources: Resource[] = isStaged ? staging : workingDirectory;
			const targetGroup: ResourceGroup = isStaged ? this.stagingGroup : this.workingDirectoryGroup;

			switch (raw.status) {
				case 'M': return targetResources.push(new Resource(targetGroup, uri, Status.MODIFIED));
				case 'A': return targetResources.push(new Resource(targetGroup, uri, Status.ADDED));
				case 'R': return targetResources.push(new Resource(targetGroup, uri, Status.DELETED));
				case 'C': return targetResources.push(new Resource(targetGroup, uri, Status.CONFLICT));
				case '?': return untracked.push(new Resource(this.untrackedGroup, uri, Status.UNTRACKED));
			}

			// case 'DD': return merge.push(new Resource(this.mergeGroup, uri, Status.BOTH_DELETED));
			// case 'AU': return merge.push(new Resource(this.mergeGroup, uri, Status.ADDED_BY_US));
			// case 'UD': return merge.push(new Resource(this.mergeGroup, uri, Status.DELETED_BY_THEM));
			// case 'UA': return merge.push(new Resource(this.mergeGroup, uri, Status.ADDED_BY_THEM));
			// case 'DU': return merge.push(new Resource(this.mergeGroup, uri, Status.DELETED_BY_US));
			// case 'AA': return merge.push(new Resource(this.mergeGroup, uri, Status.BOTH_ADDED));
			// case 'UU': return merge.push(new Resource(this.mergeGroup, uri, Status.BOTH_MODIFIED));
			// case 'R': index.push(new Resource(this.indexGroup, uri, Status.RENAMED, renameUri)); break;

			// switch (raw.y) {
			// 	case 'M': workingTree.push(new Resource(this.workingTreeGroup, uri, Status.MODIFIED, renameUri)); break;
			// 	case 'D': workingTree.push(new Resource(this.workingTreeGroup, uri, Status.DELETED, renameUri)); break;
			// }
		});

		this._mergeGroup = new MergeGroup(merge);
		this._stagingGroup = new StagingGroup(staging);
		this._workingDirectory = new WorkingDirectoryGroup(workingDirectory);
		this._untrackedGroup = new UntrackedGroup(untracked);
		this._onDidChangeResources.fire();
	}

	private onFSChange(uri: Uri): void {
		const config = workspace.getConfiguration('hg');
		const autorefresh = config.get<boolean>('autorefresh');

		if (!autorefresh) {
			return;
		}

		if (!this.operations.isIdle()) {
			return;
		}

		this.eventuallyUpdateWhenIdleAndWait();
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