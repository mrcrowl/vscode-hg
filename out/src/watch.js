/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = require("vscode");
const fs = require("fs");
function watch(path) {
    const emitter = new vscode_1.EventEmitter();
    const event = emitter.event;
    const watcher = fs.watch(path, (eventType, filename) => emitter.fire({ eventType, filename }));
    const disposable = new vscode_1.Disposable(() => watcher.close());
    return { event, disposable };
}
exports.watch = watch;
//# sourceMappingURL=watch.js.map