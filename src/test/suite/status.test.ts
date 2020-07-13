/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "mocha";
import * as assert from "assert";
import { commands, Uri, extensions } from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as tmp from "tmp";
import { Model } from "../../model";
import { eventToPromise } from "../../util";
import { Repository } from "../../repository";

// Defines a Mocha test suite to group tests of similar kind together
suite("hg", () => {
    // Set up test directory
    tmp.setGracefulCleanup();
    const testWorkspace = tmp.dirSync().name;

    console.info(`Using workspace: ${testWorkspace}`);

    const testWorkspaceUri = Uri.file(testWorkspace);
    const cwd = fs.realpathSync(testWorkspaceUri.fsPath);

    let hg: Model;
    let repository: Repository;

    function file(relativePath: string) {
        return path.join(cwd, relativePath);
    }

    suiteSetup(async function () {
        console.log("Suite setup");
        cp.execSync("hg init", { cwd });

        // make sure hg is activated
        const ext = extensions.getExtension("mrcrowl.hg");
        hg = await ext?.activate();
        hg.tryOpenRepository(cwd);

        if (hg.repositories.length === 0) {
            await eventToPromise(hg.onDidOpenRepository);
        }

        assert.equal(hg.repositories.length, 1);

        repository = hg.repositories[0];
    });

    // Defines a Mocha unit test
    test("status works", async function () {
        this.enableTimeouts(false);
        fs.writeFileSync(file("text.txt"), "test", "utf8");

        assert.equal(fs.realpathSync(repository.root), cwd);

        await commands.executeCommand("workbench.view.scm");
        await repository.status();
        assert.equal(0, repository.stagingGroup.resources.length);
        assert.equal(1, repository.untrackedGroup.resources.length);

        await commands.executeCommand("hg.addAll");
        await repository.status();
        assert.equal(1, repository.workingDirectoryGroup.resources.length);
        assert.equal(0, repository.untrackedGroup.resources.length);
    });
});
