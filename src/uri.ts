/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

"use strict";

import { Uri } from "vscode";

export interface HgUriParams {
    path: string;
    ref: string;
}

export function fromHgUri(uri: Uri): HgUriParams {
    return JSON.parse(uri.query);
}

// As a mitigation for extensions like ESLint showing warnings and errors
// for hg URIs, let's change the file extension of these uris to .hg,
// when `replaceFileExtension` is true.
export function toHgUri(
    uri: Uri,
    ref: string,
    replaceFileExtension = false
): Uri {
    const params: HgUriParams = {
        path: uri.fsPath,
        ref,
    };

    let path = uri.path;

    if (replaceFileExtension) {
        path = `${path}.hg`;
    }

    return uri.with({
        scheme: "hg",
        path,
        query: JSON.stringify(params),
    });
}
