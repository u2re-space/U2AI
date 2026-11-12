/**
 * @file src/openai/image-response-fallback.js
 * @module openai/image-response-fallback
 * @purpose Salvage pictures from an image answer the built-in parsers cannot read: the model writes a
 *   small extraction script for the shape it sees, the script runs in a sandbox with fetch and file
 *   writing, and both the raw answer and the script stay on disk for debugging.
 * @depends node:vm, node:path, node:fs/promises, openai/errors, openai/stream, openai/image-diagnostics, shared/images
 * @usedBy openai/client, openai/seedream-5-5
 * @exports describeShape, makeParserInvoke, parseImageResponseWithAI
 * @ai.tags images, fallback, sandbox, diagnostics
 * @ai.hint io
 * @changed 2026-11-12 First version: every gateway shape the `b64_json`/`url` readers miss now gets a
 *   second, model-written parser instead of a dead-end "ни b64_json, ни url" error.
 *
 * The built-in readers know two shapes: `data[].b64_json` and `data[].url` (plus the seedream task
 * layout). A gateway that nests the picture anywhere else — `data.result.images[].url[]` was the
 * first, others keep appearing — used to end the call with an error even though the bytes were in
 * hand. Rather than grow another hardcoded branch per vendor, the raw answer is described to the
 * model (long base64 strings elided, paths shown), and the model answers with the one thing that
 * generalizes: a function that walks this particular object and returns the payloads.
 *
 * The script runs in `node:vm`. That is a guardrail, not a security boundary — the same program runs
 * model-written shell scripts behind an approval prompt — so it is deliberately narrow: no require,
 * no process, no filesystem, and the only ways out are `fetch` (http/https, capped, abortable) and
 * `write`, which is confined to the workspace. Both are exactly what a picture needs: pull a link the
 * response only mentions, decode inline base64, and drop the result where the caller can find it.
 */

import path from 'node:path';
import vm from 'node:vm';
import { mkdir, writeFile } from 'node:fs/promises';
import { ApiError } from './errors.js';
import { outputText } from './stream.js';
import { saveImageResponse, saveImageParserScript } from './image-diagnostics.js';
import { sniffImage } from '../shared/images.js';

/** Strings longer than this are elided in the shape sketch: a base64 picture is not worth its tokens. */
const SHAPE_STRING_MAX = 120;
/** Array entries the sketch shows before it switches to a count. */
const SHAPE_ARRAY_MAX = 3;
/** Nesting depth the sketch walks before it collapses the rest to a type name. */
const SHAPE_MAX_DEPTH = 7;
/** The sketch itself is capped; a megabyte of keys means the answer is not salvageable by reading. */
const SHAPE_MAX_BYTES = 24 * 1024;

/** Wall-clock cap for one salvage script, including its awaits. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** Bytes one `fetch` inside the script may return. */
const FETCH_MAX_BYTES = 64 * 1024 * 1024;
/** Payloads accepted from one script; a larger list is a runaway loop, not a batch. */
const MAX_PAYLOADS = 32;
/** How much of the script's own log is kept for the record. */
const LOG_MAX_LINES = 40;

/**
 * The one way the salvage route asks a model for text: a single non-streaming Responses call whose
 * answer is read as plain text. `client` only needs `responses.create`, so a client object, a
 * fallback router, or a lazy wrapper over either works.
 * @param {{ responses: { create: Function } }} client
 * @returns {({ model: string, prompt: string, signal?: AbortSignal }) => Promise<string>}
 * @exports
 * @ai.hint io
 */
export function makeParserInvoke(client) {
    return async ({ model, prompt, signal }) => {
        const answer = await client.responses.create({
            model, store: false,
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        }, { signal });
        return outputText(answer);
    };
}

/**
 * Compact sketch of a parsed JSON answer: keys, types, counts, and short sample values.
 * Long strings — the base64 payloads themselves — become `<string N chars: head…>`, which is what
 * tells the model both where the picture lives and that it must extract rather than echo it.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function describeShape(value, depth = 0) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const type = typeof value;
    if (type === 'string') {
        const text = value;
        if (text.length <= SHAPE_STRING_MAX) return JSON.stringify(text);
        return `<string ${text.length} chars: ${JSON.stringify(text.slice(0, 48))}…>`;
    }
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'bigint') return `${value}n`;
    if (type === 'function' || type === 'symbol') return `<${type}>`;
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const shown = value.slice(0, SHAPE_ARRAY_MAX).map((item) => depth >= SHAPE_MAX_DEPTH ? '<…>' : describeShape(item, depth + 1));
        const rest = value.length > SHAPE_ARRAY_MAX ? `, … ${value.length} items total` : '';
        return `[${shown.join(', ')}${rest}]`;
    }
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    if (depth >= SHAPE_MAX_DEPTH) return `<object ${entries.length} keys>`;
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${describeShape(item, depth + 1)}`).join(', ')}}`;
}

/**
 * The request to the model: here is the answer, here are the helpers, return the payloads.
 * @param {string} shape Sketch of the response.
 * @param {{ route?: string|null, model?: string|null, taskId?: string|null }} [meta]
 * @returns {string}
 * @ai.hint pure
 */
function parserPrompt(shape, meta = {}) {
    return `A picture API answered with a JSON body whose shape is not the usual OpenAI one, so the built-in reader found no image in it.
Write the body of one async JavaScript function that extracts the picture payloads from this exact response.

Response metadata: route ${meta.route ?? 'unknown'}; model ${meta.model ?? 'unknown'}; task id ${meta.taskId ?? 'none'}.

The response object, with long strings elided (a path shown as <string N chars> is available in full at runtime):
${shape}

Inside the function these names are defined:
- response — the full parsed JSON answer, exactly as shown above but with the elided strings intact.
- fetchBytes(url) → Promise<Uint8Array|null> — downloads an http(s) URL; null when it fails.
- decodeBase64(text) → Uint8Array — decodes base64, tolerating a data: prefix and URL-safe alphabet.
- encodeBase64(bytes) → string.
- imageDataUrl(bytesOrString, mime?) → string.
- sniff(bytes) → 'png' | 'jpg' | 'webp' | 'gif' | 'svg' | null — format from magic bytes.
- write(relPath, data) → Promise<string> — writes a string or bytes under the project root (path escapes are refused); use it for the extracted picture or any sidecar you must produce.
- log(...args) — records a diagnostic line.
- fetch, URL, URLSearchParams, Buffer, TextEncoder, TextDecoder, JSON, Math, Date, atob, btoa.
There is no require, import, process, __dirname, setTimeout, or filesystem access.

Return an array whose items are any of: base64 string, data: URL, http(s) URL, Uint8Array, ArrayBuffer.
Return [] when the response truly carries no picture (an error answer is not a picture).
Extract the real values by path; never retype or truncate a base64 string.
Answer with the function body only, in one \`\`\`js fence, no wrapper function signature, no commentary.`;
}

/**
 * First `js`/untagged fenced block, or the whole text when the model skipped the fence.
 * @param {string} text
 * @returns {string}
 * @ai.hint pure
 */
function extractScript(text) {
    const source = String(text ?? '');
    const fenced = source.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
    return (fenced ? fenced[1] : source).trim();
}

/**
 * One picture payload out of whatever the script returned.
 * @param {unknown} item
 * @returns {{ kind: 'b64'|'url', value: string }|null}
 * @ai.hint pure
 */
function toSource(item) {
    const push = (value) => (value ? { kind: 'b64', value } : null);
    if (item == null) return null;
    if (typeof item === 'string') {
        const text = item.trim();
        if (!text) return null;
        if (/^data:/i.test(text)) {
            const comma = text.indexOf(',');
            if (comma < 0 || !/;base64/i.test(text.slice(0, comma))) return null;
            return push(text.slice(comma + 1).trim());
        }
        if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text };
        const compact = text.replace(/\s+/g, '');
        return /^[A-Za-z0-9+/=]{16,}$/.test(compact) ? push(compact) : null;
    }
    if (item instanceof Uint8Array) return push(Buffer.from(item).toString('base64'));
    if (item instanceof ArrayBuffer) return push(Buffer.from(new Uint8Array(item)).toString('base64'));
    if (Array.isArray(item)) {
        for (const nested of item.map(toSource).filter(Boolean)) return nested;
        return null;
    }
    if (typeof item === 'object') {
        for (const key of ['b64_json', 'b64', 'base64', 'data', 'url', 'image', 'value', 'src']) {
            const found = toSource(item[key]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Run one salvage script over the response.
 * @param {string} script Function body the model wrote.
 * @param {{ response: unknown, root: string, signal?: AbortSignal }} options
 * @returns {Promise<{ sources: Array<{kind:'b64'|'url', value:string}>, writes: string[], logs: string[] }>}
 * @ai.hint io
 */
async function runParserScript(script, { response, root, signal }) {
    const logs = [];
    const writes = [];
    const fetchBytes = async (url) => {
        let target;
        try { target = new URL(String(url)); } catch { return null; }
        if (!['http:', 'https:'].includes(target.protocol)) return null;
        const res = await fetch(target.href, { signal, redirect: 'follow' });
        if (!res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        return bytes.length > FETCH_MAX_BYTES ? null : bytes;
    };
    const decodeBase64 = (text) => {
        let body = String(text ?? '').trim();
        const comma = body.indexOf(',');
        if (body.startsWith('data:') && comma > 0) body = body.slice(comma + 1);
        body = body.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!body) return new Uint8Array();
        return new Uint8Array(Buffer.from(body, 'base64'));
    };
    const write = async (rel, data) => {
        const requested = String(rel ?? '').trim();
        if (!requested) throw new Error('write: path is required');
        if (path.isAbsolute(requested)) throw new Error(`write: absolute path refused: ${requested}`);
        const abs = path.resolve(root, requested);
        if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`write: path escapes the project: ${requested}`);
    const bytes = typeof data === 'string'
        ? (base64ImageBytes(data) ?? Buffer.from(data, 'utf8'))
        : data instanceof Uint8Array ? Buffer.from(data)
            : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data))
                : Buffer.from(String(data), 'utf8');
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
        const posix = requested.split(path.sep).join('/');
        writes.push(posix);
        return posix;
    };
    const sandbox = {
        response,
        fetch: (url, init) => fetch(url, { ...init, signal }),
        fetchBytes,
        decodeBase64,
        encodeBase64: (bytes) => Buffer.from(bytes ?? []).toString('base64'),
        imageDataUrl: (bytes, mime = 'image/png') => `data:${mime};base64,${Buffer.from(bytes ?? []).toString('base64')}`,
        sniff: (bytes) => {
            const buffer = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(bytes ?? []);
            const kind = sniffImage(buffer);
            return buffer.length ? kind.ext : null;
        },
        write,
        log: (...args) => { if (logs.length < LOG_MAX_LINES) logs.push(args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')); },
        URL, URLSearchParams, Buffer, TextEncoder, TextDecoder, JSON, Math, Date,
        atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
        btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    };
    const context = vm.createContext(sandbox);
    const run = vm.runInContext(`(async () => {\n${script}\n})()`, context, { timeout: SCRIPT_TIMEOUT_MS, displayErrors: true });
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ApiError('Скрипт разбора ответа не завершился вовремя.', { code: 'INVALID_RESPONSE' })), SCRIPT_TIMEOUT_MS);
    });
    let returned;
    try {
        returned = await Promise.race([Promise.resolve(run), deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    const list = Array.isArray(returned) ? returned : [returned];
    const sources = [];
    for (const item of list.slice(0, MAX_PAYLOADS)) {
        const source = toSource(item);
        if (source) sources.push(source);
    }
    return { sources, writes, logs };
}

/**
 * Bytes of a base64 string, but only when those bytes start with a picture signature.
 * `write` gets strings from the script, and a script is equally likely to hand over an SVG document
 * as a base64 PNG; the magic bytes are the only honest way to tell the two apart.
 * @param {string} text
 * @returns {Buffer|null}
 * @ai.hint pure
 */
function base64ImageBytes(text) {
    const compact = String(text ?? '').trim().replace(/\s+/g, '');
    if (compact.length < 64 || !/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
    const bytes = Buffer.from(compact, 'base64');
    if (!bytes.length) return null;
    const ext = sniffImage(bytes).ext;
    return (ext === 'png' && bytes.subarray(0, 4).toString('hex') === '89504e47')
        || (ext === 'jpg' && bytes[0] === 0xff && bytes[1] === 0xd8)
        || (ext === 'webp') || (ext === 'gif') || (ext === 'svg')
        ? bytes : null;
}

/** JSON for a log line, never throwing on a cyclic value the script handed over. */
function safeJson(value) {
    try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Second-chance parse of an image answer through a model-written extraction script.
 * @param {{ result: unknown, route?: string, model?: string|null, host?: string|null, taskId?: string|null,
 *   invoke?: (({ model: string, prompt: string, signal?: AbortSignal }) => Promise<string>)|null,
 *   parserModel?: string|null, root?: string|null, signal?: AbortSignal,
 *   onWarn?: ((message: string) => void)|null, onArchive?: ((file: string|null) => void)|null,
 *   archive?: boolean }} options
 *   `invoke` asks a model for text; without it (or without `parserModel`) only the raw answer is
 *   archived and null comes back, so a client that never opted in keeps its old behaviour.
 *   `archive: false` skips the save for a caller that already wrote the answer itself.
 * @returns {Promise<Array<{kind:'b64'|'url', value:string}>|null>} sources, or null when nothing was salvaged
 * @exports
 * @ai.hint io
 */
export async function parseImageResponseWithAI({ result, route = 'images', model = null, host = null, taskId = null,
    invoke = null, parserModel = null, root = null, signal, onWarn = null, onArchive = null, archive = true }) {
    const savedFile = archive ? await saveImageResponse(result, { route, model, host, taskId }) : null;
    try { onArchive?.(savedFile); } catch { /* observer */ }
    if (!invoke || !parserModel) return null;
    const warn = (message) => { try { onWarn?.(message); } catch { /* observer */ } };
    const workspace = path.resolve(root ?? process.cwd());
    try {
        signal?.throwIfAborted();
        const shape = describeShape(result).slice(0, SHAPE_MAX_BYTES);
        const answer = await invoke({ model: parserModel, prompt: parserPrompt(shape, { route, model, taskId }), signal });
        const script = extractScript(answer);
        if (!script || script.length < 16) {
            warn(`Резервный разбор: модель ${parserModel} не вернула скрипт разбора.`);
            return null;
        }
        const { sources, writes, logs } = await runParserScript(script, { response: result, root: workspace, signal });
        if (!sources.length) {
            warn(`Резервный разбор: скрипт от ${parserModel} не нашёл изображений${logs.length ? `; лог: ${logs.join(' | ').slice(0, 400)}` : ''}.`);
        }
        // The script itself is part of the evidence: the raw answer alone does not explain how the
        // pictures were pulled out of it, and a future change to this gateway shape starts here.
        await saveImageParserScript(script, {
            route,
            notes: `payloads: ${sources.length}; files written: ${writes.join(', ') || 'none'}${logs.length ? `; log: ${logs.join(' | ').slice(0, 400)}` : ''}`,
        });
        return sources.length ? sources : null;
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        warn(`Резервный разбор ответа не удался (${error?.message ?? error}).`);
        return null;
    }
}
