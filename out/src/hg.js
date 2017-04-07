/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const util_1 = require("./util");
const vscode_1 = require("vscode");
const nls = require("vscode-nls");
const localize = nls.loadMessageBundle();
const readdir = util_1.denodeify(fs.readdir);
const readfile = util_1.denodeify(fs.readFile);
var RefType;
(function (RefType) {
    RefType[RefType["Branch"] = 0] = "Branch";
    RefType[RefType["Tag"] = 1] = "Tag";
})(RefType = exports.RefType || (exports.RefType = {}));
function parseVersion(raw) {
    let match = raw.match(/\(version ([\d\.]+)\)/);
    if (match) {
        return match[1];
    }
    return "?";
}
function findSpecificHg(path) {
    return new Promise((c, e) => {
        const buffers = [];
        const child = cp.spawn(path, ['--version']);
        child.stdout.on('data', (b) => buffers.push(b));
        child.on('error', e);
        child.on('exit', code => {
            if (!code) {
                const output = Buffer.concat(buffers).toString('utf8');
                return c({
                    path,
                    version: parseVersion(output)
                });
            }
            return e(new Error('Not found'));
        });
    });
}
function findHgDarwin() {
    return new Promise((c, e) => {
        cp.exec('which hg', (err, hgPathBuffer) => {
            if (err) {
                return e('hg not found');
            }
            const path = hgPathBuffer.toString().replace(/^\s+|\s+$/g, '');
            function getVersion(path) {
                // make sure hg executes
                cp.exec('hg --version', (err, stdout) => {
                    if (err) {
                        return e('hg not found');
                    }
                    return c({ path, version: parseVersion(stdout.toString('utf8').trim()) });
                });
            }
            if (path !== '/usr/bin/hg') {
                return getVersion(path);
            }
            // must check if XCode is installed
            cp.exec('xcode-select -p', (err) => {
                if (err && err.code === 2) {
                    // hg is not installed, and launching /usr/bin/hg
                    // will prompt the user to install it
                    return e('hg not found');
                }
                getVersion(path);
            });
        });
    });
}
function findMercurialWin32(base) {
    if (!base) {
        return Promise.reject('Not found');
    }
    return findSpecificHg(path.join(base, 'Mercurial', 'hg.exe'));
}
function findTortoiseHgWin32(base) {
    if (!base) {
        return Promise.reject('Not found');
    }
    return findSpecificHg(path.join(base, 'TortoiseHg', 'hg.exe'));
}
function findHgWin32() {
    return findMercurialWin32(process.env['ProgramW6432'])
        .then(void 0, () => findTortoiseHgWin32(process.env['ProgramFiles(x86)']))
        .then(void 0, () => findTortoiseHgWin32(process.env['ProgramFiles']))
        .then(void 0, () => findMercurialWin32(process.env['ProgramFiles(x86)']))
        .then(void 0, () => findMercurialWin32(process.env['ProgramFiles']))
        .then(void 0, () => findSpecificHg('hg'));
}
function findHg(hint) {
    var first = hint ? findSpecificHg(hint) : Promise.reject(null);
    return first.then(void 0, () => {
        switch (process.platform) {
            case 'darwin': return findHgDarwin();
            case 'win32': return findHgWin32();
            default: return findSpecificHg('hg');
        }
    });
}
exports.findHg = findHg;
function exec(child) {
    return __awaiter(this, void 0, void 0, function* () {
        const disposables = [];
        const once = (ee, name, fn) => {
            ee.once(name, fn);
            disposables.push(util_1.toDisposable(() => ee.removeListener(name, fn)));
        };
        const on = (ee, name, fn) => {
            ee.on(name, fn);
            disposables.push(util_1.toDisposable(() => ee.removeListener(name, fn)));
        };
        const [exitCode, stdout, stderr] = yield Promise.all([
            new Promise((c, e) => {
                once(child, 'error', e);
                once(child, 'exit', c);
            }),
            new Promise(c => {
                const buffers = [];
                on(child.stdout, 'data', b => buffers.push(b));
                once(child.stdout, 'close', () => c(buffers.join('')));
            }),
            new Promise(c => {
                const buffers = [];
                on(child.stderr, 'data', b => buffers.push(b));
                once(child.stderr, 'close', () => c(buffers.join('')));
            })
        ]);
        util_1.dispose(disposables);
        return { exitCode, stdout, stderr };
    });
}
exports.exec = exec;
class HgError {
    constructor(data) {
        if (data.error) {
            this.error = data.error;
            this.message = data.error.message;
        }
        else {
            this.error = void 0;
        }
        this.message = this.message || data.message || 'Git error';
        this.stdout = data.stdout;
        this.stderr = data.stderr;
        this.exitCode = data.exitCode;
        this.hgErrorCode = data.hgErrorCode;
        this.hgCommand = data.hgCommand;
    }
    toString() {
        let result = this.message + ' ' + JSON.stringify({
            exitCode: this.exitCode,
            hgErrorCode: this.hgErrorCode,
            hgCommand: this.hgCommand,
            stdout: this.stdout,
            stderr: this.stderr
        }, [], 2);
        if (this.error) {
            result += this.error.stack;
        }
        return result;
    }
}
exports.HgError = HgError;
exports.HgErrorCodes = {
    BadConfigFile: 'BadConfigFile',
    AuthenticationFailed: 'AuthenticationFailed',
    NoUserNameConfigured: 'NoUserNameConfigured',
    NoUserEmailConfigured: 'NoUserEmailConfigured',
    NoRemoteRepositorySpecified: 'NoRemoteRepositorySpecified',
    NoRespositoryFound: 'NotAnHgRepository',
    NotAtRepositoryRoot: 'NotAtRepositoryRoot',
    Conflict: 'Conflict',
    UnmergedChanges: 'UnmergedChanges',
    PushRejected: 'PushRejected',
    RemoteConnectionError: 'RemoteConnectionError',
    DirtyWorkTree: 'DirtyWorkTree',
    CantOpenResource: 'CantOpenResource',
    HgNotFound: 'HgNotFound',
    CantCreatePipe: 'CantCreatePipe',
    CantAccessRemote: 'CantAccessRemote',
    RepositoryNotFound: 'RepositoryNotFound'
};
class Hg {
    constructor(options) {
        this._onOutput = new vscode_1.EventEmitter();
        this.hgPath = options.hgPath;
        this.version = options.version;
        this.env = options.env || {};
    }
    get onOutput() { return this._onOutput.event; }
    open(repository) {
        return new Repository(this, repository);
    }
    init(repository) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.exec(repository, ['init']);
            return;
        });
    }
    clone(url, parentPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const folderName = url.replace(/^.*\//, '').replace(/\.hg$/, '') || 'repository';
            const folderPath = path.join(parentPath, folderName);
            yield util_1.mkdirp(parentPath);
            yield this.exec(parentPath, ['clone', url, folderPath]);
            return folderPath;
        });
    }
    getRepositoryRoot(path) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.exec(path, ['root']);
            return result.stdout.trim();
        });
    }
    exec(cwd, args, options = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            options = util_1.assign({ cwd }, options || {});
            return yield this._exec(args, options);
        });
    }
    stream(cwd, args, options = {}) {
        options = util_1.assign({ cwd }, options || {});
        return this.spawn(args, options);
    }
    _exec(args, options = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            const child = this.spawn(args, options);
            if (options.input) {
                child.stdin.end(options.input, 'utf8');
            }
            const result = yield exec(child);
            if (result.exitCode) {
                let hgErrorCode = void 0;
                if (/Authentication failed/.test(result.stderr)) {
                    hgErrorCode = exports.HgErrorCodes.AuthenticationFailed;
                }
                else if (/no repository found/.test(result.stderr)) {
                    hgErrorCode = exports.HgErrorCodes.NoRespositoryFound;
                } /*else if (/bad config file/.test(result.stderr)) {
                    hgErrorCode = HgErrorCodes.BadConfigFile;
                } else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(result.stderr)) {
                    hgErrorCode = HgErrorCodes.CantCreatePipe;
                } else if (/Repository not found/.test(result.stderr)) {
                    hgErrorCode = HgErrorCodes.RepositoryNotFound;
                } else if (/unable to access/.test(result.stderr)) {
                    hgErrorCode = HgErrorCodes.CantAccessRemote;
                }*/
                if (options.log !== false) {
                    this.log(`${result.stderr}\n`);
                }
                return Promise.reject(new HgError({
                    message: 'Failed to execute hg',
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    hgErrorCode,
                    hgCommand: args[0]
                }));
            }
            return result;
        });
    }
    spawn(args, options = {}) {
        if (!this.hgPath) {
            throw new Error('hg could not be found in the system.');
        }
        if (!options) {
            options = {};
        }
        if (!options.stdio && !options.input) {
            options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
        }
        options.env = util_1.assign({}, process.env, this.env, options.env || {}, {
            VSCODE_GIT_COMMAND: args[0],
            LC_ALL: 'en_US',
            LANG: 'en_US.UTF-8'
        });
        if (options.log !== false) {
            this.log(`hg ${args.join(' ')}\n`);
        }
        return cp.spawn(this.hgPath, args, options);
    }
    log(output) {
        this._onOutput.fire(output);
    }
}
exports.Hg = Hg;
class Repository {
    constructor(_hg, repositoryRoot) {
        this._hg = _hg;
        this.repositoryRoot = repositoryRoot;
    }
    get hg() {
        return this._hg;
    }
    get root() {
        return this.repositoryRoot;
    }
    // TODO@Joao: rename to exec
    run(args, options = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.hg.exec(this.repositoryRoot, args, options);
        });
    }
    stream(args, options = {}) {
        return this.hg.stream(this.repositoryRoot, args, options);
    }
    spawn(args, options = {}) {
        return this.hg.spawn(args, options);
    }
    config(scope, key, value, options) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['config'];
            if (scope) {
                args.push('--' + scope);
            }
            args.push(key);
            if (value) {
                args.push(value);
            }
            const result = yield this.run(args, options);
            return result.stdout;
        });
    }
    buffer(object) {
        return __awaiter(this, void 0, void 0, function* () {
            const child = this.stream(['show', object]);
            if (!child.stdout) {
                return Promise.reject(localize('errorBuffer', "Can't open file from hg"));
            }
            return yield this.doBuffer(object);
            // TODO@joao
            // return new Promise((c, e) => {
            // detectMimesFromStream(child.stdout, null, (err, result) => {
            // 	if (err) {
            // 		e(err);
            // 	} else if (isBinaryMime(result.mimes)) {
            // 		e(<IFileOperationResult>{
            // 			message: localize('fileBinaryError', "File seems to be binary and cannot be opened as text"),
            // 			fileOperationResult: FileOperationResult.FILE_IS_BINARY
            // 		});
            // 	} else {
            // c(this.doBuffer(object));
            // 	}
            // });
            // });
        });
    }
    doBuffer(object) {
        return __awaiter(this, void 0, void 0, function* () {
            const child = this.stream(['show', object]);
            const { exitCode, stdout } = yield exec(child);
            if (exitCode) {
                return Promise.reject(new HgError({
                    message: 'Could not buffer object.',
                    exitCode
                }));
            }
            return stdout;
        });
    }
    add(paths) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['add', '-A', '--'];
            if (paths && paths.length) {
                args.push.apply(args, paths);
            }
            else {
                args.push('.');
            }
            yield this.run(args);
        });
    }
    stage(path, data) {
        return __awaiter(this, void 0, void 0, function* () {
            const child = this.stream(['hash-object', '--stdin', '-w'], { stdio: [null, null, null] });
            child.stdin.end(data, 'utf8');
            const { exitCode, stdout } = yield exec(child);
            if (exitCode) {
                throw new HgError({
                    message: 'Could not hash object.',
                    exitCode: exitCode
                });
            }
            yield this.run(['update-index', '--cacheinfo', '100644', stdout, path]);
        });
    }
    checkout(treeish, paths) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['checkout', '-q'];
            if (treeish) {
                args.push(treeish);
            }
            if (paths && paths.length) {
                args.push('--');
                args.push.apply(args, paths);
            }
            try {
                yield this.run(args);
            }
            catch (err) {
                if (/Please, commit your changes or stash them/.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.DirtyWorkTree;
                }
                throw err;
            }
        });
    }
    commit(message, opts = Object.create(null)) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['commit', '--quiet', '--allow-empty-message', '--file', '-'];
            if (opts.all) {
                args.push('--all');
            }
            if (opts.amend) {
                args.push('--amend');
            }
            if (opts.signoff) {
                args.push('--signoff');
            }
            try {
                yield this.run(args, { input: message || '' });
            }
            catch (commitErr) {
                if (/not possible because you have unmerged files/.test(commitErr.stderr || '')) {
                    commitErr.hgErrorCode = exports.HgErrorCodes.UnmergedChanges;
                    throw commitErr;
                }
                try {
                    yield this.run(['config', '--get-all', 'user.name']);
                }
                catch (err) {
                    err.hgErrorCode = exports.HgErrorCodes.NoUserNameConfigured;
                    throw err;
                }
                try {
                    yield this.run(['config', '--get-all', 'user.email']);
                }
                catch (err) {
                    err.hgErrorCode = exports.HgErrorCodes.NoUserEmailConfigured;
                    throw err;
                }
                throw commitErr;
            }
        });
    }
    branch(name, checkout) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = checkout ? ['checkout', '-q', '-b', name] : ['branch', '-q', name];
            yield this.run(args);
        });
    }
    clean(paths) {
        return __awaiter(this, void 0, void 0, function* () {
            const pathsByGroup = util_1.groupBy(paths, p => path.dirname(p));
            const groups = Object.keys(pathsByGroup).map(k => pathsByGroup[k]);
            const tasks = groups.map(paths => () => this.run(['clean', '-f', '-q', '--'].concat(paths)));
            for (let task of tasks) {
                yield task();
            }
        });
    }
    undo() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.run(['clean', '-fd']);
            try {
                yield this.run(['checkout', '--', '.']);
            }
            catch (err) {
                if (/did not match any file\(s\) known to hg\./.test(err.stderr || '')) {
                    return;
                }
                throw err;
            }
        });
    }
    reset(treeish, hard = false) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['reset'];
            if (hard) {
                args.push('--hard');
            }
            args.push(treeish);
            yield this.run(args);
        });
    }
    revertFiles(treeish, paths) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.run(['branch']);
            let args;
            // In case there are no branches, we must use rm --cached
            if (!result.stdout) {
                args = ['rm', '--cached', '-r', '--'];
            }
            else {
                args = ['reset', '-q', treeish, '--'];
            }
            if (paths && paths.length) {
                args.push.apply(args, paths);
            }
            else {
                args.push('.');
            }
            try {
                yield this.run(args);
            }
            catch (err) {
                // In case there are merge conflicts to be resolved, hg reset will output
                // some "needs merge" data. We try to get around that.
                if (/([^:]+: needs merge\n)+/m.test(err.stdout || '')) {
                    return;
                }
                throw err;
            }
        });
    }
    fetch() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.run(['fetch']);
            }
            catch (err) {
                if (/No remote repository specified\./.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.NoRemoteRepositorySpecified;
                }
                else if (/Could not read from remote repository/.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.RemoteConnectionError;
                }
                throw err;
            }
        });
    }
    pull(rebase) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['pull'];
            if (rebase) {
                args.push('-r');
            }
            try {
                yield this.run(args);
            }
            catch (err) {
                if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.Conflict;
                }
                else if (/Please tell me who you are\./.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.NoUserNameConfigured;
                }
                else if (/Could not read from remote repository/.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.RemoteConnectionError;
                }
                else if (/Pull is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/.test(err.stderr)) {
                    err.hgErrorCode = exports.HgErrorCodes.DirtyWorkTree;
                }
                throw err;
            }
        });
    }
    push(remote, name, options) {
        return __awaiter(this, void 0, void 0, function* () {
            const args = ['push'];
            if (options && options.setUpstream) {
                args.push('-u');
            }
            if (remote) {
                args.push(remote);
            }
            if (name) {
                args.push(name);
            }
            try {
                yield this.run(args);
            }
            catch (err) {
                if (/^error: failed to push some refs to\b/m.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.PushRejected;
                }
                else if (/Could not read from remote repository/.test(err.stderr || '')) {
                    err.hgErrorCode = exports.HgErrorCodes.RemoteConnectionError;
                }
                throw err;
            }
        });
    }
    getStatus() {
        return __awaiter(this, void 0, void 0, function* () {
            const executionResult = yield this.run(['status']);
            const status = executionResult.stdout;
            const result = [];
            let current;
            let i = 0;
            function readName() {
                const start = i;
                let c = status.charAt(i);
                while (c !== '\n' && c !== '\r') {
                    i++;
                    c = status.charAt(i);
                }
                // was it a windows line-ending?
                if (status.charAt(i + 1) == '\n') {
                    i++;
                }
                return status.substring(start, i++);
            }
            while (i < status.length) {
                current = {
                    status: status.charAt(i++),
                    path: ''
                };
                let gap = status.charAt(i++);
                if (gap != ' ') {
                    // message line: skip
                    readName();
                    continue;
                }
                current.path = readName();
                // if (current.path[current.path.length - 1] === '/') {
                // 	continue;
                // }
                result.push(current);
            }
            return result;
        });
    }
    getParent() {
        return __awaiter(this, void 0, void 0, function* () {
            const branchResult = yield this.run(['branch']);
            if (!branchResult.stdout) {
                throw new Error('Error parsing working directory branch result');
            }
            const branchName = branchResult.stdout.trim();
            const logResult = yield this.run(['log', '-r', branchName, '-l', '1', '--template="{short(node)}"']);
            if (!logResult.stdout) {
                throw new Error('Error parsing working directory log result');
            }
            return { name: branchName, commit: logResult.stdout.trim(), type: RefType.Branch };
        });
    }
    getRefs() {
        return __awaiter(this, void 0, void 0, function* () {
            const tagsResult = yield this.run(['tags']);
            const tagRefs = tagsResult.stdout.trim().split('\n')
                .filter(line => !!line)
                .map((line) => {
                let match = /^(.*)\s+(\d+):([A-Fa-f0-9]+)$/;
                if (match) {
                    return { name: match[1], commit: match[3], type: RefType.Tag };
                }
                return null;
            })
                .filter(ref => !!ref);
            const branches = yield this.run(['branches']);
            const branchRefs = tagsResult.stdout.trim().split('\n')
                .filter(line => !!line)
                .map((line) => {
                let match = /^(.*)\s+(\d+):([A-Fa-f0-9]+)(\s+\(inactive\))?$/;
                if (match) {
                    return { name: match[1], commit: match[3], type: RefType.Branch };
                }
                return null;
            })
                .filter(ref => !!ref);
            return [...tagRefs, ...branchRefs];
        });
    }
    getPaths() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.run(['paths']);
            const regex = /^([^\s]+)\s+=\s+([^\s]+)\s/;
            const rawPaths = result.stdout.trim().split('\n')
                .filter(b => !!b)
                .map(line => regex.exec(line))
                .filter(g => !!g)
                .map((groups) => ({ name: groups[1], url: groups[2] }));
            return rawPaths;
        });
    }
    getBranch(name) {
        return __awaiter(this, void 0, void 0, function* () {
            if (name === '.') {
                return this.getParent();
            }
            const result = yield this.run(['rev-parse', name]);
            if (!result.stdout) {
                return Promise.reject(new Error('No such branch'));
            }
            const commit = result.stdout.trim();
            try {
                const res2 = yield this.run(['rev-parse', '--symbolic-full-name', '--abbrev-ref', name + '@{u}']);
                const upstream = res2.stdout.trim();
                const res3 = yield this.run(['rev-list', '--left-right', name + '...' + upstream]);
                let ahead = 0, behind = 0;
                let i = 0;
                while (i < res3.stdout.length) {
                    switch (res3.stdout.charAt(i)) {
                        case '<':
                            ahead++;
                            break;
                        case '>':
                            behind++;
                            break;
                        default:
                            i++;
                            break;
                    }
                    while (res3.stdout.charAt(i++) !== '\n') { }
                }
                return { name, type: RefType.Branch, commit, upstream, ahead, behind };
            }
            catch (err) {
                return { name, type: RefType.Branch, commit };
            }
        });
    }
    getCommitTemplate() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const result = yield this.run(['config', '--get', 'commit.template']);
                if (!result.stdout) {
                    return '';
                }
                // https://github.com/git/git/blob/3a0f269e7c82aa3a87323cb7ae04ac5f129f036b/path.c#L612
                const homedir = os.homedir();
                let templatePath = result.stdout.trim()
                    .replace(/^~([^\/]*)\//, (_, user) => `${user ? path.join(path.dirname(homedir), user) : homedir}/`);
                if (!path.isAbsolute(templatePath)) {
                    templatePath = path.join(this.repositoryRoot, templatePath);
                }
                const raw = yield readfile(templatePath, 'utf8');
                return raw.replace(/^\s*#.*$\n?/gm, '').trim();
            }
            catch (err) {
                return '';
            }
        });
    }
    getCommit(ref) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.run(['show', '-s', '--format=%H\n%B', ref]);
            const match = /^([0-9a-f]{40})\n([^]*)$/m.exec(result.stdout.trim());
            if (!match) {
                return Promise.reject('bad commit format');
            }
            return { hash: match[1], message: match[2] };
        });
    }
}
exports.Repository = Repository;
//# sourceMappingURL=hg.js.map