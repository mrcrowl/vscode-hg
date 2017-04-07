/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { workspace, Disposable } from 'vscode';
import { HgErrorCodes } from './hg';
import { Model } from './model';
import { throttle } from './decorators';

export class AutoIncoming {

	private static Period = 3 * 60 * 1000 /* three minutes */;
	private disposables: Disposable[] = [];
	private timer: NodeJS.Timer;

	constructor(private model: Model) {
		workspace.onDidChangeConfiguration(this.onConfiguration, this, this.disposables);
		this.onConfiguration();
	}

	private onConfiguration(): void {
		const hgConfig = workspace.getConfiguration('hg');

		if (hgConfig.get<boolean>('autoincoming') === false) {
			this.disable();
		} else {
			this.enable();
		}
	}

	enable(): void {
		if (this.timer) {
			return;
		}

		this.incoming();
		this.timer = setInterval(() => this.incoming(), AutoIncoming.Period);
	}

	disable(): void {
		clearInterval(this.timer);
	}

	@throttle
	private async incoming(): Promise<void> {
		try {
			await this.model.incoming();
		} catch (err) {
			if (err.hgErrorCode === HgErrorCodes.AuthenticationFailed) {
				this.disable();
			}
		}
	}

	dispose(): void {
		this.disable();
		this.disposables.forEach(d => d.dispose());
	}
}
