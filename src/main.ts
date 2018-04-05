/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// based on https://github.com/Microsoft/vscode/commit/41f0ff15d7327da30fdae73aa04ca570ce34fa0a

import { ExtensionContext, workspace, window, Disposable, commands, Uri, OutputChannel } from 'vscode';
import { HgFinder, Hg, IHg, HgFindAttemptLogger } from './hg';
import { Model } from './model';
import { CommandCenter } from './commands';
import { HgContentProvider } from './contentProvider';
import * as nls from 'vscode-nls';
import typedConfig from './config';

import { LineTracker } from './lineTracker';

const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

async function init(context: ExtensionContext, disposables: Disposable[]): Promise<void> {
	const { name, version, aiKey } = require(context.asAbsolutePath('./package.json')) as { name: string, version: string, aiKey: string };

	const outputChannel = window.createOutputChannel('Hg');
	disposables.push(outputChannel);

	const enabled = typedConfig.enabled;
	const enableInstrumentation = typedConfig.instrumentation;
	const pathHint = typedConfig.path;
	const info: IHg = await findHg(pathHint, outputChannel);
	const hg = new Hg({ hgPath: info.path, version: info.version, enableInstrumentation });
	const model = new Model(hg);
	disposables.push(model);

	const onRepository = () => commands.executeCommand('setContext', 'hgOpenRepositoryCount', model.repositories.length);
	model.onDidOpenRepository(onRepository, null, disposables);
	model.onDidCloseRepository(onRepository, null, disposables);
	onRepository();

	if (!enabled)
	{
		const commandCenter = new CommandCenter(hg, model, outputChannel);
		disposables.push(commandCenter);
		return;
	}

	outputChannel.appendLine(localize('using hg', "Using hg {0} from {1}", info.version, info.path));
	hg.onOutput(str => outputChannel.append(str), null, disposables);

	disposables.push(
		new CommandCenter(hg, model, outputChannel),
		new HgContentProvider(model),
	);

	disposables.push(new LineTracker(hg, model));

	await checkHgVersion(info);
}

export async function findHg(pathHint: string | undefined, outputChannel: OutputChannel): Promise<IHg> {
	const logger = {
		attempts: <string[]>[],
		log: (path: string) => logger.attempts.push(path)
	}

	try {
		const finder = new HgFinder(logger);
		return await finder.find(pathHint);
	}
	catch (e) {
		outputChannel.appendLine("Could not find hg, tried:")
		logger.attempts.forEach(attempt => outputChannel.appendLine(` - ${attempt}`));
		throw e;
	}
}

export function activate(context: ExtensionContext) {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	init(context, disposables)
		.catch(err => console.error(err));
}

async function checkHgVersion(info: IHg): Promise<void> {
	if (/^[01]/.test(info.version)) {
		const update = localize('updateHg', "Update Hg");
		const choice = await window.showWarningMessage(localize('hg20', "You seem to have hg {0} installed. Code works best with hg >= 2", info.version), update);

		if (choice === update) {
			commands.executeCommand('vscode.open', Uri.parse('https://mercurial-scm.org/'));
		}
	}
}