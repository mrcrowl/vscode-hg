/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// based on https://github.com/Microsoft/vscode/commit/41f0ff15d7327da30fdae73aa04ca570ce34fa0a

import { ExtensionContext, workspace, window, Disposable, commands, Uri, OutputChannel, WorkspaceFolder } from 'vscode';
import { HgFinder, Hg, IHg, HgFindAttemptLogger } from './hg';
import { Model } from './model';
import { CommandCenter } from './commands';
import { HgContentProvider } from './contentProvider';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as fs from 'fs';
import typedConfig from './config';

const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

async function isHgRepository(folder: WorkspaceFolder): Promise<boolean> {
	if (folder.uri.scheme !== 'file') {
		return false;
	}

	const dotHg = path.join(folder.uri.fsPath, '.hg');

	try {
		const dotHgStat = await new Promise<fs.Stats>((c, e) => fs.stat(dotHg, (err, stat) => err ? e(err) : c(stat)));
		return dotHgStat.isDirectory();
	} catch (err) {
		return false;
	}
}

async function warnAboutMissingHg(): Promise<void> {
	const config = workspace.getConfiguration('hg');
	const shouldIgnore = config.get<boolean>('ignoreMissingHgWarning') === true;

	if (shouldIgnore) {
		return;
	}

	if (!workspace.workspaceFolders) {
		return;
	}

	const areHgRepositories = await Promise.all(workspace.workspaceFolders.map(isHgRepository));

	if (areHgRepositories.every(isHgRepository => !isHgRepository)) {
		return;
	}

	const download = localize('downloadhg', "Download Hg");
	const neverShowAgain = localize('neverShowAgain', "Don't Show Again");
	const choice = await window.showWarningMessage(
		localize('notfound', "Hg not found. Install it or configure it using the 'hg.path' setting."),
		download,
		neverShowAgain
	);

	if (choice === download) {
		commands.executeCommand('vscode.open', Uri.parse('https://www.mercurial-scm.org/'));
	} else if (choice === neverShowAgain) {
		await config.update('ignoreMissingHgWarning', true, true);
	}
}

async function init(context: ExtensionContext, disposables: Disposable[]): Promise<void> {
	const { name, version, aiKey } = require(context.asAbsolutePath('./package.json')) as { name: string, version: string, aiKey: string };

	const outputChannel = window.createOutputChannel('Hg');
	commands.registerCommand('hg.showOutput', () => outputChannel.show());
	disposables.push(outputChannel);

	const enabled = typedConfig.enabled;
	const enableInstrumentation = typedConfig.instrumentation;
	const pathHint = typedConfig.path;

	try {
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
	
		await checkHgVersion(info);
	} catch (err) {
		if (!/Mercurial installation not found/.test(err.message || '')) {
			throw err;
		}

		console.warn(err.message);
		outputChannel.appendLine(err.message);

		commands.executeCommand('setContext', 'hg.missing', true);
		warnAboutMissingHg();
	}
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