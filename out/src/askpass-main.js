/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const http = require("http");
const fs = require("fs");
const nls = require("vscode-nls");
const localize = nls.loadMessageBundle();
function fatal(err) {
    console.error(localize('missOrInvalid', "Missing or invalid credentials."));
    console.error(err);
    process.exit(1);
}
function main(argv) {
    if (argv.length !== 5) {
        return fatal('Wrong number of arguments');
    }
    if (!process.env['VSCODE_GIT_ASKPASS_PORT']) {
        return fatal('Missing port');
    }
    if (!process.env['VSCODE_GIT_ASKPASS_PIPE']) {
        return fatal('Missing pipe');
    }
    if (process.env['VSCODE_GIT_COMMAND'] === 'fetch') {
        return fatal('Skip fetch commands');
    }
    const output = process.env['VSCODE_GIT_ASKPASS_PIPE'];
    const port = Number.parseInt(process.env['VSCODE_GIT_ASKPASS_PORT']);
    const request = argv[2];
    const host = argv[4].substring(1, argv[4].length - 2);
    const opts = {
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST'
    };
    const req = http.request(opts, res => {
        if (res.statusCode !== 200) {
            return fatal(`Bad status code: ${res.statusCode}`);
        }
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
            const raw = chunks.join('');
            try {
                const result = JSON.parse(raw);
                fs.writeFileSync(output, result + '\n');
            }
            catch (err) {
                return fatal(`Error parsing response`);
            }
            setTimeout(() => process.exit(0), 0);
        });
    });
    req.on('error', () => fatal('Error in request'));
    req.write(JSON.stringify({ request, host }));
    req.end();
}
main(process.argv);
//# sourceMappingURL=askpass-main.js.map