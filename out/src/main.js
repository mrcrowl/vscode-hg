/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = require("vscode");
const hg_1 = require("./hg");
const model_1 = require("./model");
const scmProvider_1 = require("./scmProvider");
const commands_1 = require("./commands");
const statusbar_1 = require("./statusbar");
const contentProvider_1 = require("./contentProvider");
const autofetch_1 = require("./autofetch");
const merge_1 = require("./merge");
const askpass_1 = require("./askpass");
const vscode_extension_telemetry_1 = require("vscode-extension-telemetry");
const nls = require("vscode-nls");
const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();
function init(context, disposables) {
    return __awaiter(this, void 0, void 0, function* () {
        const { name, version, aiKey } = require(context.asAbsolutePath('./package.json'));
        const telemetryReporter = new vscode_extension_telemetry_1.default(name, version, aiKey);
        disposables.push(telemetryReporter);
        const outputChannel = vscode_1.window.createOutputChannel('Hg');
        disposables.push(outputChannel);
        const config = vscode_1.workspace.getConfiguration('hg');
        const enabled = config.get('enabled') === true;
        const workspaceRootPath = vscode_1.workspace.rootPath;
        const pathHint = vscode_1.workspace.getConfiguration('hg').get('path');
        const info = yield hg_1.findHg(pathHint);
        const askpass = new askpass_1.Askpass();
        const env = yield askpass.getEnv();
        const hg = new hg_1.Hg({ hgPath: info.path, version: info.version, env });
        if (!workspaceRootPath || !enabled) {
            const commandCenter = new commands_1.CommandCenter(hg, undefined, outputChannel, telemetryReporter);
            disposables.push(commandCenter);
            return;
        }
        const model = new model_1.Model(hg, workspaceRootPath);
        outputChannel.appendLine(localize('using hg', "Using hg {0} from {1}", info.version, info.path));
        hg.onOutput(str => outputChannel.append(str), null, disposables);
        const commandCenter = new commands_1.CommandCenter(hg, model, outputChannel, telemetryReporter);
        const statusBarCommands = new statusbar_1.StatusBarCommands(model);
        const provider = new scmProvider_1.MercurialSCMProvider(model, commandCenter, statusBarCommands);
        const contentProvider = new contentProvider_1.HgContentProvider(model);
        const autoFetcher = new autofetch_1.AutoFetcher(model);
        const mergeDecorator = new merge_1.MergeDecorator(model);
        disposables.push(commandCenter, provider, contentProvider, autoFetcher, mergeDecorator, model);
        if (/^[01]/.test(info.version)) {
            const update = localize('updateHg', "Update Hg");
            const choice = yield vscode_1.window.showWarningMessage(localize('hg20', "You seem to have hg {0} installed. Code works best with hg >= 2", info.version), update);
            if (choice === update) {
                vscode_1.commands.executeCommand('vscode.open', vscode_1.Uri.parse('https://mercurial-scm.org/'));
            }
        }
    });
}
function activate(context) {
    const disposables = [];
    context.subscriptions.push(new vscode_1.Disposable(() => vscode_1.Disposable.from(...disposables).dispose()));
    init(context, disposables)
        .catch(err => console.error(err));
}
exports.activate = activate;
//# sourceMappingURL=main.js.map