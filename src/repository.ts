import {
    Uri,
    Command,
    EventEmitter,
    Event,
    scm,
    SourceControl,
    SourceControlResourceState,
    SourceControlResourceDecorations,
    Disposable,
    ProgressLocation,
    window,
    workspace,
    commands,
    QuickDiffProvider,
    FileRenameEvent,
} from "vscode";
import {
    Repository as BaseRepository,
    Ref,
    Commit,
    Shelve,
    HgError,
    Bookmark,
    IRepoStatus,
    SyncOptions,
    PullOptions,
    PushOptions,
    HgErrorCodes,
    IMergeResult,
    RebaseResult,
    CommitDetails,
    LogEntryRepositoryOptions,
    HgRollbackDetails,
    ShelveOptions,
    UnshelveOptions,
    GetRefsOptions,
    RefType,
    MoveOptions,
    ILineAnnotation,
} from "./hg";
import {
    anyEvent,
    filterEvent,
    eventToPromise,
    dispose,
    IDisposable,
    delay,
    groupBy,
    partition,
    isDescendant,
} from "./util";
import { memoize, throttle, debounce } from "./decorators";
import { StatusBarCommands } from "./statusbar";
import typedConfig, { PushPullScopeOptions } from "./config";

import * as path from "path";
import * as fs from "fs";
import * as nls from "vscode-nls";
import {
    ResourceGroup,
    createEmptyStatusGroups,
    UntrackedGroup,
    WorkingDirectoryGroup,
    StagingGroup,
    ConflictGroup,
    MergeGroup,
    IStatusGroups,
    groupStatuses,
    IGroupStatusesParams,
} from "./resourceGroups";
import { Path } from "./hg";
import {
    AutoInOutState,
    AutoInOutStatuses,
    AutoIncomingOutgoing,
} from "./autoinout";
import {
    DefaultRepoNotConfiguredAction,
    interaction,
    PushCreatesNewHeadAction,
} from "./interaction";
import { toHgUri } from "./uri";

const timeout = (millis: number) => new Promise((c) => setTimeout(c, millis));

const localize = nls.loadMessageBundle();
const iconsRootPath = path.join(__dirname, "..", "resources", "icons");

type BadgeOptions = "off" | "all" | "tracked";

function getIconUri(iconName: string, theme: string): Uri {
    return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

export interface LogEntriesOptions {
    file?: Uri;
    revQuery?: string;
    branch?: string;
    limit?: number;
}

export enum RepositoryState {
    Idle,
    Disposed,
}

export enum Status {
    MODIFIED,
    ADDED,
    DELETED,
    UNTRACKED,
    IGNORED,
    MISSING,
    RENAMED,
    CLEAN,
}

export enum MergeStatus {
    NONE,
    UNRESOLVED,
    RESOLVED,
}

export class Resource implements SourceControlResourceState {
    @memoize
    get command(): Command {
        return {
            command: "hg.openResource",
            title: localize("open", "Open"),
            arguments: [this],
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

    get original(): Uri {
        return this._resourceUri;
    }
    get renameResourceUri(): Uri | undefined {
        return this._renameResourceUri;
    }
    @memoize
    get resourceUri(): Uri {
        if (this.renameResourceUri) {
            if (
                this._status === Status.MODIFIED ||
                this._status === Status.RENAMED ||
                this._status === Status.ADDED
            ) {
                return this.renameResourceUri;
            }

            throw new Error(
                `Renamed resource with unexpected status: ${this._status}`
            );
        }
        return this._resourceUri;
    }
    get resourceGroup(): ResourceGroup {
        return this._resourceGroup;
    }
    get status(): Status {
        return this._status;
    }
    get mergeStatus(): MergeStatus {
        return this._mergeStatus;
    }

    private static Icons = {
        light: {
            Modified: getIconUri("status-modified", "light"),
            Missing: getIconUri("status-missing", "light"),
            Added: getIconUri("status-added", "light"),
            Deleted: getIconUri("status-deleted", "light"),
            Renamed: getIconUri("status-renamed", "light"),
            Copied: getIconUri("status-copied", "light"),
            Untracked: getIconUri("status-untracked", "light"),
            Ignored: getIconUri("status-ignored", "light"),
            Conflict: getIconUri("status-conflict", "light"),
            Clean: getIconUri("status-clean", "light"),
        },
        dark: {
            Modified: getIconUri("status-modified", "dark"),
            Missing: getIconUri("status-missing", "dark"),
            Added: getIconUri("status-added", "dark"),
            Deleted: getIconUri("status-deleted", "dark"),
            Renamed: getIconUri("status-renamed", "dark"),
            Copied: getIconUri("status-copied", "dark"),
            Untracked: getIconUri("status-untracked", "dark"),
            Ignored: getIconUri("status-ignored", "dark"),
            Conflict: getIconUri("status-conflict", "dark"),
            Clean: getIconUri("status-clean", "dark"),
        },
    };

    private getIconPath(theme: string): Uri | undefined {
        if (
            this.mergeStatus === MergeStatus.UNRESOLVED &&
            this.status !== Status.MISSING &&
            this.status !== Status.DELETED
        ) {
            return Resource.Icons[theme].Conflict;
        }

        switch (this.status) {
            case Status.MISSING:
                return Resource.Icons[theme].Missing;
            case Status.MODIFIED:
                return Resource.Icons[theme].Modified;
            case Status.ADDED:
                return Resource.Icons[theme].Added;
            case Status.DELETED:
                return Resource.Icons[theme].Deleted;
            case Status.RENAMED:
                return Resource.Icons[theme].Renamed;
            case Status.UNTRACKED:
                return Resource.Icons[theme].Untracked;
            case Status.IGNORED:
                return Resource.Icons[theme].Ignored;
            case Status.CLEAN:
                return Resource.Icons[theme].Clean;
            default:
                return void 0;
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
        const light = { iconPath: this.getIconPath("light") };
        const dark = { iconPath: this.getIconPath("dark") };

        return { strikeThrough: this.strikeThrough, light, dark };
    }

    constructor(
        private _resourceGroup: ResourceGroup,
        private _resourceUri: Uri,
        private _status: Status,
        private _mergeStatus: MergeStatus,
        private _renameResourceUri?: Uri
    ) {}
}

export const enum Operation {
    Status = "Status",
    Add = "Add",
    Annotate = "Annotate",
    Commit = "Commit",
    Clean = "Clean",
    Branch = "Branch",
    Update = "Update",
    Rollback = "Rollback",
    RollbackDryRun = "RollbackDryRun",
    Pull = "Pull",
    Push = "Push",
    Show = "Show",
    Stage = "Stage",
    GetCommitTemplate = "GetCommitTemplate",
    Resolve = "Resolve",
    Unresolve = "Unresolve",
    Forget = "Forget",
    Merge = "Merge",
    Move = "Move",
    AddRemove = "AddRemove",
    SetBookmark = "SetBookmark",
    RemoveBookmark = "RemoveBookmark",
    Shelve = "Shelve",
    UnshelveContinue = "UnshelveContinue",
    UnshelveAbort = "UnshelveAbort",
    Rebase = "Rebase",
    RebaseContinue = "RebaseContinue",
    RebaseAbort = "RebaseAbort",
}

function isReadOnly(operation: Operation): boolean {
    switch (operation) {
        case Operation.Annotate:
        case Operation.GetCommitTemplate:
        case Operation.Show:
        case Operation.RollbackDryRun:
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
    private operations = new Map<Operation, number>();

    start(operation: Operation): void {
        this.operations.set(
            operation,
            (this.operations.get(operation) || 0) + 1
        );
    }

    end(operation: Operation): void {
        const count = (this.operations.get(operation) || 0) - 1;

        if (count <= 0) {
            this.operations.delete(operation);
        } else {
            this.operations.set(operation, count);
        }
    }

    isRunning(operation: Operation): boolean {
        return this.operations.has(operation);
    }

    isIdle(): boolean {
        const operations = this.operations.keys();

        for (const operation of operations) {
            if (!isReadOnly(operation)) {
                return false;
            }
        }

        return true;
    }
}

export const enum CommitScope {
    ALL,
    ALL_WITH_ADD_REMOVE,
    STAGED_CHANGES,
    CHANGES,
}

export interface CommitOptions {
    scope?: CommitScope;
    amend?: boolean;
}

export class Repository implements IDisposable, QuickDiffProvider {
    private _onDidChangeRepository = new EventEmitter<Uri>();
    readonly onDidChangeRepository: Event<Uri> = this._onDidChangeRepository
        .event;

    private _onDidChangeHgrc = new EventEmitter<void>();
    readonly onDidChangeHgrc: Event<void> = this._onDidChangeHgrc.event;

    private _onDidChangeState = new EventEmitter<RepositoryState>();
    readonly onDidChangeState: Event<RepositoryState> = this._onDidChangeState
        .event;

    private _onDidChangeStatus = new EventEmitter<void>();
    readonly onDidChangeStatus: Event<void> = this._onDidChangeStatus.event;

    private _onDidChangeInOutState = new EventEmitter<void>();
    readonly onDidChangeInOutState: Event<void> = this._onDidChangeInOutState
        .event;

    private _onDidChangeResources = new EventEmitter<void>();
    readonly onDidChangeResources: Event<void> = this._onDidChangeResources
        .event;

    @memoize
    get onDidChange(): Event<void> {
        return anyEvent<any>(
            this.onDidChangeState,
            this.onDidChangeResources,
            this.onDidChangeInOutState
        );
    }

    private _onDidChangeOriginalResource = new EventEmitter<Uri>();
    readonly onDidChangeOriginalResource: Event<Uri> = this
        ._onDidChangeOriginalResource.event;

    private _onRunOperation = new EventEmitter<Operation>();
    readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

    private _onDidRunOperation = new EventEmitter<Operation>();
    readonly onDidRunOperation: Event<Operation> = this._onDidRunOperation
        .event;

    private _sourceControl: SourceControl;

    get sourceControl(): SourceControl {
        return this._sourceControl;
    }

    @memoize
    get onDidChangeOperations(): Event<void> {
        return anyEvent(
            this.onRunOperation as Event<any>,
            this.onDidRunOperation as Event<any>
        );
    }

    private _lastPushPath: string | undefined;
    get lastPushPath(): string | undefined {
        return this._lastPushPath;
    }

    private _groups: IStatusGroups;
    get mergeGroup(): MergeGroup {
        return this._groups.merge;
    }
    get conflictGroup(): ConflictGroup {
        return this._groups.conflict;
    }
    get stagingGroup(): StagingGroup {
        return this._groups.staging;
    }
    get workingDirectoryGroup(): WorkingDirectoryGroup {
        return this._groups.working;
    }
    get untrackedGroup(): UntrackedGroup {
        return this._groups.untracked;
    }

    get head(): Ref | undefined {
        const useBookmarks = typedConfig.useBookmarks;
        return useBookmarks ? this.activeBookmark : this.currentBranch;
    }

    get headShortName(): string | undefined {
        const head = this.head;

        if (!head) {
            return;
        }

        if (head.name) {
            return head.name;
        }
        const tag = this.refs.filter(
            (iref) => iref.type === RefType.Tag && iref.commit === head.commit
        )[0];
        const tagName = tag && tag.name;

        if (tagName) {
            return tagName;
        }

        return (head.commit || "").substr(0, 8);
    }

    private _currentBranch: Ref | undefined;
    get currentBranch(): Ref | undefined {
        return this._currentBranch;
    }

    private _activeBookmark: Bookmark | undefined;
    get activeBookmark(): Bookmark | undefined {
        return this._activeBookmark;
    }

    private _repoStatus: IRepoStatus | undefined;
    get repoStatus(): IRepoStatus | undefined {
        return this._repoStatus;
    }

    private _refs: Ref[] = [];
    get refs(): Ref[] {
        return this._refs;
    }

    private _paths: Path[] = [];
    get paths(): Path[] {
        return this._paths;
    }

    private _operations = new OperationsImpl();
    get operations(): Operations {
        return this._operations;
    }

    private _syncCounts = { incoming: 0, outgoing: 0 };
    get syncCounts(): { incoming: number; outgoing: number } {
        return this._syncCounts;
    }

    private _autoInOutState: AutoInOutState = {
        status: AutoInOutStatuses.Disabled,
    };
    get autoInOutState(): AutoInOutState {
        return this._autoInOutState;
    }

    public changeAutoInoutState(state: Partial<AutoInOutState>): void {
        this._autoInOutState = {
            ...this._autoInOutState,
            ...state,
        };
        this._onDidChangeInOutState.fire();
    }

    get repoName(): string {
        return path.basename(this.repository.root);
    }

    get isClean(): boolean {
        const groups = [
            this.workingDirectoryGroup,
            this.mergeGroup,
            this.conflictGroup,
            this.stagingGroup,
        ];
        return groups.every((g) => g.resources.length === 0);
    }

    toUri(rawPath: string): Uri {
        return Uri.file(path.join(this.repository.root, rawPath));
    }

    private _state = RepositoryState.Idle;
    get state(): RepositoryState {
        return this._state;
    }
    set state(state: RepositoryState) {
        this._state = state;
        this._onDidChangeState.fire(state);

        this._currentBranch = undefined;
        this._activeBookmark = undefined;
        this._refs = [];
        this._syncCounts = { incoming: 0, outgoing: 0 };
        this._groups.conflict.clear();
        this._groups.merge.clear();
        this._groups.staging.clear();
        this._groups.untracked.clear();
        this._groups.working.clear();
        this._onDidChangeResources.fire();
    }

    get root(): string {
        return this.repository.root;
    }

    private disposables: Disposable[] = [];

    constructor(private readonly repository: BaseRepository) {
        this.updateRepositoryPaths();

        const workspaceWatcher = workspace.createFileSystemWatcher("**");
        this.disposables.push(workspaceWatcher);

        const onWorkspaceFileChange = anyEvent(
            workspaceWatcher.onDidChange,
            workspaceWatcher.onDidCreate,
            workspaceWatcher.onDidDelete
        );
        const onWorkspaceRepositoryFileChange = filterEvent(
            onWorkspaceFileChange,
            (uri) => isDescendant(repository.root, uri.fsPath)
        );
        const onRelevantRepositoryChange = filterEvent(
            onWorkspaceRepositoryFileChange,
            (uri) =>
                !/\/\.hg$/.test(uri.path) &&
                !/\/\.hg\/(\w?lock.*|.*\.log([-.]\w+~?)?)$/.test(uri.path)
        );
        onRelevantRepositoryChange(this.onFSChange, this, this.disposables);

        const onRelevantHgChange = filterEvent(
            onRelevantRepositoryChange,
            (uri) => /\/\.hg\//.test(uri.path)
        );
        const onHgrcChange = filterEvent(onRelevantHgChange, (uri) =>
            /\/\.hg\/hgrc$/.test(uri.path)
        );
        onRelevantHgChange(
            this._onDidChangeRepository.fire,
            this._onDidChangeRepository,
            this.disposables
        );
        onHgrcChange(this.onHgrcChange, this, this.disposables);

        this.disposables.push(
            workspace.onDidRenameFiles(this.onFileRename, this)
        );

        this._sourceControl = scm.createSourceControl(
            "hg",
            "Hg",
            Uri.file(repository.root)
        );
        this.disposables.push(this._sourceControl);

        this._sourceControl.acceptInputCommand = {
            command: "hg.commitWithInput",
            title: localize("commit", "Commit"),
            arguments: [this._sourceControl],
        };
        this._sourceControl.quickDiffProvider = this;

        const [groups, disposables] = createEmptyStatusGroups(
            this._sourceControl
        );

        this.disposables.push(new AutoIncomingOutgoing(this));

        this._groups = groups;
        this.disposables.push(...disposables);

        const statusBar = new StatusBarCommands(this);
        this.disposables.push(statusBar);
        statusBar.onDidChange(
            () => {
                this._sourceControl.statusBarCommands = statusBar.commands;
            },
            null,
            this.disposables
        );
        this._sourceControl.statusBarCommands = statusBar.commands;

        this.status();
    }

    provideOriginalResource(uri: Uri): Uri | undefined {
        if (uri.scheme !== "file") {
            return;
        }

        // As a mitigation for extensions like ESLint showing warnings and errors
        // for hg URIs, let's change the file extension of these uris to .hg.
        return toHgUri(uri, ".", true);
    }

    @throttle
    async status(): Promise<void> {
        await this.run(Operation.Status);
    }

    private onFSChange(_uri: Uri): void {
        if (!typedConfig.autoRefresh) {
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
        await this.whenIdleAndFocused();
        await this.status();
        await timeout(5000);
    }

    async whenIdleAndFocused(): Promise<void> {
        while (true) {
            if (!this.operations.isIdle()) {
                await eventToPromise(this.onDidRunOperation);
                continue;
            }

            if (!window.state.focused) {
                const onDidFocusWindow = filterEvent(
                    window.onDidChangeWindowState,
                    (e) => e.focused
                );
                await eventToPromise(onDidFocusWindow);
                continue;
            }

            return;
        }
    }

    @debounce(1000)
    private onHgrcChange(_uri: Uri): void {
        this._onDidChangeHgrc.fire();
        if (typedConfig.commandMode === "server") {
            this.repository.hg.onConfigurationChange(true);
        }
    }

    @throttle
    async add(...uris: Uri[]): Promise<void> {
        let resources: Resource[];
        if (uris.length === 0) {
            resources = this._groups.untracked.resources;
        } else {
            resources = this.mapResources(uris);
        }
        const relativePaths: string[] = resources.map((r) =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Add, () => this.repository.add(relativePaths));
    }

    @throttle
    async forget(...uris: Uri[]): Promise<void> {
        const resources = this.mapResources(uris);
        const relativePaths: string[] = resources.map((r) =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Forget, () =>
            this.repository.forget(relativePaths)
        );
    }

    mapResources(resourceUris: Uri[]): Resource[] {
        const resources: Resource[] = [];
        const { conflict, merge, working, untracked, staging } = this._groups;
        const groups = [working, staging, merge, untracked, conflict];
        for (const uri of resourceUris) {
            for (const group of groups) {
                const resource = group.getResource(uri);
                if (resource) {
                    resources.push(resource);
                    break;
                }
            }
        }
        return resources;
    }

    @throttle
    async stage(...resourceUris: Uri[]): Promise<void> {
        await this.run(Operation.Stage, async () => {
            let resources = this.mapResources(resourceUris);

            if (resources.length === 0) {
                resources = this._groups.working.resources;
            }

            const [missingAndAddedResources, _otherResources] = partition(
                resources,
                (r) => r.status === Status.MISSING || r.status === Status.ADDED
            );

            if (missingAndAddedResources.length) {
                const relativePaths: string[] = missingAndAddedResources.map(
                    (r) => this.mapResourceToRepoRelativePath(r)
                );
                await this.run(Operation.AddRemove, () =>
                    this.repository.addRemove(relativePaths)
                );
            }

            this._groups.staging = this._groups.staging.intersect(resources);
            this._groups.working = this._groups.working.except(resources);
            this._onDidChangeResources.fire();
        });
    }

    // resource --> repo-relative path
    public mapResourceToRepoRelativePath(resource: Resource): string {
        const relativePath = this.mapFileUriToRepoRelativePath(
            resource.resourceUri
        );
        return relativePath;
    }

    // file uri --> repo-relative path
    private mapFileUriToRepoRelativePath(fileUri: Uri): string {
        const relativePath = path
            .relative(this.repository.root, fileUri.fsPath)
            .replace(/\\/g, "/");
        return relativePath;
    }

    // resource --> workspace-relative path
    public mapResourceToWorkspaceRelativePath(resource: Resource): string {
        const relativePath = this.mapFileUriToWorkspaceRelativePath(
            resource.resourceUri
        );
        return relativePath;
    }

    // file uri --> workspace-relative path
    public mapFileUriToWorkspaceRelativePath(fileUri: Uri): string {
        const relativePath = path
            .relative(this.repository.root, fileUri.fsPath)
            .replace(/[/\\]/g, path.sep);
        return relativePath;
    }

    // repo-relative path --> workspace-relative path
    private mapRepositoryRelativePathToWorkspaceRelativePath(
        repoRelativeFilepath: string
    ): string {
        const fsPath = path.join(this.repository.root, repoRelativeFilepath);
        const relativePath = path
            .relative(this.repository.root, fsPath)
            .replace(/[/\\]/g, path.sep);
        return relativePath;
    }

    @throttle
    async resolve(uris: Uri[], opts: { mark?: boolean } = {}): Promise<void> {
        const resources = this.mapResources(uris);
        const relativePaths: string[] = resources.map((r) =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Resolve, () =>
            this.repository.resolve(relativePaths, opts)
        );
    }

    @throttle
    async unresolve(uris: Uri[]): Promise<void> {
        const resources = this.mapResources(uris);
        const relativePaths: string[] = resources.map((r) =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Unresolve, () =>
            this.repository.unresolve(relativePaths)
        );
    }

    @throttle
    async unstage(...uris: Uri[]): Promise<void> {
        let resources = this.mapResources(uris);
        if (resources.length === 0) {
            resources = this._groups.staging.resources;
        }
        this._groups.staging = this._groups.staging.except(resources);
        this._groups.working = this._groups.working.intersect(resources);
        this._onDidChangeResources.fire();
    }

    @throttle
    async commit(
        message: string,
        opts: CommitOptions = Object.create(null)
    ): Promise<void> {
        await this.run(Operation.Commit, async () => {
            let fileList: string[] = [];
            if (
                opts.scope === CommitScope.CHANGES ||
                opts.scope === CommitScope.STAGED_CHANGES
            ) {
                const selectedResources =
                    opts.scope === CommitScope.STAGED_CHANGES
                        ? this.stagingGroup.resources
                        : this.workingDirectoryGroup.resources;

                fileList = selectedResources.map((r) =>
                    this.mapResourceToRepoRelativePath(r)
                );
            }

            await this.repository.commit(message, {
                amend: opts.amend,
                addRemove: opts.scope === CommitScope.ALL_WITH_ADD_REMOVE,
                fileList,
            });
        });
    }

    async cleanOrUpdate(...resources: Uri[]): Promise<void> {
        const parents = await this.getParents();
        if (parents.length > 1) {
            return this.update(".", { discard: true });
        }

        return this.clean(...resources);
    }

    @throttle
    async clean(...uris: Uri[]): Promise<void> {
        const resources = this.mapResources(uris);
        await this.run(Operation.Clean, async () => {
            const toRevert: string[] = [];
            const toForget: string[] = [];

            for (const r of resources) {
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
                    case Status.RENAMED:
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
    async purge(...uris: Uri[]): Promise<void> {
        const resources = this.mapResources(uris);
        const relativePaths: string[] = resources.map((r) =>
            this.mapResourceToRepoRelativePath(r)
        );
        await this.run(Operation.Clean, () =>
            this.repository.purge({ paths: relativePaths })
        );
    }

    @throttle
    async purgeAll(): Promise<void> {
        await this.run(Operation.Clean, () =>
            this.repository.purge({ all: true })
        );
    }

    @throttle
    async branch(
        name: string,
        opts?: { allowBranchReuse: boolean }
    ): Promise<void> {
        const hgOpts = opts && {
            force: opts && opts.allowBranchReuse,
        };
        await this.run(Operation.Branch, () =>
            this.repository.branch(name, hgOpts)
        );
    }

    @throttle
    async update(treeish: string, opts?: { discard: boolean }): Promise<void> {
        await this.run(Operation.Update, () =>
            this.repository.update(treeish, opts)
        );
    }

    @throttle
    async rollback(
        dryRun: boolean,
        dryRunDetails?: HgRollbackDetails
    ): Promise<HgRollbackDetails> {
        const op = dryRun ? Operation.RollbackDryRun : Operation.Rollback;
        const rollback = await this.run(op, () =>
            this.repository.rollback(dryRun)
        );

        if (!dryRun) {
            if (rollback.kind === "commit") {
                // if there are currently files in the staging group, then
                // any previously-committed files should go there too.
                if (dryRunDetails && dryRunDetails.commitDetails) {
                    const { affectedFiles } = dryRunDetails.commitDetails;
                    if (
                        this.stagingGroup.resources.length &&
                        affectedFiles.length
                    ) {
                        const previouslyCommmitedResourcesToStage = affectedFiles
                            .map((f) => {
                                const uri = Uri.file(
                                    path.join(this.repository.root, f.path)
                                );
                                const resource = this.findTrackedResourceByUri(
                                    uri
                                );
                                return resource;
                            })
                            .filter((r) => !!r) as Resource[];
                        this.stage(
                            ...previouslyCommmitedResourcesToStage.map(
                                (r) => r.resourceUri
                            )
                        );
                    }
                }
            }
        }
        return rollback;
    }

    findTrackedResourceByUri(uri: Uri): Resource | undefined {
        const groups = [
            this.workingDirectoryGroup,
            this.stagingGroup,
            this.mergeGroup,
            this.conflictGroup,
        ];
        for (const group of groups) {
            for (const resource of group.resources) {
                if (resource.resourceUri.toString() === uri.toString()) {
                    return resource;
                }
            }
        }

        return undefined;
    }

    async enumerateSyncBookmarkNames(): Promise<string[]> {
        if (!typedConfig.useBookmarks) {
            return [];
        }
        if (typedConfig.pushPullScope === "current") {
            return this.activeBookmark ? [this.activeBookmark.name] : [];
        }
        return await this.getBookmarkNamesFromHeads(
            typedConfig.pushPullScope === "default"
        );
    }

    @throttle
    async setBookmark(name: string, opts: { force: boolean }): Promise<any> {
        await this.run(Operation.SetBookmark, () =>
            this.repository.bookmark(name, { force: opts.force })
        );
    }

    @throttle
    async removeBookmark(name: string): Promise<any> {
        await this.run(Operation.RemoveBookmark, () =>
            this.repository.bookmark(name, { remove: true })
        );
    }

    get pushPullBranchName(): string | undefined {
        if (typedConfig.useBookmarks) {
            return undefined;
        }
        return this.expandScopeOption(
            typedConfig.pushPullScope,
            this.currentBranch
        );
    }

    get pushPullBookmarkName(): string | undefined {
        if (!typedConfig.useBookmarks) {
            return undefined;
        }
        return this.expandScopeOption(
            typedConfig.pushPullScope,
            this.activeBookmark
        );
    }

    private async createSyncOptions(): Promise<SyncOptions> {
        if (typedConfig.useBookmarks) {
            const branch =
                typedConfig.pushPullScope === "default" ? "default" : undefined;
            const bookmarks = await this.enumerateSyncBookmarkNames();
            return { branch, bookmarks };
        } else {
            return { branch: this.pushPullBranchName };
        }
    }

    public async createPullOptions(): Promise<PullOptions> {
        const syncOptions = await this.createSyncOptions();
        const autoUpdate = typedConfig.autoUpdate;

        if (typedConfig.useBookmarks) {
            // bookmarks
            return { ...syncOptions, autoUpdate };
        } else {
            // branches
            return { branch: syncOptions.branch, autoUpdate };
        }
    }

    public async createPushOptions(): Promise<PushOptions> {
        const pullOptions = await this.createPullOptions();

        return {
            allowPushNewBranches: typedConfig.allowPushNewBranches,
            ...pullOptions,
        };
    }

    private expandScopeOption(
        branchOptions: PushPullScopeOptions,
        ref: Ref | undefined
    ): string | undefined {
        switch (branchOptions) {
            case "current":
                return ref ? ref.name : undefined;

            case "default":
                return "default";

            case "all":
            default:
                return undefined;
        }
    }

    async countIncomingOutgoingAfterDelay(
        expectedDeltas?: { incoming: number; outgoing: number },
        delayMillis = 3000
    ): Promise<void> {
        try {
            await Promise.all([
                this.countIncomingAfterDelay(
                    expectedDeltas && expectedDeltas.incoming,
                    delayMillis
                ),
                this.countOutgoingAfterDelay(
                    expectedDeltas && expectedDeltas.outgoing,
                    delayMillis
                ),
            ]);
        } catch (err) {
            if (
                err instanceof HgError &&
                (err.hgErrorCode === HgErrorCodes.AuthenticationFailed ||
                    err.hgErrorCode === HgErrorCodes.RepositoryIsUnrelated ||
                    err.hgErrorCode === HgErrorCodes.RepositoryDefaultNotFound)
            ) {
                this.changeAutoInoutState({
                    status: AutoInOutStatuses.Error,
                    error: (
                        (err.stderr || "").replace(/^abort:\s*/, "") ||
                        err.hgErrorCode ||
                        err.message
                    ).trim(),
                });
            }
            throw err;
        }
    }

    async countIncomingAfterDelay(
        expectedDelta = 0,
        delayMillis = 3000
    ): Promise<void> {
        // immediate UI update with expected
        if (expectedDelta) {
            this._syncCounts.incoming = Math.max(
                0,
                this._syncCounts.incoming + expectedDelta
            );
            this._onDidChangeInOutState.fire();
        }

        // then confirm after delay
        if (delayMillis) {
            await delay(delayMillis);
        }
        const options: SyncOptions = await this.createSyncOptions();
        this._syncCounts.incoming = await this.repository.countIncoming(
            options
        );
        this._onDidChangeInOutState.fire();
    }

    async countOutgoingAfterDelay(
        expectedDelta = 0,
        delayMillis = 3000
    ): Promise<void> {
        // immediate UI update with expected
        if (expectedDelta) {
            this._syncCounts.outgoing = Math.max(
                0,
                this._syncCounts.outgoing + expectedDelta
            );
            this._onDidChangeInOutState.fire();
        }

        // then confirm after delay
        if (delayMillis) {
            await delay(delayMillis);
        }
        const options: SyncOptions = await this.createSyncOptions();
        this._syncCounts.outgoing = await this.repository.countOutgoing(
            options
        );
        this._onDidChangeInOutState.fire();
    }

    @throttle
    async pull(options?: PullOptions): Promise<void> {
        await this.run(Operation.Pull, async () => {
            try {
                await this.repository.pull(options);
            } catch (e) {
                if (
                    e instanceof HgError &&
                    e.hgErrorCode ===
                        HgErrorCodes.DefaultRepositoryNotConfigured
                ) {
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
    async push(path: string | undefined, options: PushOptions): Promise<void> {
        return await this.run(Operation.Push, async () => {
            try {
                this._lastPushPath = path;
                await this.repository.push(path, options);
            } catch (e) {
                if (
                    e instanceof HgError &&
                    e.hgErrorCode ===
                        HgErrorCodes.DefaultRepositoryNotConfigured
                ) {
                    const action = await interaction.warnDefaultRepositoryNotConfigured();
                    if (action === DefaultRepoNotConfiguredAction.OpenHGRC) {
                        commands.executeCommand("hg.openhgrc");
                    }
                    return;
                } else if (
                    e instanceof HgError &&
                    e.hgErrorCode === HgErrorCodes.PushCreatesNewRemoteHead
                ) {
                    const action = await interaction.warnPushCreatesNewHead();
                    if (action === PushCreatesNewHeadAction.Pull) {
                        commands.executeCommand("hg.pull");
                    }
                    return;
                } else if (
                    e instanceof HgError &&
                    e.hgErrorCode === HgErrorCodes.PushCreatesNewRemoteBranches
                ) {
                    const allow = await interaction.warnPushCreatesNewBranchesAllow();
                    if (allow) {
                        return this.push(path, {
                            ...options,
                            allowPushNewBranches: true,
                        });
                    }

                    return;
                }

                throw e;
            }
        });
    }

    @throttle
    merge(revQuery: string): Promise<IMergeResult> {
        return this.run(Operation.Merge, async () => {
            try {
                return await this.repository.merge(revQuery);
            } catch (e) {
                if (
                    e instanceof HgError &&
                    e.hgErrorCode === HgErrorCodes.UntrackedFilesDiffer &&
                    e.hgFilenames
                ) {
                    e.hgFilenames = e.hgFilenames.map((filename) =>
                        this.mapRepositoryRelativePathToWorkspaceRelativePath(
                            filename
                        )
                    );
                }
                throw e;
            }
        });
    }

    repositoryContains(uri: Uri): boolean {
        if (uri.fsPath) {
            return uri.fsPath.startsWith(this.repository.root);
        }
        return true;
    }

    async rebaseCurrentBranch(destination: string): Promise<RebaseResult> {
        return this.run(Operation.Rebase, async () => {
            try {
                return await this.repository.rebaseCurrentBranch(destination);
            } catch (e) {
                if (
                    e instanceof HgError &&
                    e.hgErrorCode === HgErrorCodes.UntrackedFilesDiffer &&
                    e.hgFilenames
                ) {
                    e.hgFilenames = e.hgFilenames.map((filename) =>
                        this.mapRepositoryRelativePathToWorkspaceRelativePath(
                            filename
                        )
                    );
                }
                throw e;
            }
        });
    }

    async rebaseAbort(): Promise<void> {
        await this.run(
            Operation.RebaseAbort,
            async () => await this.repository.rebaseAbort()
        );
    }

    async rebaseContinue(): Promise<void> {
        await this.run(
            Operation.RebaseContinue,
            async () => await this.repository.rebaseContinue()
        );
    }

    async shelve(options: ShelveOptions): Promise<void> {
        return await this.run(Operation.Shelve, () =>
            this.repository.shelve(options)
        );
    }

    async unshelve(options: UnshelveOptions): Promise<void> {
        return await this.run(Operation.Shelve, () =>
            this.repository.unshelve(options)
        );
    }

    async unshelveAbort(): Promise<void> {
        await this.run(
            Operation.UnshelveAbort,
            async () => await this.repository.unshelveAbort()
        );
    }

    async unshelveContinue(): Promise<void> {
        await this.run(
            Operation.UnshelveContinue,
            async () => await this.repository.unshelveContinue()
        );
    }

    async getShelves(): Promise<Shelve[]> {
        return await this.repository.getShelves();
    }

    async show(ref: string, filePath: string): Promise<string> {
        // TODO@Joao: should we make this a general concept?
        await this.whenIdleAndFocused();

        return await this.run(Operation.Show, async () => {
            const relativePath = path
                .relative(this.repository.root, filePath)
                .replace(/\\/g, "/");
            try {
                return await this.repository.cat(relativePath, ref);
            } catch (e) {
                if (
                    e &&
                    e instanceof HgError &&
                    e.hgErrorCode === "NoSuchFile"
                ) {
                    return "";
                }

                if (e.exitCode !== 0) {
                    throw new HgError({
                        message: localize("cantshow", "Could not show object"),
                        exitCode: e.exitCode,
                    });
                }

                throw e;
            }
        });
    }

    async move(
        files: readonly { oldUri: Uri; newUri: Uri }[],
        options: MoveOptions
    ): Promise<void> {
        return await this.run(Operation.Move, async () => {
            Promise.all(
                files.map(({ oldUri, newUri }) => {
                    this.repository.move(oldUri, newUri, options);
                })
            );
        });
    }

    async showAsStream(ref: string, filePath: string): Promise<Buffer> {
        return this.run(Operation.Show, () => {
            const relativePath = path
                .relative(this.repository.root, filePath)
                .replace(/\\/g, "/");
            return this.repository.catAsStream(relativePath, ref);
        });
    }

    private async run<T>(
        operation: Operation,
        runOperation: () => Promise<T> = () => Promise.resolve<any>(null)
    ): Promise<T> {
        if (this.state !== RepositoryState.Idle) {
            throw new Error("Repository not initialized");
        }

        return window.withProgress(
            { location: ProgressLocation.SourceControl },
            async () => {
                this._operations.start(operation);
                this._onRunOperation.fire(operation);

                try {
                    await this.unlocked();
                    const result = await runOperation();

                    if (!isReadOnly(operation)) {
                        await this.updateModelState();
                    }

                    return result;
                } catch (err) {
                    if (err.hgErrorCode === HgErrorCodes.NotAnHgRepository) {
                        this.state = RepositoryState.Disposed;
                    }

                    throw err;
                } finally {
                    this._operations.end(operation);
                    this._onDidRunOperation.fire(operation);
                }
            }
        );
    }

    private async unlocked<T>(): Promise<void> {
        let attempt = 1;

        const existsLocal = (path: string) =>
            new Promise((resolve, reject) => {
                fs.stat(path, (err) => {
                    if (err) {
                        if (err.code === "ENOENT") {
                            return resolve(false);
                        }
                        reject(err);
                    }
                    return resolve(true);
                });
            });

        while (
            attempt <= 10 &&
            (await existsLocal(
                path.join(this.repository.root, ".hg", "index.lock")
            ))
        ) {
            await timeout(Math.pow(attempt, 2) * 50);
            attempt++;
        }
    }

    private async updateRepositoryPaths() {
        try {
            this._paths = await this.repository.getPaths();
        } catch (e) {
            // noop
        }
    }

    private async onFileRename(e: FileRenameEvent) {
        return this.move(e.files, { after: true });
    }

    @throttle
    public async getPaths(): Promise<Path[]> {
        try {
            this._paths = await this.repository.getPaths();
            return this._paths;
        } catch (e) {
            // noop
        }

        return [];
    }

    @throttle
    public async getUpdateCandidates(
        useBookmarks: boolean,
        uncleanBookmarks?: boolean
    ): Promise<Ref[]> {
        if (useBookmarks) {
            // bookmarks
            if (uncleanBookmarks) {
                // unclean: only allow bookmarks already on the parents
                const [bookmarks, parents] = await Promise.all([
                    this.repository.getBookmarks(),
                    this.repository.getParents(),
                ]);
                return bookmarks.filter((b) =>
                    parents.some((p) => p.hash.startsWith(b.commit!))
                );
            } else {
                // clean: allow all bookmarks and other commits
                const opts = { excludeBookmarks: true } as GetRefsOptions;
                const [bookmarks, maxPublic, draftHeads] = await Promise.all([
                    this.repository.getBookmarks(),
                    this.repository.getPublicTip(opts),
                    this.repository.getDraftHeads(opts),
                ]);
                return [...bookmarks, ...maxPublic, ...draftHeads];
            }
        } else {
            // branches/tags
            const opts = { excludeTags: true } as GetRefsOptions;
            const [branches, tags, maxPublic, draftHeads] = await Promise.all([
                this.repository.getBranches(),
                this.repository.getTags(),
                this.repository.getPublicTip(opts),
                this.repository.getDraftHeads(opts),
            ]);
            return [...branches, ...tags, ...maxPublic, ...draftHeads];
        }
    }

    @throttle
    public async getBookmarks(): Promise<Bookmark[]> {
        return this.repository.getBookmarks();
    }

    @throttle
    public getParents(revision?: string): Promise<Commit[]> {
        return this.repository.getParents(revision);
    }

    @throttle
    public async getBranchNamesWithMultipleHeads(
        branch?: string
    ): Promise<string[]> {
        const allHeads = await this.repository.getHeads({
            branch,
            excludeSecret: true,
        });
        const multiHeadBranches: string[] = [];
        const headsPerBranch = groupBy(allHeads, (h) => h.branch);
        for (const branch in headsPerBranch) {
            const branchHeads = headsPerBranch[branch];
            if (branchHeads.length > 1) {
                multiHeadBranches.push(branch);
            }
        }
        return multiHeadBranches;
    }

    @throttle
    public async getHashesOfNonDistinctBookmarkHeads(
        defaultOnly: boolean
    ): Promise<string[]> {
        const defaultOrAll = defaultOnly ? "default" : undefined;
        const allHeads = await this.repository.getHeads({
            branch: defaultOrAll,
            excludeSecret: true,
        });
        const headsWithoutBookmarks = allHeads.filter(
            (h) => h.bookmarks.length === 0
        );
        if (headsWithoutBookmarks.length > 1) {
            // allow one version of any branch with no bookmark
            return headsWithoutBookmarks.map((h) => h.hash);
        }
        return [];
    }

    @throttle
    public async getBookmarkNamesFromHeads(
        defaultOnly: boolean
    ): Promise<string[]> {
        const defaultOrAll = defaultOnly ? "default" : undefined;
        const allHeads = await this.repository.getHeads({
            branch: defaultOrAll,
        });
        const headsWithBookmarks = allHeads.filter(
            (h) => h.bookmarks.length > 0
        );
        return headsWithBookmarks.reduce(
            (prev, curr) => [...prev, ...curr.bookmarks],
            <string[]>[]
        );
    }

    @throttle
    public getHeads(
        options: { branch?: string; excludeSelf?: boolean } = {}
    ): Promise<Commit[]> {
        const { branch, excludeSelf } = options;
        return this.repository.getHeads({ branch, excludeSelf });
    }

    @throttle
    public async getCommitDetails(revision: string): Promise<CommitDetails> {
        const commitPromise = this.getLogEntries({
            revQuery: revision,
            limit: 1,
        });
        const fileStatusesPromise = this.repository.getStatus(revision);
        const parentsPromise = this.getParents(revision);

        const [[commit], fileStatuses, [parent1, parent2]] = await Promise.all([
            commitPromise,
            fileStatusesPromise,
            parentsPromise,
        ]);

        return {
            ...commit,
            parent1,
            parent2,
            files: fileStatuses,
        };
    }

    public async getLastCommitMessage(): Promise<string> {
        return this.repository.getLastCommitMessage();
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
            limit: options.limit || 200,
        };
        return this.repository.getLogEntries(opts);
    }

    @throttle
    public async annotate(uri: Uri, rev?: string): Promise<ILineAnnotation[]> {
        return await this.run(Operation.Annotate, () => {
            const filePath = this.mapFileUriToRepoRelativePath(uri);
            return this.repository.annotate(filePath, rev);
        });
    }

    @throttle
    private async updateModelState(): Promise<void> {
        this._repoStatus = await this.repository.getSummary();

        const useBookmarks = typedConfig.useBookmarks;
        const currentRefPromise:
            | Promise<Bookmark | undefined>
            | Promise<Ref | undefined> = useBookmarks
            ? this.repository.getActiveBookmark()
            : this.repository.getCurrentBranch();

        const [fileStatuses, currentRef, resolveStatuses] = await Promise.all([
            this.repository.getStatus(),
            currentRefPromise,
            this._repoStatus.isMerge
                ? this.repository.getResolveList()
                : Promise.resolve(undefined),
        ]);

        useBookmarks
            ? (this._activeBookmark = <Bookmark>currentRef)
            : (this._currentBranch = currentRef);

        const groupInput: IGroupStatusesParams = {
            respositoryRoot: this.repository.root,
            fileStatuses: fileStatuses || [],
            repoStatus: this._repoStatus,
            resolveStatuses: resolveStatuses,
            statusGroups: this._groups,
        };

        this._groups = groupStatuses(groupInput);
        this._sourceControl.count = this.count;
        this._onDidChangeStatus.fire();
    }

    get count(): number {
        const countBadge = workspace
            .getConfiguration("hg")
            .get<BadgeOptions>("countBadge");

        switch (countBadge) {
            case "off":
                return 0;

            case "tracked":
                return (
                    this.mergeGroup.resources.length +
                    this.stagingGroup.resources.length +
                    this.workingDirectoryGroup.resources.length +
                    this.conflictGroup.resources.length
                );

            case "all":
            default:
                return (
                    this.mergeGroup.resources.length +
                    this.stagingGroup.resources.length +
                    this.workingDirectoryGroup.resources.length +
                    this.conflictGroup.resources.length +
                    this.untrackedGroup.resources.length
                );
        }
    }

    private get hgrcPath(): string {
        return path.join(this.repository.root, ".hg", "hgrc");
    }

    async hgrcPathIfExists(): Promise<string | undefined> {
        const filePath: string = this.hgrcPath;
        const exists = await new Promise((c, _e) => fs.exists(filePath, c));
        if (exists) {
            return filePath;
        }
    }

    async createHgrc(): Promise<string> {
        const filePath: string = this.hgrcPath;
        const fd = fs.openSync(filePath, "w");
        fs.writeSync(
            fd,
            `[paths]
; Uncomment line below to add a remote path:
; default = https://bitbucket.org/<yourname>/<repo>
`,
            0,
            "utf-8"
        );
        fs.closeSync(fd);
        return filePath;
    }

    dispose(): void {
        this.disposables = dispose(this.disposables);
    }
}
