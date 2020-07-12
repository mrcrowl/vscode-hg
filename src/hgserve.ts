import { spawn, ChildProcess } from "child_process";
import { interaction } from "./interaction";
import { EventEmitter } from "vscode";
// import { logger } from "./logger";

export interface Deferred<T> {
    resolve: (c: T) => any;
    reject: (e) => any;
    promise: Promise<T>;
}

export function defer<T>(): Deferred<T> {
    const deferred: Deferred<T> = Object.create(null);
    deferred.promise = new Promise<T>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
    });
    return deferred;
}

const defaults = {
    hgOpts: ["serve", "--cmdserver", "pipe"],
};

export interface IExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface PipelineCommand {
    cmd: string;
    args: string[];
    result: Deferred<IExecutionResult>;
}

export class HgCommandServer {
    private hgPath: string;
    private config;
    private serverProcess: ChildProcess | undefined;
    private starting: boolean;
    private encoding: string;
    private capabilities;
    private commandQueue: PipelineCommand[];
    private stopWhenQueueEmpty: boolean;
    private channelProcessor: ChannelProcessor;

    private constructor(config = {}, private logger: (text: string) => void) {
        // super();
        this.config = { ...defaults, ...config };
        this.commandQueue = [];
        this.starting = false;
    }

    /** Static constructor */
    public static async start(
        hgPath: string,
        repository: string,
        logger: (text: string) => void
    ): Promise<HgCommandServer> {
        const config = {
            hgOpts: [
                "--config",
                "ui.interactive=True",
                "serve",
                "--cmdserver",
                "pipe",
                "--cwd",
                repository,
            ],
        };
        const commandServer = new HgCommandServer(config, logger);
        return await commandServer.start(hgPath);
    }

    /** Start the command server at a specified directory (path must already be an hg repository) */
    private async start(hgPath: string): Promise<HgCommandServer> {
        this.hgPath = hgPath;
        this.serverProcess = await this.spawnCommandServerProcess(hgPath);
        const lineInputHandler = async (body: string, _limit: number) => {
            const response = await interaction.handleChoices(body);
            if (this.serverProcess) {
                serverSendLineInput(
                    this.serverProcess,
                    this.encoding,
                    response
                );
            }
        };

        this.channelProcessor = new ChannelProcessor(
            this.encoding,
            lineInputHandler
        );
        this.attachListeners();
        return this;
    }

    /**	Stop the current command server process from running */
    public stop(force?: boolean): void {
        if (!this.serverProcess) {
            return;
        }

        if (this.commandQueue.length && !force) {
            this.stopWhenQueueEmpty = true;
            return;
        }

        try {
            this.serverProcess.removeAllListeners("exit");
            this.serverProcess.stdout.removeAllListeners("data");
            this.serverProcess.stderr.removeAllListeners("data");
            this.serverProcess.stdin.end();
        } catch (e) {
            this.logger(`Failed to remove cmdserve listeners: ${e}`);
            // logger.error(`Failed to remove cmdserve listeners: ${e}`);
        } finally {
            this.serverProcess = undefined;
        }
    }

    /** Run a command */
    public runcommand(...args: string[]): Promise<IExecutionResult> {
        return this.enqueueCommand("runcommand", ...args);
    }

    /** Enqueue a command  */
    private enqueueCommand(
        cmd: string,
        ...args: string[]
    ): Promise<IExecutionResult> {
        if (this.serverProcess) {
            const command: PipelineCommand = {
                cmd,
                args,
                result: defer<IExecutionResult>(),
            };
            this.commandQueue.push(command);
            serverSendCommand(this.serverProcess, this.encoding, cmd, args);
            return command.result.promise;
        }

        return Promise.reject("HGCommandServer is not started");
    }

    private dequeueCommand(): PipelineCommand | undefined {
        return this.commandQueue.shift();
    }

    /** Spawn the hg cmdserver as a child process */
    private spawnCommandServerProcess(path: string): Promise<ChildProcess> {
        return new Promise<ChildProcess>((c, e) => {
            this.starting = true;
            const cp = this.spawnHgServer(path);

            const stream = new StreamReader();

            cp.stdout.once("data", async (data: Buffer) => {
                stream.write(data);

                const _chan = await stream.readChar();
                const length = await stream.readInt();
                const body = await stream.readString(length, "ascii");
                const {
                    capabilities,
                    encoding,
                } = this.parseCapabilitiesAndEncoding(body);
                this.capabilities = capabilities;
                this.encoding = encoding;

                this.starting = false;

                if (!capabilities.includes("runcommand")) {
                    return e("runcommand not available");
                }

                c(cp);
            });
            cp.stderr.on("data", (data) => {
                if (this.starting) {
                    return e(data);
                }
                return this.handleServerError(data);
            });
            cp.on("exit", (_code) => {
                if (cp) {
                    cp.removeAllListeners("exit");
                }
            });
        });
    }

    private spawnHgServer(path) {
        const processEnv = { HGENCODING: "UTF-8", ...process.env };
        const spawnOpts = {
            env: processEnv,
            cwd: path || process.cwd(),
        };
        return spawn("hg", this.config.hgOpts, spawnOpts);
    }

    /** Parse the capabilities and encoding when the cmd server starts up */
    parseCapabilitiesAndEncoding(
        data: string
    ): { capabilities: string[]; encoding: string } {
        let matches = /capabilities: (.*?)\nencoding: (.*?)$/.exec(data);
        if (!matches) {
            matches = /capabilities: (.*?)\nencoding: (.*?)\n(.*?)$/g.exec(
                data
            );
        }

        if (!matches) {
            throw new Error("Unable to parse capabilities: " + data);
        }

        const [_, caps, encoding] = matches;
        return {
            capabilities: caps.split(" "),
            encoding: encoding,
        };
    }

    handleServerError(data: any): void {
        console.error(data);
        // return this.emit("error", data);
    }

    /*
      Send the raw command strings to the cmdserver over `stdin`
     */

    /** Parse the Channel information, emit an event on the channel with the data. */
    async attachListeners(): Promise<void> {
        const { serverProcess } = this;
        if (!serverProcess) {
            return;
        }

        serverProcess.on("exit", (code) => {
            this.logger(`hg command server was closed unexpectedly: ${code}\n`);
            this.stop(true);
            this.start(this.hgPath);
        });

        serverProcess.stdout.on("data", (data: Buffer) => {
            this.channelProcessor.consume(data);
        });

        this.channelProcessor.event((result) => {
            const command = this.dequeueCommand();
            if (command) {
                command.result.resolve(result);
            }

            if (this.stopWhenQueueEmpty && this.commandQueue.length === 0) {
                this.stop();
            }
        });
    }
}

class ChannelProcessor extends EventEmitter<IExecutionResult> {
    private errorBuffers: (string | Buffer)[];
    private outputBodies: string[];
    private errorBodies: string[];
    private exitCode: number | undefined;
    private input: StreamReader;

    constructor(
        private encoding: string,
        private lineInputHandler: (body: string, limit: number) => Promise<void>
    ) {
        super();
        this.input = new StreamReader();
        this.reset();
        this.process();
    }

    public consume(data: Buffer) {
        this.input.write(data);
    }

    private reset() {
        this.errorBodies = [];
        this.errorBuffers = [];
        this.outputBodies = [];
        this.exitCode = undefined;
    }

    private async process() {
        while (true) {
            const chan = await this.input.readChar();
            const length = await this.input.readInt();

            switch (chan) {
                case RESULT_CHANNEL: {
                    this.exitCode = await this.input.readInt();
                    // logger.info(`hgserve:r:${this.exitCode}`);
                    break;
                }

                case LINE_CHANNEL: {
                    const body = this.outputBodies.join("");
                    // logger.info(`hgserve:L:${body}`);
                    await this.lineInputHandler(body, length);
                    break;
                }

                case OUTPUT_CHANNEL: {
                    const outputBody = await this.input.readString(
                        length,
                        this.encoding
                    );
                    this.outputBodies.push(outputBody);
                    break;
                }

                case ERROR_CHANNEL: {
                    const errorBody = await this.input.readString(
                        length,
                        this.encoding
                    );
                    this.errorBodies.push(errorBody);
                    break;
                }
            }

            if (this.exitCode !== undefined) {
                const stdout = this.outputBodies.join("");
                const stderr = this.errorBodies.join("");
                const result = <IExecutionResult>{
                    stdout,
                    stderr,
                    exitCode: this.exitCode,
                };

                this.reset();
                this.fire(result);
            }
        }
    }
}

class StreamReader {
    private buffers: {
        data: Buffer;
        size: number;
    }[];
    private offset: number;
    private currentRead?: {
        remainingBytes: number;
        result: Deferred<Buffer>;
        chunks: Buffer[];
    };

    constructor() {
        this.buffers = [];
        this.offset = 0;
    }

    public write(data: Buffer) {
        this.buffers.push({
            data: data,
            size: data.byteLength,
        });
        if (this.currentRead) {
            this.continueRead();
        }
    }

    public async readChar(): Promise<string> {
        const buffer = await this.readBuffer(UINT8_SIZE);
        return String.fromCharCode(buffer.readUInt8(0));
    }

    public async readInt(): Promise<number> {
        const buffer = await this.readBuffer(UINT32_SIZE);
        return buffer.readUInt32BE(0);
    }

    public async readString(length: number, encoding: string): Promise<string> {
        const buffer = await this.readBuffer(length);
        return buffer.toString(encoding);
    }

    private async readBuffer(length: number): Promise<Buffer> {
        this.currentRead = {
            remainingBytes: length,
            chunks: [],
            result: defer<Buffer>(),
        };
        return this.continueRead();
    }

    private continueRead(): Promise<Buffer> {
        const currentRead = this.currentRead!;
        while (currentRead.remainingBytes > 0 && this.buffers.length > 0) {
            const { data, size } = this.buffers[0];
            const availableBytes = size - this.offset;
            const chunkSize = Math.min(
                availableBytes,
                currentRead.remainingBytes
            );
            const chunk = data.slice(this.offset, this.offset + chunkSize);
            if (availableBytes - chunkSize === 0) {
                this.buffers.shift();
                this.offset = 0;
            } else {
                this.offset += chunkSize;
            }
            currentRead.chunks.push(chunk);
            currentRead.remainingBytes -= chunkSize;
            if (currentRead.remainingBytes === 0) {
                const readBuffer = Buffer.concat(currentRead.chunks);
                currentRead.result.resolve(readBuffer);
                this.currentRead = undefined;
                break;
            }
        }
        return currentRead.result.promise;
    }
}

const UINT32_SIZE = 4;
const UINT8_SIZE = 1;

async function serverSendCommand(
    server: ChildProcess,
    encoding: string,
    cmd: string,
    args: string[] = []
) {
    if (!server) {
        throw new Error(
            "Must start the command server before issuing commands"
        );
    }
    const cmdLength = cmd.length + 1;
    const argsJoined = args.join("\0");
    const argsJoinedLength = argsJoined.length;
    const totalBufferSize = cmdLength + UINT32_SIZE + argsJoinedLength;
    const buffer = new Buffer(totalBufferSize);
    buffer.write(cmd + "\n", 0, cmdLength, encoding);
    buffer.writeUInt32BE(argsJoinedLength, cmdLength);
    buffer.write(
        argsJoined,
        cmdLength + UINT32_SIZE,
        argsJoinedLength,
        encoding
    );
    // logger.info(`hgserve:stdin:\\0${cmd}\\n${argsJoinedLength}${argsJoined}`);
    await writeBufferToStdIn(server, buffer);
}

async function serverSendLineInput(
    server: ChildProcess,
    encoding: string,
    text: string
) {
    if (!server) {
        throw new Error(
            "Must start the command server before issuing commands"
        );
    }
    const textLength = text.length + 1;
    const totalBufferSize = textLength + UINT32_SIZE;
    const buffer = new Buffer(totalBufferSize);
    buffer.writeUInt32BE(textLength, 0);
    buffer.write(`${text}\n`, UINT32_SIZE, textLength, "ascii");
    // logger.info(`hgserve:stdin:${text}\n`);
    await writeBufferToStdIn(server, buffer);
}

function writeBufferToStdIn(
    server: ChildProcess,
    buffer: Buffer
): Promise<any> {
    return new Promise((c, _e) => server.stdin.write(buffer, c));
}

const LINE_CHANNEL = "L";
const RESULT_CHANNEL = "r";
const OUTPUT_CHANNEL = "o";
const ERROR_CHANNEL = "e";
