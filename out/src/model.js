/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = require("vscode");
const hg_1 = require("./hg");
const util_1 = require("./util");
const decorators_1 = require("./decorators");
const watch_1 = require("./watch");
const path = require("path");
const fs = require("fs");
const nls = require("vscode-nls");
const timeout = (millis) => new Promise(c => setTimeout(c, millis));
const exists = (path) => new Promise(c => fs.exists(path, c));
const localize = nls.loadMessageBundle();
const iconsRootPath = path.join(path.dirname(__dirname), 'resources', 'icons');
function getIconUri(iconName, theme) {
    return vscode_1.Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}
var State;
(function (State) {
    State[State["Uninitialized"] = 0] = "Uninitialized";
    State[State["Idle"] = 1] = "Idle";
    State[State["NotAnHgRepository"] = 2] = "NotAnHgRepository";
})(State = exports.State || (exports.State = {}));
var Status;
(function (Status) {
    Status[Status["MODIFIED"] = 0] = "MODIFIED";
    Status[Status["ADDED"] = 1] = "ADDED";
    Status[Status["DELETED"] = 2] = "DELETED";
    Status[Status["UNTRACKED"] = 3] = "UNTRACKED";
    Status[Status["IGNORED"] = 4] = "IGNORED";
    Status[Status["MISSING"] = 5] = "MISSING";
    Status[Status["CONFLICT"] = 6] = "CONFLICT";
})(Status = exports.Status || (exports.Status = {}));
class Resource {
    constructor(_resourceGroup, _resourceUri, _type, _renameResourceUri) {
        this._resourceGroup = _resourceGroup;
        this._resourceUri = _resourceUri;
        this._type = _type;
        this._renameResourceUri = _renameResourceUri;
    }
    get resourceUri() {
        if (this.renameResourceUri && (this._type === Status.MODIFIED || this._type === Status.DELETED)) {
            return this.renameResourceUri;
        }
        return this._resourceUri;
    }
    get command() {
        return {
            command: 'hg.openResource',
            title: localize('open', "Open"),
            arguments: [this]
        };
    }
    get resourceGroup() { return this._resourceGroup; }
    get type() { return this._type; }
    get original() { return this._resourceUri; }
    get renameResourceUri() { return this._renameResourceUri; }
    getIconPath(theme) {
        switch (this.type) {
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
    get strikeThrough() {
        switch (this.type) {
            case Status.DELETED:
                return true;
            default:
                return false;
        }
    }
    get decorations() {
        const light = { iconPath: this.getIconPath('light') };
        const dark = { iconPath: this.getIconPath('dark') };
        return { strikeThrough: this.strikeThrough, light, dark };
    }
}
Resource.Icons = {
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
__decorate([
    decorators_1.memoize
], Resource.prototype, "resourceUri", null);
__decorate([
    decorators_1.memoize
], Resource.prototype, "command", null);
exports.Resource = Resource;
class ResourceGroup {
    constructor(_id, _label, _resources) {
        this._id = _id;
        this._label = _label;
        this._resources = _resources;
    }
    get id() { return this._id; }
    get contextKey() { return this._id; }
    get label() { return this._label; }
    get resources() { return this._resources; }
}
exports.ResourceGroup = ResourceGroup;
class MergeGroup extends ResourceGroup {
    constructor(resources = []) {
        super(MergeGroup.ID, localize('merge changes', "Merge Changes"), resources);
    }
}
MergeGroup.ID = 'merge';
exports.MergeGroup = MergeGroup;
class IndexGroup extends ResourceGroup {
    constructor(resources = []) {
        super(IndexGroup.ID, localize('staged changes', "Staged Changes"), resources);
    }
}
IndexGroup.ID = 'index';
exports.IndexGroup = IndexGroup;
class WorkingFolderGroup extends ResourceGroup {
    constructor(resources = []) {
        super(WorkingFolderGroup.ID, localize('changes', "Changes"), resources);
    }
}
WorkingFolderGroup.ID = 'workingTree';
exports.WorkingFolderGroup = WorkingFolderGroup;
var Operation;
(function (Operation) {
    Operation[Operation["Status"] = 1] = "Status";
    Operation[Operation["Add"] = 2] = "Add";
    Operation[Operation["RevertFiles"] = 4] = "RevertFiles";
    Operation[Operation["Commit"] = 8] = "Commit";
    Operation[Operation["Clean"] = 16] = "Clean";
    Operation[Operation["Branch"] = 32] = "Branch";
    Operation[Operation["Checkout"] = 64] = "Checkout";
    Operation[Operation["Reset"] = 128] = "Reset";
    Operation[Operation["Fetch"] = 256] = "Fetch";
    Operation[Operation["Pull"] = 512] = "Pull";
    Operation[Operation["Push"] = 1024] = "Push";
    Operation[Operation["Sync"] = 2048] = "Sync";
    Operation[Operation["Init"] = 4096] = "Init";
    Operation[Operation["Show"] = 8192] = "Show";
    Operation[Operation["Stage"] = 16384] = "Stage";
    Operation[Operation["GetCommitTemplate"] = 32768] = "GetCommitTemplate";
})(Operation = exports.Operation || (exports.Operation = {}));
// function getOperationName(operation: Operation): string {
// 	switch (operation) {
// 		case Operation.Status: return 'Status';
// 		case Operation.Add: return 'Add';
// 		case Operation.RevertFiles: return 'RevertFiles';
// 		case Operation.Commit: return 'Commit';
// 		case Operation.Clean: return 'Clean';
// 		case Operation.Branch: return 'Branch';
// 		case Operation.Checkout: return 'Checkout';
// 		case Operation.Reset: return 'Reset';
// 		case Operation.Fetch: return 'Fetch';
// 		case Operation.Pull: return 'Pull';
// 		case Operation.Push: return 'Push';
// 		case Operation.Sync: return 'Sync';
// 		case Operation.Init: return 'Init';
// 		case Operation.Show: return 'Show';
// 		case Operation.Stage: return 'Stage';
// 		case Operation.GetCommitTemplate: return 'GetCommitTemplate';
// 		default: return 'unknown';
// 	}
// }
function isReadOnly(operation) {
    switch (operation) {
        case Operation.Show:
        case Operation.GetCommitTemplate:
            return true;
        default:
            return false;
    }
}
class OperationsImpl {
    constructor(operations = 0) {
        this.operations = operations;
        // noop
    }
    start(operation) {
        return new OperationsImpl(this.operations | operation);
    }
    end(operation) {
        return new OperationsImpl(this.operations & ~operation);
    }
    isRunning(operation) {
        return (this.operations & operation) !== 0;
    }
    isIdle() {
        return this.operations === 0;
    }
}
class Model {
    constructor(_hg, workspaceRootPath) {
        this._hg = _hg;
        this.workspaceRootPath = workspaceRootPath;
        this._onDidChangeRepository = new vscode_1.EventEmitter();
        this.onDidChangeRepository = this._onDidChangeRepository.event;
        this._onDidChangeState = new vscode_1.EventEmitter();
        this.onDidChangeState = this._onDidChangeState.event;
        this._onDidChangeResources = new vscode_1.EventEmitter();
        this.onDidChangeResources = this._onDidChangeResources.event;
        this._onRunOperation = new vscode_1.EventEmitter();
        this.onRunOperation = this._onRunOperation.event;
        this._onDidRunOperation = new vscode_1.EventEmitter();
        this.onDidRunOperation = this._onDidRunOperation.event;
        this._mergeGroup = new MergeGroup([]);
        this._workingTreeGroup = new WorkingFolderGroup([]);
        this._refs = [];
        this._paths = [];
        this._operations = new OperationsImpl();
        this._state = State.Uninitialized;
        this.repositoryDisposable = util_1.EmptyDisposable;
        this.disposables = [];
        const fsWatcher = vscode_1.workspace.createFileSystemWatcher('**');
        this.onWorkspaceChange = util_1.anyEvent(fsWatcher.onDidChange, fsWatcher.onDidCreate, fsWatcher.onDidDelete);
        this.disposables.push(fsWatcher);
        this.status();
    }
    get onDidChange() {
        return util_1.anyEvent(this.onDidChangeState, this.onDidChangeResources);
    }
    get onDidChangeOperations() {
        return util_1.anyEvent(this.onRunOperation, this.onDidRunOperation);
    }
    get mergeGroup() { return this._mergeGroup; }
    get workingTreeGroup() { return this._workingTreeGroup; }
    get workingDirectoryParent() {
        return this._workingDirParent;
    }
    get refs() {
        return this._refs;
    }
    get paths() {
        return this._paths;
    }
    get operations() { return this._operations; }
    get state() { return this._state; }
    set state(state) {
        this._state = state;
        this._onDidChangeState.fire(state);
        this._workingDirParent = undefined;
        this._refs = [];
        this._mergeGroup = new MergeGroup();
        // this._indexGroup = new IndexGroup();
        this._workingTreeGroup = new WorkingFolderGroup();
        this._onDidChangeResources.fire();
    }
    whenIdle() {
        return __awaiter(this, void 0, void 0, function* () {
            while (!this.operations.isIdle()) {
                yield util_1.eventToPromise(this.onDidRunOperation);
            }
        });
    }
    /**
     * Returns promise which resolves when there is no `.hg/index.lock` file,
     * or when it has attempted way too many times. Back off mechanism.
     */
    whenUnlocked() {
        return __awaiter(this, void 0, void 0, function* () {
            let millis = 100;
            let retries = 0;
            while (retries < 10 && (yield exists(path.join(this.repository.root, '.hg', 'index.lock')))) {
                retries += 1;
                millis *= 1.4;
                yield timeout(millis);
            }
        });
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state !== State.NotAnHgRepository) {
                return;
            }
            yield this._hg.init(this.workspaceRootPath);
            yield this.status();
        });
    }
    status() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Status);
        });
    }
    add(...resources) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Add, () => this.repository.add(resources.map(r => r.resourceUri.fsPath)));
        });
    }
    stage(uri, contents) {
        return __awaiter(this, void 0, void 0, function* () {
            const relativePath = path.relative(this.repository.root, uri.fsPath).replace(/\\/g, '/');
            yield this.run(Operation.Stage, () => this.repository.stage(relativePath, contents));
        });
    }
    revertFiles(...resources) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.RevertFiles, () => this.repository.revertFiles('HEAD', resources.map(r => r.resourceUri.fsPath)));
        });
    }
    commit(message, opts = Object.create(null)) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Commit, () => __awaiter(this, void 0, void 0, function* () {
                if (opts.all) {
                    yield this.repository.add([]);
                }
                yield this.repository.commit(message, opts);
            }));
        });
    }
    clean(...resources) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Clean, () => __awaiter(this, void 0, void 0, function* () {
                const toClean = [];
                const toCheckout = [];
                resources.forEach(r => {
                    switch (r.type) {
                        case Status.UNTRACKED:
                        case Status.IGNORED:
                            toClean.push(r.resourceUri.fsPath);
                            break;
                        default:
                            toCheckout.push(r.resourceUri.fsPath);
                            break;
                    }
                });
                const promises = [];
                if (toClean.length > 0) {
                    promises.push(this.repository.clean(toClean));
                }
                if (toCheckout.length > 0) {
                    promises.push(this.repository.checkout('', toCheckout));
                }
                yield Promise.all(promises);
            }));
        });
    }
    branch(name) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Branch, () => this.repository.branch(name, true));
        });
    }
    checkout(treeish) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Checkout, () => this.repository.checkout(treeish, []));
        });
    }
    getCommit(ref) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.repository.getCommit(ref);
        });
    }
    reset(treeish, hard) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Reset, () => this.repository.reset(treeish, hard));
        });
    }
    fetch() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Fetch, () => this.repository.fetch());
        });
    }
    pull(rebase) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Pull, () => this.repository.pull(rebase));
        });
    }
    push(remote, name, options) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Push, () => this.repository.push(remote, name, options));
        });
    }
    sync() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(Operation.Sync, () => __awaiter(this, void 0, void 0, function* () {
                yield this.repository.pull();
                const shouldPush = this.workingDirectoryParent && this.workingDirectoryParent.ahead ? this.workingDirectoryParent.ahead > 0 : true;
                if (shouldPush) {
                    yield this.repository.push();
                }
            }));
        });
    }
    show(ref, uri) {
        return __awaiter(this, void 0, void 0, function* () {
            // TODO@Joao: should we make this a general concept?
            yield this.whenIdle();
            return yield this.run(Operation.Show, () => __awaiter(this, void 0, void 0, function* () {
                const relativePath = path.relative(this.repository.root, uri.fsPath).replace(/\\/g, '/');
                const result = yield this.repository.hg.exec(this.repository.root, ['show', `${ref}:${relativePath}`]);
                if (result.exitCode !== 0) {
                    throw new hg_1.HgError({
                        message: localize('cantshow', "Could not show object"),
                        exitCode: result.exitCode
                    });
                }
                return result.stdout;
            }));
        });
    }
    getCommitTemplate() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.run(Operation.GetCommitTemplate, () => __awaiter(this, void 0, void 0, function* () { return this.repository.getCommitTemplate(); }));
        });
    }
    run(operation, runOperation = () => Promise.resolve(null)) {
        return __awaiter(this, void 0, void 0, function* () {
            return vscode_1.window.withScmProgress(() => __awaiter(this, void 0, void 0, function* () {
                this._operations = this._operations.start(operation);
                this._onRunOperation.fire(operation);
                try {
                    yield this.assertIdleState();
                    yield this.whenUnlocked();
                    const result = yield runOperation();
                    if (!isReadOnly(operation)) {
                        yield this.refresh();
                    }
                    return result;
                }
                catch (err) {
                    if (err.hgErrorCode === hg_1.HgErrorCodes.NoRespositoryFound) {
                        this.repositoryDisposable.dispose();
                        const disposables = [];
                        this.onWorkspaceChange(this.onFSChange, this, disposables);
                        this.repositoryDisposable = util_1.combinedDisposable(disposables);
                        this.state = State.NotAnHgRepository;
                    }
                    throw err;
                }
                finally {
                    this._operations = this._operations.end(operation);
                    this._onDidRunOperation.fire(operation);
                }
            }));
        });
    }
    /* We use the native Node `watch` for faster, non debounced events.
     * That way we hopefully get the events during the operations we're
     * performing, thus sparing useless `hg status` calls to refresh
     * the model's state.
     */
    assertIdleState() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.state === State.Idle) {
                return;
            }
            this.repositoryDisposable.dispose();
            const disposables = [];
            const repositoryRoot = yield this._hg.getRepositoryRoot(this.workspaceRootPath);
            this.repository = this._hg.open(repositoryRoot);
            const dotHgPath = path.join(repositoryRoot, '.hg');
            const { event: onRawHgChange, disposable: watcher } = watch_1.watch(dotHgPath);
            disposables.push(watcher);
            const onHgChange = util_1.mapEvent(onRawHgChange, ({ filename }) => vscode_1.Uri.file(path.join(dotHgPath, filename)));
            const onRelevantHgChange = util_1.filterEvent(onHgChange, uri => !/\/\.hg\/index\.lock$/.test(uri.fsPath));
            onRelevantHgChange(this.onFSChange, this, disposables);
            onRelevantHgChange(this._onDidChangeRepository.fire, this._onDidChangeRepository, disposables);
            const onNonHgChange = util_1.filterEvent(this.onWorkspaceChange, uri => !/\/\.hg\//.test(uri.fsPath));
            onNonHgChange(this.onFSChange, this, disposables);
            this.repositoryDisposable = util_1.combinedDisposable(disposables);
            this.state = State.Idle;
        });
    }
    refresh() {
        return __awaiter(this, void 0, void 0, function* () {
            const status = yield this.repository.getStatus();
            let branch;
            try {
                branch = yield this.repository.getParent();
            }
            catch (err) {
                // noop
            }
            this._workingDirParent = branch;
            this._refs = yield this.repository.getRefs();
            ;
            const workingTree = [];
            const merge = [];
            status.forEach(raw => {
                const uri = vscode_1.Uri.file(path.join(this.repository.root, raw.path));
                const renameUri = raw.rename ? vscode_1.Uri.file(path.join(this.repository.root, raw.rename)) : undefined;
                switch (raw.status) {
                    case '?': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.UNTRACKED));
                    case '!': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.MISSING));
                    case 'M': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.MODIFIED));
                    case 'A': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.ADDED));
                    case 'R': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.DELETED));
                    case 'C': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.CONFLICT));
                    case 'I': return workingTree.push(new Resource(this.workingTreeGroup, uri, Status.IGNORED));
                }
                // switch (raw.y) {
                // 	case 'M': workingTree.push(new Resource(this.workingTreeGroup, uri, Status.MODIFIED, renameUri)); break;
                // 	case 'D': workingTree.push(new Resource(this.workingTreeGroup, uri, Status.DELETED, renameUri)); break;
                // }
            });
            this._mergeGroup = new MergeGroup(merge);
            this._workingTreeGroup = new WorkingFolderGroup(workingTree);
            this._onDidChangeResources.fire();
        });
    }
    onFSChange(uri) {
        const config = vscode_1.workspace.getConfiguration('hg');
        const autorefresh = config.get('autorefresh');
        if (!autorefresh) {
            return;
        }
        if (!this.operations.isIdle()) {
            return;
        }
        this.eventuallyUpdateWhenIdleAndWait();
    }
    eventuallyUpdateWhenIdleAndWait() {
        this.updateWhenIdleAndWait();
    }
    updateWhenIdleAndWait() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.whenIdle();
            yield this.status();
            yield timeout(5000);
        });
    }
    dispose() {
        this.repositoryDisposable.dispose();
        this.disposables = util_1.dispose(this.disposables);
    }
}
__decorate([
    decorators_1.memoize
], Model.prototype, "onDidChange", null);
__decorate([
    decorators_1.memoize
], Model.prototype, "onDidChangeOperations", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "init", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "status", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "add", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "stage", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "revertFiles", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "commit", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "clean", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "branch", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "checkout", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "getCommit", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "reset", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "fetch", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "pull", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "push", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "sync", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "refresh", null);
__decorate([
    decorators_1.debounce(1000)
], Model.prototype, "eventuallyUpdateWhenIdleAndWait", null);
__decorate([
    decorators_1.throttle
], Model.prototype, "updateWhenIdleAndWait", null);
exports.Model = Model;
//# sourceMappingURL=model.js.map