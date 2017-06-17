/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, Disposable } from 'vscode';
import { HgErrorCodes, HgError } from "./hg";
import { Model, Operation, Operations } from "./model";
import { throttle } from './decorators';
import typedConfig from "./config";

export const enum AutoInOutStatuses {
	Disabled,
	Enabled,
	Error
}

export interface AutoInOutState {
	readonly status: AutoInOutStatuses;
	readonly nextCheckTime?: Date;
	readonly error?: string;
}

const STARTUP_DELAY = 3 * 1000 /* three seconds */;
const OPS_AFFECTING_IN_OUT = Operation.Commit | Operation.Rollback | Operation.Update | Operation.Push | Operation.Pull;
const opAffectsInOut = (op: Operation): boolean => (OPS_AFFECTING_IN_OUT & op) > 0;

export class AutoIncomingOutgoing {

	private disposables: Disposable[] = [];
	private timer: NodeJS.Timer | undefined;

	constructor(private model: Model) {
		workspace.onDidChangeConfiguration(this.onConfiguration, this, this.disposables);
		this.model.onDidChangeHgrc(this.onConfiguration, this, this.disposables);
		this.model.onDidRunOperation(this.onDidRunOperation, this, this.disposables);
		this.onConfiguration();
	}

	private onConfiguration(): void {
		if (typedConfig.autoInOut) {
			this.model.changeAutoInoutState({ status: AutoInOutStatuses.Enabled })
			this.enable();
		}
		else {
			this.model.changeAutoInoutState({ status: AutoInOutStatuses.Disabled })
			this.disable();
		}
	}

	enable(): void {
		if (this.enabled) {
			return;
		}

		setTimeout(() => this.refresh(), STARTUP_DELAY); // delay to let 'status' run first
		this.timer = setInterval(() => this.refresh(), typedConfig.autoInOutInterval);
	}

	disable(): void {
		if (!this.enabled) {
			return;
		}

		clearInterval(this.timer!);
		this.timer = undefined;
	}

	get enabled(): boolean { return this.timer !== undefined; }

	private onDidRunOperation(op: Operation): void {
		if (!this.enabled || !opAffectsInOut(op)) {
			return;
		}

		const pushPullBranchName = this.model.pushPullBranchName;
		switch (op) {
			case Operation.Push:
				const path = this.model.lastPushPath;
				if (!path || path === "default" || path === "default-push") {
					const delta = -this.model.syncCounts.outgoing;
					this.model.countOutgoingAfterDelay(delta);
				}
				break;

			case Operation.Pull:
				const delta = -this.model.syncCounts.incoming;
				this.model.countIncomingAfterDelay(delta);
				break;

			case Operation.Commit:
			case Operation.Rollback:
				const currentBranch = this.model.currentBranch;
				const affectsInOut =
					pushPullBranchName === undefined // all branches
					|| currentBranch && pushPullBranchName === currentBranch.name;

				if (affectsInOut) {
					const delta = (op === Operation.Commit) ? +1 : -1;
					this.model.countOutgoingAfterDelay(delta);
				}
				break;

			case Operation.Update:
				if (pushPullBranchName && pushPullBranchName !== "default") { // i.e. "current" setting
					const incoming = -this.model.syncCounts.incoming;
					const outgoing = -this.model.syncCounts.outgoing;
					this.model.countIncomingOutgoingAfterDelay({ incoming, outgoing })
				}

			default:
			// no-op
		}
	}

	@throttle
	private async refresh(): Promise<void> {
		const nextCheckTime = new Date(Date.now() + typedConfig.autoInOutInterval);
		this.model.changeAutoInoutState({ nextCheckTime });

		try {
			await this.model.countIncomingOutgoingAfterDelay();
		}
		catch (err) {
			if (err instanceof HgError && (
				err.hgErrorCode === HgErrorCodes.AuthenticationFailed ||
				err.hgErrorCode === HgErrorCodes.RepositoryIsUnrelated ||
				err.hgErrorCode === HgErrorCodes.RepositoryDefaultNotFound)) {
				this.disable();
			}
		}
	}

	dispose(): void {
		this.disable();
		this.disposables.forEach(d => d.dispose());
	}
}