/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, commands, scm, Disposable, window, workspace, QuickPickItem, OutputChannel, Range, WorkspaceEdit, Position, LineChange, SourceControlResourceState, SourceControl } from "vscode";
import { Ref, RefType, Hg, Commit, HgError, HgErrorCodes, PushOptions, IMergeResult } from "./hg";
import { Model, Resource, Status, CommitOptions, CommitScope, MergeStatus } from "./model";
import * as path from 'path';
import * as os from 'os';
import * as nls from 'vscode-nls';
import { WorkingDirectoryGroup, StagingGroup, MergeGroup, UntrackedGroup, ConflictGroup } from "./resourceGroups";
import { warnOutstandingMerge, warnUnclean, WarnScenario } from "./warnings";
import { humanise } from "./humanise";

const localize = nls.loadMessageBundle();

const SHORT_HASH_LENGTH = 12;

class CommitItem implements QuickPickItem {
	constructor(protected commit: Commit) { }
	get shortHash() { return (this.commit.hash || '').substr(0, SHORT_HASH_LENGTH); }
	get label() { return this.commit.branch; }
	get detail() { return `${this.commit.revision} (${this.shortHash})`; }
	get description() { return this.commit.message; }
}

class MergeCommitItem extends CommitItem {
	constructor(commit: Commit) { super(commit); }
	async run(model): Promise<IMergeResult> {
		return await model.merge(this.commit.hash);
	}
}

class UpdateCommitItem extends CommitItem {
	constructor(commit: Commit, private opts?: { discard: boolean }) {
		super(commit);
	}
	async run(model: Model) {
		await model.update(this.commit.hash, this.opts);
	}
}

class LogEntryItem extends CommitItem {
	get description() {
		return ``;
	}
	get label() { return this.commit.message; }
	get detail() {
		const branch = this.commit.branch === 'default' ? '' : `$(git-branch) ${this.commit.branch}: `;
		return `${branch} #${this.commit.revision} ${this.commit.author} ${this.age}`;
	}
	protected get age(): string {
		return humanise.ageFromNow(this.commit.date);
	}
	async run(model: Model) {
		await model.chooseLogAction(this.commit);
	}

}

class UpdateRefItem implements QuickPickItem {
	protected get shortCommit(): string { return (this.ref.commit || '').substr(0, SHORT_HASH_LENGTH); }
	protected get treeish(): string | undefined { return this.ref.name; }
	protected get icon(): string { return '' }
	get label(): string { return `${this.icon}${this.ref.name || this.shortCommit}`; }
	get description(): string { return this.shortCommit; }

	constructor(protected ref: Ref) { }

	async run(model: Model): Promise<void> {
		const ref = this.treeish;

		if (!ref) {
			return;
		}

		await model.update(ref);
	}
}

class UpdateTagItem extends UpdateRefItem {
	protected get icon(): string { return '$(tag) ' }
	get description(): string {
		return localize('tag at', "Tag at {0}", this.shortCommit);
	}
}

interface Command {
	commandId: string;
	key: string;
	method: Function;
	skipModelCheck: boolean;
}

const Commands: Command[] = [];

function command(commandId: string, skipModelCheck = false): Function {
	return (target: any, key: string, descriptor: any) => {
		if (!(typeof descriptor.value === 'function')) {
			throw new Error('not supported');
		}

		Commands.push({ commandId, key, method: descriptor.value, skipModelCheck });
	};
}

export class CommandCenter {

	private model: Model;
	private disposables: Disposable[];

	constructor(
		private hg: Hg,
		model: Model | undefined,
		private outputChannel: OutputChannel
	) {
		if (model) {
			this.model = model;
		}

		this.disposables = Commands
			.map(({ commandId, key, method, skipModelCheck }) => {
				const command = this.createCommand(commandId, key, method, skipModelCheck);
				return commands.registerCommand(commandId, command);
			});
	}

	// @command('hg.log')
	// async refresh(): Promise<void> {
	// 			return commands.executeCommand('vscode.previewHtml', previewUri, vscode.ViewColumn.Two, 'CSS Property Preview').then((success) => {
	// 	}, (reason) => {
	// 		vscode.window.showErrorMessage(reason);
	// 	});
	// }	

	@command('hg.refresh')
	async refresh(): Promise<void> {
		await this.model.status();
	}

	@command('hg.openResource')
	async openResource(resource: Resource): Promise<void> {
		await this._openResource(resource);
	}

	private async _openResource(resource: Resource): Promise<void> {
		const left = this.getLeftResource(resource);
		const right = this.getRightResource(resource);
		const title = this.getTitle(resource);

		if (!right) {
			// TODO
			console.error('oh no');
			return;
		}

		if (!left) {
			return await commands.executeCommand<void>('vscode.open', right);
		}

		return await commands.executeCommand<void>('vscode.diff', left, right, title);
	}

	private getLeftResource(resource: Resource): Uri | undefined {
		if (resource.mergeStatus === MergeStatus.UNRESOLVED &&
			resource.status !== Status.MISSING &&
			resource.status !== Status.DELETED) {
			return resource.resourceUri.with({ scheme: 'file', path: `${resource.original.path}.orig` });
		}

		switch (resource.status) {
			case Status.MODIFIED:
				return resource.original.with({ scheme: 'hg', query: '.' });

			case Status.RENAMED:
				if (resource.renameResourceUri) {
					return resource.original.with({ scheme: 'hg', query: '.' })
				}
				return undefined;

			case Status.ADDED:
			case Status.IGNORED:
			case Status.DELETED:
			case Status.MISSING:
			case Status.UNTRACKED:
				return undefined;
		}
	}

	private getRightResource(resource: Resource): Uri | undefined {
		switch (resource.status) {
			case Status.DELETED:
				return resource.resourceUri.with({ scheme: 'hg', query: '.' });

			case Status.ADDED:
			case Status.IGNORED:
			case Status.MISSING:
			case Status.MODIFIED:
			case Status.RENAMED:
			case Status.UNTRACKED:
				return resource.resourceUri;
		}
	}

	private getTitle(resource: Resource): string {
		const basename = path.basename(resource.resourceUri.fsPath);
		if (resource.mergeStatus === MergeStatus.UNRESOLVED) {
			return `${basename} (Merge)`
		}

		switch (resource.status) {
			case Status.MODIFIED:
			case Status.ADDED:
				return `${basename} (Working Directory)`;

			case Status.RENAMED:
				return `${basename} (Renamed)`;

			case Status.DELETED:
				return `${basename} (Deleted)`;
		}

		return '';
	}

	@command('hg.clone', true)
	async clone(): Promise<void> {
		const url = await window.showInputBox({
			prompt: localize('repourl', "Repository URL"),
			ignoreFocusOut: true
		});

		if (!url) {
			return;
		}

		const parentPath = await window.showInputBox({
			prompt: localize('parent', "Parent Directory"),
			value: os.homedir(),
			ignoreFocusOut: true
		});

		if (!parentPath) {
			return;
		}

		const clonePromise = this.hg.clone(url, parentPath);
		window.setStatusBarMessage(localize('cloning', "Cloning hg repository..."), clonePromise);

		try {
			const repositoryPath = await clonePromise;

			const open = localize('openrepo', "Open Repository");
			const result = await window.showInformationMessage(localize('proposeopen', "Would you like to open the cloned repository?"), open);

			const openFolder = result === open;
			if (openFolder) {
				commands.executeCommand('vscode.openFolder', Uri.file(repositoryPath));
			}
		}
		catch (err) {
			throw err;
		}
	}

	@command('hg.init')
	async init(): Promise<void> {
		await this.model.init();
	}

	@command('hg.openFile')
	async openFile(resource?: Resource): Promise<void> {
		if (!resource) {
			return;
		}

		return await commands.executeCommand<void>('vscode.open', resource.resourceUri);
	}

	@command('hg.openChange')
	async openChange(resource?: Resource): Promise<void> {
		if (!resource) {
			return;
		}

		return await this._openResource(resource);
	}

	@command('hg.openFileFromUri')
	async openFileFromUri(uri?: Uri): Promise<void> {
		const resource = this.getSCMResource(uri);

		if (!resource) {
			return;
		}

		return await commands.executeCommand<void>('vscode.open', resource.resourceUri);
	}

	@command('hg.openChangeFromUri')
	async openChangeFromUri(uri?: Uri): Promise<void> {
		const resource = this.getSCMResource(uri);

		if (!resource) {
			return;
		}

		return await this._openResource(resource);
	}

	@command('hg.addAll')
	async addAll(): Promise<void> {
		return await this.model.add();
	}

	@command('hg.add')
	async add(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates
			.filter(s => s instanceof Resource && s.resourceGroup instanceof UntrackedGroup) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.add(...resources);
	}

	@command('hg.forget')
	async forget(...resourceStates: SourceControlResourceState[]): Promise<void> {
		const resources = resourceStates
			.filter(s => s instanceof Resource && s.resourceGroup instanceof WorkingDirectoryGroup) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.forget(...resources);
	}

	@command('hg.stage')
	async stage(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates
			.filter(s => s instanceof Resource && (s.resourceGroup instanceof WorkingDirectoryGroup || s.resourceGroup instanceof MergeGroup)) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.stage(...resources);
	}

	@command('hg.stageAll')
	async stageAll(): Promise<void> {
		return await this.model.stage();
	}

	@command('hg.resolve')
	async resolve(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			return;
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof ConflictGroup &&
			s.mergeStatus === MergeStatus.UNRESOLVED) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.resolve(...resources);
	}

	@command('hg.unresolve')
	async unresolve(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			return;
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof MergeGroup &&
			s.mergeStatus === MergeStatus.RESOLVED) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.unresolve(...resources);
	}

	@command('hg.unstage')
	async unstage(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof StagingGroup) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.unstage(...resources);
	}

	@command('hg.unstageAll')
	async unstageAll(): Promise<void> {
		return await this.model.unstage();
	}

	@command('hg.clean')
	async clean(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.isDirtyStatus) as Resource[];

		if (!resources.length) {
			return;
		}

		const resourcesNeedingConfirmation = resources.filter(s => s.status !== Status.ADDED);
		if (resourcesNeedingConfirmation.length > 0) {
			const message = resourcesNeedingConfirmation.length === 1
				? localize('confirm discard', "Are you sure you want to discard changes in {0}?", path.basename(resourcesNeedingConfirmation[0].resourceUri.fsPath))
				: localize('confirm discard multiple', "Are you sure you want to discard changes in {0} files?", resourcesNeedingConfirmation.length);

			const yes = localize('discard', "Discard Changes");
			const pick = await window.showWarningMessage(message, { modal: true }, yes);

			if (pick !== yes) {
				return;
			}
		}

		await this.model.cleanOrUpdate(...resources);
	}

	@command('hg.cleanAll')
	async cleanAll(): Promise<void> {
		const message = localize('confirm discard all', "Are you sure you want to discard ALL changes?");
		const yes = localize('discard', "Discard Changes");
		const pick = await window.showWarningMessage(message, { modal: true }, yes);

		if (pick !== yes) {
			return;
		}

		const resources = this.model.workingDirectoryGroup.resources;
		await this.model.cleanOrUpdate(...resources);
	}

	private async smartCommit(getCommitMessage: () => Promise<string>, opts?: CommitOptions): Promise<boolean> {
		// validate no conflicts
		const numConflictResources = this.model.conflictGroup.resources.length;
		if (numConflictResources > 0) {
			window.showWarningMessage(localize('conflicts', "Resolve conflicts before committing."));
			return false;
		}

		const isMergeCommit = this.model.repoStatus && this.model.repoStatus.isMerge;
		if (isMergeCommit) {
			// merge-commit
			opts = { scope: CommitScope.ALL };
		}
		else {
			// validate non-merge commit
			const numWorkingResources = this.model.workingDirectoryGroup.resources.length;
			const numStagingResources = this.model.stagingGroup.resources.length;
			if (!opts || opts.scope === undefined) {
				if (numStagingResources > 0) {
					opts = {
						scope: CommitScope.STAGED_CHANGES
					};
				}
				else {
					opts = {
						scope: CommitScope.CHANGES
					};
				}
			}

			if ((numWorkingResources === 0 && numStagingResources === 0) // no changes
				|| (opts && opts.scope === CommitScope.STAGED_CHANGES && numStagingResources === 0) // no staged changes
				|| (opts && opts.scope === CommitScope.CHANGES && numWorkingResources === 0) // no working directory changes
			) {
				window.showInformationMessage(localize('no changes', "There are no changes to commit."));
				return false;
			}
		}

		const message = await getCommitMessage();

		if (!message) {
			// TODO@joao: show modal dialog to confirm empty message commit
			return false;
		}

		await this.model.commit(message, opts);

		return true;
	}

	private async commitWithAnyInput(opts?: CommitOptions): Promise<void> {
		const message = scm.inputBox.value;
		const getCommitMessage = async () => {
			if (message) {
				return message;
			}

			return await window.showInputBox({
				placeHolder: localize('commit message', "Commit message"),
				prompt: localize('provide commit message', "Please provide a commit message"),
				ignoreFocusOut: true
			});
		};

		const didCommit = await this.smartCommit(getCommitMessage, opts);

		if (message && didCommit) {
			scm.inputBox.value = ""; //await this.model.getCommitTemplate();
		}
	}

	@command('hg.commit')
	async commit(): Promise<void> {
		await this.commitWithAnyInput();
	}

	@command('hg.commitWithInput')
	async commitWithInput(): Promise<void> {
		const didCommit = await this.smartCommit(async () => scm.inputBox.value);

		if (didCommit) {
			scm.inputBox.value = ""; //await this.model.getCommitTemplate();
		}
	}

	@command('hg.commitStaged')
	async commitStaged(): Promise<void> {
		await this.commitWithAnyInput({ scope: CommitScope.STAGED_CHANGES });
	}

	@command('hg.commitAll')
	async commitAll(): Promise<void> {
		await this.commitWithAnyInput({ scope: CommitScope.ALL_WITH_ADD_REMOVE });
	}

	private focusScm() {
		commands.executeCommand("workbench.view.scm");
	}

	@command('hg.undoRollback')
	async undoRollback(): Promise<void> {
		try {
			// dry-run
			const { revision, kind, commitMessage } = await this.model.rollback(true);

			// prompt
			const rollback = "Rollback";
			const message = localize('rollback', `Rollback to revision {0}? (undo {1})`, revision, kind);
			const choice = await window.showInformationMessage(message, { modal: true }, rollback);

			if (choice === rollback) {
				await this.model.rollback();

				if (kind === "commit") {
					scm.inputBox.value = commitMessage;
					this.focusScm();
				}
			}
		}
		catch (e) {
			if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.NoRollbackInformationAvailable) {
				await window.showWarningMessage(localize('no rollback', "Nothing to rollback to."));
			}
		}
	}


	@command('hg.update')
	async update(): Promise<void> {
		if (await warnOutstandingMerge(this.model, WarnScenario.Update) ||
			await warnUnclean(this.model, WarnScenario.Update)) {
			this.focusScm();
			return;
		}

		const { currentBranch } = this.model;
		const config = workspace.getConfiguration('hg');
		const checkoutType = config.get<string>('updateType') || 'all';
		const includeTags = checkoutType === 'all' || checkoutType === 'tags';

		let refs = await this.model.getRefs();
		const branches = refs.filter(ref => ref.type === RefType.Branch)
			.map(ref => new UpdateRefItem(ref));

		const tags = (includeTags ? refs.filter(ref => ref.type === RefType.Tag) : [])
			.map(ref => new UpdateTagItem(ref));

		const picks = [...branches, ...tags];
		const placeHolder = 'Select a branch/tag to update to:';
		const choice = await window.showQuickPick<UpdateRefItem>(picks, { placeHolder });

		if (!choice) {
			return;
		}

		await choice.run(this.model);
	}

	@command('hg.branch')
	async branch(): Promise<void> {
		const result = await window.showInputBox({
			placeHolder: localize('branch name', "Branch name"),
			prompt: localize('provide branch name', "Please provide a branch name"),
			ignoreFocusOut: true
		});

		if (!result) {
			return;
		}

		const name = result.replace(/^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$/g, '-');
		try {
			await this.model.branch(name);
		}
		catch (e) {
			if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.BranchAlreadyExists) {
				const updateTo = "Update";
				const reopen = "Re-open";
				const message = localize('branch already exists', `Branch '{0}' already exists. Update or Re-open?`, name);
				const choice = await window.showWarningMessage(message, { modal: true }, updateTo, reopen);
				if (choice === reopen) {
					await this.model.branch(name, { allowBranchReuse: true });
				}
				else if (choice === updateTo) {
					await this.model.update(name);
				}
			}
		}
	}

	@command('hg.pull')
	async pull(): Promise<void> {
		const paths = this.model.paths;

		if (paths.length === 0) {
			window.showWarningMessage(localize('no paths to pull', "Your repository has no paths configured to pull from."));
			return;
		}

		await this.model.pull();
	}

	private createPushOptions(): PushOptions | undefined {
		const config = workspace.getConfiguration('hg');
		const allowPushNewBranches = config.get<boolean>('allowPushNewBranches') || false;
		return allowPushNewBranches ?
			{ allowPushNewBranches: true } :
			undefined;
	}

	@command('hg.mergeWithLocal')
	async mergeWithLocal() {
		if (await warnOutstandingMerge(this.model, WarnScenario.Merge) ||
			await warnUnclean(this.model, WarnScenario.Merge)) {
			this.focusScm();
			return;
		}

		const otherHeads = await this.model.getHeads({ excludeSelf: true });
		const heads = otherHeads.map(head => new MergeCommitItem(head));
		const placeHolder = localize('choose head', `Choose head to merge into working directory:`);
		const choice = await window.showQuickPick(heads, { placeHolder });
		if (!choice) {
			return;
		}
		const mergeResult = await choice.run(this.model);
		this.afterMerge(mergeResult);
		return;
	}

	@command('hg.mergeHeads')
	async mergeHeads() {
		if (await warnOutstandingMerge(this.model, WarnScenario.Merge) ||
			await warnUnclean(this.model, WarnScenario.Merge)) {
			this.focusScm();
			return;
		}

		const { currentBranch } = this.model;
		if (!currentBranch) {
			return;
		}

		const otherBranchHeads = await this.model.getHeads({ branch: currentBranch.name, excludeSelf: true });
		if (otherBranchHeads.length === 0) {
			// 1 head
			window.showWarningMessage(localize('only one head', "There is only 1 head for branch '{0}'. Nothing to merge.", currentBranch.name));
			return;
		}
		else if (otherBranchHeads.length === 1) {
			// 2 heads
			const [otherHead] = otherBranchHeads;
			const mergeResult = await this.model.merge(otherHead.hash);
			this.afterMerge(mergeResult);
			return;
		}
		else {
			// 3+ heads
			const heads = otherBranchHeads.map(head => new MergeCommitItem(head));
			const placeHolder = localize('choose branch head', "Branch {0} has {1} heads. Choose which to merge:", currentBranch.name, otherBranchHeads.length + 1);
			const choice = await window.showQuickPick(heads, { placeHolder });
			if (!choice) {
				return;
			}
			const mergeResult = await choice.run(this.model);
			this.afterMerge(mergeResult);
			return;
		}
	}

	private async afterMerge({ unresolvedCount }: IMergeResult) {
		if (unresolvedCount > 0) {
			const fileOrFiles = unresolvedCount === 1 ? localize('file', 'file') : localize('files', 'files');
			window.showWarningMessage(localize('unresolved files', "Merge leaves {0} {1} unresolved.", unresolvedCount, fileOrFiles));
		}
	}

	@command('hg.push')
	async push(): Promise<void> {
		const paths = this.model.paths;

		if (paths.length === 0) {
			window.showWarningMessage(localize('no paths to push', "Your repository has no paths configured to push to."));
			return;
		}

		// check for branches with 2+ heads		
		const multiHeadBranchNames = await this.model.getBranchNamesWithMultipleHeads();
		if (multiHeadBranchNames.length === 1) {
			const [branch] = multiHeadBranchNames;
			window.showWarningMessage(localize('multi head branch', `Branch '{0}' has multiple heads. Merge required before pushing.`, branch));
			return;
		}
		else if (multiHeadBranchNames.length > 1) {
			window.showWarningMessage(localize('multi head branches', `These branches have multiple heads: {0}. Merges required before pushing.`, multiHeadBranchNames.join(",")));
			return;
		}

		await this.model.push(undefined, this.createPushOptions());
	}

	@command('hg.pushTo')
	async pushTo(): Promise<void> {
		const paths = this.model.paths;

		if (paths.length === 0) {
			window.showWarningMessage(localize('no remotes to push', "Your repository has no paths configured to push to."));
			return;
		}

		const picks = paths.map(p => ({ label: p.name, description: p.url }));
		const placeHolder = localize('pick remote', "Pick a remote to push to:");
		const pick = await window.showQuickPick(picks, { placeHolder });

		if (!pick) {
			return;
		}

		this.model.push(pick.label, this.createPushOptions());
	}

	@command('hg.showOutput')
	showOutput(): void {
		this.outputChannel.show();
	}

	@command('hg.fileLog')
	async fileLog(uri?: Uri) {
		if (!uri) {
			if (window.activeTextEditor) {
				uri = window.activeTextEditor.document.uri;
			}

			if (!uri || uri.scheme !== 'file') {
				return;
			}
		}

		const logEntries = await this.model.getLogEntries(uri);
		const quickPickItems = logEntries.map(le => new LogEntryItem(le));
		const choice = await window.showQuickPick<LogEntryItem>(quickPickItems, {
			matchOnDescription: true,
			matchOnDetail: true,
			placeHolder: localize('file history', "File History"),
			onDidSelectItem: (x) => console.log(x)
		});

		if (choice) {
			choice.run(this.model);
		}
	}

	private createCommand(id: string, key: string, method: Function, skipModelCheck: boolean): (...args: any[]) => any {
		const result = (...args) => {
			if (!skipModelCheck && !this.model) {
				window.showInformationMessage(localize('disabled', "Hg is either disabled or not supported in this workspace"));
				return;
			}

			const result = Promise.resolve(method.apply(this, args));

			return result.catch(async err => {
				let message: string;

				switch (err.hgErrorCode) {
					case 'DirtyWorkingDirectory':
						message = localize('clean repo', "Please clean your repository working directory before updating.");
						break;

					default:
						const hint = (err.stderr || err.message || String(err))
							.replace(/^abort: /mi, '')
							.replace(/^> husky.*$/mi, '')
							.split(/[\r\n]/)
							.filter(line => !!line)
						[0];

						message = hint
							? localize('hg error details', "Hg: {0}", hint)
							: localize('hg error', "Hg error");

						break;
				}

				if (!message) {
					console.error(err);
					return;
				}

				const openOutputChannelChoice = localize('open hg log', "Open Hg Log");
				const choice = await window.showErrorMessage(message, openOutputChannelChoice);

				if (choice === openOutputChannelChoice) {
					this.outputChannel.show();
				}
				else {
					this.focusScm();
				}
			});
		};

		// patch this object, so people can call methods directly
		this[key] = result;

		return result;
	}

	private getSCMResource(uri?: Uri): Resource | undefined {
		uri = uri ? uri : window.activeTextEditor && window.activeTextEditor.document.uri;

		if (!uri) {
			return undefined;
		}

		if (uri.scheme === 'hg') {
			uri = uri.with({ scheme: 'file' });
		}

		if (uri.scheme === 'file') {
			const uriString = uri.toString();

			return this.model.workingDirectoryGroup.getResource(uri)
				|| this.model.stagingGroup.getResource(uri)
				|| this.model.untrackedGroup.getResource(uri)
				|| this.model.mergeGroup.getResource(uri);
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}