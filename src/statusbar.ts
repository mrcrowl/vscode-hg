/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Command, EventEmitter, Event, workspace } from "vscode";
import { RefType, Branch } from './hg';
import { Model, Operation } from './model';
import { anyEvent, dispose } from './util';
import { AutoInOutStatuses, AutoInOutState } from "./autoinout";
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();
const enum SyncStatus { None = 0, Pushing = 1, Pulling = 2 }

class BranchStatusBar {

	private _onDidChange = new EventEmitter<void>();
	get onDidChange(): Event<void> { return this._onDidChange.event; }
	private disposables: Disposable[] = [];

	constructor(private model: Model) {
		model.onDidChange(this._onDidChange.fire, this._onDidChange, this.disposables);
	}

	get command(): Command | undefined {
		const { currentBranch: branch, repoStatus } = this.model;

		if (!branch) {
			return undefined;
		}

		const icon = repoStatus && repoStatus.isMerge ? '$(git-merge) ' : '$(git-branch) '

		const title = icon
			+ branch.name
			+ (this.model.workingDirectoryGroup.resources.length > 0 ? '+' : '')
			+ (this.model.mergeGroup.resources.length > 0 ? '!' : '');

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
	branch: Branch | undefined;
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
			syncCounts: this.model.syncCounts,
			autoInOut: this.model.autoInOutState
		};
	}

	private describeAutoInOutStatus(pushPullBranchName: string | undefined): { icon: string, message?: string, status: AutoInOutStatuses } {
		const { autoInOut } = this.state;
		switch (autoInOut.status) {
			case AutoInOutStatuses.Enabled:
				if (autoInOut.nextCheckTime) {
					const time = autoInOut.nextCheckTime.toLocaleTimeString();
					const message = pushPullBranchName ?
						localize('synced next check branch', '{0} is synced (next check {1})', pushPullBranchName, time) :
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
				const message = pushPullBranchName ?
					localize('pull branch', 'Pull ({0} only)', pushPullBranchName) :
					localize('pull', 'Pull');
				return { icon: '$(cloud-download)', message, status: AutoInOutStatuses.Disabled };
		}
	}

	get command(): Command | undefined {
		if (!this.state.hasPaths) {
			return undefined;
		}

		const pushPullBranchName = this.model.pushPullBranchName;
		const branch = this.state.branch;
		let autoInOut = this.describeAutoInOutStatus(pushPullBranchName);
		let icon = autoInOut.icon;
		let text = '';
		let command = 'hg.pull';
		let tooltip = autoInOut.message;
		let syncCounts = this.state.syncCounts;
		let plural = '';

		if (branch) {
			if (syncCounts && syncCounts.incoming) {
				text = `${syncCounts.incoming}↓ ${syncCounts.outgoing}↑`;
				icon = '$(cloud-download)';
				command = 'hg.pull';
				plural = (syncCounts.incoming === 1) ? '' : 's';
				tooltip = pushPullBranchName ?
					localize('pull changesets branch', "Pull {0} changeset{1} ({2} only)", syncCounts.incoming, plural, pushPullBranchName) :
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
				tooltip = pushPullBranchName ?
					localize('push changesets branch', "Push {0} changeset{1} ({2} only)", syncCounts.outgoing, plural, pushPullBranchName) :
					localize('push changesets', "Push {0} changeset{1}", syncCounts.outgoing, plural);
					
			}
		}
		else {
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
	private branchStatusBar: BranchStatusBar;
	private disposables: Disposable[] = [];

	constructor(model: Model) {
		this.syncStatusBar = new SyncStatusBar(model);
		this.branchStatusBar = new BranchStatusBar(model);
	}

	get onDidChange(): Event<void> {
		return anyEvent(
			this.syncStatusBar.onDidChange,
			this.branchStatusBar.onDidChange
		);
	}

	get commands(): Command[] {
		const result: Command[] = [];

		const update = this.branchStatusBar.command;

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
		this.branchStatusBar.dispose();
		this.disposables = dispose(this.disposables);
	}
}