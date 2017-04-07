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
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = require("vscode");
const model_1 = require("./model");
const util_1 = require("./util");
const decorators_1 = require("./decorators");
const iterators_1 = require("./iterators");
function* lines(document) {
    for (let i = 0; i < document.lineCount; i++) {
        yield document.lineAt(i).text;
    }
}
const pattern = /^<<<<<<<|^=======|^>>>>>>>/;
function decorate(document) {
    return iterators_1.iterate(lines(document))
        .map((line, i) => pattern.test(line) ? i : null)
        .filter(i => i !== null)
        .map((i) => new vscode_1.Range(i, 1, i, 1))
        .toArray();
}
class TextEditorMergeDecorator {
    constructor(model, editor) {
        this.model = model;
        this.editor = editor;
        this.disposables = [];
        this.uri = this.editor.document.uri.toString();
        const onDidChange = util_1.filterEvent(vscode_1.workspace.onDidChangeTextDocument, e => e.document && e.document.uri.toString() === this.uri);
        onDidChange(this.redecorate, this, this.disposables);
        model.onDidChange(this.redecorate, this, this.disposables);
        this.redecorate();
    }
    redecorate() {
        let decorations = [];
        if (vscode_1.window.visibleTextEditors.every(e => e !== this.editor)) {
            this.dispose();
            return;
        }
        if (this.model.mergeGroup.resources.some(r => r.type === model_1.Status.MODIFIED && r.resourceUri.toString() === this.uri)) {
            decorations = decorate(this.editor.document);
        }
        this.editor.setDecorations(TextEditorMergeDecorator.DecorationType, decorations);
    }
    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
TextEditorMergeDecorator.DecorationType = vscode_1.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 139, 0, 0.3)',
    isWholeLine: true,
    dark: {
        backgroundColor: 'rgba(235, 59, 0, 0.3)'
    }
});
__decorate([
    decorators_1.debounce(300)
], TextEditorMergeDecorator.prototype, "redecorate", null);
class MergeDecorator {
    constructor(model) {
        this.model = model;
        this.textEditorDecorators = [];
        this.disposables = [];
        vscode_1.window.onDidChangeVisibleTextEditors(this.onDidChangeVisibleTextEditors, this, this.disposables);
        this.onDidChangeVisibleTextEditors(vscode_1.window.visibleTextEditors);
    }
    onDidChangeVisibleTextEditors(editors) {
        this.textEditorDecorators.forEach(d => d.dispose());
        this.textEditorDecorators = editors.map(e => new TextEditorMergeDecorator(this.model, e));
    }
    dispose() {
        this.textEditorDecorators.forEach(d => d.dispose());
        this.disposables.forEach(d => d.dispose());
    }
}
exports.MergeDecorator = MergeDecorator;
//# sourceMappingURL=merge.js.map