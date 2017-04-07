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
const model_1 = require("./model");
const path = require("path");
const os = require("os");
const nls = require("vscode-nls");
const localize = nls.loadMessageBundle();
class CheckoutItem {
    constructor(ref) {
        this.ref = ref;
    }
    get shortCommit() { return (this.ref.commit || '').substr(0, 8); }
    get treeish() { return this.ref.name; }
    get label() { return this.ref.name || this.shortCommit; }
    get description() { return this.shortCommit; }
    run(model) {
        return __awaiter(this, void 0, void 0, function* () {
            const ref = this.treeish;
            if (!ref) {
                return;
            }
            yield model.checkout(ref);
        });
    }
}
class CheckoutTagItem extends CheckoutItem {
    get description() {
        return localize('tag at', "Tag at {0}", this.shortCommit);
    }
}
class CheckoutRemoteHeadItem extends CheckoutItem {
    get description() {
        return localize('remote branch at', "Remote branch at {0}", this.shortCommit);
    }
    get treeish() {
        if (!this.ref.name) {
            return;
        }
        const match = /^[^/]+\/(.*)$/.exec(this.ref.name);
        return match ? match[1] : this.ref.name;
    }
}
const Commands = [];
function command(commandId, skipModelCheck = false) {
    return (target, key, descriptor) => {
        if (!(typeof descriptor.value === 'function')) {
            throw new Error('not supported');
        }
        Commands.push({ commandId, key, method: descriptor.value, skipModelCheck });
    };
}
class CommandCenter {
    constructor(hg, model, outputChannel, telemetryReporter) {
        this.hg = hg;
        this.outputChannel = outputChannel;
        this.telemetryReporter = telemetryReporter;
        if (model) {
            this.model = model;
        }
        this.disposables = Commands
            .map(({ commandId, key, method, skipModelCheck }) => {
            const command = this.createCommand(commandId, key, method, skipModelCheck);
            return vscode_1.commands.registerCommand(commandId, command);
        });
    }
    refresh() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.model.status();
        });
    }
    openResource(resource) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this._openResource(resource);
        });
    }
    _openResource(resource) {
        return __awaiter(this, void 0, void 0, function* () {
            const left = this.getLeftResource(resource);
            const right = this.getRightResource(resource);
            const title = this.getTitle(resource);
            if (!right) {
                // TODO
                console.error('oh no');
                return;
            }
            if (!left) {
                return yield vscode_1.commands.executeCommand('vscode.open', right);
            }
            return yield vscode_1.commands.executeCommand('vscode.diff', left, right, title);
        });
    }
    getLeftResource(resource) {
        switch (resource.type) {
            case model_1.Status.INDEX_MODIFIED:
            case model_1.Status.INDEX_RENAMED:
                return resource.original.with({ scheme: 'hg', query: 'HEAD' });
            case model_1.Status.MODIFIED:
                return resource.resourceUri.with({ scheme: 'hg', query: '~' });
        }
    }
    getRightResource(resource) {
        switch (resource.type) {
            case model_1.Status.INDEX_MODIFIED:
            case model_1.Status.INDEX_ADDED:
            case model_1.Status.INDEX_COPIED:
                return resource.resourceUri.with({ scheme: 'hg' });
            case model_1.Status.INDEX_RENAMED:
                return resource.resourceUri.with({ scheme: 'hg' });
            case model_1.Status.INDEX_DELETED:
            case model_1.Status.DELETED:
                return resource.resourceUri.with({ scheme: 'hg', query: 'HEAD' });
            case model_1.Status.MODIFIED:
            case model_1.Status.UNTRACKED:
            case model_1.Status.IGNORED:
                const uriString = resource.resourceUri.toString();
                const [indexStatus] = this.model.indexGroup.resources.filter(r => r.resourceUri.toString() === uriString);
                if (indexStatus && indexStatus.renameResourceUri) {
                    return indexStatus.renameResourceUri;
                }
                return resource.resourceUri;
            case model_1.Status.BOTH_MODIFIED:
                return resource.resourceUri;
        }
    }
    getTitle(resource) {
        const basename = path.basename(resource.resourceUri.fsPath);
        switch (resource.type) {
            case model_1.Status.INDEX_MODIFIED:
            case model_1.Status.INDEX_RENAMED:
                return `${basename} (Index)`;
            case model_1.Status.MODIFIED:
                return `${basename} (Working Tree)`;
        }
        return '';
    }
    clone() {
        return __awaiter(this, void 0, void 0, function* () {
            const url = yield vscode_1.window.showInputBox({
                prompt: localize('repourl', "Repository URL"),
                ignoreFocusOut: true
            });
            if (!url) {
                this.telemetryReporter.sendTelemetryEvent('clone', { outcome: 'no_URL' });
                return;
            }
            const parentPath = yield vscode_1.window.showInputBox({
                prompt: localize('parent', "Parent Directory"),
                value: os.homedir(),
                ignoreFocusOut: true
            });
            if (!parentPath) {
                this.telemetryReporter.sendTelemetryEvent('clone', { outcome: 'no_directory' });
                return;
            }
            const clonePromise = this.hg.clone(url, parentPath);
            vscode_1.window.setStatusBarMessage(localize('cloning', "Cloning hg repository..."), clonePromise);
            try {
                const repositoryPath = yield clonePromise;
                const open = localize('openrepo', "Open Repository");
                const result = yield vscode_1.window.showInformationMessage(localize('proposeopen', "Would you like to open the cloned repository?"), open);
                const openFolder = result === open;
                this.telemetryReporter.sendTelemetryEvent('clone', { outcome: 'success' }, { openFolder: openFolder ? 1 : 0 });
                if (openFolder) {
                    vscode_1.commands.executeCommand('vscode.openFolder', vscode_1.Uri.file(repositoryPath));
                }
            }
            catch (err) {
                if (/already exists and is not an empty directory/.test(err && err.stderr || '')) {
                    this.telemetryReporter.sendTelemetryEvent('clone', { outcome: 'directory_not_empty' });
                }
                else {
                    this.telemetryReporter.sendTelemetryEvent('clone', { outcome: 'error' });
                }
                throw err;
            }
        });
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.model.init();
        });
    }
    openFile(resource) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!resource) {
                return;
            }
            return yield vscode_1.commands.executeCommand('vscode.open', resource.resourceUri);
        });
    }
    openChange(resource) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!resource) {
                return;
            }
            return yield this._openResource(resource);
        });
    }
    openFileFromUri(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            const resource = this.getSCMResource(uri);
            if (!resource) {
                return;
            }
            return yield vscode_1.commands.executeCommand('vscode.open', resource.resourceUri);
        });
    }
    openChangeFromUri(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            const resource = this.getSCMResource(uri);
            if (!resource) {
                return;
            }
            return yield this._openResource(resource);
        });
    }
    stage(...resourceStates) {
        return __awaiter(this, void 0, void 0, function* () {
            if (resourceStates.length === 0) {
                const resource = this.getSCMResource();
                if (!resource) {
                    return;
                }
                resourceStates = [resource];
            }
            const resources = resourceStates
                .filter(s => s instanceof model_1.Resource && (s.resourceGroup instanceof model_1.WorkingTreeGroup || s.resourceGroup instanceof model_1.MergeGroup));
            if (!resources.length) {
                return;
            }
            return yield this.model.add(...resources);
        });
    }
    stageAll() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.model.add();
        });
    }
    unstage(...resourceStates) {
        return __awaiter(this, void 0, void 0, function* () {
            if (resourceStates.length === 0) {
                const resource = this.getSCMResource();
                if (!resource) {
                    return;
                }
                resourceStates = [resource];
            }
            const resources = resourceStates
                .filter(s => s instanceof model_1.Resource && s.resourceGroup instanceof model_1.IndexGroup);
            if (!resources.length) {
                return;
            }
            return yield this.model.revertFiles(...resources);
        });
    }
    unstageAll() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.model.revertFiles();
        });
    }
    clean(...resourceStates) {
        return __awaiter(this, void 0, void 0, function* () {
            if (resourceStates.length === 0) {
                const resource = this.getSCMResource();
                if (!resource) {
                    return;
                }
                resourceStates = [resource];
            }
            const resources = resourceStates
                .filter(s => s instanceof model_1.Resource && s.resourceGroup instanceof model_1.WorkingTreeGroup);
            if (!resources.length) {
                return;
            }
            const message = resources.length === 1
                ? localize('confirm discard', "Are you sure you want to discard changes in {0}?", path.basename(resources[0].resourceUri.fsPath))
                : localize('confirm discard multiple', "Are you sure you want to discard changes in {0} files?", resources.length);
            const yes = localize('discard', "Discard Changes");
            const pick = yield vscode_1.window.showWarningMessage(message, { modal: true }, yes);
            if (pick !== yes) {
                return;
            }
            yield this.model.clean(...resources);
        });
    }
    cleanAll() {
        return __awaiter(this, void 0, void 0, function* () {
            const message = localize('confirm discard all', "Are you sure you want to discard ALL changes?");
            const yes = localize('discard', "Discard Changes");
            const pick = yield vscode_1.window.showWarningMessage(message, { modal: true }, yes);
            if (pick !== yes) {
                return;
            }
            yield this.model.clean(...this.model.workingTreeGroup.resources);
        });
    }
    smartCommit(getCommitMessage, opts) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!opts) {
                opts = { all: this.model.indexGroup.resources.length === 0 };
            }
            if (
            // no changes
            (this.model.indexGroup.resources.length === 0 && this.model.workingTreeGroup.resources.length === 0)
                || (!opts.all && this.model.indexGroup.resources.length === 0)) {
                vscode_1.window.showInformationMessage(localize('no changes', "There are no changes to commit."));
                return false;
            }
            const message = yield getCommitMessage();
            if (!message) {
                // TODO@joao: show modal dialog to confirm empty message commit
                return false;
            }
            yield this.model.commit(message, opts);
            return true;
        });
    }
    commitWithAnyInput(opts) {
        return __awaiter(this, void 0, void 0, function* () {
            const message = vscode_1.scm.inputBox.value;
            const getCommitMessage = () => __awaiter(this, void 0, void 0, function* () {
                if (message) {
                    return message;
                }
                return yield vscode_1.window.showInputBox({
                    placeHolder: localize('commit message', "Commit message"),
                    prompt: localize('provide commit message', "Please provide a commit message"),
                    ignoreFocusOut: true
                });
            });
            const didCommit = yield this.smartCommit(getCommitMessage, opts);
            if (message && didCommit) {
                vscode_1.scm.inputBox.value = yield this.model.getCommitTemplate();
            }
        });
    }
    commit() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.commitWithAnyInput();
        });
    }
    commitWithInput() {
        return __awaiter(this, void 0, void 0, function* () {
            const didCommit = yield this.smartCommit(() => __awaiter(this, void 0, void 0, function* () { return vscode_1.scm.inputBox.value; }));
            if (didCommit) {
                vscode_1.scm.inputBox.value = yield this.model.getCommitTemplate();
            }
        });
    }
    commitStaged() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.commitWithAnyInput({ all: false });
        });
    }
    commitStagedSigned() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.commitWithAnyInput({ all: false, signoff: true });
        });
    }
    commitAll() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.commitWithAnyInput({ all: true });
        });
    }
    commitAllSigned() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.commitWithAnyInput({ all: true, signoff: true });
        });
    }
    undoCommit() {
        return __awaiter(this, void 0, void 0, function* () {
            const HEAD = this.model.HEAD;
            if (!HEAD || !HEAD.commit) {
                return;
            }
            const commit = yield this.model.getCommit('HEAD');
            yield this.model.reset('HEAD~');
            vscode_1.scm.inputBox.value = commit.message;
        });
    }
    checkout() {
        return __awaiter(this, void 0, void 0, function* () {
            const config = vscode_1.workspace.getConfiguration('hg');
            const checkoutType = config.get('checkoutType') || 'all';
            const includeTags = checkoutType === 'all' || checkoutType === 'tags';
            const includeRemotes = checkoutType === 'all' || checkoutType === 'remote';
            const heads = this.model.refs.filter(ref => ref.type === hg_1.RefType.Head)
                .map(ref => new CheckoutItem(ref));
            const tags = (includeTags ? this.model.refs.filter(ref => ref.type === hg_1.RefType.Tag) : [])
                .map(ref => new CheckoutTagItem(ref));
            const remoteHeads = (includeRemotes ? this.model.refs.filter(ref => ref.type === hg_1.RefType.RemoteHead) : [])
                .map(ref => new CheckoutRemoteHeadItem(ref));
            const picks = [...heads, ...tags, ...remoteHeads];
            const placeHolder = 'Select a ref to checkout';
            const choice = yield vscode_1.window.showQuickPick(picks, { placeHolder });
            if (!choice) {
                return;
            }
            yield choice.run(this.model);
        });
    }
    branch() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield vscode_1.window.showInputBox({
                placeHolder: localize('branch name', "Branch name"),
                prompt: localize('provide branch name', "Please provide a branch name"),
                ignoreFocusOut: true
            });
            if (!result) {
                return;
            }
            const name = result.replace(/^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$/g, '-');
            yield this.model.branch(name);
        });
    }
    pull() {
        return __awaiter(this, void 0, void 0, function* () {
            const remotes = this.model.remotes;
            if (remotes.length === 0) {
                vscode_1.window.showWarningMessage(localize('no remotes to pull', "Your repository has no remotes configured to pull from."));
                return;
            }
            yield this.model.pull();
        });
    }
    pullRebase() {
        return __awaiter(this, void 0, void 0, function* () {
            const remotes = this.model.remotes;
            if (remotes.length === 0) {
                vscode_1.window.showWarningMessage(localize('no remotes to pull', "Your repository has no remotes configured to pull from."));
                return;
            }
            yield this.model.pull(true);
        });
    }
    push() {
        return __awaiter(this, void 0, void 0, function* () {
            const remotes = this.model.remotes;
            if (remotes.length === 0) {
                vscode_1.window.showWarningMessage(localize('no remotes to push', "Your repository has no remotes configured to push to."));
                return;
            }
            yield this.model.push();
        });
    }
    pushTo() {
        return __awaiter(this, void 0, void 0, function* () {
            const remotes = this.model.remotes;
            if (remotes.length === 0) {
                vscode_1.window.showWarningMessage(localize('no remotes to push', "Your repository has no remotes configured to push to."));
                return;
            }
            if (!this.model.HEAD || !this.model.HEAD.name) {
                vscode_1.window.showWarningMessage(localize('nobranch', "Please check out a branch to push to a remote."));
                return;
            }
            const branchName = this.model.HEAD.name;
            const picks = remotes.map(r => ({ label: r.name, description: r.url }));
            const placeHolder = localize('pick remote', "Pick a remote to publish the branch '{0}' to:", branchName);
            const pick = yield vscode_1.window.showQuickPick(picks, { placeHolder });
            if (!pick) {
                return;
            }
            this.model.push(pick.label, branchName);
        });
    }
    sync() {
        return __awaiter(this, void 0, void 0, function* () {
            const HEAD = this.model.HEAD;
            if (!HEAD || !HEAD.upstream) {
                return;
            }
            const config = vscode_1.workspace.getConfiguration('hg');
            const shouldPrompt = config.get('confirmSync') === true;
            if (shouldPrompt) {
                const message = localize('sync is unpredictable', "This action will push and pull commits to and from '{0}'.", HEAD.upstream);
                const yes = localize('ok', "OK");
                const neverAgain = localize('never again', "OK, Never Show Again");
                const pick = yield vscode_1.window.showWarningMessage(message, { modal: true }, yes, neverAgain);
                if (pick === neverAgain) {
                    yield config.update('confirmSync', false, true);
                }
                else if (pick !== yes) {
                    return;
                }
            }
            yield this.model.sync();
        });
    }
    publish() {
        return __awaiter(this, void 0, void 0, function* () {
            const remotes = this.model.remotes;
            if (remotes.length === 0) {
                vscode_1.window.showWarningMessage(localize('no remotes to publish', "Your repository has no remotes configured to publish to."));
                return;
            }
            const branchName = this.model.HEAD && this.model.HEAD.name || '';
            const picks = this.model.remotes.map(r => r.name);
            const placeHolder = localize('pick remote', "Pick a remote to publish the branch '{0}' to:", branchName);
            const choice = yield vscode_1.window.showQuickPick(picks, { placeHolder });
            if (!choice) {
                return;
            }
            yield this.model.push(choice, branchName, { setUpstream: true });
        });
    }
    showOutput() {
        this.outputChannel.show();
    }
    createCommand(id, key, method, skipModelCheck) {
        const result = (...args) => {
            if (!skipModelCheck && !this.model) {
                vscode_1.window.showInformationMessage(localize('disabled', "Hg is either disabled or not supported in this workspace"));
                return;
            }
            this.telemetryReporter.sendTelemetryEvent('hg.command', { command: id });
            const result = Promise.resolve(method.apply(this, args));
            return result.catch((err) => __awaiter(this, void 0, void 0, function* () {
                let message;
                switch (err.hgErrorCode) {
                    case 'DirtyWorkTree':
                        message = localize('clean repo', "Please clean your repository working tree before checkout.");
                        break;
                    default:
                        const hint = (err.stderr || err.message || String(err))
                            .replace(/^error: /mi, '')
                            .replace(/^> husky.*$/mi, '')
                            .split(/[\r\n]/)
                            .filter(line => !!line)[0];
                        message = hint
                            ? localize('hg error details', "Hg: {0}", hint)
                            : localize('hg error', "Hg error");
                        break;
                }
                if (!message) {
                    console.error(err);
                    return;
                }
                const outputChannel = this.outputChannel;
                const openOutputChannelChoice = localize('open hg log', "Open Hg Log");
                const choice = yield vscode_1.window.showErrorMessage(message, openOutputChannelChoice);
                if (choice === openOutputChannelChoice) {
                    outputChannel.show();
                }
            }));
        };
        // patch this object, so people can call methods directly
        this[key] = result;
        return result;
    }
    getSCMResource(uri) {
        uri = uri ? uri : vscode_1.window.activeTextEditor && vscode_1.window.activeTextEditor.document.uri;
        if (!uri) {
            return undefined;
        }
        if (uri.scheme === 'hg') {
            uri = uri.with({ scheme: 'file' });
        }
        if (uri.scheme === 'file') {
            const uriString = uri.toString();
            return this.model.workingTreeGroup.resources.filter(r => r.resourceUri.toString() === uriString)[0]
                || this.model.indexGroup.resources.filter(r => r.resourceUri.toString() === uriString)[0];
        }
    }
    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
__decorate([
    command('hg.refresh')
], CommandCenter.prototype, "refresh", null);
__decorate([
    command('hg.openResource')
], CommandCenter.prototype, "openResource", null);
__decorate([
    command('hg.clone', true)
], CommandCenter.prototype, "clone", null);
__decorate([
    command('hg.init')
], CommandCenter.prototype, "init", null);
__decorate([
    command('hg.openFile')
], CommandCenter.prototype, "openFile", null);
__decorate([
    command('hg.openChange')
], CommandCenter.prototype, "openChange", null);
__decorate([
    command('hg.openFileFromUri')
], CommandCenter.prototype, "openFileFromUri", null);
__decorate([
    command('hg.openChangeFromUri')
], CommandCenter.prototype, "openChangeFromUri", null);
__decorate([
    command('hg.stage')
], CommandCenter.prototype, "stage", null);
__decorate([
    command('hg.stageAll')
], CommandCenter.prototype, "stageAll", null);
__decorate([
    command('hg.unstage')
], CommandCenter.prototype, "unstage", null);
__decorate([
    command('hg.unstageAll')
], CommandCenter.prototype, "unstageAll", null);
__decorate([
    command('hg.clean')
], CommandCenter.prototype, "clean", null);
__decorate([
    command('hg.cleanAll')
], CommandCenter.prototype, "cleanAll", null);
__decorate([
    command('hg.commit')
], CommandCenter.prototype, "commit", null);
__decorate([
    command('hg.commitWithInput')
], CommandCenter.prototype, "commitWithInput", null);
__decorate([
    command('hg.commitStaged')
], CommandCenter.prototype, "commitStaged", null);
__decorate([
    command('hg.commitStagedSigned')
], CommandCenter.prototype, "commitStagedSigned", null);
__decorate([
    command('hg.commitAll')
], CommandCenter.prototype, "commitAll", null);
__decorate([
    command('hg.commitAllSigned')
], CommandCenter.prototype, "commitAllSigned", null);
__decorate([
    command('hg.undoCommit')
], CommandCenter.prototype, "undoCommit", null);
__decorate([
    command('hg.checkout')
], CommandCenter.prototype, "checkout", null);
__decorate([
    command('hg.branch')
], CommandCenter.prototype, "branch", null);
__decorate([
    command('hg.pull')
], CommandCenter.prototype, "pull", null);
__decorate([
    command('hg.pullRebase')
], CommandCenter.prototype, "pullRebase", null);
__decorate([
    command('hg.push')
], CommandCenter.prototype, "push", null);
__decorate([
    command('hg.pushTo')
], CommandCenter.prototype, "pushTo", null);
__decorate([
    command('hg.sync')
], CommandCenter.prototype, "sync", null);
__decorate([
    command('hg.publish')
], CommandCenter.prototype, "publish", null);
__decorate([
    command('hg.showOutput')
], CommandCenter.prototype, "showOutput", null);
exports.CommandCenter = CommandCenter;
//# sourceMappingURL=commands.js.map