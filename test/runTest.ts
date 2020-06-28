import * as path from 'path';
import * as tmp from 'tmp';

import { runTests } from 'vscode-test';
import { tmpName } from 'tmp';

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to the extension test runner script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Set up test directory
    tmp.setGracefulCleanup();
    const testWorkspace = tmp.dirSync().name;

    console.info(`Using workspace: ${testWorkspace}`);

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: extensionTestsPath,
      launchArgs: [
        testWorkspace,
        '--disable-extensions'
      ]
    });
  } catch (err) {
    console.error(err);
    console.error('Failed to run tests');
    process.exit(1);
  }
}

main();