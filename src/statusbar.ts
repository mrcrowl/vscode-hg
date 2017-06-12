/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Command, EventEmitter, Event, workspace } from "vscode";
import { RefType, Ref, Repository, Bookmark, IRepoStatus } from "./hg";
import { Model, Operation } from './model';
import { anyEvent, dispose } from './util';
import { AutoInOutStatuses, AutoInOutState } from "./autoinout";
import * as nls from 'vscode-nls';
import typedConfig from "./config";
import { activate } from "./main";

const localize = nls.loadMessageBundle();
const enum SyncStatus { None = 0, Pushing = 1, Pulling = 2 }

interface CurrentRef {
	ref: Ref | undefined;
	icon: string;
}

class ScopeStatusBar {

	private _onDidChange = new EventEmitter<void>();
	get onDidChange(): Event<void> { return this._onDidChange.event; }
	private disposables: Disposable[] = [];

	constructor(private model: Model) {
		model.onDidChange(this._onDidChange.fire, this._onDidChange, this.disposables);
	}

	chooseCurrentRef(useBookmarks: boolean, currentBranch: Ref | undefined, activeBookmark: Bookmark | undefined, repoStatus: IRepoStatus | undefined): CurrentRef {
		const mergeIcon = (repoStatus && repoStatus.isMerge) ? "$(git-merge)" : "";

		if (useBookmarks) {
			if (activeBookmark) {
				return { ref: activeBookmark, icon: mergeIcon || '$(bookmark)' };
			}
			else if (repoStatus) {
				return { ref: repoStatus.parents[0], icon: mergeIcon || '$(issue-opened)' };
			}
			else {
				return { ref: { type: RefType.Commit, name: "" }, icon: mergeIcon || '$(issue-opened)' };
			}
		}
		else {
			return { ref: currentBranch, icon: mergeIcon || '$(git-branch)' };
		}
	}

	get command(): Command | undefined {
		const useBookmarks = typedConfig.useBookmarks
		const { currentBranch, activeBookmark, repoStatus } = this.model
		const currentRef: CurrentRef = this.chooseCurrentRef(useBookmarks, currentBranch, activeBookmark, repoStatus);

		if (!currentRef.ref) {
			return undefined
		}

		const label = (currentRef.ref.name || currentRef.ref.commit)!;
		const title =
			currentRef.icon + ' ' +
			label +
			(this.model.workingDirectoryGroup.resources.length > 0 ? '+' : '') +
			(this.model.mergeGroup.resources.length > 0 ? '!' : '');

		return {
			command: 'hg.update',
			tooltip: localize('update', 'Update...'),
			title
		};
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

interface SyncStatusBarState {
	autoInOut: AutoInOutState;
	syncStatus: SyncStatus;
	nextCheckTime: Date;
	hasPaths: boolean;
	branch: Ref | undefined;
	bookmark: Bookmark | undefined;
	syncCounts: { incoming: number, outgoing: number };
}

class SyncStatusBar {

	private static StartState: SyncStatusBarState = {
		autoInOut: {
			status: AutoInOutStatuses.Disabled,
			error: ""
		},
		nextCheckTime: new Date(),
		syncStatus: SyncStatus.None,
		hasPaths: false,
		branch: undefined,
		bookmark: undefined,
		syncCounts: { incoming: 0, outgoing: 0 }
	};

	private _onDidChange = new EventEmitter<void>();
	get onDidChange(): Event<void> { return this._onDidChange.event; }
	private disposables: Disposable[] = [];

	private _state: SyncStatusBarState = SyncStatusBar.StartState;
	private get state() { return this._state; }
	private set state(state: SyncStatusBarState) {
		this._state = state;
		this._onDidChange.fire();
	}

	constructor(private model: Model) {
		model.onDidChange(this.onModelChange, this, this.disposables);
		model.onDidChangeOperations(this.onOperationsChange, this, this.disposables);
		this._onDidChange.fire();
	}

	private getSyncStatus(): SyncStatus {
		if (this.model.operations.isRunning(Operation.Push)) {
			return SyncStatus.Pushing;
		}

		if (this.model.operations.isRunning(Operation.Pull)) {
			return SyncStatus.Pulling;
		}

		return SyncStatus.None;
	}

	private onOperationsChange(): void {
		this.state = {
			...this.state,
			syncStatus: this.getSyncStatus(),
			autoInOut: this.model.autoInOutState
		};
	}

	private onModelChange(): void {
		this.state = {
			...this.state,
			hasPaths: this.model.paths.length > 0,
			branch: this.model.currentBranch,
			bookmark: this.model.activeBookmark,
			syncCounts: this.model.syncCounts,
			autoInOut: this.model.autoInOutState
		};
	}

	private describeAutoInOutStatus(refName: string | undefined): { icon: string, message?: string, status: AutoInOutStatuses } {
		const { autoInOut } = this.state;
		switch (autoInOut.status) {
			case AutoInOutStatuses.Enabled:
				if (autoInOut.nextCheckTime) {
					const time = autoInOut.nextCheckTime.toLocaleTimeString();
					const message = refName ?
						localize('synced next check scoped', '{0} is synced (next check {1})', refName, time) :
						localize('synced next check', 'Synced (next check {0})', time);

					return { icon: '$(check)', message, status: AutoInOutStatuses.Enabled };
				}
				else {
					return { icon: '', message: '', status: AutoInOutStatuses.Enabled };
				}

			case AutoInOutStatuses.Error:
				return { icon: '$(stop)', message: `${localize('remote error', 'Remote error')}: ${autoInOut.error}`, status: AutoInOutStatuses.Error };

			case AutoInOutStatuses.Disabled:
			default:
				const message = refName ?
					localize('pull scoped', 'Pull ({0} only)', refName) :
					localize('pull', 'Pull');
				return { icon: '$(cloud-download)', message, status: AutoInOutStatuses.Disabled };
		}
	}

	get command(): Command | undefined {
		if (!this.state.hasPaths) {
			return undefined;
		}

		const { pushPullBranchName, pushPullBookmarkName } = this.model;
		const { bookmark, branch } = this.state;
		const useBookmarks = typedConfig.useBookmarks;
		const scopeName = useBookmarks ? pushPullBookmarkName : pushPullBranchName;
		let autoInOut = this.describeAutoInOutStatus(scopeName);
		let icon = autoInOut.icon;
		let text = '';
		let command = 'hg.pull';
		let tooltip = autoInOut.message;
		let syncCounts = this.state.syncCounts;
		let plural = '';

		if ((branch && !useBookmarks) || (bookmark && useBookmarks)) {
			if (syncCounts && syncCounts.incoming) {
				text = `${syncCounts.incoming}↓ ${syncCounts.outgoing}↑`;
				icon = '$(cloud-download)';
				command = 'hg.pull';
				plural = (syncCounts.incoming === 1) ? '' : 's';
				tooltip = scopeName ?
					localize('pull changesets scoped', "Pull {0} changeset{1} ({2} only)", syncCounts.incoming, plural, scopeName) :
					localize('pull changesets', "Pull {0} changeset{1}", syncCounts.incoming, plural);
			}
			else if (syncCounts && syncCounts.outgoing) {
				if (autoInOut.status === AutoInOutStatuses.Enabled) {
					text = `${syncCounts.incoming}↓ ${syncCounts.outgoing}↑`;
				}
				else {
					text = `${syncCounts.outgoing}`;
				}
				icon = '$(cloud-upload)';
				command = 'hg.push';
				plural = (syncCounts.outgoing === 1) ? '' : 's';
				tooltip = scopeName ?
					localize('push changesets scoped', "Push {0} changeset{1} ({2} only)", syncCounts.outgoing, plural, scopeName) :
					localize('push changesets', "Push {0} changeset{1}", syncCounts.outgoing, plural);
			}
		} else {
			command = '';
			tooltip = '';
		}

		const { syncStatus } = this.state;
		if (syncStatus) {
			icon = '$(sync~spin)'
			text = '';
			command = '';
			tooltip = (syncStatus === SyncStatus.Pushing) ?
				localize('pushing', "Pushing changes...") :
				localize('pulling', "Pulling changes...");
		}

		return {
			command,
			title: `${icon} ${text}`.trim(),
			tooltip
		};
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

export class StatusBarCommands {

	private syncStatusBar: SyncStatusBar;
	private scopeStatusBar: ScopeStatusBar;
	private disposables: Disposable[] = [];

	constructor(model: Model) {
		this.syncStatusBar = new SyncStatusBar(model);
		this.scopeStatusBar = new ScopeStatusBar(model);
	}

	get onDidChange(): Event<void> {
		return anyEvent(
			this.syncStatusBar.onDidChange,
			this.scopeStatusBar.onDidChange
		);
	}

	get commands(): Command[] {
		const result: Command[] = [];

		const update = this.scopeStatusBar.command;

		if (update) {
			result.push(update);
		}

		const sync = this.syncStatusBar.command;

		if (sync) {
			result.push(sync);
		}

		return result;
	}

	dispose(): void {
		this.syncStatusBar.dispose();
		this.scopeStatusBar.dispose();
		this.disposables = dispose(this.disposables);
	}
}