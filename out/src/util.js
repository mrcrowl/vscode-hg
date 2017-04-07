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
const path_1 = require("path");
const fs = require("fs");
function log(...args) {
    console.log.apply(console, ['hg:', ...args]);
}
exports.log = log;
function dispose(disposables) {
    disposables.forEach(d => d.dispose());
    return [];
}
exports.dispose = dispose;
function toDisposable(dispose) {
    return { dispose };
}
exports.toDisposable = toDisposable;
function combinedDisposable(disposables) {
    return toDisposable(() => dispose(disposables));
}
exports.combinedDisposable = combinedDisposable;
exports.EmptyDisposable = toDisposable(() => null);
function mapEvent(event, map) {
    return (listener, thisArgs = null, disposables) => event(i => listener.call(thisArgs, map(i)), null, disposables);
}
exports.mapEvent = mapEvent;
function filterEvent(event, filter) {
    return (listener, thisArgs = null, disposables) => event(e => filter(e) && listener.call(thisArgs, e), null, disposables);
}
exports.filterEvent = filterEvent;
function anyEvent(...events) {
    return (listener, thisArgs = null, disposables) => {
        const result = combinedDisposable(events.map(event => event(i => listener.call(thisArgs, i))));
        if (disposables) {
            disposables.push(result);
        }
        return result;
    };
}
exports.anyEvent = anyEvent;
function done(promise) {
    return promise.then(() => void 0, () => void 0);
}
exports.done = done;
function once(event) {
    return (listener, thisArgs = null, disposables) => {
        const result = event(e => {
            result.dispose();
            return listener.call(thisArgs, e);
        }, null, disposables);
        return result;
    };
}
exports.once = once;
function eventToPromise(event) {
    return new Promise(c => once(event)(c));
}
exports.eventToPromise = eventToPromise;
// TODO@Joao: replace with Object.assign
function assign(destination, ...sources) {
    for (const source of sources) {
        Object.keys(source).forEach(key => destination[key] = source[key]);
    }
    return destination;
}
exports.assign = assign;
function uniqBy(arr, fn) {
    const seen = Object.create(null);
    return arr.filter(el => {
        const key = fn(el);
        if (seen[key]) {
            return false;
        }
        seen[key] = true;
        return true;
    });
}
exports.uniqBy = uniqBy;
function groupBy(arr, fn) {
    return arr.reduce((result, el) => {
        const key = fn(el);
        result[key] = [...(result[key] || []), el];
        return result;
    }, Object.create(null));
}
exports.groupBy = groupBy;
function denodeify(fn) {
    return (...args) => new Promise((c, e) => fn(...args, (err, r) => err ? e(err) : c(r)));
}
exports.denodeify = denodeify;
function nfcall(fn, ...args) {
    return new Promise((c, e) => fn(...args, (err, r) => err ? e(err) : c(r)));
}
exports.nfcall = nfcall;
function mkdirp(path, mode) {
    return __awaiter(this, void 0, void 0, function* () {
        const mkdir = () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield nfcall(fs.mkdir, path, mode);
            }
            catch (err) {
                if (err.code === 'EEXIST') {
                    const stat = yield nfcall(fs.stat, path);
                    if (stat.isDirectory) {
                        return;
                    }
                    throw new Error(`'${path}' exists and is not a directory.`);
                }
                throw err;
            }
        });
        // is root?
        if (path === path_1.dirname(path)) {
            return true;
        }
        try {
            yield mkdir();
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
            yield mkdirp(path_1.dirname(path), mode);
            yield mkdir();
        }
        return true;
    });
}
exports.mkdirp = mkdirp;
function uniqueFilter(keyFn) {
    const seen = Object.create(null);
    return element => {
        const key = keyFn(element);
        if (seen[key]) {
            return false;
        }
        seen[key] = true;
        return true;
    };
}
exports.uniqueFilter = uniqueFilter;
//# sourceMappingURL=util.js.map