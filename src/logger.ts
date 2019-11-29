// import * as DailyRotateFile from 'winston-daily-rotate-file';
// import { NullTransport } from 'winston-null';
// import * as winston from 'winston';
// import * as fs from 'fs';
// import { workspace } from "vscode";

// const logFolder: string | undefined = workspace.getConfiguration("hg").get<string>("serverLogFolder");
// const timestampFormat = () => (new Date()).toLocaleTimeString();

// let transports: winston.TransportInstance[] = [];
// if (logFolder) {
//     // ensure log folder exists
//     if (!fs.existsSync(logFolder)) {
//         fs.mkdirSync(logFolder);
//     }
//     transports = [
//         new DailyRotateFile({
//             filename: `${logFolder}/-results.log`,
//             timestamp: timestampFormat,
//             datePattern: 'yyyy-MM-dd',
//             prepend: true,
//             level: 'debug'
//         })
//     ]
// }
// else {
//     transports = [
//         new NullTransport()
//     ]
// }

// export const logger = new winston.Logger({ transports });
/* */
