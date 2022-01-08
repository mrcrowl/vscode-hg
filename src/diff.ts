import { TextDocument, Range } from "vscode";
import { ILineAnnotation } from "./hg";

export interface LineChange {
    readonly originalStartLineNumber: number;
    readonly originalEndLineNumber: number;
    readonly modifiedStartLineNumber: number;
    readonly modifiedEndLineNumber: number;
}

export function applyLineChanges(
    original: TextDocument,
    modified: TextDocument,
    diffs: LineChange[]
): string {
    const result: string[] = [];
    let currentLine = 0;

    for (const diff of diffs) {
        const isInsertion = diff.originalEndLineNumber === 0;
        const isDeletion = diff.modifiedEndLineNumber === 0;

        let endLine = isInsertion
            ? diff.originalStartLineNumber
            : diff.originalStartLineNumber - 1;
        let endCharacter = 0;

        // if this is a deletion at the very end of the document,then we need to account
        // for a newline at the end of the last line which may have been deleted
        // https://github.com/Microsoft/vscode/issues/59670
        if (isDeletion && diff.originalStartLineNumber === original.lineCount) {
            endLine -= 1;
            endCharacter = original.lineAt(endLine).range.end.character;
        }

        result.push(
            original.getText(new Range(currentLine, 0, endLine, endCharacter))
        );

        if (!isDeletion) {
            let fromLine = diff.modifiedStartLineNumber - 1;
            let fromCharacter = 0;

            // if this is an insertion at the very end of the document,
            // then we must start the next range after the last character of the
            // previous line, in order to take the correct eol
            if (
                isInsertion &&
                diff.originalStartLineNumber === original.lineCount
            ) {
                fromLine -= 1;
                fromCharacter = modified.lineAt(fromLine).range.end.character;
            }

            result.push(
                modified.getText(
                    new Range(
                        fromLine,
                        fromCharacter,
                        diff.modifiedEndLineNumber,
                        0
                    )
                )
            );
        }

        currentLine = isInsertion
            ? diff.originalStartLineNumber
            : diff.originalEndLineNumber;
    }

    result.push(
        original.getText(new Range(currentLine, 0, original.lineCount, 0))
    );

    return result.join("");
}

// Apply diffs to line annotations to reflect uncommitted changes.
export function applyLineChangesToAnnotations(
    original: ILineAnnotation[],
    diffs: LineChange[]
): ILineAnnotation[] {
    const result: ILineAnnotation[] = [];
    let currentLine = 0;

    for (const diff of diffs) {
        const isInsertion = diff.originalEndLineNumber === 0;
        const isDeletion = diff.modifiedEndLineNumber === 0;

        let endLine = isInsertion
            ? diff.originalStartLineNumber
            : diff.originalStartLineNumber - 1;

        // if this is a deletion at the very end of the document,then we need to account
        // for a newline at the end of the last line which may have been deleted
        // https://github.com/Microsoft/vscode/issues/59670
        if (isDeletion && diff.originalStartLineNumber === original.length) {
            endLine -= 1;
        }

        result.push(...original.slice(currentLine, endLine));

        if (!isDeletion) {
            const fromLine = diff.modifiedStartLineNumber - 1;

            // if this is an insertion at the very end of the document,
            // then we must start the next range after the last character of the
            // previous line, in order to take the correct eol
            // if (
            //     isInsertion &&
            //     diff.originalStartLineNumber === original.length
            // ) {
            //     fromLine -= 1;
            //     fromCharacter = modified.lineAt(fromLine).range.end.character;
            // }

            result.push(
                ...new Array<ILineAnnotation>(
                    diff.modifiedEndLineNumber - fromLine
                ).fill({
                    hash: "ffffffffffff",
                    user: "You",
                    date: undefined,
                    description: "Uncommitted changes",
                } as ILineAnnotation)
            );
        }

        currentLine = isInsertion
            ? diff.originalStartLineNumber
            : diff.originalEndLineNumber;
    }

    result.push(...original.slice(currentLine, original.length));

    return result;
}
