import * as nls from "vscode-nls";
import * as path from "path";
import { window, QuickPickItem, workspace } from "vscode";
import { ChildProcess } from "child_process";
import { Resource, Model } from "./model";
import { HgRollbackDetails, Path, Ref, RefType, Commit, HgError } from "./hg";
import { humanise } from "./humanise";
import * as os from "os";
const localize = nls.loadMessageBundle();

const USE_CHANGED = "Use changed version";
const LEAVE_DELETED = "Leave deleted";
const LEAVE_UNRESOLVED = "Leave unresolved";

const INT32_SIZE = 4;
const SHORT_HASH_LENGTH = 12;
const BULLET = "\u2022";

export const enum BranchExistsAction { None, Reopen, UpdateTo }
export const enum PushCreatesNewHeadAction { None, Pull }
export const enum WarnScenario { Merge, Update }
export const enum DefaultRepoNotConfiguredAction { None, OpenHGRC }

export namespace interaction {

    export function statusCloning(clonePromise: Promise<any>) {
        return window.setStatusBarMessage(localize('cloning', "Cloning hg repository..."), clonePromise);
    }

    export function informHgNotSupported() {
        return window.showInformationMessage(localize('disabled', "Hg is either disabled or not supported in this workspace"));
    }

    export function informNoChangesToCommit() {
        return window.showInformationMessage(localize('no changes', "There are no changes to commit."));
    }

    export async function checkThenWarnOutstandingMerge(this: void, model: Model, scenario: WarnScenario): Promise<boolean> {
        const { repoStatus } = model;
        if (repoStatus && repoStatus.isMerge) {
            window.showErrorMessage(localize('outstanding merge', "There is an outstanding merge in your working directory."));
            return true;
        }
        return false;
    }

    export async function checkThenWarnUnclean(this: void, model: Model, scenario: WarnScenario): Promise<boolean> {
        if (!model.isClean) {
            let nextStep: string = "";
            if (scenario === WarnScenario.Merge) {
                const discardAllChanges = localize('command.cleanAll', "Discard All Changes");
                const abandonMerge = localize('abandon merge', "abandon merge");
                localize('use x to y', "Use {0} to {1}", discardAllChanges, abandonMerge);
            }
            window.showErrorMessage(localize('not clean merge', "There are uncommited changes in your working directory. {0}", nextStep));
            return true;
        }
        return false;
    }

    export function warnBranchMultipleHeads(branchWithMultipleHeads: string) {
        return window.showWarningMessage(localize('multi head branch', `Branch '{0}' has multiple heads. Merge required before pushing.`, branchWithMultipleHeads));
    }

    export function warnMergeOnlyOneHead(branch: string | undefined) {
        return window.showWarningMessage(localize('only one head', "There is only 1 head for branch '{0}'. Nothing to merge.", branch));
    }

    export async function warnPushCreatesNewHead(): Promise<PushCreatesNewHeadAction> {
        const warningMessage = localize('pullandmerge', "Push would create new head. Try Pull and Merge first.");
        const pullOption = localize('pull', 'Pull');
        const choice = await window.showErrorMessage(warningMessage, pullOption);
        if (choice === pullOption) {
            return PushCreatesNewHeadAction.Pull;
        }
        return PushCreatesNewHeadAction.None;
    }

    export async function warnPushCreatesNewBranchesAllow(): Promise<boolean> {
        const warningMessage = localize('pushnewbranches', `Push creates new remote branches. Allow?`);
        const allowOption = localize('allow', 'Allow');
        const choice = await window.showWarningMessage(warningMessage, { modal: true }, allowOption);
        if (choice === allowOption) {
            return true;
        }
        return false;
    }

    export function warnMultipleBranchMultipleHeads(branchesWithMultipleHeads: string[]) {
        return window.showWarningMessage(localize('multi head branches', `These branches have multiple heads: {0}. Merges required before pushing.`, branchesWithMultipleHeads.join(",")));
    }

    export async function warnDefaultRepositoryNotConfigured(message?: string): Promise<DefaultRepoNotConfiguredAction> {
        const defaultMessage = localize('no default repo', "No default repository is configured.");
        const hgrcOption = localize('open hgrc', 'Open hgrc file');
        const choice = await window.showErrorMessage(message || defaultMessage, hgrcOption);
        if (choice === hgrcOption) {
            return DefaultRepoNotConfiguredAction.OpenHGRC;
        }
        return DefaultRepoNotConfiguredAction.None;
    }

    export function warnNoPaths(push: boolean) {
        if (push) {
            return warnDefaultRepositoryNotConfigured(localize('no paths to push', "Your repository has no paths configured to push to."));
        }
        else {
            return warnDefaultRepositoryNotConfigured(localize('no paths to pull', "Your repository has no paths configured to pull from."));
        }
    }

    export function warnResolveConflicts() {
        return window.showWarningMessage(localize('conflicts', "Resolve conflicts before committing."));
    }

    export function warnNoRollback() {
        return window.showWarningMessage(localize('no rollback', "Nothing to rollback to."));
    }

    export async function errorPromptOpenLog(err: any): Promise<boolean> {
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
            return false;
        }

        const openOutputChannelChoice = localize('open hg log', "Open Hg Log");
        const choice = await window.showErrorMessage(message, openOutputChannelChoice);
        return choice === openOutputChannelChoice;
    }

    export async function promptOpenClonedRepo() {
        const open = localize('openrepo', "Open Repository");
        const result = await window.showInformationMessage(localize('proposeopen', "Would you like to open the cloned repository?"), open);

        return result === open;
    }

    export async function inputRepoUrl(): Promise<string | undefined> {
        const url = await window.showInputBox({
            prompt: localize('repourl', "Repository URL"),
            ignoreFocusOut: true
        });
        return url;
    }

    export async function inputCloneParentPath(): Promise<string | undefined> {
        return await window.showInputBox({
            prompt: localize('parent', "Parent Directory"),
            value: os.homedir(),
            ignoreFocusOut: true
        });
    }

    function formatFilesAsBulletedList(this: void, filenames: string[], limit: number = 8): string {
        let extraCount = 0;
        if (filenames.length > (limit + 1)) {
            extraCount = filenames.length - limit;
            filenames = filenames.slice(0, limit);
        }

        let formatted = ` ${BULLET} ${filenames.join(`\n ${BULLET} `)}`;
        if (extraCount > 1) {
            formatted += `\n ${BULLET} and ${extraCount} others`;
        }

        return formatted;
    }

    export async function warnBranchAlreadyExists(name: string): Promise<BranchExistsAction> {
        const updateTo = "Update";
        const reopen = "Re-open";
        const message = localize('branch already exists', `Branch '{0}' already exists. Update or Re-open?`, name);
        const choice = await window.showWarningMessage(message, { modal: true }, updateTo, reopen);
        if (choice === reopen) {
            return BranchExistsAction.Reopen;
        }
        else if (choice === updateTo) {
            return BranchExistsAction.UpdateTo;
        }
        return BranchExistsAction.None;
    }

    export async function inputBranchName(this: void): Promise<string | undefined> {
        const input = await window.showInputBox({
            placeHolder: localize('branch name', "Branch name"),
            prompt: localize('provide branch name', "Please provide a branch name"),
            ignoreFocusOut: true
        });
        return input;
    }

    export async function pickHead(this: void, heads: Commit[], placeHolder: string): Promise<Commit | undefined> {
        const headChoices = heads.map(head => new CommitItem(head));
        const choice = await window.showQuickPick(headChoices, { placeHolder });
        return choice && choice.commit;
    }

    export async function pickBranchOrTag(this: void, refs: Ref[]): Promise<UpdateRefItem | undefined> {
        const config = workspace.getConfiguration('hg');
        const checkoutType = config.get<string>('updateType') || 'all';
        const includeTags = checkoutType === 'all' || checkoutType === 'tags';
        const branches = refs.filter(ref => ref.type === RefType.Branch)
            .map(ref => new UpdateRefItem(ref));

        const tags = (includeTags ? refs.filter(ref => ref.type === RefType.Tag) : [])
            .map(ref => new UpdateTagItem(ref));

        const picks = [...branches, ...tags];
        const placeHolder = 'Select a branch/tag to update to:';
        const choice = await window.showQuickPick<UpdateRefItem>(picks, { placeHolder });
        return choice;
    }

    export async function pickLogEntry(this: void, logEntries: Commit[]): Promise<LogEntryItem | undefined> {
        const quickPickItems = logEntries.map(entry => new LogEntryItem(entry));
        const choice = await window.showQuickPick<LogEntryItem>(quickPickItems, {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: localize('file history', "File History"),
            onDidSelectItem: (x) => console.log(x)
        });
        return choice;
    }

    export async function pickRemotePath(this: void, paths: Path[]): Promise<string | undefined> {
        const picks = paths.map(p => ({ label: p.name, description: p.url } as QuickPickItem));
        const placeHolder = localize('pick remote', "Pick a remote to push to:");
        const choice = await window.showQuickPick<QuickPickItem>(picks, { placeHolder });
        if (choice) {
            return choice.label;
        }

        return;
    }

    export function warnUnresolvedFiles(unresolvedCount: number) {
        const fileOrFiles = unresolvedCount === 1 ? localize('file', 'file') : localize('files', 'files');
        window.showWarningMessage(localize('unresolved files', "Merge leaves {0} {1} unresolved.", unresolvedCount, fileOrFiles));
    }

    export async function confirmRollback(this: void, { revision, kind, commitMessage }: HgRollbackDetails) {
        // prompt
        const rollback = "Rollback";
        const message = localize('rollback', `Rollback to revision {0}? (undo {1})`, revision, kind);
        const choice = await window.showInformationMessage(message, { modal: true }, rollback);
        return choice === rollback;
    }

    export async function inputCommitMessage(this: void, message: string) {
        if (message) {
            return message;
        }

        return await window.showInputBox({
            placeHolder: localize('commit message', "Commit message"),
            prompt: localize('provide commit message', "Please provide a commit message"),
            ignoreFocusOut: true
        });
    };

    export async function confirmDiscardAllChanges(this: void): Promise<boolean> {
        const message = localize('confirm discard all', "Are you sure you want to discard ALL changes?");
        const discard = localize('discard', "Discard Changes");
        const choice = await window.showWarningMessage(message, { modal: true }, discard);
        return choice === discard;
    }

    export async function confirmDiscardChanges(this: void, resources: Resource[]): Promise<boolean> {
        const message = resources.length === 1
            ? localize('confirm discard', "Are you sure you want to discard changes in {0}?", path.basename(resources[0].resourceUri.fsPath))
            : localize('confirm discard multiple', "Are you sure you want to discard changes in {0} files?", resources.length);

        const discard = localize('discard', "Discard Changes");
        const choice = await window.showWarningMessage(message, { modal: true }, discard);
        return choice === discard;
    }

    export async function handleChoices(this: void, stdout: string, limit: number): Promise<string> {
        /* other [merge rev] changed letters.txt which local [working copy] deleted
    use (c)hanged version, leave (d)eleted, or leave (u)nresolved*/
        const [options, prompt, ..._] = stdout.split('\n').reverse();
        const choices: string[] = [];
        if (options.includes("(c)hanged")) {
            choices.push(USE_CHANGED);
        }
        if (options.includes("(d)eleted")) {
            choices.push(LEAVE_DELETED);
        }
        if (options.includes("(u)nresolved")) {
            choices.push(LEAVE_UNRESOLVED);
        }

        const choice = await window.showQuickPick(choices, { ignoreFocusOut: true, placeHolder: prompt });
        switch (choice) {
            case USE_CHANGED: return "c";
            case LEAVE_DELETED: return "d";
            case LEAVE_UNRESOLVED: default: return "u";
        }
    }

    export async function serverSendCommand(this: void, server: ChildProcess, encoding: string, cmd: string, args: string[] = []) {
        if (!server) {
            throw new Error("Must start the command server before issuing commands");
        }
        const cmdLength = cmd.length + 1;
        const argsJoined = args.join("\0");
        const argsJoinedLength = argsJoined.length;
        const totalBufferSize = cmdLength + INT32_SIZE + argsJoinedLength;
        const buffer = new Buffer(totalBufferSize);
        buffer.write(cmd + "\n", 0, cmdLength, encoding);
        buffer.writeUInt32BE(argsJoinedLength, cmdLength);
        buffer.write(argsJoined, cmdLength + INT32_SIZE, argsJoinedLength, encoding);
        await writeBufferToStdIn(server, buffer);
    };

    export async function serverSendLineInput(this: void, server: ChildProcess, encoding: string, text: string) {
        if (!server) {
            throw new Error("Must start the command server before issuing commands");
        }
        const textLength = text.length + 1;
        const totalBufferSize = textLength + INT32_SIZE;
        const buffer = new Buffer(totalBufferSize);
        buffer.writeUInt32BE(textLength, 0);
        buffer.write(`${text}\n`, INT32_SIZE, textLength, encoding);
        await writeBufferToStdIn(server, buffer);
        const zeroBuffer = new Buffer(INT32_SIZE);

        // buffer.writeUInt32BE(0, 0);
        // await writeBufferToStdIn(server, zeroBuffer)
    };

    function writeBufferToStdIn(this: void, server: ChildProcess, buffer: Buffer): Promise<any> {
        return new Promise((c, e) => server.stdin.write(buffer, c));
    }

    export function errorUntrackedFilesDiffer(this: void, filenames: string[]) {
        const fileList = formatFilesAsBulletedList(filenames);
        const message = localize('untracked files differ', `Merge failed!

Untracked files in your working directory would be overwritten
by files of the same name from the merge revision:

{0}

Either track these files, move them, or delete them before merging.`, fileList);
        window.showErrorMessage(message, { modal: true });
    }
}


class CommitItem implements QuickPickItem {
    constructor(public readonly commit: Commit) { }
    get shortHash() { return (this.commit.hash || '').substr(0, SHORT_HASH_LENGTH); }
    get label() { return this.commit.branch; }
    get detail() { return `${this.commit.revision} (${this.shortHash})`; }
    get description() { return this.commit.message; }
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
        return `\u00a0\u2022\u00a0\u00a0#${this.commit.revision} \u2014 ${this.commit.branch}`;
    }
    get label() { return this.commit.message; }
    get detail() {
        return `\u00a0\u00a0\u00a0${this.commit.author}, ${this.age}`;
    }
    protected get age(): string {
        return humanise.ageFromNow(this.commit.date);
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