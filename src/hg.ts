/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from "path";
import * as os from "os";
import * as cp from "child_process";
import {
    assign,
    groupBy,
    IDisposable,
    toDisposable,
    dispose,
    mkdirp,
    asciiOnly,
    writeStringToTempFile,
} from "./util";
import { EventEmitter, Event, workspace, Disposable, Uri } from "vscode";
import { HgCommandServer } from "./hgserve";

const isWindows = os.platform() === "win32";

export interface IHg {
    path: string;
    version: string;
}

export interface LogEntryRepositoryOptions extends LogEntryOptions {
    filePaths?: string[];
    follow?: boolean;
    limit?: number;
}

export interface LogEntryOptions {
    revQuery?: string;
    branch?: string;
    bookmark?: string;
}

export interface PushOptions extends PullOptions {
    allowPushNewBranches?: boolean;
}

export interface PullOptions extends SyncOptions {
    autoUpdate: boolean; // run an update after the pull?
}

export interface SyncOptions {
    bookmarks?: string[];
    branch?: string;
    revs?: string[];
}

export interface RebaseResult {
    unresolvedCount: number;
}

export interface ShelveOptions {
    name?: string;
}

export interface UnshelveOptions {
    name: string;
    keep?: boolean;
}

export interface MoveOptions {
    after: boolean;
}

export interface PurgeOptions {
    paths?: string[];
    all?: boolean;
}

export interface IMergeResult {
    unresolvedCount: number;
}

export interface IRepoStatus {
    isMerge: boolean;
    parents: Ref[];
}

export interface IFileStatus {
    status: string;
    path: string;
    rename?: string;
}

export interface ICommitDetails {
    message: string;
    affectedFiles: IFileStatus[];
}

export interface GetRefsOptions {
    excludeBookmarks?: boolean;
    excludeTags?: boolean;
}

export interface ILineAnnotation {
    hash: string;
    user: string;
    date?: Date;
    description: string;
}

export enum RefType {
    Branch,
    Tag,
    Bookmark,
    Commit,
}

export interface Ref {
    type: RefType;
    name?: string;
    commit?: string;
}

export interface Bookmark extends Ref {
    name: string;
    active: boolean;
}

export interface Shelve {
    name: string;
}

export interface Path {
    name: string;
    url: string;
}

function parseVersion(raw: string): string {
    const match = raw.match(/\(version ([^)]+)\)/);
    if (match) {
        return match[1];
    }

    return "?";
}

export interface HgFindAttemptLogger {
    log(path: string);
}

export class HgFinder {
    constructor(private logger: HgFindAttemptLogger) {}

    private logAttempt(path: string) {
        this.logger.log(path);
    }

    public async find(hint?: string): Promise<IHg> {
        const first = hint
            ? this.findSpecificHg(hint)
            : Promise.reject<IHg>(null);

        return first
            .then(undefined, () => {
                switch (process.platform) {
                    case "darwin":
                        return this.findHgDarwin();
                    case "win32":
                        return this.findHgWin32();
                    default:
                        return this.findSpecificHg("hg");
                }
            })
            .then(null, () =>
                Promise.reject(new Error("Mercurial installation not found."))
            );
    }

    private findHgDarwin(): Promise<IHg> {
        return this.findTortoiseHgDarwin(
            "/Applications/TortoiseHg.app/Contents/Resources"
        ).then(undefined, () => this.findHgDarwinUsingWhich());
    }

    private findTortoiseHgDarwin(base: string): Promise<IHg> {
        if (!base) {
            return Promise.reject<IHg>("Not found");
        }

        return this.findSpecificHg(path.join(base, "lib", "python2.7", "hg"));
    }

    private findHgDarwinUsingWhich(): Promise<IHg> {
        return new Promise<IHg>((c, e) => {
            cp.exec("which hg", (err, hgPathBuffer) => {
                if (err) {
                    return e("hg not found");
                }

                const path = hgPathBuffer.toString().replace(/^\s+|\s+$/g, "");

                const getVersion = (path: string) => {
                    // make sure hg executes
                    this.logAttempt(path);
                    cp.exec(
                        "hg --version",
                        { encoding: "utf-8", env: { HGPLAIN: "" } },
                        (err, stdout: Buffer) => {
                            if (err) {
                                return e("hg not found");
                            }

                            return c({
                                path,
                                version: parseVersion(
                                    stdout.toString("utf8").trim()
                                ),
                            });
                        }
                    );
                };

                return getVersion(path);
            });
        });
    }

    private findMercurialWin32(base: string | undefined): Promise<IHg> {
        if (!base) {
            return Promise.reject<IHg>("Not found");
        }

        return this.findSpecificHg(path.join(base, "Mercurial", "hg.exe"));
    }

    private findTortoiseHgWin32(base: string | undefined): Promise<IHg> {
        if (!base) {
            return Promise.reject<IHg>("Not found");
        }

        return this.findSpecificHg(path.join(base, "TortoiseHg", "hg.exe"));
    }

    private findHgWin32(): Promise<IHg> {
        return this.findMercurialWin32(process.env["ProgramW6432"])
            .then(undefined, () =>
                this.findMercurialWin32(process.env["ProgramFiles(x86)"])
            )
            .then(undefined, () =>
                this.findTortoiseHgWin32(process.env["ProgramW6432"])
            )
            .then(undefined, () =>
                this.findTortoiseHgWin32(process.env["ProgramFiles(x86)"])
            )
            .then(undefined, () => this.findSpecificHg("hg"));
    }

    private findSpecificHg(path: string): Promise<IHg> {
        return new Promise<IHg>((c, e) => {
            const buffers: Buffer[] = [];
            this.logAttempt(path);
            const child = cp.spawn(path, ["--version"], {
                env: { ...process.env, HGPLAIN: "" },
            });
            child.stdout.on("data", (b: Buffer) => buffers.push(b));
            child.on("error", e);
            child.on("exit", (code) => {
                if (!code) {
                    const output = Buffer.concat(buffers).toString("utf8");
                    return c({
                        path,
                        version: parseVersion(output),
                    });
                }
                return e(new Error("Not found"));
            });
        });
    }
}

export interface IExecutionResult<T extends string | Buffer> {
    exitCode: number;
    stdout: T;
    stderr: string;
}

export async function exec(
    child: cp.ChildProcess
): Promise<IExecutionResult<Buffer>> {
    if (!child.stdout || !child.stderr) {
        throw new HgError({
            message: "Failed to get stdout or stderr from git process.",
        });
    }

    const disposables: IDisposable[] = [];

    const once = (
        ee: NodeJS.EventEmitter,
        name: string,
        fn: (...args: any[]) => void
    ) => {
        ee.once(name, fn);
        disposables.push(toDisposable(() => ee.removeListener(name, fn)));
    };

    const on = (
        ee: NodeJS.EventEmitter,
        name: string,
        fn: (...args: any[]) => void
    ) => {
        ee.on(name, fn);
        disposables.push(toDisposable(() => ee.removeListener(name, fn)));
    };

    const result = Promise.all<any>([
        new Promise<number>((c, e) => {
            once(child, "error", e);
            once(child, "exit", c);
        }),
        new Promise<Buffer>((c) => {
            const buffers: Buffer[] = [];
            on(child.stdout!, "data", (b: Buffer) => buffers.push(b));
            once(child.stdout!, "close", () => c(Buffer.concat(buffers)));
        }),
        new Promise<string>((c) => {
            const buffers: Buffer[] = [];
            on(child.stderr!, "data", (b: Buffer) => buffers.push(b));
            once(child.stderr!, "close", () =>
                c(Buffer.concat(buffers).toString("utf8"))
            );
        }),
    ]) as Promise<[number, Buffer, string]>;

    try {
        const [exitCode, stdout, stderr] = await result;
        return { exitCode, stdout, stderr };
    } finally {
        dispose(disposables);
    }
}

export interface IHgErrorData {
    error?: Error;
    message?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    hgErrorCode?: string;
    hgCommand?: string;
}

export class HgRollbackDetails {
    revision: number;
    kind: string;
    commitDetails: ICommitDetails | undefined;
}

export class HgError {
    error?: Error;
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    hgErrorCode?: string;
    hgCommand?: string;
    hgBranches?: string;
    hgFilenames?: string[];

    constructor(data: IHgErrorData) {
        if (data.error) {
            this.error = data.error;
            this.message = data.error.message;
        } else {
            this.error = void 0;
        }

        this.message = this.message || data.message || "Hg error";
        this.stdout = data.stdout;
        this.stderr = data.stderr;
        this.exitCode = data.exitCode;
        this.hgErrorCode = data.hgErrorCode;
        this.hgCommand = data.hgCommand;
    }

    toString(): string {
        let result =
            this.message +
            " " +
            JSON.stringify(
                {
                    exitCode: this.exitCode,
                    hgErrorCode: this.hgErrorCode,
                    hgCommand: this.hgCommand,
                    stdout: this.stdout,
                    stderr: this.stderr,
                },
                [],
                2
            );

        if (this.error) {
            result += (<any>this.error).stack;
        }

        return result;
    }
}

export interface IHgOptions {
    hgPath: string;
    version: string;
    env?: any;
    enableInstrumentation: boolean;
}

export const HgErrorCodes = {
    BadConfigFile: "BadConfigFile",
    AuthenticationFailed: "AuthenticationFailed",
    NoUserNameConfigured: "NoUserNameConfigured",
    RepositoryDefaultNotFound: "RepositoryDefaultNotFound",
    RepositoryIsUnrelated: "RepositoryIsUnrelated",
    NotAnHgRepository: "NotAnHgRepository",
    NotAtRepositoryRoot: "NotAtRepositoryRoot",
    UnmergedChanges: "UnmergedChanges",
    PushCreatesNewRemoteHead: "PushCreatesNewRemoteHead",
    PushCreatesNewRemoteBranches: "PushCreatesNewRemoteBranches",
    RemoteConnectionError: "RemoteConnectionError",
    DirtyWorkingDirectory: "DirtyWorkingDirectory",
    CantOpenResource: "CantOpenResource",
    HgNotFound: "HgNotFound",
    CantCreatePipe: "CantCreatePipe",
    CantAccessRemote: "CantAccessRemote",
    RepositoryNotFound: "RepositoryNotFound",
    NoSuchFile: "NoSuchFile",
    ExtensionMissing: "ExtensionMissing",
    BranchAlreadyExists: "BranchAlreadyExists",
    NoRollbackInformationAvailable: "NoRollbackInformationAvailable",
    UntrackedFilesDiffer: "UntrackedFilesDiffer",
    NothingToRebase: "NothingToRebase",
    NoRebaseInProgress: "NoRebaseInProgress",
    DefaultRepositoryNotConfigured: "DefaultRepositoryNotConfigured",
    UnshelveInProgress: "UnshelveInProgress",
    ShelveConflict: "ShelveConflict",
};

export class Hg {
    private hgPath: string;
    private version: string;
    private server: HgCommandServer | undefined;
    private instrumentEnabled: boolean;
    private useServer: boolean;
    private disposables: Disposable[] = [];
    private openRepository: Repository | undefined;

    private _onOutput = new EventEmitter<string>();
    get onOutput(): Event<string> {
        return this._onOutput.event;
    }

    constructor(options: IHgOptions) {
        this.hgPath = options.hgPath;
        this.version = options.version;
        this.instrumentEnabled = options.enableInstrumentation;

        workspace.onDidChangeConfiguration(
            () => this.onConfigurationChange(),
            this,
            this.disposables
        );
        this.onConfigurationChange();
    }

    async onConfigurationChange(forceServerRestart?: boolean): Promise<void> {
        const hgConfig = workspace.getConfiguration("hg");
        const wasUsingServer = this.useServer;
        const useServer = hgConfig.get<string>("commandMode") === "server";
        this.useServer = useServer;

        if (this.server && (!useServer || forceServerRestart)) {
            this.server.stop();
            this.server = undefined;
            this.log("cmdserve stopped\n");
        }

        if (useServer && (!wasUsingServer || forceServerRestart)) {
            if (this.openRepository !== undefined) {
                this.server = await this.startServer(this.openRepository.root);
            }
        }
    }

    async startServer(repositoryRoot: string): Promise<HgCommandServer> {
        const hgFolderPath = path.dirname(this.hgPath);
        const logger = this.log.bind(this);
        const server = await HgCommandServer.start(
            hgFolderPath,
            repositoryRoot,
            logger
        );
        logger("cmdserve started\n");
        return server;
    }

    open(repository: string): Repository {
        if (this.useServer) {
            this.startServer(repository).then(
                (server) => (this.server = server)
            );
        }
        this.openRepository = new Repository(this, repository);
        return this.openRepository;
    }

    async init(repository: string): Promise<void> {
        await this.exec(repository, ["init"]);
        return;
    }

    async clone(url: string, parentPath: string): Promise<string> {
        const folderName = url.replace(/^.*\//, "") || "repository";
        const folderPath = path.join(parentPath, folderName);

        await mkdirp(parentPath);
        await this.exec(parentPath, ["clone", url, folderPath]);
        return folderPath;
    }

    async getRepositoryRoot(path: string): Promise<string> {
        const result = await this.exec(path, ["root"], {
            stdoutIsBinaryEncodedInWindows: true,
        });
        return result.stdout.trim();
    }

    async exec(
        cwd: string,
        args: string[],
        options: any = {}
    ): Promise<IExecutionResult<string>> {
        options = { cwd, ...options };
        return await this._exec(args, options);
    }

    stream(cwd: string, args: string[], options: any = {}): cp.ChildProcess {
        options = assign({ cwd }, options || {});
        return this.spawn(args, options);
    }

    private async runServerCommand(
        server: HgCommandServer,
        args: string[],
        options: any = {}
    ) {
        if (options.log !== false && !this.instrumentEnabled) {
            this.log(`hg ${args.join(" ")}\n`);
        }
        const result = await server.runcommand(...args);
        return result;
    }

    private async _exec(
        args: string[],
        options: any = {}
    ): Promise<IExecutionResult<string>> {
        const startTimeHR = process.hrtime();

        let result: IExecutionResult<string>;
        if (this.server) {
            result = await this.runServerCommand(this.server, args, options);
        } else {
            const child = this.spawn(args, options);
            if (options.input) {
                child.stdin.end(options.input, "utf8");
            }

            const bufferResult = await exec(child);

            if (options.log !== false && bufferResult.stderr.length > 0) {
                this.log(`${bufferResult.stderr}\n`);
            }

            const stdoutEncoding =
                isWindows && options.stdoutIsBinaryEncodedInWindows
                    ? "binary"
                    : "utf8";
            result = {
                exitCode: bufferResult.exitCode,
                stdout: bufferResult.stdout.toString(stdoutEncoding),
                stderr: bufferResult.stderr,
            };
        }

        if (this.instrumentEnabled) {
            const durationHR = process.hrtime(startTimeHR);
            this.log(
                `hg ${args.join(" ")}: ${Math.floor(
                    msFromHighResTime(durationHR)
                )}ms\n`
            );
        }

        if (result.exitCode) {
            let hgErrorCode: string | undefined = void 0;

            if (/Authentication failed/.test(result.stderr)) {
                hgErrorCode = HgErrorCodes.AuthenticationFailed;
            } else if (/no repository found/.test(result.stderr)) {
                hgErrorCode = HgErrorCodes.NotAnHgRepository;
            } else if (/no such file/.test(result.stderr)) {
                hgErrorCode = HgErrorCodes.NoSuchFile;
            } else if (/unknown command/.test(result.stderr)) {
                hgErrorCode = HgErrorCodes.ExtensionMissing;
                result.stderr = result.stderr.replace(
                    /.*(unknown command '.*?').*/s,
                    "$1"
                );
            }

            if (options.logErrors !== false && result.stderr) {
                this.log(`${result.stdout}\n${result.stderr}\n`);
            }

            return Promise.reject<IExecutionResult<string>>(
                new HgError({
                    message: "Failed to execute hg",
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    hgErrorCode,
                    hgCommand: args[0],
                })
            );
        }

        return result;
    }

    spawn(args: string[], options: any = {}): cp.ChildProcess {
        if (!this.hgPath) {
            throw new Error("hg could not be found in the system.");
        }

        if (!options) {
            options = {};
        }

        if (!options.stdio && !options.input) {
            options.stdio = ["ignore", null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
        }

        options.env = {
            HGENCODING: "utf-8", // allow user's env to overwrite this
            ...process.env,
            ...options.env,
            HGPLAIN: "",
            VSCODE_HG_COMMAND: args[0],
            LC_ALL: "en_US.UTF-8",
            LANG: "en_US.UTF-8",
        };

        if (!this.instrumentEnabled && options.log !== false) {
            this.log(`hg ${args.join(" ")}\n`);
        }

        return cp.spawn(this.hgPath, args, options);
    }

    private log(output: string): void {
        this._onOutput.fire(output);
    }
}

export interface Revision {
    revision: number;
    hash: string;
}

export interface Commit extends Revision {
    branch: string;
    message: string;
    author: string;
    date: Date;
    bookmarks: string[];
}

interface NativeCommit {
    rev: number;
    node: string;
    branch: string;
    phase: string;
    user: string;
    date: [number, number];
    desc: string;
    bookmarks: string[];
    tags: string[];
    parents: string[];
}

export interface CommitDetails extends Commit {
    files: IFileStatus[];
    parent1: Commit;
    parent2: Commit | undefined;
}

export class Repository {
    constructor(private _hg: Hg, private repositoryRoot: string) {}

    get hg(): Hg {
        return this._hg;
    }

    get root(): string {
        return this.repositoryRoot;
    }

    // TODO@Joao: rename to exec
    async run(
        args: string[],
        options: any = {}
    ): Promise<IExecutionResult<string>> {
        return await this.hg.exec(this.repositoryRoot, args, options);
    }

    stream(args: string[], options: any = {}): cp.ChildProcess {
        return this.hg.stream(this.repositoryRoot, args, options);
    }

    spawn(args: string[], options: any = {}): cp.ChildProcess {
        return this.hg.spawn(args, options);
    }

    async config(
        scope: string,
        key: string,
        value: string,
        options: any = {}
    ): Promise<string> {
        const args = ["config"];

        if (scope) {
            args.push("--" + scope);
        }

        args.push(key);

        if (value) {
            args.push(value);
        }

        const result = await this.run(args, options);
        return result.stdout;
    }

    async add(paths?: string[]): Promise<void> {
        const args = ["add"];

        if (paths && paths.length) {
            args.push(...paths);
        } else {
            // args.push('.');
        }

        await this.run(args);
    }

    async addRemove(paths: string[]): Promise<void> {
        const args = ["addremove", "-s", "50"];

        for (const path of paths) {
            args.push("-I", path);
        }

        await this.run(args);
    }

    async resolve(
        paths: string[],
        opts: { mark?: boolean } = {}
    ): Promise<void> {
        const args = ["resolve"];

        if (opts.mark) {
            args.push("--mark");
        }

        args.push(...paths);

        try {
            await this.run(args);
        } catch (e) {
            if (e instanceof HgError && e.exitCode === 1 && !e.stderr) {
                return;
            }

            throw e;
        }
    }

    async unresolve(paths: string[]): Promise<void> {
        const args = ["resolve", "--unmark"];
        args.push(...paths);

        await this.run(args);
    }

    async cat(relativePath: string, ref?: string): Promise<string> {
        const args = ["cat", relativePath];
        if (ref) {
            args.push("-r", ref);
        }
        const result = await this.run(args, { logErrors: false });
        return result.stdout;
    }

    async catAsStream(relativePath: string, ref: string): Promise<Buffer> {
        const args = ["cat", relativePath];
        if (ref) {
            args.push("-r", ref);
        }
        const child = this.stream(args);

        if (!child.stdout) {
            return Promise.reject<Buffer>("Can't open file from hg");
        }

        const { exitCode, stdout, stderr } = await exec(child);

        if (exitCode) {
            const err = new HgError({
                message: "Could not show object.",
                exitCode,
            });

            if (/exists on disk, but not in/.test(stderr)) {
                err.hgErrorCode = HgErrorCodes.NoSuchFile;
            }

            return Promise.reject<Buffer>(err);
        }

        return stdout;
    }

    async bookmark(
        name: string,
        opts?: { remove?: boolean; force?: boolean }
    ): Promise<void> {
        const args = ["bookmark", name];
        if (opts && opts.force) {
            args.push("-f");
        }

        if (opts && opts.remove) {
            args.push("-d");
        }

        await this.run(args);
    }

    async update(treeish: string, opts?: { discard: boolean }): Promise<void> {
        const args = ["update", "-q"];

        if (treeish) {
            args.push(treeish);
        }

        if (opts && opts.discard) {
            args.push("--clean");
        }

        try {
            await this.run(args);
        } catch (err) {
            if (/uncommitted changes/.test(err.stderr || "")) {
                err.hgErrorCode = HgErrorCodes.DirtyWorkingDirectory;
            }

            throw err;
        }
    }

    async commit(
        message: string,
        opts: {
            addRemove?: boolean;
            amend?: boolean;
            fileList: string[];
        } = Object.create(null)
    ): Promise<void> {
        const disposables: IDisposable[] = [];
        const args = ["commit"];

        if (opts.addRemove) {
            args.push("--addremove");
        }

        if (opts.amend) {
            args.push("--amend");
        }

        if (opts.fileList && opts.fileList.length) {
            args.push(...opts.fileList);
        }

        if (asciiOnly(message)) {
            args.push("-m", message || "");
        } else {
            const commitMessageFsPath = await writeStringToTempFile(
                message,
                disposables
            );
            args.push("-l", commitMessageFsPath);
        }

        try {
            await this.run(args);
        } catch (err) {
            if (
                /not possible because you have unmerged files/.test(err.stderr)
            ) {
                err.hgErrorCode = HgErrorCodes.UnmergedChanges;
                throw err;
            }

            throw err;
        } finally {
            dispose(disposables);
        }
    }

    async branch(name: string, opts?: { force: boolean }): Promise<void> {
        const args = ["branch", "-q"];
        if (opts && opts.force) {
            args.push("-f");
        }
        args.push(name);

        try {
            await this.run(args);
        } catch (err) {
            if (
                err instanceof HgError &&
                /a branch of the same name already exists/.test(
                    err.stderr || ""
                )
            ) {
                err.hgErrorCode = HgErrorCodes.BranchAlreadyExists;
            }

            throw err;
        }
    }

    async revert(paths: string[]): Promise<void> {
        const pathsByGroup = groupBy(paths, (p) => path.dirname(p));
        const groups = Object.keys(pathsByGroup).map((k) => pathsByGroup[k]);
        const tasks = groups.map((paths) => () =>
            this.run(["revert", "-C"].concat(paths))
        ); // -C = no-backup

        for (const task of tasks) {
            await task();
        }
    }

    async forget(paths: string[]): Promise<void> {
        const pathsByGroup = groupBy(paths, (p) => path.dirname(p));
        const groups = Object.keys(pathsByGroup).map((k) => pathsByGroup[k]);
        const tasks = groups.map((paths) => () =>
            this.run(["forget"].concat(paths))
        );

        for (const task of tasks) {
            await task();
        }
    }

    async purge(opts: PurgeOptions): Promise<void> {
        const args = ["purge", "--config", "extensions.purge="];

        if (opts.paths && opts.paths.length) {
            args.push(...opts.paths);
        }
        if (opts.all) {
            args.push("--all");
        }

        await this.run(args);
    }

    async rollback(dryRun?: boolean): Promise<HgRollbackDetails> {
        const args = ["rollback"];

        if (dryRun) {
            args.push("--dry-run");
        }

        try {
            const result = await this.run(args);
            const match = /back to revision (\d+) \(undo (.*)\)/.exec(
                result.stdout
            );

            if (!match) {
                throw new HgError({
                    message: `Unexpected rollback result: ${JSON.stringify(
                        result.stdout
                    )}`,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    hgCommand: "rollback",
                });
            }

            const [_, revision, kind] = match;
            const commitDetails: ICommitDetails | undefined =
                dryRun && kind === "commit"
                    ? await this.tryGetLastCommitDetails()
                    : undefined;

            return {
                revision: parseInt(revision),
                kind,
                commitDetails,
            };
        } catch (error) {
            if (
                error instanceof HgError &&
                /no rollback information available/.test(error.stderr || "")
            ) {
                error.hgErrorCode = HgErrorCodes.NoRollbackInformationAvailable;
            }
            throw error;
        }
    }

    private async rebase(args: string[]): Promise<RebaseResult> {
        try {
            await this.run([
                "rebase",
                "--config",
                "extensions.rebase=",
                "--tool",
                "internal:merge",
                ...args,
            ]);
            return {
                unresolvedCount: 0,
            };
        } catch (e) {
            if (
                e instanceof HgError &&
                e.stdout &&
                e.stdout.match(/nothing to rebase/)
            ) {
                e.hgErrorCode = HgErrorCodes.NothingToRebase;
                throw e;
            }

            if (
                e instanceof HgError &&
                e.stderr &&
                e.stderr.match(/no rebase in progress/)
            ) {
                e.hgErrorCode = HgErrorCodes.NoRebaseInProgress;
            }

            if (
                e instanceof HgError &&
                e.stderr &&
                e.stderr.match(/untracked files in working directory differ/)
            ) {
                e.hgErrorCode = HgErrorCodes.UntrackedFilesDiffer;
                e.hgFilenames = this.parseUntrackedFilenames(e.stderr);
            }

            if (e instanceof HgError && e.exitCode === 1) {
                const match = (e.stdout || "").match(/(\d+) files unresolved/);
                if (match) {
                    return {
                        unresolvedCount: parseInt(match[1]),
                    };
                }
            }

            throw e;
        }
    }

    async rebaseCurrentBranch(destination: string): Promise<RebaseResult> {
        return this.rebase(["--base", ".", "--dest", destination]);
    }

    async rebaseAbort(): Promise<void> {
        await this.rebase(["--abort"]);
    }

    async rebaseContinue(): Promise<RebaseResult> {
        return this.rebase(["--continue"]);
    }

    async shelve(opts: ShelveOptions): Promise<void> {
        const args = ["shelve", "--config", "extensions.shelve="];
        if (opts.name) {
            args.push("--name", opts.name);
        }

        await this.run(args);
    }

    async getShelves(): Promise<Shelve[]> {
        const result = await this.run(
            ["shelve", "--config", "extensions.shelve=", "--list", "--quiet"],
            {
                stdoutIsBinaryEncodedInWindows: true,
            }
        );
        const shelves = result.stdout
            .trim()
            .split("\n")
            .filter((l) => !!l)
            .map((line) => ({ name: line }));
        return shelves;
    }

    async unshelve(opts: UnshelveOptions): Promise<void> {
        const args = [
            "unshelve",
            "--config",
            "extensions.shelve=",
            "--name",
            opts.name,
        ];
        if (opts.keep) {
            args.push("--keep");
        }

        try {
            await this.run(args);
        } catch (err) {
            if (/unresolved conflicts/.test(err.stderr || "")) {
                err.hgErrorCode = HgErrorCodes.ShelveConflict;
            } else if (
                /abort: unshelve already in progress/.test(err.stderr || "")
            ) {
                err.hgErrorCode = HgErrorCodes.UnshelveInProgress;
            }

            throw err;
        }
    }

    async unshelveAbort(): Promise<void> {
        await this.run([
            "unshelve",
            "--config",
            "extensions.shelve=",
            "--abort",
        ]);
    }

    async unshelveContinue(): Promise<void> {
        await this.run([
            "unshelve",
            "--config",
            "extensions.shelve=",
            "--continue",
        ]);
    }

    async move(src: Uri, dest: Uri, opts: MoveOptions): Promise<void> {
        const args = ["move", src.path, dest.path];
        if (opts.after) {
            args.push("--after");
        }
        await this.run(args);
    }

    async tryGetLastCommitDetails(): Promise<ICommitDetails> {
        try {
            return {
                message: await this.getLastCommitMessage(),
                affectedFiles: await this.getStatus("."),
            };
        } catch (e) {
            return {
                message: "",
                affectedFiles: [],
            };
        }
    }

    async countIncoming(options?: SyncOptions): Promise<number> {
        try {
            return options && options.bookmarks && options.bookmarks.length
                ? await this.countIncomingForBookmarks(
                      options.bookmarks,
                      options
                  )
                : await this.countIncomingOutgoingSimple("incoming", options);
        } catch (err) {
            if (err instanceof HgError && err.exitCode === 1) {
                // expected result from hg when none
                return 0;
            }

            if (
                /repository default(-push)? not found!/.test(err.stderr || "")
            ) {
                err.hgErrorCode = HgErrorCodes.RepositoryDefaultNotFound;
            } else if (/repository is unrelated/.test(err.stderr || "")) {
                err.hgErrorCode = HgErrorCodes.RepositoryIsUnrelated;
            } else if (/abort/.test(err.stderr || "")) {
                err.hgErrorCode = HgErrorCodes.RemoteConnectionError;
            }

            throw err;
        }
    }

    async countIncomingOutgoingSimple(
        command: "incoming" | "outgoing",
        options?: SyncOptions
    ): Promise<number> {
        const args = [command, "-q"];
        if (options && options.branch) {
            args.push("-b", options.branch);
        }
        if (options && options.revs) {
            for (const rev of options.revs) {
                args.push("-r", rev);
            }
        }
        const commandResult = await this.run(args);
        if (commandResult.stdout) {
            const count = commandResult.stdout.trim().split("\n").length;
            return count;
        }
        return 0;
    }

    async countIncomingForBookmarks(
        bookmarks: string[],
        options?: SyncOptions
    ): Promise<number> {
        const args = ["incoming", "-q"];
        if (options && options.branch) {
            args.push("-b", options.branch);
        }

        // have any of our bookmarks changed on the remote?
        // ...results will look something like:
        // -----------------------------------------
        //    hobbit                    02e814f73802
        //    lotr                      f074f6108afc
        const bookmarkResult = await this.run([...args, "--bookmarks"]);
        const bookmarkChangedPattern = /\s*(.*?)\s+(\S+)\s*$/;
        const hashesOfBookmarkedRevisions: string[] = [];
        for (const line of bookmarkResult.stdout.trim().split("\n")) {
            const match = line && line.match(bookmarkChangedPattern);
            if (!match) {
                continue;
            }

            const [_, bookmark, hash] = match;
            if (!bookmarks.includes(bookmark)) {
                continue;
            }

            hashesOfBookmarkedRevisions.push(hash);
        }

        if (hashesOfBookmarkedRevisions.length === 0) {
            return 0;
        }

        // count how many changesets for the interested revs
        return this.countIncomingOutgoingSimple("incoming", {
            ...options,
            revs: hashesOfBookmarkedRevisions,
        });
    }

    async countOutgoing(options?: SyncOptions): Promise<number> {
        try {
            const args = ["outgoing", "-q"];
            if (options && options.branch) {
                args.push("-b", options.branch);
            }

            return options && options.bookmarks && options.bookmarks.length
                ? await this.countOutgoingForBookmarks(
                      options.bookmarks,
                      options
                  )
                : await this.countIncomingOutgoingSimple("outgoing", options);
        } catch (err) {
            if (err instanceof HgError && err.exitCode === 1) {
                // expected result from hg when none
                return 0;
            }

            if (
                /repository default(-push)? not found!/.test(err.stderr || "")
            ) {
                err.hgErrorCode = HgErrorCodes.RepositoryDefaultNotFound;
            } else if (/abort/.test(err.stderr || "")) {
                err.hgErrorCode = HgErrorCodes.RemoteConnectionError;
            }

            throw err;
        }
    }

    async countOutgoingForBookmarks(
        bookmarks: string[],
        options?: SyncOptions
    ): Promise<number> {
        // filtered count (based on list of bookmarks)

        const args = ["outgoing", "-q"];
        if (options && options.branch) {
            args.push("-b", options.branch);
        }
        args.push("-T", "{rev}:{node}:{join(bookmarks,'\\t')}\\n");

        const outgoingResult = await this.run(args);
        const count = outgoingResult.stdout
            .trim()
            .split("\n")
            .filter((line) => !!line)
            .map((line: string): string[] => {
                const [_rev, _hash, tabDelimBookmarks] = line.split(":", 3);
                const bookmarks = tabDelimBookmarks
                    ? tabDelimBookmarks.split("\t")
                    : [];
                return bookmarks; // <-- the bookmarks for this commit
            })
            .filter((bookmarksForCommit) => {
                return bookmarks.some((bookmark) =>
                    bookmarksForCommit.includes(bookmark)
                );
            }).length;

        return count;
    }

    async pull(options?: PullOptions): Promise<void> {
        const args = ["pull", "-q"];

        if (options && options.branch) {
            args.push("-b", options.branch);
        }

        if (options && options.bookmarks) {
            for (const bookmark of options.bookmarks) {
                args.push("-B", bookmark);
            }
        }

        if (options && options.autoUpdate) {
            args.push("-u");
        }

        try {
            await this.run(args);
        } catch (err) {
            if (err instanceof HgError && err.exitCode === 1) {
                return;
            }

            if (
                err instanceof HgError &&
                err.stderr &&
                /default repository not configured/.test(err.stderr)
            ) {
                err.hgErrorCode = HgErrorCodes.DefaultRepositoryNotConfigured;
            }

            throw err;
        }
    }

    async push(path?: string, options?: PushOptions): Promise<void> {
        const args = ["push", "-q"];

        if (options && options.allowPushNewBranches) {
            args.push("--new-branch");
        }

        if (options && options.branch) {
            args.push("-b", options.branch);
        }

        if (options && options.bookmarks) {
            for (const bookmark of options.bookmarks) {
                args.push("-B", bookmark);
            }
        }

        if (path) {
            args.push(path);
        }

        try {
            await this.run(args);
        } catch (err) {
            if (err instanceof HgError && err.exitCode === 1) {
                return;
            }

            if (
                err instanceof HgError &&
                err.stderr &&
                /default repository not configured/.test(err.stderr)
            ) {
                err.hgErrorCode = HgErrorCodes.DefaultRepositoryNotConfigured;
            } else if (/push creates new remote head/.test(err.stderr || "")) {
                err.hgErrorCode = HgErrorCodes.PushCreatesNewRemoteHead;
            } else if (
                err instanceof HgError &&
                err.stderr &&
                /push creates new remote branches/.test(err.stderr)
            ) {
                err.hgErrorCode = HgErrorCodes.PushCreatesNewRemoteBranches;
                const branchMatch = err.stderr.match(/: (.*)!/);
                if (branchMatch) {
                    err.hgBranches = branchMatch[1];
                }
            }

            throw err;
        }
    }

    private parseUntrackedFilenames(stderr: string): string[] {
        const untrackedFilesPattern = /([^:]+): untracked file differs\n/g;
        let match: RegExpExecArray | null;
        const files: string[] = [];
        while ((match = untrackedFilesPattern.exec(stderr))) {
            if (match !== null) {
                files.push(match[1]);
            }
        }
        return files;
    }

    async merge(revQuery: string): Promise<IMergeResult> {
        try {
            await this.run(["merge", "-r", revQuery]);
            return {
                unresolvedCount: 0,
            };
        } catch (e) {
            if (
                e instanceof HgError &&
                e.stderr &&
                e.stderr.match(/untracked files in working directory differ/)
            ) {
                e.hgErrorCode = HgErrorCodes.UntrackedFilesDiffer;
                e.hgFilenames = this.parseUntrackedFilenames(e.stderr);
            }

            if (e instanceof HgError && e.exitCode === 1) {
                const match = (e.stdout || "").match(/(\d+) files unresolved/);
                if (match) {
                    return {
                        unresolvedCount: parseInt(match[1]),
                    };
                }
            }

            throw e;
        }
    }

    async getSummary(): Promise<IRepoStatus> {
        const parents = await this.getLogEntries({ revQuery: "p1() + p2()" });

        return {
            isMerge: parents.length > 1,
            parents: parents.map(
                (p: Commit): Ref => {
                    return {
                        type: RefType.Commit,
                        commit: p.hash.substr(0, 12),
                    };
                }
            ),
        };
    }

    async getLastCommitMessage(): Promise<string> {
        const { stdout: message } = await this.run([
            "log",
            "-r",
            ".",
            "-T",
            "{desc}",
        ]);
        return message;
    }

    async getResolveList(): Promise<IFileStatus[]> {
        const resolveResult = await this.run(["resolve", "--list"]);
        const resolve = resolveResult.stdout;
        return this.parseStatusLines(resolve);
    }

    async getStatus(revision?: string): Promise<IFileStatus[]> {
        const args = ["status", "-C"];

        if (revision) {
            args.push("--change", `${revision}`);
        }

        const executionResult = await this.run(args, {
            stdoutIsBinaryEncodedInWindows: true,
        }); // quiet, include renames/copies
        const status = executionResult.stdout;
        return this.parseStatusLines(status);
    }

    parseStatusLines(status: string): IFileStatus[] {
        const result: IFileStatus[] = [];
        let current: IFileStatus | undefined;
        let i = 0;

        function readName(): string {
            const start = i;
            let c: string = status.charAt(i);
            while (c !== "\n" && c !== "\r") {
                i++;
                c = status.charAt(i);
            }

            // was it a windows line-ending?
            if (status.charAt(i + 1) == "\n") {
                i++;
            }

            const name = status.substring(start, i++);
            return name.replace(/\\/g, "/");
        }

        while (i < status.length) {
            const code = status.charAt(i++);
            const gap = status.charAt(i++);

            // copy/rename line?
            if (code === " " && gap === " " && current) {
                [current.path, current.rename] = [readName(), current.path];
                continue;
            }

            current = {
                status: code,
                path: "",
            };

            // message line: skip?
            if (gap !== " ") {
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
    }

    async getCurrentBranch(): Promise<Ref> {
        const branchResult = await this.run(["branch"]);
        if (!branchResult.stdout) {
            throw new Error("Error parsing working directory branch result");
        }
        const branchName = branchResult.stdout.trim();
        // const logResult = await this.run(['identify'])
        // if (!logResult.stdout) {
        // 	throw new Error('Error parsing working directory identify result');
        // }

        return { name: branchName, commit: "", type: RefType.Branch };
    }

    async getActiveBookmark(): Promise<Bookmark | undefined> {
        const bookmarks = await this.getBookmarks();
        const activeBookmark = bookmarks.filter((b) => b.active)[0];
        return activeBookmark;
    }

    private async getNativeCommits({
        revQuery,
        branch,
        filePaths,
        follow,
        limit,
    }: LogEntryRepositoryOptions = {}): Promise<NativeCommit[]> {
        const args = ["log", "-T", "json"];

        if (revQuery) {
            args.push("-r", revQuery);
        }

        if (branch) {
            args.push("-b", branch);
        }

        if (follow) {
            args.push("-f");
        }

        if (limit) {
            args.push("-l", `${limit}`);
        }

        if (filePaths) {
            args.push(...filePaths);
        }

        const result = await this.run(args);
        return JSON.parse(result.stdout.trim()) as NativeCommit[];
    }

    async getLogEntries(
        options: LogEntryRepositoryOptions = {}
    ): Promise<Commit[]> {
        const nativeCommits = await this.getNativeCommits(options);

        return nativeCommits.map(
            (commit: NativeCommit): Commit => {
                return {
                    revision: commit.rev,
                    date: new Date(commit.date[0] * 1000),
                    hash: commit.node,
                    branch: commit.branch,
                    message: commit.desc,
                    author: commit.user,
                    bookmarks: commit.bookmarks,
                } as Commit;
            }
        );
    }

    async annotate(filePath: string, rev?: string): Promise<ILineAnnotation[]> {
        const templateFields = [
            "short(node)",
            "shortdate(date)",
            "person(author)",
            "firstline(desc)",
        ];
        const args = [
            "annotate",
            "-T",
            `"{lines % '{${templateFields.join("}|{")}}\\n'}"`,
            filePath,
        ];
        if (rev) {
            args.push("-r", rev);
        }
        const annotateResult = await this.run(args);
        const lines = annotateResult.stdout.trim().split("\n");
        return lines.map((annotation) => {
            const components = annotation.split("|", templateFields.length);
            return {
                hash: components[0],
                date: new Date(components[1]),
                user: components[2],
                description: components[3],
            } as ILineAnnotation;
        });
    }

    async getParents(revision?: string): Promise<Commit[]> {
        return this.getLogEntries({ revQuery: `parents(${revision || ""})` });
    }

    async getHeads(options?: {
        branch?: string;
        excludeSelf?: boolean;
        excludeSecret?: boolean;
    }): Promise<Commit[]> {
        const excludeSelf = options && options.excludeSelf ? " - ." : "";
        const heads =
            options && options.excludeSecret
                ? "heads(all() and not secret())"
                : "head()";
        const revQuery = `${heads} and not closed()${excludeSelf}`;
        return this.getLogEntries({
            revQuery,
            branch: options && options.branch,
        });
    }

    async getTags(): Promise<Ref[]> {
        const tagsResult = await this.run(["tags"]);
        const tagRefs = tagsResult.stdout
            .trim()
            .split("\n")
            .filter((line) => !!line)
            .map((line: string): Ref | null => {
                const match = line.match(/^(.*?)\s+(\d+):([A-Fa-f0-9]+)$/);
                if (match) {
                    return {
                        name: match[1],
                        commit: match[3],
                        type: RefType.Tag,
                    };
                }
                return null;
            })
            .filter((ref) => !!ref) as Ref[];

        return tagRefs;
    }

    async getBranches(): Promise<Ref[]> {
        const branchesResult = await this.run(["branches"]);
        const branchRefs = branchesResult.stdout
            .trim()
            .split("\n")
            .filter((line) => !!line)
            .map((line: string): Ref | null => {
                const match = line.match(
                    /^(.*?)\s+(\d+):([A-Fa-f0-9]+)(\s+\(inactive\))?$/
                );
                if (match) {
                    return {
                        name: match[1],
                        commit: match[3],
                        type: RefType.Branch,
                    };
                }
                return null;
            })
            .filter((ref) => !!ref) as Ref[];

        return branchRefs;
    }

    async getDraftHeads(opts: GetRefsOptions): Promise<Ref[]> {
        const draftHeads = await this.getNativeCommits({
            revQuery: "head() and draft()",
        });

        return draftHeads
            .filter(
                (c) =>
                    (!opts.excludeTags || c.tags.length === 0) &&
                    (!opts.excludeBookmarks || c.bookmarks.length === 0)
            )
            .map((c) => {
                return {
                    type: RefType.Commit,
                    commit: c.node.substr(0, 12),
                };
            });
    }

    async getPublicTip(opts: GetRefsOptions): Promise<Ref[]> {
        const maxPublic = await this.getNativeCommits({
            revQuery: "max(public())",
            limit: 1,
        });

        return maxPublic
            .filter(
                (c) =>
                    (!opts.excludeTags || c.tags.length === 0) &&
                    (!opts.excludeBookmarks || c.bookmarks.length === 0)
            )
            .map((c) => {
                return {
                    name: "public tip",
                    type: RefType.Commit,
                    commit: c.node.substr(0, 12),
                };
            });
    }

    async getBookmarks(): Promise<Bookmark[]> {
        const bookmarksResult = await this.run(["bookmarks"]);
        const bookmarkRefs = bookmarksResult.stdout
            .split("\n")
            .filter((line) => !!line)
            .map((line: string): Bookmark | null => {
                const match = line.match(/^.(.).(.*?)\s+(\d+):([A-Fa-f0-9]+)$/);
                if (match) {
                    return {
                        name: match[2],
                        commit: match[4],
                        type: RefType.Bookmark,
                        active: match[1] === "*",
                    };
                }
                return null;
            })
            .filter((ref) => !!ref) as Bookmark[];

        return bookmarkRefs;
    }

    async getPaths(): Promise<Path[]> {
        const pathsResult = await this.run(["paths"]);
        const trimmedOutput = pathsResult.stdout.trim();
        const paths = trimmedOutput
            .split("\n")
            .filter((line) => !!line)
            .map((line: string): Path | null => {
                const match = line.match(/^(\S+)\s*=\s*(.*)$/);
                if (match) {
                    return { name: match[1], url: match[2] };
                }
                return null;
            })
            .filter((ref) => !!ref) as Path[];

        return paths;
    }
}

function msFromHighResTime(hiResTime: [number, number]): number {
    const [seconds, nanoSeconds] = hiResTime;
    return seconds * 1e3 + nanoSeconds / 1e6;
}
