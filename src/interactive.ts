import { window } from "vscode";
import { ChildProcess } from "child_process";

const USE_CHANGED = "Use changed version";
const LEAVE_DELETED = "Leave deleted";
const LEAVE_UNRESOLVED = "Leave unresolved";

const INT32_SIZE = 4;

export async function handleInteraction(stdout: string, limit: number): Promise<string> {
    /* other [merge rev] changed letters.txt which local [working copy] deleted
use (c)hanged version, leave (d)eleted, or leave (u)nresolved*/
    const [options, prompt, ..._] = stdout.split('\n').reverse();
    const choices: string[] = [];
    if (options.includes("(c)hanged")) {
        choices.push(USE_CHANGED);
    }
    if (options.includes("(d)eleted")) {
        choices.push(LEAVE_DELETED);
    }
    if (options.includes("(u)nresolved")) {
        choices.push(LEAVE_UNRESOLVED);
    }

    const choice = await window.showQuickPick(choices, { ignoreFocusOut: true, placeHolder: prompt });
    switch (choice) {
        case USE_CHANGED: return "c";
        case LEAVE_DELETED: return "d";
        case LEAVE_UNRESOLVED: default: return "u";
    }
}

export async function serverSendCommand(this: void, server: ChildProcess, encoding: string, cmd: string, args: string[] = []) {
    if (!server) {
        throw new Error("Must start the command server before issuing commands");
    }
    const cmdLength = cmd.length + 1;
    const argsJoined = args.join("\0");
    const argsJoinedLength = argsJoined.length;
    const totalBufferSize = cmdLength + INT32_SIZE + argsJoinedLength;
    const buffer = new Buffer(totalBufferSize);
    buffer.write(cmd + "\n", 0, cmdLength, encoding);
    buffer.writeUInt32BE(argsJoinedLength, cmdLength);
    buffer.write(argsJoined, cmdLength + INT32_SIZE, argsJoinedLength, encoding);
    await writeBufferToStdIn(server, buffer);
};

export async function serverSendLineInput(this: void, server: ChildProcess, encoding: string, text: string) {
    if (!server) {
        throw new Error("Must start the command server before issuing commands");
    }
    const textLength = text.length + 1;
    const totalBufferSize = textLength + INT32_SIZE;
    const buffer = new Buffer(totalBufferSize);
    buffer.writeUInt32BE(textLength, 0);
    buffer.write(`${text}\n`, INT32_SIZE, textLength, encoding);
    await writeBufferToStdIn(server, buffer);
    const zeroBuffer = new Buffer(INT32_SIZE);

    // buffer.writeUInt32BE(0, 0);
    // await writeBufferToStdIn(server, zeroBuffer)
};

export function writeBufferToStdIn(server: ChildProcess, buffer: Buffer): Promise<any> {
    return new Promise((c, e) => server.stdin.write(buffer, c));
}