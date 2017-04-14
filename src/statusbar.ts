/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Disposable, Command, EventEmitter, Event } from 'vscode';
import { RefType, Branch } from './hg';
import { Model, Operation } from './model';
import { anyEvent, dispose } from './util';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

class BranchStatusBar {

	private _onDidChange = new EventEmitter<void>();
	get onDidChange(): Event<void> { return this._onDidChange.event; }
	private disposables: Disposable[] = [];

	constructor(private model: Model) {
		model.onDidChange(this._onDidChange.fire, this._onDidChange, this.disposables);
	}

	get command(): Command | undefined {
		const branch = this.model.parent;

		if (!branch) {
			return undefined;
		}

		const branchName = branch.name || (branch.commit || '').substr(0, 8);
		const title = '$(hg-branch) '
			+ branchName
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
	isSyncRunning: boolean;
	hasPaths: boolean;
	branch: Branch | undefined;
	syncCounts: { incoming: number, outgoing: number };
}

class SyncStatusBar {

	private static StartState: SyncStatusBarState = {
		isSyncRunning: false,
		hasPaths: false,
		branch: undefined,
		syncCounts: {incoming: 0, outgoing: 0} 
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

	private onOperationsChange(): void {
		const isPushing = this.model.operations.isRunning(Operation.Push);
		const isPulling = this.model.operations.isRunning(Operation.Pull);

		this.state = {
			...this.state,
			isSyncRunning: isPushing || isPulling
		};
	}

	private onModelChange(): void {
		this.state = {
			...this.state,
			hasPaths: this.model.paths.length > 0,
			branch: this.model.parent,
			syncCounts: this.model.syncCounts
		};
	}

	get command(): Command | undefined {
		if (!this.state.hasPaths) {
			return undefined;
		}

		const branch = this.state.branch;
		let icon = '$(sync) $(check)';
		let text = '';
		let command = '';
		let tooltip = 'Sync is up to date';
		let syncCounts = this.state.syncCounts;

		if (branch) {
			if (syncCounts && syncCounts.incoming) {
				text = `${syncCounts.incoming}↓ ${syncCounts.outgoing}↑`;
				icon = '$(cloud-download)';
				command = 'hg.pull';
				tooltip = localize('pull changes', "Pull changes");
			} else if (syncCounts && syncCounts.outgoing) {
				text = `${syncCounts.incoming}↓ ${syncCounts.outgoing}↑`;
				icon = '$(cloud-upload)';
				command = 'hg.push';
				tooltip = localize('push changes', "Push changes");
			}
		} else {
			command = '';
			tooltip = '';
		}

		if (this.state.isSyncRunning) {
			icon = '$(sync)';
			text = '';
			command = '';
			tooltip = localize('syncing changes', "Synchronizing changes...");
		}

		return {
			command,
			title: [icon, text].join(' ').trim(),
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