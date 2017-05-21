/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, Disposable } from 'vscode';
import { HgErrorCodes, HgError } from "./hg";
import { Model, Operation, Operations } from "./model";
import { throttle } from './decorators';

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
const INTERVAL = 3 * 60 * 1000 /* three minutes */;

export class AutoIncomingOutgoing {

	private disposables: Disposable[] = [];
	private timer: NodeJS.Timer;

	constructor(private model: Model) {
		workspace.onDidChangeConfiguration(this.onConfiguration, this, this.disposables);
		this.model.onDidChangeHgrc(this.onConfiguration, this, this.disposables);
		this.model.onDidRunOperation(this.onDidRunOperation, this, this.disposables);
		this.onConfiguration();
	}

	private onConfiguration(): void {
		const hgConfig = workspace.getConfiguration('hg');

		if (hgConfig.get<boolean>('autoInOut') === false) {
			this.model.changeAutoInoutState({ status: AutoInOutStatuses.Disabled })
			this.disable();
		}
		else {
			this.model.changeAutoInoutState({ status: AutoInOutStatuses.Enabled })
			this.enable();
		}
	}

	enable(): void {
		if (this.timer) {
			return;
		}

		setTimeout(() => this.refresh(), STARTUP_DELAY); // delay to let 'status' run first
		this.timer = setInterval(() => this.refresh(), INTERVAL);
	}

	disable(): void {
		clearInterval(this.timer);
	}

	private onDidRunOperation(op: Operation): void {
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
				this.model.countOutgoingAfterDelay(+1);
				break;

			case Operation.Rollback:
				this.model.countOutgoingAfterDelay(-1);
				break;

			default:
				// no-op
		}
	}

	@throttle
	private async refresh(): Promise<void> {
		const nextCheckTime = new Date(Date.now() + INTERVAL);
		this.model.changeAutoInoutState({ nextCheckTime });

		try {
			await this.model.countIncomingOutgoing();
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