/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
const decorators_1 = require("./decorators");
class AutoFetcher {
    constructor(model) {
        this.model = model;
        this.disposables = [];
        vscode_1.workspace.onDidChangeConfiguration(this.onConfiguration, this, this.disposables);
        this.onConfiguration();
    }
    onConfiguration() {
        const hgConfig = vscode_1.workspace.getConfiguration('hg');
        if (hgConfig.get('autofetch') === false) {
            this.disable();
        }
        else {
            this.enable();
        }
    }
    enable() {
        if (this.timer) {
            return;
        }
        this.fetch();
        this.timer = setInterval(() => this.fetch(), AutoFetcher.Period);
    }
    disable() {
        clearInterval(this.timer);
    }
    fetch() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.model.fetch();
            }
            catch (err) {
                if (err.hgErrorCode === hg_1.HgErrorCodes.AuthenticationFailed) {
                    this.disable();
                }
            }
        });
    }
    dispose() {
        this.disable();
        this.disposables.forEach(d => d.dispose());
    }
}
AutoFetcher.Period = 3 * 60 * 1000 /* three minutes */;
__decorate([
    decorators_1.throttle
], AutoFetcher.prototype, "fetch", null);
exports.AutoFetcher = AutoFetcher;
//# sourceMappingURL=autofetch.js.map