import { window } from "vscode";
import { ChildProcess } from "child_process";

const USE_CHANGED = "Use changed version";
const LEAVE_DELETED = "Leave deleted";
const LEAVE_UNRESOLVED = "Leave unresolved";

const INT32_SIZE = 4;

export async function handleInteraction(stdout: string): Promise<string | undefined> {
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
        case LEAVE_UNRESOLVED: return "u";
        default: return undefined;
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
    const toWrite = new Buffer(totalBufferSize);
    toWrite.write(cmd + "\n", 0, cmdLength, encoding);
    toWrite.writeUInt32BE(argsJoinedLength, cmdLength);
    toWrite.write(argsJoined, cmdLength + INT32_SIZE, argsJoinedLength, encoding);
    // console.log(toWrite.toString("utf-8").replace(/\0/g, '\\0'));
    return new Promise((c, _) => {
        server.stdin.write(toWrite, c);
    });
};

export async function serverSendLineInput(this: void, server: ChildProcess, encoding: string, text: string) {
    if (!server) {
        throw new Error("Must start the command server before issuing commands");
    }
    const textLength = text.length + 1;
    const totalBufferSize = textLength + INT32_SIZE;
    const toWrite = new Buffer(totalBufferSize);
    toWrite.writeUInt32BE(textLength, 0);
    toWrite.write(`${text}\n`, INT32_SIZE, textLength, encoding);
    return new Promise((c, _) => { server.stdin.write(toWrite, c); });
};