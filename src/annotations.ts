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
    Uri,
    TextEditor,
    MarkdownString,
    TextDocumentChangeEvent,
} from "vscode";
import { Hg, ILineAnnotation } from "./hg";
import { Model, ModelChangeEvent } from "./model";
import { Repository } from "./repository";
import typedConfig from "./config";

const GUTTER_CHARACTER_WIDTH = 50;

const currentLineDecoration: TextEditorDecorationType = window.createTextEditorDecorationType(
    {
        after: {
            margin: "0 0 0 3em",
            textDecoration: "none",
        },
        rangeBehavior: DecorationRangeBehavior.ClosedOpen,
    } as DecorationRenderOptions
);

const gutterDecoration: TextEditorDecorationType = window.createTextEditorDecorationType(
    {
        before: {
            margin: "0",
            textDecoration: "none",
        },
        rangeBehavior: DecorationRangeBehavior.ClosedOpen,
    } as DecorationRenderOptions
);
const fileCache = new (class LineAnnotationCache {
    private fileAnnotationCache = new Map<Uri, ILineAnnotation[]>();

    async getFileAnnotations(
        repo: Repository,
        uri: Uri
    ): Promise<ILineAnnotation[]> {
        // Cache file annotations
        if (!this.fileAnnotationCache.has(uri)) {
            this.fileAnnotationCache.set(
                uri,
                await repo.annotate(uri, "wdir()")
            );
        }
        return this.fileAnnotationCache.get(uri)!;
    }

    clearFileCache(file?: Uri | TextDocument): void {
        // Clear cache of a single file if given, or the whole thing
        if (file instanceof Uri) {
            this.fileAnnotationCache.delete(file);
        } else if (file) {
            this.fileAnnotationCache.delete((file as TextDocument).uri);
        } else {
            this.fileAnnotationCache.clear();
        }
    }
})();

abstract class BaseAnnotationProvider extends Disposable {
    protected disposable: Disposable | undefined;
    protected configDisposable: Disposable;
    protected hg: Hg;
    protected model: Model;

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

    abstract applyConfiguration(): void;

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

    dispose(): void {
        this.stop();
        this.configDisposable.dispose();
    }

    stop(): void {
        this.disposable?.dispose();
        this.disposable = undefined;
        fileCache.clearFileCache();
    }
}

export class CurrentLineAnnotationProvider extends BaseAnnotationProvider {
    applyConfiguration(): void {
        if (typedConfig.lineAnnotationEnabled) {
            this.start();
        } else {
            this.stop();
        }
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
        const uncommittedChangeDiffs = await this.diffHeadAndEditorContents(
            event.textEditor.document,
            repo
        );
        const workingCopyAnnotations = await fileCache.getFileAnnotations(
            repo,
            event.textEditor.document.uri
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

        event.textEditor.setDecorations(currentLineDecoration, decorations);
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

    @debounce(1000)
    onRepositoryChanged(_e: ModelChangeEvent): void {
        fileCache.clearFileCache();
    }

    start(): void {
        this.disposable = Disposable.from(
            window.onDidChangeTextEditorSelection(
                this.onTextEditorSelectionChanged,
                this
            ),
            workspace.onDidCloseTextDocument(
                fileCache.clearFileCache,
                fileCache
            ),
            this.model.onDidChangeRepository(this.onRepositoryChanged, this)
        );
    }
}

export class GutterAnnotationProvider extends BaseAnnotationProvider {
    private _editor: TextEditor;
    private _decorations: DecorationOptions[] | undefined;

    constructor(editor: TextEditor, hg: Hg, model: Model) {
        super(hg, model);
        this._editor = editor;
    }

    applyConfiguration(): void {
        return;
    }

    async provideAnnotations(): Promise<void> {
        const repo = this.model.repositories[0];
        const uncommittedChangeDiffs = await this.diffHeadAndEditorContents(
            this._editor.document,
            repo
        );
        const workingCopyAnnotations = await fileCache.getFileAnnotations(
            repo,
            this._editor.document.uri
        );
        const annotations = applyLineChangesToAnnotations(
            workingCopyAnnotations,
            uncommittedChangeDiffs
        );

        const decorations = this.generateDecorations(
            annotations,
            [],
            this._editor.document
        );

        this.setDecorations(decorations);
    }

    protected setDecorations(decorations: DecorationOptions[]): void {
        if (this._decorations?.length) {
            this.clearDecorations();
        }

        this._decorations = decorations;
        if (this._decorations?.length) {
            this._editor.setDecorations(gutterDecoration, decorations);
        }
    }

    clearDecorations(): void {
        if (this._editor == null) return;

        this._editor.setDecorations(gutterDecoration, []);
        this._decorations = undefined;
    }

    generateDecorations(
        annotations: ILineAnnotation[],
        selections: number[],
        document: TextDocument
    ): DecorationOptions[] {
        const annotationColor = new ThemeColor("input.foreground");
        let previousHash: string | undefined;
        const decorations = annotations.map((annotation, l) => {
            let text: string;
            if (annotation.hash != previousHash) {
                text = this.formatAnnotation(annotation);
                previousHash = annotation.hash;
            } else {
                text = "".padEnd(GUTTER_CHARACTER_WIDTH);
            }
            const decoration = {
                range: document.validateRange(new Range(l, 0, l, 0)),
                hoverMessage: this.hoverForAnnotation(annotation, document.uri),
                renderOptions: {
                    before: {
                        backgroundColor: new ThemeColor(
                            "editorGroupHeader.tabsBackground"
                        ),
                        color: annotationColor,
                        contentText: text,
                        fontWeight: "normal",
                        height: "100%",
                        margin: "0 26px -1px 6px",
                        textDecoration: "overline solid rgba(0, 0, 0, .2)",
                        width: `calc(${GUTTER_CHARACTER_WIDTH}ch)`,
                    },
                },
            };
            return decoration;
        });
        return decorations;
    }

    hoverForAnnotation(
        annotation: ILineAnnotation,
        _fileUri: Uri
    ): MarkdownString {
        const commandArgs = encodeURIComponent(
            JSON.stringify([annotation.hash])
        );
        const commandUri = Uri.parse(`command:hg.logRev?${commandArgs}`);
        let hoverMsg = new MarkdownString(
            `[${annotation.hash}](${commandUri}): `
        );
        hoverMsg = hoverMsg.appendText(
            `${annotation.user} &bullet; ${annotation.description}`
        );
        hoverMsg.isTrusted = true;
        return hoverMsg;
    }

    formatAnnotation(annotation: ILineAnnotation): string {
        if (annotation.hash == "ffffffffffff") {
            return "Uncommitted changes".padEnd(GUTTER_CHARACTER_WIDTH);
        } else if (!annotation.description) {
            return annotation.hash.padEnd(GUTTER_CHARACTER_WIDTH);
        } else {
            const dateString = annotation.date?.toLocaleDateString() || "";
            const descriptionWidth =
                GUTTER_CHARACTER_WIDTH - dateString.length - 2;
            let description;
            if (annotation.description.length >= descriptionWidth) {
                description =
                    annotation.description.substring(0, descriptionWidth - 1) +
                    "…";
            } else {
                description = annotation.description.padEnd(
                    descriptionWidth,
                    "\u00a0"
                );
            }
            return `${description}  ${dateString}`;
        }
    }

    restore(editor: TextEditor): void {
        this._editor = editor;
        if (this._decorations?.length) {
            this._editor.setDecorations(gutterDecoration, this._decorations);
        }
    }

    start(): void {
        this.provideAnnotations();
    }

    stop(): void {
        this.clearDecorations();
        fileCache.clearFileCache(this._editor.document);
    }

    dispose(): void {
        this.stop();
    }
}

export class FileAnnotationController implements Disposable {
    private _hg: Hg;
    private _model: Model;
    private _disposables = new Array<Disposable>();
    private _annotationProviders = new Map<Uri, GutterAnnotationProvider>();

    constructor(hg: Hg, model: Model) {
        this._hg = hg;
        this._model = model;
        this._disposables.push(
            workspace.onDidChangeTextDocument(this.onDocumentChanged, this),
            workspace.onDidCloseTextDocument(this.onDocumentClosed, this),
            window.onDidChangeVisibleTextEditors(
                this.onVisibleTextEditorsChanged,
                this
            )
        );
    }

    isShowing(editor: TextEditor): boolean {
        return this._annotationProviders.has(this.getProviderKey(editor));
    }

    toggle(editor: TextEditor): void {
        if (this.isShowing(editor)) {
            this.clear(editor.document);
        } else {
            this.show(editor);
        }
    }

    getProvider(
        editor: TextEditor | undefined
    ): GutterAnnotationProvider | undefined {
        if (editor == null || editor.document == null) return undefined;
        const key = this.getProviderKey(editor);
        return this._annotationProviders.get(key);
    }

    getProviderKey(docOrEd: TextDocument | TextEditor): Uri {
        let document: TextDocument;
        if ("document" in docOrEd) {
            document = docOrEd.document;
        } else {
            document = docOrEd;
        }
        return document.uri;
    }

    show(editor: TextEditor): void {
        if (this.getProvider(editor)) {
            return;
        }

        const provider = new GutterAnnotationProvider(
            editor,
            this._hg,
            this._model
        );
        provider.start();
        this._annotationProviders.set(this.getProviderKey(editor), provider);
    }

    clear(document: TextDocument): void {
        const key = this.getProviderKey(document);
        if (!this._annotationProviders.has(key)) {
            return;
        }
        const provider = this._annotationProviders.get(key)!;
        provider.dispose();
        this._annotationProviders.delete(key);
    }

    @debounce(50)
    onDocumentChanged(e: TextDocumentChangeEvent): void {
        // Clear the annotation on edit
        this.clear(e.document);
    }

    onDocumentClosed(document: TextDocument): void {
        this.clear(document);
    }

    onVisibleTextEditorsChanged(editors: readonly TextEditor[]): void {
        // VS Code clears decorations on tab change, so we need to restore them
        let provider: GutterAnnotationProvider | undefined;
        for (const e of editors) {
            provider = this.getProvider(e);
            if (provider == null) continue;

            void provider.restore(e);
        }
    }

    dispose(): void {
        this._disposables.forEach((provider) => provider.dispose());
        this._annotationProviders.forEach((provider) => provider.dispose());
    }
}
