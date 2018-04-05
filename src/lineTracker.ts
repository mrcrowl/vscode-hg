import { Disposable, window, TextEditor, TextEditorSelectionChangeEvent, Uri, DecorationRenderOptions, TextEditorDecorationType, DecorationRangeBehavior, ThemeColor, Range } from 'vscode';
import { Hg, LineAnnotation, Commit } from './hg';

import { debounce } from './decorators';
import { Model } from './model';

import typedConfig from "./config";
import { uniqBy, keyBy } from './util';

export type CommitsByRevision = {
    [revision: string]: Commit
}

const commitCache = {};

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

    async getCommitMessageByRevision(revisions: string[]): Promise<CommitsByRevision> {
        const uncachedRevisions: string[] = [];
        const cachedCommits: CommitsByRevision = {};
        const repo = this.model.repositories[0];

        revisions.forEach(revision => {
            if (!commitCache[revision]) {
                uncachedRevisions.push(revision);
            } else {
                cachedCommits[revision] = commitCache[revision];
            }
        });
        if (uncachedRevisions.length) {
            await Promise.all(revisions.map(revision => {
                return repo
                    .getLogEntries({
                        revQuery: revision,
                        limit: 1
                    })
                    .then(commits => {
                        cachedCommits[revision] = commits[0];
                        commitCache[revision] = commits[0];
                    });
            }));

        }
        return cachedCommits;
    }

    /* @debounce(0)
    onActiveTextEditorChanged(editor: TextEditor) {
        console.log(editor.selections, editor.document.fileName);
    } */
    @debounce(0)
    async onTextEditorSelectionChanged(event: TextEditorSelectionChangeEvent) {
        try {
            const selections = event.selections.map(x => x.active.line);
            const repo = this.model.repositories[0];
            const annotations = await repo.getAnnotations(event.textEditor.document.uri)
            let revisions = uniqBy(annotations.map(x => x.revision), x => x);

            const revs = await this.getCommitMessageByRevision(revisions);

            event.textEditor.setDecorations(annotationDecoration, annotations.map((x, l) => {
                const revision: Commit = revs[x.revision];
                const text = !selections.includes(l) ? '' : `${x.user.replace(/ /g, '\u00a0')} ${x.revision} ${x.timestamp} ${ revision.message.split('\n')[0] }`
                return {
                    range: event.textEditor.document.validateRange(new Range(l, 100000000, l, 100000000)),
                    renderOptions: {
                        after: {
                            color: typedConfig.annotationColor,
                            contentText: text,
                            fontWeight: 'normal',
                            fontStyle: 'normal',
                            textDecoration: 'none; position: absolute'
                        }
                    }
                }
            }));
        } catch (e) {
            console.error(e);
        }
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
