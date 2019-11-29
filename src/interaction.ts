/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as path from 'path';
import { window, QuickPickItem, workspace, Uri } from 'vscode';
import { ChildProcess } from 'child_process';
import { Model } from './model';
import {
  HgRollbackDetails,
  Path,
  Ref,
  RefType,
  Commit,
  HgError,
  LogEntryOptions,
  CommitDetails,
  IFileStatus,
  Bookmark
} from './hg';
import { humanise } from './humanise';
import * as os from 'os';
import typedConfig from './config';
import { Repository, Resource, Status, LogEntriesOptions } from './repository';
const localize = nls.loadMessageBundle();

const USE_CHANGED = 'Use changed version';
const LEAVE_DELETED = 'Leave deleted';
const LEAVE_UNRESOLVED = 'Leave unresolved';
const DELETE = 'Delete';

const SHORT_HASH_LENGTH = 12;
const BULLET = '\u2022';
const NBSP = '\u00a0';

const NOOP = function() {};

export const enum BranchExistsAction {
  None,
  Reopen,
  UpdateTo
}
export const enum PushCreatesNewHeadAction {
  None,
  Pull
}
export const enum WarnScenario {
  Merge,
  Update
}
export const enum DefaultRepoNotConfiguredAction {
  None,
  OpenHGRC
}
export const enum CommitSources {
  File,
  Branch,
  Repo
}

export namespace interaction {
  export function statusCloning(clonePromise: Promise<any>) {
    return window.setStatusBarMessage(
      localize('cloning', 'Cloning hg repository...'),
      clonePromise
    );
  }

  export function informHgNotSupported(this: void) {
    return window.showInformationMessage(
      localize(
        'disabled',
        'Hg is either disabled or not supported in this workspace'
      )
    );
  }

  export function informNoChangesToCommit(this: void) {
    return window.showInformationMessage(
      localize('no changes', 'There are no changes to commit.')
    );
  }

  export async function checkThenWarnOutstandingMerge(
    repository: Repository,
    scenario: WarnScenario
  ): Promise<boolean> {
    const { repoStatus } = repository;
    if (repoStatus && repoStatus.isMerge) {
      window.showErrorMessage(
        localize(
          'outstanding merge',
          'There is an outstanding merge in your working directory.'
        )
      );
      return true;
    }
    return false;
  }

  export async function checkThenWarnUnclean(
    repository: Repository,
    scenario: WarnScenario
  ): Promise<boolean> {
    if (!repository.isClean) {
      let nextStep: string = '';
      if (scenario === WarnScenario.Merge) {
        const discardAllChanges = localize(
          'command.cleanAll',
          'Discard All Changes'
        );
        const abandonMerge = localize('abandon merge', 'abandon merge');
        localize(
          'use x to y',
          'Use {0} to {1}',
          discardAllChanges,
          abandonMerge
        );
      }
      window.showErrorMessage(
        localize(
          'not clean merge',
          'There are uncommited changes in your working directory. {0}',
          nextStep
        )
      );
      return true;
    }
    return false;
  }

  export function warnNonDistinctHeads(nonDistinctHeads: string[]) {
    const nonDistinctHeadShortHashes = nonDistinctHeads
      .map(h => h.slice(0, SHORT_HASH_LENGTH))
      .join(', ');
    return window.showWarningMessage(
      localize(
        'non distinct heads',
        '{0} heads without bookmarks [{1}]. Set bookmark or merge heads before pushing.',
        nonDistinctHeads.length,
        nonDistinctHeadShortHashes
      )
    );
  }

  export function warnNoActiveBookmark() {
    return window.showWarningMessage(
      localize(
        'no active bookmark',
        "Nothing to push. There is no active bookmark and pushPullScope is 'current'."
      )
    );
  }

  export function warnBranchMultipleHeads(branchWithMultipleHeads: string) {
    return window.showWarningMessage(
      localize(
        'multi head branch',
        "Branch '{0}' has multiple heads. Merge required before pushing.",
        branchWithMultipleHeads
      )
    );
  }

  export function warnMergeOnlyOneHead(branch?: string) {
    if (typedConfig.useBookmarks) {
      return window.showWarningMessage(
        localize(
          'only one head',
          'There is only 1 head. Nothing to merge.',
          branch
        )
      );
    }

    return window.showWarningMessage(
      localize(
        'only one head',
        "There is only 1 head for branch '{0}'. Nothing to merge.",
        branch
      )
    );
  }

  export async function warnPushCreatesNewHead(
    this: void
  ): Promise<PushCreatesNewHeadAction> {
    const warningMessage = localize(
      'pullandmerge',
      'Push would create new head. Try Pull and Merge first.'
    );
    const pullOption = localize('pull', 'Pull');
    const choice = await window.showErrorMessage(warningMessage, pullOption);
    if (choice === pullOption) {
      return PushCreatesNewHeadAction.Pull;
    }
    return PushCreatesNewHeadAction.None;
  }

  export async function warnPushCreatesNewBranchesAllow(
    this: void
  ): Promise<boolean> {
    const warningMessage = localize(
      'pushnewbranches',
      'Push creates new remote branches. Allow?'
    );
    const allowOption = localize('allow', 'Allow');
    const choice = await window.showWarningMessage(
      warningMessage,
      { modal: true },
      allowOption
    );
    if (choice === allowOption) {
      return true;
    }
    return false;
  }

  export function warnMultipleBranchMultipleHeads(
    branchesWithMultipleHeads: string[]
  ) {
    return window.showWarningMessage(
      localize(
        'multi head branches',
        'These branches have multiple heads: {0}. Merges required before pushing.',
        branchesWithMultipleHeads.join(',')
      )
    );
  }

  export async function warnDefaultRepositoryNotConfigured(
    message?: string
  ): Promise<DefaultRepoNotConfiguredAction> {
    const defaultMessage = localize(
      'no default repo',
      'No default repository is configured.'
    );
    const hgrcOption = localize('open hgrc', 'Open hgrc file');
    const choice = await window.showErrorMessage(
      message || defaultMessage,
      hgrcOption
    );
    if (choice === hgrcOption) {
      return DefaultRepoNotConfiguredAction.OpenHGRC;
    }
    return DefaultRepoNotConfiguredAction.None;
  }

  export function warnNoPaths(push: boolean) {
    if (push) {
      return warnDefaultRepositoryNotConfigured(
        localize(
          'no paths to push',
          'Your repository has no paths configured to push to.'
        )
      );
    } else {
      return warnDefaultRepositoryNotConfigured(
        localize(
          'no paths to pull',
          'Your repository has no paths configured to pull from.'
        )
      );
    }
  }

  export function warnResolveConflicts(this: void) {
    return window.showWarningMessage(
      localize('conflicts', 'Resolve conflicts before committing.')
    );
  }

  export function warnNoRollback(this: void) {
    return window.showWarningMessage(
      localize('no rollback', 'Nothing to rollback to.')
    );
  }

  export async function errorPromptOpenLog(err: any): Promise<boolean> {
    let message: string;

    switch (err.hgErrorCode) {
      case 'DirtyWorkingDirectory':
        message = localize(
          'clean repo',
          'Please clean your repository working directory before updating.'
        );
        break;

      default:
        const hint = (err.stderr || err.message || String(err))
          .replace(/^abort: /im, '')
          .replace(/^> husky.*$/im, '')
          .split(/[\r\n]/)
          .filter(line => !!line)[0];

        message = hint
          ? localize('hg error details', 'Hg: {0}', hint)
          : localize('hg error', 'Hg error');

        break;
    }

    if (!message) {
      console.error(err);
      return false;
    }

    const openOutputChannelChoice = localize('open hg log', 'Open Hg Log');
    const choice = await window.showErrorMessage(
      message,
      openOutputChannelChoice
    );
    return choice === openOutputChannelChoice;
  }

  export async function promptOpenClonedRepo(this: void) {
    const open = localize('openrepo', 'Open Repository');
    const result = await window.showInformationMessage(
      localize('proposeopen', 'Would you like to open the cloned repository?'),
      open
    );

    return result === open;
  }

  export async function inputRepoUrl(this: void): Promise<string | undefined> {
    const url = await window.showInputBox({
      prompt: localize('repourl', 'Repository URL'),
      ignoreFocusOut: true
    });
    return url;
  }

  export async function inputCloneParentPath(
    this: void
  ): Promise<string | undefined> {
    return await window.showInputBox({
      prompt: localize('parent', 'Parent Directory'),
      value: os.homedir(),
      ignoreFocusOut: true
    });
  }

  export async function inputBookmarkName(): Promise<string | undefined> {
    const bookmark = await window.showInputBox({
      prompt: localize('bookmark name', 'Bookmark Name'),
      ignoreFocusOut: true
    });

    return bookmark;
  }

  export async function warnNotUsingBookmarks(): Promise<boolean> {
    const message = localize(
      'offer bookmarks',
      'Bookmarks requires the hg.useBookmarks setting to be enabled.'
    );
    const useBookmarks = localize('use bookmarks', 'Use Bookmarks (workspace)');
    const choice = await window.showInformationMessage(message, useBookmarks);
    if (choice === useBookmarks) {
      await typedConfig.setUseBookmarks(true);
      return true;
    }

    return false;
  }

  export async function warnBranchAlreadyExists(
    name: string
  ): Promise<BranchExistsAction> {
    const updateTo = localize('upadte', 'Update');
    const reopen = localize('reopen', 'Re-open');
    const message = localize(
      'branch already exists',
      "Branch '{0}' already exists. Update or Re-open?",
      name
    );
    const choice = await window.showWarningMessage(
      message,
      { modal: true },
      updateTo,
      reopen
    );
    if (choice === reopen) {
      return BranchExistsAction.Reopen;
    } else if (choice === updateTo) {
      return BranchExistsAction.UpdateTo;
    }
    return BranchExistsAction.None;
  }

  export async function inputBranchName(
    this: void
  ): Promise<string | undefined> {
    const input = await window.showInputBox({
      placeHolder: localize('branch name', 'Branch name'),
      prompt: localize('provide branch name', 'Please provide a branch name'),
      ignoreFocusOut: true
    });
    return input;
  }

  export async function pickHead(
    heads: Commit[],
    placeHolder: string
  ): Promise<Commit | undefined> {
    const useBookmarks = typedConfig.useBookmarks;
    const headChoices = heads.map(head => new CommitItem(head, useBookmarks));
    const choice = await window.showQuickPick(headChoices, { placeHolder });
    return choice && choice.commit;
  }

  export async function pickUpdateRevision(
    refs: Ref[],
    unclean: boolean = false
  ): Promise<UpdateRefItem | undefined> {
    const useBookmarks = typedConfig.useBookmarks;

    const branches = !useBookmarks
      ? refs
          .filter(ref => ref.type === RefType.Branch)
          .map(ref => new UpdateRefItem(ref))
      : [];

    const bookmarks = useBookmarks
      ? refs
          .filter(ref => ref.type === RefType.Bookmark)
          .map(ref => new UpdateBookmarkItem(ref))
      : [];

    const tags = !useBookmarks
      ? refs
          .filter(ref => ref.type === RefType.Tag)
          .map(ref => new UpdateTagItem(ref))
      : [];

    const picks = [...branches, ...bookmarks, ...tags];
    const revType = useBookmarks ? 'bookmark' : 'branch/tag';

    const placeHolder = `Select a ${revType} to update to: ${
      unclean
        ? '(only showing local bookmarks while working directory unclean)'
        : ''
    }`;
    const choice = await window.showQuickPick<UpdateRefItem>(picks, {
      placeHolder
    });
    return choice;
  }

  function describeLogEntrySource(kind: CommitSources): string {
    switch (kind) {
      case CommitSources.Branch:
        return localize('branch history', 'Branch history');
      case CommitSources.Repo:
        return localize('repo history', 'Repo history');
      case CommitSources.File:
        return localize('file history', 'File history');
      default:
        return localize('history', 'History');
    }
  }

  function describeCommitOneLine(commit: Commit): string {
    return `#${commit.revision} ${BULLET} ${
      commit.author
    }, ${humanise.ageFromNow(commit.date)} ${BULLET} ${commit.message}`;
  }

  function asLabelItem(
    label: string,
    description: string = '',
    action: RunnableAction = NOOP
  ): RunnableQuickPickItem {
    return new LiteralRunnableQuickPickItem(label, description, action);
  }

  function asBackItem(
    description: string,
    action: RunnableAction
  ): RunnableQuickPickItem {
    const goBack = localize('go back', 'go back');
    const to = localize('to', 'to');
    return new LiteralRunnableQuickPickItem(
      `$(arrow-left)${NBSP}${NBSP}${goBack}`,
      `${to} ${description}`,
      action
    );
  }

  export async function presentLogSourcesMenu(
    commands: LogMenuAPI,
    useBookmarks: boolean
  ) {
    const repoName = commands.getRepoName();
    const branchName = commands.getBranchName();
    const source = await interaction.pickLogSource(repoName, branchName);
    if (source) {
      const historyScope = localize('history scope', 'history scope');
      const back = asBackItem(historyScope, () =>
        presentLogSourcesMenu(commands, useBookmarks)
      );
      return presentLogMenu(
        source.source,
        source.options,
        useBookmarks,
        commands,
        back
      );
    }
  }

  export async function presentLogMenu(
    source: CommitSources,
    logOptions: LogEntryOptions,
    useBookmarks: boolean,
    commands: LogMenuAPI,
    back?: RunnableQuickPickItem
  ) {
    const entries = await commands.getLogEntries(logOptions);
    let result = await pickCommitAsShowCommitDetailsRunnable(
      source,
      entries,
      useBookmarks,
      commands,
      back
    );
    while (result) {
      result = await result.run();
    }
  }

  type BookmarkQuickPick = QuickPickItem & { bookmark: Bookmark };
  export async function pickBookmarkToRemove(
    bookmarks: Bookmark[]
  ): Promise<Bookmark | undefined> {
    const picks = bookmarks.map(
      b =>
        ({
          label: `$(bookmark) ${b.name}`,
          description: b.commit,
          bookmark: b
        } as BookmarkQuickPick)
    );
    const placeHolder = localize('pick bookmark', 'Pick a bookmark to remove:');
    const choice = await window.showQuickPick<BookmarkQuickPick>(picks, {
      placeHolder
    });
    if (choice) {
      return choice.bookmark;
    }

    return;
  }

  async function pickCommitAsShowCommitDetailsRunnable(
    source: CommitSources,
    entries: Commit[],
    useBookmarks: boolean,
    commands: LogMenuAPI,
    back?: RunnableQuickPickItem
  ): Promise<RunnableQuickPickItem | undefined> {
    const backhere = asBackItem(
      describeLogEntrySource(source).toLowerCase(),
      () =>
        pickCommitAsShowCommitDetailsRunnable(
          source,
          entries,
          useBookmarks,
          commands,
          back
        )
    );
    const commitPickedActionFactory = (commit: Commit) => async () => {
      const details = await commands.getCommitDetails(commit.hash);
      return interaction.presentCommitDetails(details, backhere, commands);
    };

    const choice = await pickCommit(
      source,
      entries,
      useBookmarks,
      commitPickedActionFactory,
      back
    );
    return choice;
  }

  export async function pickCommit(
    source: CommitSources,
    logEntries: Commit[],
    useBookmarks: boolean,
    actionFactory: (commit) => RunnableAction,
    backItem?: RunnableQuickPickItem
  ): Promise<RunnableQuickPickItem | undefined> {
    const logEntryPickItems = logEntries.map(
      entry => new LogEntryItem(entry, useBookmarks, actionFactory(entry))
    );
    const placeHolder = describeLogEntrySource(source);
    const pickItems = backItem
      ? [backItem, ...logEntryPickItems]
      : logEntryPickItems;
    const choice = await window.showQuickPick<RunnableQuickPickItem>(
      pickItems,
      {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true
      }
    );

    return choice;
  }

  export async function presentCommitDetails(
    details: CommitDetails,
    back: RunnableQuickPickItem,
    commands: LogMenuAPI
  ): Promise<RunnableQuickPickItem | undefined> {
    const placeHolder = describeCommitOneLine(details);
    const fileActionFactory = (f: IFileStatus) => () => {
      return commands.diffToParent(f, details);
    };
    const filePickItems = details.files.map(
      f => new FileStatusQuickPickItem(f, details, fileActionFactory(f))
    );
    const backToSelfRunnable = () =>
      presentCommitDetails(details, back, commands);
    const items = [
      back,
      asLabelItem('Files', undefined, backToSelfRunnable),
      ...filePickItems
    ];

    const choice = await window.showQuickPick<RunnableQuickPickItem>(items, {
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder
    });

    return choice;
  }

  export async function pickLogSource(
    repoName: string,
    branchName: string | undefined
  ): Promise<LogSourcePickItem | undefined> {
    const branchLabel: string = '$(git-branch)'; //localize('branch', 'branch');
    const repoLabel: string = `$(repo)`; // ${localize('repo', 'repo')}`;
    const branch: LogSourcePickItem = {
      description: branchLabel,
      label: branchName || '???',
      source: CommitSources.Branch,
      options: { branch: '.' }
    };
    const default_: LogSourcePickItem = {
      description: branchLabel,
      label: 'default',
      source: CommitSources.Branch,
      options: { branch: 'default' }
    };
    const repo: LogSourcePickItem = {
      description: repoLabel,
      label: 'entire repo',
      source: CommitSources.Repo,
      options: {}
    };

    const pickItems =
      branchName !== 'default' ? [branch, default_, repo] : [branch, repo];

    const choice = await window.showQuickPick<LogSourcePickItem>(pickItems, {
      placeHolder: localize('history for', 'Show history for...')
    });

    return choice;
  }

  export async function pickRemotePath(
    paths: Path[]
  ): Promise<string | undefined> {
    const picks = paths.map(
      p => ({ label: p.name, description: p.url } as QuickPickItem)
    );
    const placeHolder = localize('pick remote', 'Pick a remote to push to:');
    const choice = await window.showQuickPick<QuickPickItem>(picks, {
      placeHolder
    });
    if (choice) {
      return choice.label;
    }

    return;
  }

  export function warnUnresolvedFiles(unresolvedCount: number) {
    const fileOrFiles =
      unresolvedCount === 1
        ? localize('file', 'file')
        : localize('files', 'files');
    window.showWarningMessage(
      localize(
        'unresolved files',
        'Merge leaves {0} {1} unresolved.',
        unresolvedCount,
        fileOrFiles
      )
    );
  }

  export async function confirmRollback({
    revision,
    kind,
    commitDetails: _
  }: HgRollbackDetails) {
    // prompt
    const rollback = 'Rollback';
    const message = localize(
      'rollback',
      'Rollback to revision {0}? (undo {1})',
      revision,
      kind
    );
    const choice = await window.showInformationMessage(
      message,
      { modal: true },
      rollback
    );
    return choice === rollback;
  }

  export async function inputCommitMessage(
    message: string,
    defaultMessage?: string
  ) {
    if (message) {
      return message;
    }

    return await window.showInputBox({
      value: defaultMessage,
      placeHolder: localize('commit message', 'Commit message'),
      prompt: localize(
        'provide commit message',
        'Please provide a commit message'
      ),
      ignoreFocusOut: true
    });
  }

  export async function confirmDiscardAllChanges(this: void): Promise<boolean> {
    const message = localize(
      'confirm discard all',
      'Are you sure you want to discard ALL changes?'
    );
    const discard = localize('discard', 'Discard Changes');
    const choice = await window.showWarningMessage(
      message,
      { modal: true },
      discard
    );
    return choice === discard;
  }

  export async function confirmForceSetBookmark(
    bookmark: string
  ): Promise<boolean> {
    const message = localize(
      'confirm discard all',
      "Bookmark '{0}' already exists. Force?",
      bookmark
    );
    const force = localize('force', 'Force');
    const choice = await window.showWarningMessage(
      message,
      { modal: true },
      force
    );
    return choice === force;
  }

  export async function confirmDiscardChanges(
    discardFilesnames: string[],
    addedFilenames: string[]
  ): Promise<boolean> {
    let message: string;
    let addedMessage: string = '';
    if (addedFilenames.length > 0) {
      if (addedFilenames.length === 1) {
        addedMessage = localize(
          'and forget',
          "\n\n(and forget added file '{0}')",
          path.basename(addedFilenames[0])
        );
      } else {
        addedMessage = localize(
          'and forget multiple',
          '\n\n(and forget {0} other added files)',
          addedFilenames.length
        );
      }
    }

    if (discardFilesnames.length === 1) {
      message = localize(
        'confirm discard',
        "Are you sure you want to discard changes to '{0}'?{1}",
        path.basename(discardFilesnames[0]),
        addedMessage
      );
    } else {
      const fileList = humanise.formatFilesAsBulletedList(discardFilesnames);
      message = localize(
        'confirm discard multiple',
        'Are you sure you want to discard changes to {0} files?\n\n{1}{2}',
        discardFilesnames.length,
        fileList,
        addedMessage
      );
    }

    const discard = localize('discard', 'Discard Changes');
    const choice = await window.showWarningMessage(
      message,
      { modal: true },
      discard
    );
    return choice === discard;
  }

  export async function confirmDeleteMissingFilesForCommit(
    filenames: string[]
  ): Promise<boolean> {
    let message: string;
    if (filenames.length === 1) {
      message = localize(
        'confirm delete missing',
        "Did you want to delete '{0}' in this commit?",
        path.basename(filenames[0])
      );
    } else {
      const fileList = humanise.formatFilesAsBulletedList(filenames);
      message = localize(
        'confirm delete missing multiple',
        'Did you want to delete {0} missing files in this commit?\n\n{1}',
        filenames.length,
        fileList
      );
    }

    const deleteOption = localize('delete', 'Delete');
    const choice = await window.showWarningMessage(
      message,
      { modal: true },
      deleteOption
    );
    return choice === deleteOption;
  }

  export async function handleChoices(
    stdout: string,
    limit: number
  ): Promise<string> {
    /* other [merge rev] changed letters.txt which local [working copy] deleted
    use (c)hanged version, leave (d)eleted, or leave (u)nresolved*/
    const [options, prompt, ..._] = stdout.split('\n').reverse();
    const choices: string[] = [];
    if (options.includes('(c)hanged')) {
      choices.push(USE_CHANGED);
    }
    if (options.includes('leave (d)eleted')) {
      choices.push(LEAVE_DELETED);
    }
    if (options.match(/\(d\)elete\b/)) {
      choices.push(DELETE);
    }
    if (options.includes('(u)nresolved')) {
      choices.push(LEAVE_UNRESOLVED);
    }

    const choice = await window.showQuickPick(choices, {
      ignoreFocusOut: true,
      placeHolder: prompt
    });
    switch (choice) {
      case USE_CHANGED:
        return 'c';

      case DELETE:
      case LEAVE_DELETED:
        return 'd';

      case LEAVE_UNRESOLVED:
      default:
        return 'u';
    }
  }

  export function errorUntrackedFilesDiffer(filenames: string[]) {
    const fileList = humanise.formatFilesAsBulletedList(filenames);
    const message = localize(
      'untracked files differ',
      'Merge failed!\n\nUntracked files in your working directory would be overwritten by files of the same name from the merge revision:\n\n{0}\n\nEither track these files, move them, or delete them before merging.',
      fileList
    );
    window.showErrorMessage(message, { modal: true });
  }
}

abstract class RunnableQuickPickItem implements QuickPickItem {
  abstract get label();
  abstract get description();
  abstract run(): RunnableReturnType;
}

class CommitItem implements RunnableQuickPickItem {
  constructor(
    public readonly commit: Commit,
    protected useBookmarks: boolean
  ) {}
  get shortHash() {
    return (this.commit.hash || '').substr(0, SHORT_HASH_LENGTH);
  }
  get label() {
    if (this.useBookmarks) {
      if (this.commit.bookmarks.length) {
        const bookmarks = this.commit.bookmarks.join(', ');
        return `$(bookmark) ${bookmarks}`;
      }
      return '';
    } else {
      return this.commit.branch;
    }
  }
  get detail() {
    return `${this.commit.revision}(${this.shortHash}) `;
  }
  get description() {
    return this.commit.message;
  }
  run() {}
}

class LogEntryItem extends CommitItem {
  constructor(
    commit: Commit,
    useBookmarks: boolean,
    private action: RunnableAction
  ) {
    super(commit, useBookmarks);
  }
  protected get age(): string {
    return humanise.ageFromNow(this.commit.date);
  }
  get description() {
    let scope: string = '';
    if (this.useBookmarks) {
      if (this.commit.bookmarks.length) {
        scope = '\u2014 $(bookmark) ' + this.commit.bookmarks.join(', ');
      }
    } else {
      scope = '\u2014 ' + this.commit.branch;
    }
    return `${NBSP}${BULLET}${NBSP}${NBSP}#${this.commit.revision}${scope}`;
  }
  get label() {
    return this.commit.message;
  }
  get detail() {
    return `${NBSP}${NBSP}${NBSP}${this.commit.author}, ${this.age}`;
  }
  run() {
    return this.action();
  }
}

class UpdateRefItem implements QuickPickItem {
  protected get shortCommit(): string {
    return (this.ref.commit || '').substr(0, SHORT_HASH_LENGTH);
  }
  protected get treeish(): string | undefined {
    return this.ref.name;
  }
  protected get icon(): string {
    return '';
  }
  get label(): string {
    return `${this.icon}${this.ref.name || this.shortCommit}`;
  }
  get description(): string {
    return this.shortCommit;
  }

  constructor(protected ref: Ref) {}

  async run(repository: Repository): Promise<void> {
    const ref = this.treeish;

    if (!ref) {
      return;
    }

    await repository.update(ref);
  }
}

class UpdateTagItem extends UpdateRefItem {
  protected get icon(): string {
    return '$(tag) ';
  }
  get description(): string {
    return localize('tag at', 'Tag at {0}', this.shortCommit);
  }
}

class UpdateBookmarkItem extends UpdateRefItem {
  protected get icon(): string {
    return '$(bookmark) ';
  }
}

class FileStatusQuickPickItem extends RunnableQuickPickItem {
  get basename(): string {
    return path.basename(this.status.path);
  }
  get label(): string {
    return `${NBSP}${NBSP}${NBSP}${NBSP}${this.icon}${NBSP}${NBSP}${this.basename}`;
  }
  get description(): string {
    return path.dirname(this.status.path);
  }
  get icon(): string {
    switch (this.status.status) {
      case 'A':
        return 'Ａ'; //'$(diff-added)';
      case 'M':
        return 'Ｍ'; //'$(diff-modified)';
      case 'R':
        return 'Ｒ'; //'$(diff-removed)';
      default:
        return '';
    }
  }

  constructor(
    private status: IFileStatus,
    private commitDetails: CommitDetails,
    private action: RunnableAction
  ) {
    super();
  }

  async run(): Promise<void> {
    return this.action();
  }
}

interface LogSourcePickItem extends QuickPickItem {
  options: LogEntryOptions;
  source: CommitSources;
}

class LiteralRunnableQuickPickItem extends RunnableQuickPickItem {
  constructor(
    private _label: string,
    private _description: string,
    private _action: RunnableAction
  ) {
    super();
  }

  get label() {
    return this._label;
  }
  get description() {
    return this._description;
  }

  run(): RunnableReturnType {
    return this._action();
  }
}

type RunnableReturnType = Promise<any> | any;
export type RunnableAction = () => RunnableReturnType;
export type DescribedBackAction = {
  description: string;
  action: RunnableAction;
};
export interface LogMenuAPI {
  getRepoName: () => string;
  getBranchName: () => string | undefined;
  getCommitDetails: (revision: string) => Promise<CommitDetails>;
  getLogEntries(options: LogEntriesOptions): Promise<Commit[]>;
  diffToLocal: (file: IFileStatus, commit: CommitDetails) => any;
  diffToParent: (file: IFileStatus, commit: CommitDetails) => any;
}
