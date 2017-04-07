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
const path = require("path");
const http = require("http");
class Askpass {
    constructor() {
        this.server = http.createServer((req, res) => this.onRequest(req, res));
        this.server.listen(0, 'localhost');
        this.portPromise = new Promise(c => {
            this.server.on('listening', () => c(this.server.address().port));
        });
        this.server.on('error', err => console.error(err));
    }
    onRequest(req, res) {
        const chunks = [];
        req.setEncoding('utf8');
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            const { request, host } = JSON.parse(chunks.join(''));
            this.prompt(host, request).then(result => {
                res.writeHead(200);
                res.end(JSON.stringify(result));
            }, () => {
                res.writeHead(500);
                res.end();
            });
        });
    }
    prompt(host, request) {
        return __awaiter(this, void 0, void 0, function* () {
            const options = {
                password: /password/i.test(request),
                placeHolder: request,
                prompt: `Git: ${host}`,
                ignoreFocusOut: true
            };
            return (yield vscode_1.window.showInputBox(options)) || '';
        });
    }
    getEnv() {
        return this.portPromise.then(port => ({
            ELECTRON_RUN_AS_NODE: '1',
            GIT_ASKPASS: path.join(__dirname, 'askpass.sh'),
            VSCODE_GIT_ASKPASS_NODE: process.execPath,
            VSCODE_GIT_ASKPASS_MAIN: path.join(__dirname, 'askpass-main.js'),
            VSCODE_GIT_ASKPASS_PORT: String(port)
        }));
    }
    dispose() {
        this.server.close();
    }
}
exports.Askpass = Askpass;
//# sourceMappingURL=askpass.js.map