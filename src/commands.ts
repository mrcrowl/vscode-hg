/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    Uri,
    commands,
    scm,
    Disposable,
    window,
    workspace,
    OutputChannel,
    Range,
    WorkspaceEdit,
    Position,
    SourceControlResourceState,
    SourceControlResourceGroup,
    TextDocumentShowOptions,
    ViewColumn,
    TextEditor,
} from "vscode";
import {
    RefType,
    ShelveOptions,
    Hg,
    Commit,
    HgError,
    HgErrorCodes,
    IFileStatus,
    CommitDetails,
    Revision,
    Bookmark,
} from "./hg";
import { Model } from "./model";
import {
    Resource,
    Status,
    CommitOptions,
    CommitScope,
    MergeStatus,
    LogEntriesOptions,
    Repository,
} from "./repository";
import { FileAnnotationController } from "./annotations";
import * as path from "path";
import * as os from "os";
import {
    WorkingDirectoryGroup,
    StagingGroup,
    MergeGroup,
    UntrackedGroup,
    ConflictGroup,
    isResourceGroup,
} from "./resourceGroups";
import {
    interaction,
    BranchExistsAction,
    WarnScenario,
    CommitSources,
    DefaultRepoNotConfiguredAction,
    LogMenuAPI,
} from "./interaction";
import { humanise } from "./humanise";
import { partition } from "./util";
import * as nls from "vscode-nls";
import typedConfig from "./config";
import { toHgUri } from "./uri";
import { LineChange, applyLineChanges } from "./diff";

const localize = nls.loadMessageBundle();

interface Command {
    commandId: string;
    key: string;
    method: Function;
    options: CommandOptions;
}

interface CommandOptions {
    repository?: boolean;
    diff?: boolean;
}

const Commands: Command[] = [];

function command(commandId: string, options: CommandOptions = {}): Function {
    return (target: any, key: string, descriptor: any) => {
        if (!(typeof descriptor.value === "function")) {
            throw new Error("not supported");
        }

        Commands.push({ commandId, key, method: descriptor.value, options });
    };
}

export class CommandCenter {
    private model: Model;
    private disposables: Disposable[];
    private fileAnnotationsController: FileAnnotationController;

    constructor(
        private hg: Hg,
        model: Model,
        private outputChannel: OutputChannel
    ) {
        this.model = model;

        this.disposables = Commands.map(
            ({ commandId, key, method, options }) => {
                const command = this.createCommand(
                    commandId,
                    key,
                    method,
                    options
                );

                // if (options.diff) {
                // 	return commands.registerDiffInformationCommand(commandId, command);
                // } else {
                return commands.registerCommand(commandId, command);
                // }
            }
        );
        this.fileAnnotationsController = new FileAnnotationController(
            hg,
            model
        );
        this.disposables.push(this.fileAnnotationsController);
    }

    @command("hg.refresh", { repository: true })
    async refresh(repository: Repository): Promise<void> {
        await repository.status();
    }

    @command("hg.openResource")
    async openResource(resource: Resource): Promise<void> {
        await this._openResource(resource, undefined, true, false);
    }

    private async _openResource(
        resource: Resource,
        preview?: boolean,
        preserveFocus?: boolean,
        preserveSelection?: boolean
    ): Promise<void> {
        const left = this.getLeftResource(resource);
        const right = this.getRightResource(resource);
        const title = this.getTitle(resource);

        if (!right) {
            // TODO
            console.error("oh no");
            return;
        }

        const opts: TextDocumentShowOptions = {
            preserveFocus,
            preview,
            viewColumn: ViewColumn.Active,
        };

        const activeTextEditor = window.activeTextEditor;

        // Check if active text editor has same path as other editor. we cannot compare via
        // URI.toString() here because the schemas can be different. Instead we just go by path.
        if (
            preserveSelection &&
            activeTextEditor &&
            activeTextEditor.document.uri.path === right.path
        ) {
            opts.selection = activeTextEditor.selection;
        }

        if (!left) {
            await commands.executeCommand("vscode.open", right, opts, title);
        } else {
            await commands.executeCommand<void>(
                "vscode.diff",
                left,
                right,
                title,
                opts
            );
        }
    }

    private getLeftResource(resource: Resource): Uri | undefined {
        switch (resource.status) {
            case Status.MODIFIED:
                return toHgUri(resource.original, ".");

            case Status.RENAMED:
                if (resource.renameResourceUri) {
                    return toHgUri(resource.original, ".");
                }
                return undefined;

            case Status.ADDED:
            case Status.IGNORED:
            case Status.DELETED:
            case Status.MISSING:
            case Status.UNTRACKED:
            case Status.CLEAN:
                return undefined;
        }
    }

    private getRightResource(resource: Resource): Uri | undefined {
        if (
            resource.mergeStatus === MergeStatus.UNRESOLVED &&
            resource.status !== Status.MISSING &&
            resource.status !== Status.DELETED
        ) {
            return toHgUri(resource.resourceUri, "p2()");
        }

        switch (resource.status) {
            case Status.DELETED:
                return toHgUri(resource.resourceUri, ".");

            case Status.ADDED:
            case Status.IGNORED:
            case Status.MODIFIED:
            case Status.RENAMED:
            case Status.UNTRACKED:
            case Status.CLEAN:
                return resource.resourceUri;

            case Status.MISSING:
                return undefined;
        }
    }

    private getTitle(resource: Resource): string {
        const basename = path.basename(resource.resourceUri.fsPath);
        if (
            resource.mergeStatus === MergeStatus.UNRESOLVED &&
            resource.status !== Status.MISSING &&
            resource.status !== Status.DELETED
        ) {
            return `${basename} (local <-> other)`;
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

        return "";
    }

    @command("hg.clone")
    async clone(): Promise<void> {
        const url = await interaction.inputRepoUrl();
        if (!url) {
            return;
        }

        const parentPath = await interaction.inputCloneParentPath();
        if (!parentPath) {
            return;
        }

        const clonePromise = this.hg.clone(url, parentPath);
        interaction.statusCloning(clonePromise);

        const repositoryPath = await clonePromise;
        const openClonedRepo = await interaction.promptOpenClonedRepo();
        if (openClonedRepo) {
            commands.executeCommand(
                "vscode.openFolder",
                Uri.file(repositoryPath)
            );
        }
    }

    @command("hg.init")
    async init(): Promise<void> {
        const homeUri = Uri.file(os.homedir());
        const defaultUri =
            workspace.workspaceFolders && workspace.workspaceFolders.length > 0
                ? Uri.file(workspace.workspaceFolders[0].uri.fsPath)
                : homeUri;

        const result = await window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri,
            openLabel: localize("init repo", "Initialize Repository"),
        });

        if (!result || result.length === 0) {
            return;
        }

        const uri = result[0];

        if (homeUri.toString().startsWith(uri.toString())) {
            const yes = localize("create repo", "Initialize Repository");
            const answer = await window.showWarningMessage(
                localize(
                    "are you sure",
                    "This will create an Hg repository in '{0}'. Are you sure you want to continue?",
                    uri.fsPath
                ),
                yes
            );

            if (answer !== yes) {
                return;
            }
        }

        const path = uri.fsPath;
        await this.hg.init(path);
        await this.model.tryOpenRepository(path);

        // await this.model.init();
    }

    @command("hg.close", { repository: true })
    async close(repository: Repository): Promise<void> {
        this.model.close(repository);
    }

    @command("hg.openhgrc", { repository: true })
    async openhgrc(repository: Repository): Promise<void> {
        let hgrcPath = await repository.hgrcPathIfExists();
        if (!hgrcPath) {
            hgrcPath = await repository.createHgrc();
        }

        const hgrcUri = Uri.file(hgrcPath);
        commands.executeCommand("vscode.open", hgrcUri);
    }

    @command("hg.openFiles")
    openFiles(
        ...resources: (Resource | SourceControlResourceGroup)[]
    ): Promise<void> {
        if (resources.length === 1) {
            // a resource group proxy object?
            const [resourceGroup] = resources;
            if (isResourceGroup(resourceGroup)) {
                const resources = resourceGroup.resourceStates as Resource[];
                return this.openFile(...resources);
            }
        }

        return this.openFile(...(<Resource[]>resources));
    }

    @command("hg.openFile")
    async openFile(
        arg?: Resource | Uri,
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        const preserveFocus = arg instanceof Resource;

        let uris: Uri[] | undefined;

        if (arg instanceof Uri) {
            uris = [arg];
        } else {
            let resource = arg;

            if (!(resource instanceof Resource)) {
                // can happen when called from a keybinding
                resource = this.getSCMResource();
            }

            if (resource) {
                uris = ([resource, ...resourceStates] as Resource[]).map(
                    (r) => r.resourceUri
                );
            } else if (window.activeTextEditor) {
                uris = [window.activeTextEditor.document.uri];
            }
        }

        if (!uris) {
            return;
        }

        const activeTextEditor = window.activeTextEditor;

        for (const uri of uris) {
            const opts: TextDocumentShowOptions = {
                preserveFocus,
                preview: false,
                viewColumn: ViewColumn.Active,
            };

            let document;
            try {
                document = await workspace.openTextDocument(uri);
            } catch (error) {
                await commands.executeCommand<void>("vscode.open", uri, opts);
                continue;
            }

            // Check if active text editor has same path as other editor. we cannot compare via
            // URI.toString() here because the schemas can be different. Instead we just go by path.
            if (
                activeTextEditor &&
                activeTextEditor.document.uri.path === uri.path
            ) {
                // preserve not only selection but also visible range
                opts.selection = activeTextEditor.selection;
                const previousVisibleRanges = activeTextEditor.visibleRanges;
                const editor = await window.showTextDocument(document, opts);
                editor.revealRange(previousVisibleRanges[0]);
            } else {
                await window.showTextDocument(document, opts);
            }
        }
    }

    @command("hg.openChange")
    async openChange(...resources: Resource[]): Promise<void> {
        if (!resources) {
            return;
        }

        if (resources.length === 1) {
            // a resource group proxy object?
            const [resourceGroup] = resources;
            if (isResourceGroup(resourceGroup)) {
                const resources = resourceGroup.resourceStates as Resource[];
                return this.openChange(...resources);
            }
        }

        const preview = resources.length === 1 ? undefined : false;
        for (const resource of resources) {
            await this._openResource(resource, preview, true, false);
        }
    }

    @command("hg.openFileFromUri")
    async openFileFromUri(uri?: Uri): Promise<void> {
        const resource = this.getSCMResource(uri);

        if (!resource) {
            return;
        }

        return await this.openFile(resource);
    }

    @command("hg.openChangeFromUri")
    async openChangeFromUri(uri?: Uri): Promise<void> {
        const resource = this.getSCMResource(uri);

        if (!resource) {
            return;
        }

        return await this._openResource(resource);
    }

    @command("hg.addAll", { repository: true })
    async addAll(repository: Repository): Promise<void> {
        return await repository.add();
    }

    @command("hg.add")
    async add(...resourceStates: SourceControlResourceState[]): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                s.resourceGroup instanceof UntrackedGroup
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, uris) =>
            repository.add(...uris)
        );
    }

    @command("hg.forget")
    async forget(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                s.resourceGroup instanceof WorkingDirectoryGroup
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, uris) =>
            repository.forget(...uris)
        );
    }

    @command("hg.stage") // run by repo
    async stage(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                (s.resourceGroup instanceof WorkingDirectoryGroup ||
                    s.resourceGroup instanceof MergeGroup)
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, uris) =>
            repository.stage(...uris)
        );
    }

    @command("hg.stageAll", { repository: true })
    async stageAll(repository: Repository): Promise<void> {
        await repository.stage();
    }

    @command("hg.revertChange")
    async revertChange(
        uri: Uri,
        changes: LineChange[],
        index: number
    ): Promise<void> {
        const textEditor = window.visibleTextEditors.filter(
            (e) => e.document.uri.toString() === uri.toString()
        )[0];

        if (!textEditor) {
            return;
        }

        await this._revertChanges(textEditor, [
            ...changes.slice(0, index),
            ...changes.slice(index + 1),
        ]);
    }

    private async _revertChanges(
        textEditor: TextEditor,
        changes: LineChange[]
    ): Promise<void> {
        const modifiedDocument = textEditor.document;
        const modifiedUri = modifiedDocument.uri;

        if (modifiedUri.scheme !== "file") {
            return;
        }

        const originalUri = toHgUri(modifiedUri, ".");
        const originalDocument = await workspace.openTextDocument(originalUri);
        const selectionsBeforeRevert = textEditor.selections;
        const visibleRangesBeforeRevert = textEditor.visibleRanges;
        const result = applyLineChanges(
            originalDocument,
            modifiedDocument,
            changes
        );

        const edit = new WorkspaceEdit();
        edit.replace(
            modifiedUri,
            new Range(
                new Position(0, 0),
                modifiedDocument.lineAt(
                    modifiedDocument.lineCount - 1
                ).range.end
            ),
            result
        );
        workspace.applyEdit(edit);

        await modifiedDocument.save();

        textEditor.selections = selectionsBeforeRevert;
        textEditor.revealRange(visibleRangesBeforeRevert[0]);
    }

    @command("hg.markResolved")
    async markResolved(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            return;
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                s.resourceGroup instanceof ConflictGroup &&
                s.mergeStatus === MergeStatus.UNRESOLVED
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, _uris) =>
            repository.resolve(resources, { mark: true })
        );
    }

    @command("hg.resolveAgain")
    async resolve(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            return;
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                s.resourceGroup instanceof ConflictGroup &&
                s.mergeStatus === MergeStatus.UNRESOLVED
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, _uris) =>
            repository.resolve(resources)
        );
    }

    @command("hg.unresolve")
    async unresolve(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            return;
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                s.resourceGroup instanceof MergeGroup &&
                s.mergeStatus !== MergeStatus.UNRESOLVED
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }
        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, _uris) =>
            repository.unresolve(resources)
        );
    }

    @command("hg.unstage")
    async unstage(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource && s.resourceGroup instanceof StagingGroup
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, uris) =>
            repository.unstage(...uris)
        );
    }

    @command("hg.unstageAll", { repository: true })
    async unstageAll(repository: Repository): Promise<void> {
        return await repository.unstage();
    }

    @command("hg.clean")
    async clean(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s) => s instanceof Resource && s.isDirtyStatus
        ) as Resource[];

        if (!scmResources.length) {
            return;
        }

        const [discardResources, addedResources] = partition(
            scmResources,
            (s) => s.status !== Status.ADDED
        );
        if (discardResources.length > 0) {
            const confirmFilenames = discardResources.map((r) =>
                path.basename(r.resourceUri.fsPath)
            );
            const addedFilenames = addedResources.map((r) =>
                path.basename(r.resourceUri.fsPath)
            );

            const confirmed = await interaction.confirmDiscardChanges(
                confirmFilenames,
                addedFilenames
            );
            if (!confirmed) {
                return;
            }
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, uris) =>
            repository.cleanOrUpdate(...uris)
        );
    }

    @command("hg.cleanAll", { repository: true })
    async cleanAll(repository: Repository): Promise<void> {
        if (await interaction.confirmDiscardAllChanges()) {
            const resources = repository.workingDirectoryGroup.resources;
            await repository.cleanOrUpdate(
                ...resources.map((r) => r.resourceUri)
            );
        }
    }

    @command("hg.purgeFiles", { repository: true })
    async purgeFiles(repository: Repository): Promise<void> {
        return this._purge(repository.untrackedGroup.resources);
    }

    @command("hg.purgeAll", { repository: true })
    async purgeAll(repository: Repository): Promise<void> {
        if (await interaction.confirmDeleteUntrackedAndIgnored()) {
            return await repository.purgeAll();
        }
    }

    @command("hg.purge")
    async purge(
        ...resourceStates: SourceControlResourceState[]
    ): Promise<void> {
        if (resourceStates.length === 0) {
            const resource = this.getSCMResource();

            if (!resource) {
                return;
            }

            resourceStates = [resource];
        }

        const scmResources = resourceStates.filter(
            (s) =>
                s instanceof Resource &&
                s.resourceGroup instanceof UntrackedGroup
        ) as Resource[];
        return this._purge(scmResources);
    }

    private async _purge(scmResources: Resource[]): Promise<void> {
        if (!scmResources.length) {
            return;
        }

        const fileNames = scmResources.map((r) =>
            path.basename(r.resourceUri.fsPath)
        );
        const confirmed = await interaction.confirmDeleteFiles(fileNames);
        if (!confirmed) {
            return;
        }

        const resources = scmResources.map((r) => r.resourceUri);
        await this.runByRepository(resources, async (repository, uris) =>
            repository.purge(...uris)
        );
    }

    private async smartCommit(
        repository: Repository,
        getCommitMessage: () => Promise<string | undefined>,
        opts: CommitOptions = {}
    ): Promise<boolean> {
        // validate no conflicts
        const numConflictResources = repository.conflictGroup.resources.length;
        if (numConflictResources > 0) {
            interaction.warnResolveConflicts();
            return false;
        }

        const isMergeCommit =
            repository.repoStatus && repository.repoStatus.isMerge;
        if (isMergeCommit) {
            // merge-commit
            opts.scope = CommitScope.ALL;
        } else {
            // validate non-merge commit
            const numWorkingResources =
                repository.workingDirectoryGroup.resources.length;
            const numStagingResources =
                repository.stagingGroup.resources.length;
            if (opts.scope === undefined) {
                if (numStagingResources > 0) {
                    opts.scope = CommitScope.STAGED_CHANGES;
                } else {
                    opts.scope = CommitScope.CHANGES;
                }
            }

            if (opts.scope === CommitScope.CHANGES) {
                const missingResources = repository.workingDirectoryGroup.resources.filter(
                    (r) => r.status === Status.MISSING
                );
                if (missingResources.length > 0) {
                    const missingFilenames = missingResources.map((r) =>
                        repository.mapResourceToWorkspaceRelativePath(r)
                    );
                    const deleteConfirmed = await interaction.confirmDeleteMissingFilesForCommit(
                        missingFilenames
                    );
                    if (!deleteConfirmed) {
                        return false;
                    }
                    await this.forget(...missingResources);
                }
            }

            if (
                (numWorkingResources === 0 && numStagingResources === 0) || // no changes
                (opts.scope === CommitScope.STAGED_CHANGES &&
                    numStagingResources === 0) || // no staged changes
                (opts.scope === CommitScope.CHANGES &&
                    numWorkingResources === 0) // no working directory changes
            ) {
                interaction.informNoChangesToCommit();
                return false;
            }
        }

        const message = await getCommitMessage();

        if (!message) {
            // TODO@joao: show modal dialog to confirm empty message commit
            return false;
        }

        await repository.commit(message, opts);

        return true;
    }

    private async commitWithAnyInput(
        repository: Repository,
        opts?: CommitOptions
    ): Promise<void> {
        const message = scm.inputBox.value;
        const getCommitMessage = async () => {
            let _message: string | undefined = message;

            if (!_message) {
                let value: string | undefined = undefined;

                if (opts && opts.amend) {
                    value = await repository.getLastCommitMessage();
                }

                const branchName = repository.headShortName;
                let placeHolder: string;

                if (branchName) {
                    placeHolder = localize(
                        "commitMessageWithHeadLabel2",
                        "Message (commit on '{0}')",
                        branchName
                    );
                } else {
                    placeHolder = localize("commit message", "Commit message");
                }

                _message = await window.showInputBox({
                    value: value,
                    placeHolder: placeHolder,
                    prompt: localize(
                        "provide commit message",
                        "Please provide a commit message"
                    ),
                    ignoreFocusOut: true,
                });
            }

            return _message;
        };
        const didCommit = await this.smartCommit(
            repository,
            getCommitMessage,
            opts
        );

        if (message && didCommit) {
            scm.inputBox.value = "";
        }
    }

    @command("hg.commit", { repository: true })
    async commit(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository);
    }

    @command("hg.commitAmend", { repository: true })
    async commitAmend(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, { amend: true });
    }

    @command("hg.commitWithInput", { repository: true })
    async commitWithInput(repository: Repository): Promise<void> {
        const didCommit = await this.smartCommit(
            repository,
            async () => repository.sourceControl.inputBox.value
        );

        if (didCommit) {
            scm.inputBox.value = "";
        }
    }

    @command("hg.commitStaged", { repository: true })
    async commitStaged(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {
            scope: CommitScope.STAGED_CHANGES,
        });
    }

    @command("hg.commitStagedAmend", { repository: true })
    async commitStagedAmend(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {
            scope: CommitScope.STAGED_CHANGES,
            amend: true,
        });
    }

    @command("hg.commitAll", { repository: true })
    async commitAll(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {
            scope: CommitScope.ALL_WITH_ADD_REMOVE,
        });
    }

    @command("hg.commitAllAmend", { repository: true })
    async commitAllAmend(repository: Repository): Promise<void> {
        await this.commitWithAnyInput(repository, {
            scope: CommitScope.ALL_WITH_ADD_REMOVE,
            amend: true,
        });
    }

    private focusScm() {
        commands.executeCommand("workbench.view.scm");
    }

    @command("hg.undoRollback", { repository: true })
    async undoRollback(repository: Repository): Promise<void> {
        try {
            const rollback = await repository.rollback(true); // dry-run
            if (await interaction.confirmRollback(rollback)) {
                await repository.rollback(false, rollback); // real-thing

                if (rollback.kind === "commit" && rollback.commitDetails) {
                    scm.inputBox.value = rollback.commitDetails.message;
                    this.focusScm();
                }
            }
        } catch (e) {
            if (
                e instanceof HgError &&
                e.hgErrorCode === HgErrorCodes.NoRollbackInformationAvailable
            ) {
                await interaction.warnNoRollback();
            }
        }
    }

    private async checkThenWarnOutstandingMergeOrUnclean(
        repository: Repository,
        scenario: WarnScenario
    ): Promise<boolean> {
        if (
            (await interaction.checkThenWarnOutstandingMerge(repository)) ||
            (await interaction.checkThenWarnUnclean(repository, scenario))
        ) {
            this.focusScm();
            return true;
        }
        return false;
    }

    @command("hg.update", { repository: true })
    async update(repository: Repository): Promise<void> {
        const useBookmarks = typedConfig.useBookmarks;

        if (
            !useBookmarks &&
            (await this.checkThenWarnOutstandingMergeOrUnclean(
                repository,
                WarnScenario.Update
            ))
        ) {
            return;
        }

        const { isClean, repoStatus } = repository;
        const uncleanBookmarks =
            useBookmarks && (!isClean || (repoStatus && repoStatus.isMerge));

        const refs = await repository.getUpdateCandidates(
            useBookmarks,
            uncleanBookmarks
        );

        if (uncleanBookmarks && refs.length === 0) {
            this.checkThenWarnOutstandingMergeOrUnclean(
                repository,
                WarnScenario.Update
            );
            return;
        }

        const placeHolder = `Select a ${
            useBookmarks ? "bookmark" : "branch/tag"
        } to update to: ${
            uncleanBookmarks
                ? "(only showing local bookmarks while working directory unclean)"
                : ""
        }`;
        const choice = await interaction.pickRevision(refs, placeHolder);
        if (choice) {
            const ref =
                choice.type === RefType.Commit ? choice.commit : choice.name;
            if (ref) {
                await repository.update(ref);
            }
        }
    }

    @command("hg.branch", { repository: true })
    async branch(repository: Repository): Promise<void> {
        const result = await interaction.inputBranchName();
        if (!result) {
            return;
        }

        const name = result.replace(
            /^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$/g,
            "-"
        );
        try {
            await repository.branch(name);
        } catch (e) {
            if (
                e instanceof HgError &&
                e.hgErrorCode === HgErrorCodes.BranchAlreadyExists
            ) {
                const action = await interaction.warnBranchAlreadyExists(name);
                if (action === BranchExistsAction.Reopen) {
                    await repository.branch(name, { allowBranchReuse: true });
                } else if (action === BranchExistsAction.UpdateTo) {
                    await repository.update(name);
                }
            }
        }
    }

    @command("hg.pull", { repository: true })
    async pull(repository: Repository): Promise<void> {
        const paths = await repository.getPaths();

        if (paths.length === 0) {
            const action = await interaction.warnNoPaths(false);
            if (action === DefaultRepoNotConfiguredAction.OpenHGRC) {
                commands.executeCommand("hg.openhgrc");
            }
            return;
        }

        const pullOptions = await repository.createPullOptions();
        await repository.pull(pullOptions);
    }

    @command("hg.mergeWithLocal", { repository: true })
    async mergeWithLocal(repository: Repository): Promise<void> {
        if (
            await this.checkThenWarnOutstandingMergeOrUnclean(
                repository,
                WarnScenario.Merge
            )
        ) {
            return;
        }

        const otherHeads = await repository.getHeads({ excludeSelf: true });
        const placeholder = localize(
            "choose head",
            "Choose head to merge into working directory:"
        );
        const head = await interaction.pickHead(otherHeads, placeholder);
        if (head) {
            return await this.doMerge(repository, head.hash, head.branch);
        }
    }

    @command("hg.mergeHeads", { repository: true })
    async mergeHeads(repository: Repository): Promise<void> {
        if (
            await this.checkThenWarnOutstandingMergeOrUnclean(
                repository,
                WarnScenario.Merge
            )
        ) {
            return;
        }

        if (!typedConfig.useBookmarks) {
            const { currentBranch } = repository;
            if (!currentBranch) {
                return;
            }

            const otherBranchHeads = await repository.getHeads({
                branch: currentBranch.name,
                excludeSelf: true,
            });
            if (otherBranchHeads.length === 0) {
                // 1 head
                interaction.warnMergeOnlyOneHead(currentBranch.name);
                return;
            } else if (otherBranchHeads.length === 1) {
                // 2 heads
                const [otherHead] = otherBranchHeads;
                return await this.doMerge(repository, otherHead.hash);
            } else {
                // 3+ heads
                const placeHolder = localize(
                    "choose branch head",
                    "Branch {0} has {1} heads. Choose which to merge:",
                    currentBranch.name,
                    otherBranchHeads.length + 1
                );
                const head = await interaction.pickHead(
                    otherBranchHeads,
                    placeHolder
                );
                if (head) {
                    return await this.doMerge(repository, head.hash);
                }
            }
        } else {
            const otherHeads = await repository.getHeads({ excludeSelf: true });
            if (otherHeads.length === 0) {
                // 1 head
                interaction.warnMergeOnlyOneHead();
                return;
            } else {
                // 2+ heads
                const placeHolder = localize(
                    "choose head",
                    "Choose head to merge with:"
                );
                const head = await interaction.pickHead(
                    otherHeads,
                    placeHolder
                );
                if (head) {
                    return await this.doMerge(repository, head.hash);
                }
            }
        }
    }

    @command("hg.rebaseCurrentBranch", { repository: true })
    public async rebaseCurrentBranch(repository: Repository): Promise<void> {
        if (
            await this.checkThenWarnOutstandingMergeOrUnclean(
                repository,
                WarnScenario.Rebase
            )
        ) {
            return;
        }

        const refs = await repository.getUpdateCandidates(false, false);

        const choice = await interaction.pickRevision(
            refs,
            "Select a destination"
        );

        if (!choice) {
            return;
        }
        const ref =
            choice.type === RefType.Commit ? choice.commit : choice.name;
        if (!ref) {
            return;
        }
        const result = await repository.rebaseCurrentBranch(ref);
        if (result.unresolvedCount > 0) {
            interaction.warnUnresolvedFiles(result.unresolvedCount);
        }
    }

    @command("hg.rebaseAbort", { repository: true })
    public async rebaseAbort(repository: Repository): Promise<void> {
        await repository.rebaseAbort();
    }

    @command("hg.rebaseContinue", { repository: true })
    public async rebaseContinue(repository: Repository): Promise<void> {
        await repository.rebaseContinue();
    }

    @command("hg.shelve", { repository: true })
    public async shelve(repository: Repository): Promise<void> {
        const options: ShelveOptions = {};
        const shelveName = await interaction.inputShelveName();
        if (shelveName) {
            options.name = shelveName;
        }
        return repository.shelve(options);
    }

    @command("hg.unshelve", { repository: true })
    public async unshelve(repository: Repository): Promise<void> {
        const shelves = await repository.getShelves();
        const shelve = await interaction.pickShelve(shelves);

        if (!shelve) {
            return;
        }

        const opts = { name: shelve.name };
        await repository.unshelve(opts);
    }

    @command("hg.unshelveKeep", { repository: true })
    public async unshelveKeep(repository: Repository): Promise<void> {
        const shelves = await repository.getShelves();
        const shelve = await interaction.pickShelve(shelves);

        if (!shelve) {
            return;
        }
        const opts = { name: shelve.name, keep: true };
        await repository.unshelve(opts);
    }

    @command("hg.unshelveAbort", { repository: true })
    public async unshelveAbort(repository: Repository): Promise<void> {
        await repository.unshelveAbort();
    }

    @command("hg.unshelveContinue", { repository: true })
    public async unshelveContinue(repository: Repository): Promise<void> {
        await repository.unshelveContinue();
    }

    private async doMerge(
        repository: Repository,
        otherRevision: string,
        otherBranchName?: string
    ) {
        try {
            const result = await repository.merge(otherRevision);
            const { currentBranch } = repository;

            if (result.unresolvedCount > 0) {
                interaction.warnUnresolvedFiles(result.unresolvedCount);
            } else if (currentBranch) {
                const defaultMergeMessage = await humanise.describeMerge(
                    currentBranch.name!,
                    otherBranchName
                );
                const didCommit = await this.smartCommit(
                    repository,
                    async () =>
                        await interaction.inputCommitMessage(
                            "",
                            defaultMergeMessage
                        )
                );

                if (didCommit) {
                    scm.inputBox.value = "";
                }
            }
        } catch (e) {
            if (
                e instanceof HgError &&
                e.hgErrorCode === HgErrorCodes.UntrackedFilesDiffer &&
                e.hgFilenames
            ) {
                interaction.errorUntrackedFilesDiffer(e.hgFilenames);
                return;
            }

            throw e;
        }
    }

    private async validateBookmarkPush(
        repository: Repository
    ): Promise<boolean> {
        const pushPullScope = typedConfig.pushPullScope;
        if (pushPullScope === "current") {
            if (repository.activeBookmark) {
                return true;
            }
            interaction.warnNoActiveBookmark();
            return false;
        }

        // 'all' or 'default'
        const nonDistinctHeadHashes = await repository.getHashesOfNonDistinctBookmarkHeads(
            pushPullScope === "default"
        );
        if (nonDistinctHeadHashes.length > 0) {
            interaction.warnNonDistinctHeads(nonDistinctHeadHashes);
            return false;
        }
        return true;
    }

    private async validateBranchPush(repository: Repository): Promise<boolean> {
        const branch = repository.pushPullBranchName;
        const multiHeadBranchNames = await repository.getBranchNamesWithMultipleHeads(
            branch
        );
        if (multiHeadBranchNames.length === 1) {
            const [branch] = multiHeadBranchNames;
            interaction.warnBranchMultipleHeads(branch);
            return false;
        } else if (multiHeadBranchNames.length > 1) {
            interaction.warnMultipleBranchMultipleHeads(multiHeadBranchNames);
            return false;
        }

        return true;
    }

    @command("hg.push", { repository: true })
    async push(repository: Repository): Promise<void> {
        // check for branches with 2+ heads
        const validated = typedConfig.useBookmarks
            ? await this.validateBookmarkPush(repository)
            : await this.validateBranchPush(repository);

        if (validated) {
            const pushOptions = await repository.createPushOptions();
            await repository.push(undefined, pushOptions);
        }
    }

    @command("hg.pushTo", { repository: true })
    async pushTo(repository: Repository): Promise<void> {
        const paths = await repository.getPaths();

        if (paths.length === 0) {
            const action = await interaction.warnNoPaths(true);
            if (action === DefaultRepoNotConfiguredAction.OpenHGRC) {
                commands.executeCommand("hg.openhgrc");
            }
            return;
        }

        const chosenPath = await interaction.pickRemotePath(paths);
        if (chosenPath) {
            const pushOptions = await repository.createPushOptions();
            repository.push(chosenPath, pushOptions);
        }
    }

    createLogMenuAPI(repository: Repository): LogMenuAPI {
        return {
            getRepoName: () => repository.repoName,
            getBranchName: () =>
                repository.currentBranch && repository.currentBranch.name,
            getCommitDetails: (revision: string) =>
                repository.getCommitDetails(revision),
            getLogEntries: (options: LogEntriesOptions) =>
                repository.getLogEntries(options),
            diffToLocal: (_file: IFileStatus, _commit: CommitDetails) => {
                // do nothing.
            },
            diffToParent: (file: IFileStatus, commit: CommitDetails) =>
                this.diffFile(repository, commit.parent1, commit, file),
        };
    }

    @command("hg.log", { repository: true })
    async log(repository: Repository): Promise<void> {
        interaction.presentLogSourcesMenu(
            this.createLogMenuAPI(repository),
            typedConfig.useBookmarks
        );
    }

    @command("hg.logBranch", { repository: true })
    async logBranch(repository: Repository): Promise<void> {
        interaction.presentLogMenu(
            CommitSources.Branch,
            { branch: "." },
            typedConfig.useBookmarks,
            this.createLogMenuAPI(repository)
        );
    }

    @command("hg.logRev", { repository: true })
    async logRev(repository: Repository, rev: string): Promise<void> {
        const commit = await repository.getCommitDetails(rev);
        const selectedFile = await interaction.presentCommitDetails(
            commit,
            undefined,
            this.createLogMenuAPI(repository)
        );
        selectedFile?.run();
    }

    @command("hg.logDefault", { repository: true })
    async logDefault(repository: Repository): Promise<void> {
        interaction.presentLogMenu(
            CommitSources.Branch,
            { branch: "default" },
            typedConfig.useBookmarks,
            this.createLogMenuAPI(repository)
        );
    }

    @command("hg.logRepo", { repository: true })
    async logRepo(repository: Repository): Promise<void> {
        interaction.presentLogMenu(
            CommitSources.Repo,
            {},
            typedConfig.useBookmarks,
            this.createLogMenuAPI(repository)
        );
    }

    @command("hg.fileLog")
    async fileLog(uri?: Uri): Promise<void> {
        if (!uri) {
            if (window.activeTextEditor) {
                uri = window.activeTextEditor.document.uri;
            }

            if (!uri || uri.scheme !== "file") {
                return;
            }
        }

        const repository = this.model.getRepository(uri);
        if (!repository) {
            return;
        }

        const logEntries = await repository.getLogEntries({ file: uri });
        const choice = await interaction.pickCommit(
            CommitSources.File,
            logEntries,
            typedConfig.useBookmarks,
            (commit) => () => {
                if (uri) {
                    this.diff(commit, uri);
                }
            }
        );

        if (choice) {
            choice.run();
        }
    }

    @command("hg.setBookmark", { repository: true })
    async setBookmark(repository: Repository): Promise<void> {
        if (!typedConfig.useBookmarks) {
            const switched = await interaction.warnNotUsingBookmarks();
            if (!switched) {
                return;
            }
        }

        const bookmarkName = await interaction.inputBookmarkName();

        if (bookmarkName) {
            const bookmarkRefs = await repository.getBookmarks();
            const existingBookmarks = bookmarkRefs.filter(
                (ref) => ref.type === RefType.Bookmark
            ) as Bookmark[];

            const parents = await repository.getParents();
            const currentBookmark = existingBookmarks.filter(
                (b) =>
                    b.name === bookmarkName &&
                    parents.some((p) => p.hash.startsWith(b.commit!))
            )[0];
            if (currentBookmark) {
                if (currentBookmark.active) {
                    return;
                }

                return repository.update(bookmarkName);
            }

            const existingBookmarkNames = existingBookmarks.map(
                (b: Bookmark) => b.name
            );
            const alreadyExists = existingBookmarkNames.includes(bookmarkName);
            if (alreadyExists) {
                const force = await interaction.confirmForceSetBookmark(
                    bookmarkName
                );
                if (!force) {
                    return;
                }
            }
            repository.setBookmark(bookmarkName, { force: alreadyExists });
        }
    }

    @command("hg.removeBookmark", { repository: true })
    async removeBookmark(repository: Repository): Promise<void> {
        if (!typedConfig.useBookmarks) {
            const switched = await interaction.warnNotUsingBookmarks();
            if (!switched) {
                return;
            }
        }

        const bookmarkRefs = await repository.getBookmarks();
        const existingBookmarks = bookmarkRefs.filter(
            (ref) => ref.type === RefType.Bookmark
        ) as Bookmark[];
        const bookmark = await interaction.pickBookmarkToRemove(
            existingBookmarks
        );
        if (bookmark) {
            repository.removeBookmark(bookmark.name);
        }
    }

    // Toggle line annotations for the current file
    @command("hg.toggleAnnotations", { repository: true })
    async toggleAnnotate(_repository: Repository): Promise<void> {
        const activeEditor = window.activeTextEditor;
        // TODO: allow annotate of a specific hg rev
        if (!activeEditor || activeEditor.document.uri.scheme != "file") {
            return;
        }
        try {
            this.fileAnnotationsController.toggle(activeEditor);
        } catch (ex) {
            void window.showErrorMessage(
                `Unable to toggle file ${activeEditor.document.uri} annotations. See output channel for more details`
            );
        }
    }

    private async diffFile(
        repository: Repository,
        rev1: Revision,
        rev2: Revision,
        file: IFileStatus
    ) {
        const uri = repository.toUri(file.path);
        const left = toHgUri(uri, rev1.hash);
        const right = toHgUri(uri, rev2.hash);
        const baseName = path.basename(uri.fsPath);
        const title = `${baseName} (#${rev1.revision} vs. ${rev2.revision})`;

        if (left && right) {
            return await commands.executeCommand<void>(
                "vscode.diff",
                left,
                right,
                title
            );
        }
    }

    private async diff(commit: Commit, uri: Uri) {
        const left = toHgUri(uri, commit.hash);
        const right = uri;
        const baseName = path.basename(uri.fsPath);
        const title = `${baseName} (#${commit.revision} vs. local)`;

        if (left && right) {
            return await commands.executeCommand<void>(
                "vscode.diff",
                left,
                right,
                title
            );
        }
    }

    private createCommand(
        id: string,
        key: string,
        method: Function,
        options: CommandOptions
    ): (...args: any[]) => Promise<any> | undefined {
        const res = (...args) => {
            let result: Promise<any>;

            if (!options.repository) {
                result = Promise.resolve(method.apply(this, args));
            } else {
                // try to guess the repository based on the first argument
                const repository = this.model.getRepository(args[0]);
                let repositoryPromise: Promise<Repository | undefined>;

                if (repository) {
                    repositoryPromise = Promise.resolve(repository);
                } else if (this.model.repositories.length === 1) {
                    repositoryPromise = Promise.resolve(
                        this.model.repositories[0]
                    );
                } else {
                    repositoryPromise = this.model.pickRepository();
                }

                result = repositoryPromise.then((repository) => {
                    if (!repository) {
                        return Promise.resolve();
                    }

                    return Promise.resolve(
                        method.apply(this, [repository, ...args])
                    );
                });
            }

            return result.catch(async (err) => {
                const openLog = await interaction.errorPromptOpenLog(err);
                if (openLog) {
                    this.outputChannel.show();
                } else {
                    this.focusScm();
                }
            });
        };

        // patch this object, so people can call methods directly
        this[key] = res;
        return res;
    }

    private getSCMResource(uri?: Uri): Resource | undefined {
        uri = uri
            ? uri
            : window.activeTextEditor && window.activeTextEditor.document.uri;

        if (!uri) {
            return undefined;
        }

        if (uri.scheme === "hg") {
            uri = uri.with({ scheme: "file" });
        }

        if (uri.scheme === "file") {
            const repository = this.model.getRepository(uri);

            if (!repository) {
                return undefined;
            }

            return (
                repository.workingDirectoryGroup.getResource(uri) ||
                repository.stagingGroup.getResource(uri) ||
                repository.untrackedGroup.getResource(uri) ||
                repository.mergeGroup.getResource(uri) ||
                repository.conflictGroup.getResource(uri)
            );
        }
    }

    private runByRepository<T>(
        resource: Uri,
        fn: (repository: Repository, resource: Uri) => Promise<T>
    ): Promise<T[]>;
    private runByRepository<T>(
        resources: Uri[],
        fn: (repository: Repository, resources: Uri[]) => Promise<T>
    ): Promise<T[]>;
    private async runByRepository<T>(
        arg: Uri | Uri[],
        fn: (repository: Repository, resources: any) => Promise<T>
    ): Promise<T[]> {
        const resources = arg instanceof Uri ? [arg] : arg;
        const isSingleResource = arg instanceof Uri;

        const groups = resources.reduce((result, resource) => {
            const repository = this.model.getRepository(resource);

            if (!repository) {
                console.warn("Could not find hg repository for ", resource);
                return result;
            }

            const tuple = result.filter((r) => r.repository === repository)[0];

            if (tuple) {
                tuple.resources.push(resource);
            } else {
                result.push({ repository, resources: [resource] });
            }

            return result;
        }, [] as { repository: Repository; resources: Uri[] }[]);

        const promises = groups.map(({ repository, resources }) =>
            fn(
                repository as Repository,
                isSingleResource ? resources[0] : resources
            )
        );

        return Promise.all(promises);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
