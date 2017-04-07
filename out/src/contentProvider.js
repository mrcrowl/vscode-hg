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
const decorators_1 = require("./decorators");
const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;
class HgContentProvider {
    constructor(model) {
        this.model = model;
        this.onDidChangeEmitter = new vscode_1.EventEmitter();
        this.cache = Object.create(null);
        this.disposables = [];
        this.disposables.push(model.onDidChangeRepository(this.eventuallyFireChangeEvents, this), vscode_1.workspace.registerTextDocumentContentProvider('hg', this), vscode_1.workspace.registerTextDocumentContentProvider('hg-original', this));
        setInterval(() => this.cleanup(), FIVE_MINUTES);
    }
    get onDidChange() { return this.onDidChangeEmitter.event; }
    eventuallyFireChangeEvents() {
        this.fireChangeEvents();
    }
    fireChangeEvents() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.model.whenIdle();
            Object.keys(this.cache)
                .forEach(key => this.onDidChangeEmitter.fire(this.cache[key].uri));
        });
    }
    provideTextDocumentContent(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            const cacheKey = uri.toString();
            const timestamp = new Date().getTime();
            const cacheValue = { uri, timestamp };
            this.cache[cacheKey] = cacheValue;
            if (uri.scheme === 'hg-original') {
                uri = new vscode_1.Uri().with({ scheme: 'hg', path: uri.query });
            }
            let ref = uri.query;
            if (ref === '~') {
                const fileUri = uri.with({ scheme: 'file', query: '' });
                const uriString = fileUri.toString();
                const [indexStatus] = this.model.workingTreeGroup.resources.filter(r => r.original.toString() === uriString);
                ref = indexStatus ? '' : 'HEAD';
            }
            try {
                const result = yield this.model.show(ref, uri);
                return result;
            }
            catch (err) {
                return '';
            }
        });
    }
    cleanup() {
        const now = new Date().getTime();
        const cache = Object.create(null);
        Object.keys(this.cache).forEach(key => {
            const row = this.cache[key];
            const isOpen = vscode_1.window.visibleTextEditors.some(e => e.document.uri.fsPath === row.uri.fsPath);
            if (isOpen || now - row.timestamp < THREE_MINUTES) {
                cache[row.uri.toString()] = row;
            }
        });
        this.cache = cache;
    }
    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
__decorate([
    decorators_1.debounce(1100)
], HgContentProvider.prototype, "eventuallyFireChangeEvents", null);
__decorate([
    decorators_1.throttle
], HgContentProvider.prototype, "fireChangeEvents", null);
exports.HgContentProvider = HgContentProvider;
//# sourceMappingURL=contentProvider.js.map