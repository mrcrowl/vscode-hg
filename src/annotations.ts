import { DiffComputer, IDiffComputerOpts, ILineChange } from "vscode-diff";

import { debounce } from "./decorators";

import { applyLineChangesToAnnotations } from "./diff";

import {
    DecorationOptions,
    Disposable,
    Range,
    TextEditorDecorationType,
    window,
    DecorationRangeBehavior,
    DecorationRenderOptions,
    TextEditorSelectionChangeEvent,
    TextDocument,
    ThemeColor,
    workspace,
    ConfigurationChangeEvent,
} from "vscode";
import { Hg, ILineAnnotation } from "./hg";
import { Model } from "./model";
import { Repository } from "./repository";
import typedConfig from "./config";

const annotationDecoration: TextEditorDecorationType = window.createTextEditorDecorationType(
    {
        after: {
            margin: "0 0 0 3em",
            textDecoration: "none",
        },
        rangeBehavior: DecorationRangeBehavior.ClosedOpen,
    } as DecorationRenderOptions
);

// const gutterAnnotationDecoration: TextEditorDecorationType = window.createTextEditorDecorationType({

// });

export class LineTracker<T> extends Disposable {
    private disposable: Disposable | undefined;
    private configDisposable: Disposable;
    private hg: Hg;
    private model: Model;

    constructor(hg: Hg, model: Model) {
        super(() => this.dispose());
        this.hg = hg;
        this.model = model;
        this.configDisposable = Disposable.from(
            workspace.onDidChangeConfiguration(
                this.onConfigurationChanged,
                this
            )
        );
        this.applyConfiguration();
    }

    onConfigurationChanged(e: ConfigurationChangeEvent): void {
        if (e.affectsConfiguration("hg")) {
            this.applyConfiguration();
        }
    }

    applyConfiguration(): void {
        if (typedConfig.lineAnnotationEnabled) {
            this.start();
        } else {
            this.stop();
        }
    }

    async diffHeadAndEditorContents(
        document: TextDocument,
        repo: Repository
    ): Promise<ILineChange[]> {
        const editorLines = document.getText().split("\n");
        const headContents = (
            await repo.show("wdir()", document.uri.fsPath)
        ).split("\n");
        const options: IDiffComputerOpts = {
            shouldPostProcessCharChanges: false,
            shouldIgnoreTrimWhitespace: true,
            shouldMakePrettyDiff: false,
            shouldComputeCharChanges: false,
            maxComputationTime: 0, // time in milliseconds, 0 => no computation limit.
        };
        const diffComputer = new DiffComputer(
            headContents,
            editorLines,
            options
        );
        const lineChanges: ILineChange[] = diffComputer.computeDiff().changes;
        return lineChanges;
    }

    @debounce(0)
    async onTextEditorSelectionChanged(
        event: TextEditorSelectionChangeEvent
    ): Promise<void> {
        const selections = event.selections.map((x) => x.active.line);
        const repo = this.model.repositories[0];
        if (event.textEditor.document.uri.scheme != "file") {
            return;
        }
        console.log();
        const uncommittedChangeDiffs = await this.diffHeadAndEditorContents(
            event.textEditor.document,
            repo
        );
        const workingCopyAnnotations = await repo.annotate(
            event.textEditor.document.uri,
            "wdir()"
        );
        const annotations = applyLineChangesToAnnotations(
            workingCopyAnnotations,
            uncommittedChangeDiffs
        );

        const decorations = this.generateDecorations(
            annotations,
            selections,
            event.textEditor.document
        );

        event.textEditor.setDecorations(annotationDecoration, decorations);
    }

    generateDecorations(
        annotations: ILineAnnotation[],
        selections: number[],
        document: TextDocument
    ): DecorationOptions[] {
        const annotationColor = new ThemeColor(
            "editorOverviewRuler.modifiedForeground"
        );
        const decorations = annotations.map((annotation, l) => {
            let text = "";
            if (selections.includes(l)) {
                text = this.formatAnnotation(annotation);
            }
            return {
                range: document.validateRange(
                    new Range(
                        l,
                        Number.MAX_SAFE_INTEGER,
                        l,
                        Number.MAX_SAFE_INTEGER
                    )
                ),
                renderOptions: {
                    after: {
                        color: annotationColor,
                        contentText: text,
                        fontWeight: "normal",
                    },
                },
            };
        });
        return decorations;
    }

    formatAnnotation(annotation: ILineAnnotation): string {
        if (annotation.hash == "ffffffffffff") {
            return "Uncommitted changes";
        } else {
            return `${
                annotation.user
            }, ${annotation.date?.toLocaleDateString()} • ${
                annotation.description
            }`;
        }
    }

    dispose(): void {
        this.stop();
        this.configDisposable.dispose();
    }
    start(): void {
        this.disposable = Disposable.from(
            window.onDidChangeTextEditorSelection(
                this.onTextEditorSelectionChanged,
                this
            )
        );
    }
    stop(): void {
        this.disposable?.dispose();
        this.disposable = undefined;
    }
}
