/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { workspace, commands, window, Uri, WorkspaceEdit, Range, TextDocument, extensions, scm } from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Model } from '../../src/model';
import { eventToPromise } from '../../src/util';
import { Repository } from '../../src/repository';

// Defines a Mocha test suite to group tests of similar kind together
suite("hg", () => {

	const cwd = fs.realpathSync(workspace.workspaceFolders![0].uri.fsPath);

	var hg: Model;
	var repository: Repository;

	function file(relativePath: string) {
		return path.join(cwd, relativePath);
	}

	function uri(relativePath: string) {
		return Uri.file(file(relativePath));
	}

	async function open(relativePath: string) {
		const doc = await workspace.openTextDocument(uri(relativePath));
		await window.showTextDocument(doc);
		return doc;
	}

	async function type(doc: TextDocument, text: string) {
		const edit = new WorkspaceEdit();
		const end = doc.lineAt(doc.lineCount - 1).range.end;
		edit.replace(doc.uri, new Range(end, end), text);
		await workspace.applyEdit(edit);
	}

    suiteSetup(async function() {
		console.log("Suite setup");
		cp.execSync('rm -rf .hg', { cwd });
		cp.execSync('hg init', { cwd });

		// make sure hg is activated
		const ext = extensions.getExtension('mrcrowl.hg');
		hg = await ext?.activate();

		if (hg.repositories.length === 0) {
			await eventToPromise(hg.onDidOpenRepository);
		}

		assert.equal(hg.repositories.length, 1);

		repository = hg.repositories[0];
	});
	
	// Defines a Mocha unit test
	test("status works", async function() {
		this.enableTimeouts(false);
		fs.writeFileSync(file('text.txt'), 'test', 'utf8');

		assert.equal(fs.realpathSync(repository.root), cwd);

		await commands.executeCommand('workbench.view.scm');
		await repository.status();
		assert.equal(0, repository.stagingGroup.resources.length);
		assert.equal(1, repository.untrackedGroup.resources.length);

		await commands.executeCommand('hg.addAll');
		await repository.status();
		assert.equal(1, repository.workingDirectoryGroup.resources.length);
		assert.equal(0, repository.untrackedGroup.resources.length);
	});
});