import { Disposable, window, TextEditor, TextEditorSelectionChangeEvent, Uri, DecorationRenderOptions, TextEditorDecorationType, DecorationRangeBehavior, ThemeColor, Range } from 'vscode';
import { Hg, LineAnnotation } from './hg';

import { debounce } from './decorators';
import { Model } from './model';

import typedConfig from "./config";

const annotationDecoration: TextEditorDecorationType = window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 3em',
        textDecoration: 'none'
    },
    rangeBehavior: DecorationRangeBehavior.ClosedOpen
} as DecorationRenderOptions);

export class LineTracker<T> extends Disposable {
    private disposable: Disposable | undefined;
    private hg: Hg;
    private model: Model;

    constructor(hg: Hg, model: Model) {
        super(() => this.dispose());
        this.hg = hg;
        this.model = model;
        if (typedConfig.annotationEnabled) {
            this.start();
        }
    }

    /* @debounce(0)
    onActiveTextEditorChanged(editor: TextEditor) {
        console.log(editor.selections, editor.document.fileName);
    } */
    @debounce(0)
    onTextEditorSelectionChanged(event: TextEditorSelectionChangeEvent) {
        const selections = event.selections.map(x => x.active.line);
        const repo = this.model.repositories[0];
        repo.getAnnotations(event.textEditor.document.uri)
            .then((lines: LineAnnotation[]) => {
                event.textEditor.setDecorations(annotationDecoration, lines.map((x, l) => {
                    return {
                        range: event.textEditor.document.validateRange(new Range(l, 100000000, l, 100000000)),
                        renderOptions: {
                            after: {
                                color: typedConfig.annotationColor,
                                contentText: !selections.includes(l) ? '' : `${ x.user.replace(/ /g, '\u00a0') } ${ x.revision } ${ x.timestamp }`,
                                fontWeight: 'normal',
                                fontStyle: 'normal',
                                textDecoration: 'none; position: absolute'
                            }
                        }
                    }
                }));
            })
            .catch(console.error);
    }
    dispose() {
        this.stop();
    }
    start() {
        this.disposable = Disposable.from(
            // window.onDidChangeActiveTextEditor(this.onActiveTextEditorChanged, this),
            window.onDidChangeTextEditorSelection(this.onTextEditorSelectionChanged, this),
        );
    }
    stop() {
        if (this.disposable) {
            this.disposable.dispose();
        }
        this.disposable = undefined;
    }
}
