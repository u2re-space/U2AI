/**
 * @file src/openai/seedream-5-5.js
 * @module openai/seedream-5-5
 * @purpose API layer for the seedream-5.5 image model: layer decomposition, transparent generation,
 *   async task polling, and the normalized layer geometry the advanced measurer builds on.
 * @depends node:timers/promises, openai/errors, shared/model-profiles, shared/images
 * @usedBy agent/advanced
 * @exports SEEDREAM_MODEL, isSeedream55, seedreamLayerSizes, layerDecompositionBody,
 *   parseLayerDecomposition, normalizeLayerBox, decomposeLayers, generateTransparentLayer,
 *   SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS
 * @ai.tags images, seedream, decomposition, layers
 * @ai.hint io
 * @changed 2026-11-10 First extraction of the seedream-5.5 route: decomposition is asynchronous
 *   (POST /images/generations answers a task_id, GET /tasks/{id} carries the results), so the model
 *   needs its own file instead of another flag inside the generic images client.
 *
 * Documented API: https://docs.apimart.ai/ru/api-reference/images/seedream-5-5/generation
 *
 * The decomposition mode differs from every other image route this program uses:
 *   - exactly one input image, and the `background` field must be absent entirely (not even `auto`);
 *   - `size` accepts only the tiers `1K` / `1.5K` / `2K` / `auto` — ratios and pixel frames are a
 *     synchronous HTTP 400, so this module must never reuse the generic frame ladder;
 *   - `n` must be 1; the number of outputs is `layer_decomposition_options.max_images`, counting
 *     the base image;
 *   - the reply is a task, not a picture: the caller polls until `completed` or `failed`.
 * Layers come back as transparent PNGs with a bounding box in base-image coordinates; the box is
 * what makes them measurement data rather than mere artwork, because it is a number the model
 * itself read off the picture.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './errors.js';
import { modelMissing, providerDown } from './fallback.js';
import { SEEDREAM_5_5 } from '../shared/model-profiles.js';

/** Default model id of the seedream-5.5 route on the proxy gateway. */
//export const SEEDREAM_MODEL = 'bytedance-seed/seedream-5-5';
export const SEEDREAM_MODEL = 'seedream-5-5';

/** Frames the decomposition mode accepts. Anything else is a synchronous 400. */
export const SEEDREAM_LAYER_SIZES = Object.freeze(['1K', '1.5K', '2K', 'auto']);

/** Generation frames (free WIDTHxHEIGHT on the 16-pixel grid); kept here for the enhanced-crop pass. */
export const SEEDREAM_INPUT_MAX_BYTES = 30 * 1024 * 1024;
export const SEEDREAM_INPUT_MAX_PIXELS = 36_000_000;

/** Task poll cadence the vendor recommends: 3 s for the first half-minute, 5 s afterwards. */
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 5_000;
const POLL_FAST_WINDOW_MS = 30_000;
/** The server itself waits at most 13 minutes; the client gives up shortly after that. */
const DEFAULT_TASK_TIMEOUT_MS = 14 * 60_000;

/**
 * Does this model id belong to the seedream-5.5 family?
 * @param {string|null|undefined} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isSeedream55(model) {
    return SEEDREAM_5_5.test(String(model ?? '').trim());
}

/**
 * A tier the decomposition mode accepts, or `auto` for anything else.
 * A pixel frame or a ratio would be rejected by the gateway, and guessing a tier out of it would
 * silently change the resolution of every layer — `auto` keeps the source's own geometry.
 * @param {string|null|undefined} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function seedreamLayerSize(value) {
    const token = String(value ?? '').trim().toUpperCase();
    return SEEDREAM_LAYER_SIZES.includes(token) ? token : 'auto';
}

/**
 * A data URI for one picture, in the lowercase format name the gateway parses.
 * @param {Buffer} bytes
 * @param {string} mime
 * @returns {string}
 * @ai.hint pure
 */
function toDataUri(bytes, mime = 'image/png') {
    const format = String(mime).split('/').pop().toLowerCase().replace('jpeg', 'jpg');
    return `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * Body for POST /images/generations in layer-decomposition mode.
 * `background` is never present here — the vendor rejects even `auto` alongside
 * `layer_decomposition: true` — and `n` stays out because the mode answers exactly one task.
 * @param {{ model?: string, source: { bytes: Buffer, mime?: string }, prompt?: string|null, size?: string|null,
 *   maxImages?: number|null, textRecognition?: boolean }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function layerDecompositionBody({ model = SEEDREAM_MODEL, source, prompt = null, size = 'auto', maxImages = null, textRecognition = true }) {
    if (!source?.bytes?.length) throw new ApiError('Разложение на слои требует ровно одно входное изображение.', { code: 'INVALID_REQUEST' });
    const body = {
        model,
        image_urls: [toDataUri(source.bytes, source.mime ?? 'image/png')],
        layer_decomposition: true,
        size: seedreamLayerSize(size),
    };
    const text = String(prompt ?? '').trim();
    if (text) body.prompt = text;
    // max_images covers base + layers, so a request for 16 layers asks for at least 17 outputs;
    // the gateway clamps to [2, 100] and rejects a non-integer outright.
    if (Number.isSafeInteger(maxImages) && maxImages >= 2 && maxImages <= 100) body.layer_decomposition_options = { max_images: maxImages };
    if (textRecognition === true) {
        body.layer_decomposition_options = { ...(body.layer_decomposition_options ?? {}), text_recognition: true };
    }
    return body;
}

/**
 * `data` of a task answer, or null while the task is still running.
 * @param {object} result
 * @returns {{ status: string, error: string|null, images: object[] }|null}
 * @ai.hint pure
 */
function taskData(result) {
    const data = result?.data ?? result ?? null;
    if (!data || typeof data !== 'object') return null;
    const status = String(data.status ?? '').trim().toLowerCase();
    if (!['pending', 'processing', 'completed', 'failed', 'canceled', 'cancelled'].includes(status)) return null;
    const error = typeof data.error === 'string' ? data.error : (data.error?.message ?? null);
    return { status, error, images: Array.isArray(data.result?.images) ? data.result.images : [] };
}

/**
 * Read one layer's box in base-image pixels, from either box shape the vendor sends.
 * `absolute` is `[left, top, right, bottom]` in base pixels; `normalized` is the same frame on a
 * 0–1000 scale, which becomes pixels through the base size. A file's own pixel size is NOT the
 * base frame (every layer is rescaled to its tier independently), so it never enters here.
 * @param {object|null|undefined} box
 * @param {{ width: number, height: number }|null} baseFrame
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 * @exports
 * @ai.hint pure
 */
export function normalizeLayerBox(box, baseFrame) {
    if (!box || typeof box !== 'object') return null;
    const absolute = Array.isArray(box.absolute) ? box.absolute.map(Number) : null;
    const normalized = Array.isArray(box.normalized) ? box.normalized.map(Number) : null;
    let left = null;
    let top = null;
    let right = null;
    let bottom = null;
    if (absolute && absolute.every((n) => Number.isFinite(n))) {
        [left, top, right, bottom] = absolute;
    } else if (normalized && normalized.every((n) => Number.isFinite(n)) && baseFrame?.width && baseFrame?.height) {
        left = normalized[0] / 1000 * baseFrame.width;
        top = normalized[1] / 1000 * baseFrame.height;
        right = normalized[2] / 1000 * baseFrame.width;
        bottom = normalized[3] / 1000 * baseFrame.height;
    } else {
        return null;
    }
    const width = right - left;
    const height = bottom - top;
    if (!(width > 0) || !(height > 0)) return null;
    return { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

/**
 * The frames (`WxH`) the gateway reported for one result row, parsed into {width,height}.
 * @param {unknown} value
 * @returns {Array<{width:number|null,height:number|null}>}
 * @ai.hint pure
 */
function parseSizes(value) {
    if (!Array.isArray(value)) return [];
    return value.map((token) => {
        const match = /^(\d+)\s*[xх*]\s*(\d+)$/i.exec(String(token ?? '').trim());
        return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
    });
}

/**
 * Flatten one completed decomposition answer into layer records.
 * `url[]`, `sizes[]` and `layers[]` are index-aligned per the API contract; index 0 of `url` is the
 * base image and index 0 of `layers` carries its z_index (0). Metadata arrays may be absent when
 * their length does not match, so every row is read defensively and a missing box stays null
 * rather than becoming a fabricated measurement.
 * @param {object} result the task answer
 * @returns {{ base: {url:string,size:{width:number|null,height:number|null}}|null,
 *   layers: Array<{ index: number, z: number, name: string, description: string, url: string,
 *     size: {width:number|null,height:number|null}, background: string, box: object|null,
 *     text: {text:string,lines:object[]}|null }>, ocr: object[] }}
 * @exports
 * @ai.hint pure
 */
export function parseLayerDecomposition(result) {
    const rows = taskData(result)?.images ?? [];
    const out = { base: null, layers: [], ocr: [] };
    for (const row of rows) {
        const urls = Array.isArray(row?.url) ? row.url.filter((u) => typeof u === 'string' && u.trim()) : [];
        if (!urls.length) continue;
        const sizes = parseSizes(row.sizes);
        const meta = Array.isArray(row.layers) && row.layers.length === urls.length ? row.layers : null;
        const baseFrame = sizes[0]?.width ? { width: sizes[0].width, height: sizes[0].height } : null;
        out.base ??= { url: urls[0], size: baseFrame ?? { width: null, height: null } };
        for (let index = 1; index < urls.length; index++) {
            const layer = meta?.[index] ?? null;
            const textRecognition = layer?.text_recognition && typeof layer.text_recognition === 'object'
                ? { text: String(layer.text_recognition.text ?? ''), lines: Array.isArray(layer.text_recognition.lines) ? layer.text_recognition.lines : [] }
                : null;
            out.layers.push({
                index,
                z: Number.isFinite(layer?.z_index) ? layer.z_index : index,
                name: String(layer?.name ?? '').trim(),
                description: String(layer?.description ?? '').trim(),
                url: urls[index],
                size: sizes[index] ?? { width: null, height: null },
                background: String(layer?.background ?? (Array.isArray(row.backgrounds) ? row.backgrounds[index] : '') ?? '').trim(),
                box: normalizeLayerBox(layer?.bounding_box, out.base.size),
                text: textRecognition,
            });
            if (textRecognition) out.ocr.push({ layer: index, ...textRecognition });
        }
    }
    return out;
}

/**
 * Poll one task until it reaches a final state.
 * `run.call` owns transport, retries, and auth, so this loop only owns the schedule: 3 s inside the
 * first half-minute, then 5 s, and giving up after `timeoutMs` (the server itself stops at 13 min).
 * @param {{ call: Function }} client
 * @param {string} taskId
 * @param {{ signal?: AbortSignal, timeoutMs?: number, onPoll?: Function }} options
 * @returns {Promise<object>} the completed task answer
 * @ai.hint io
 */
async function pollTask(client, taskId, { signal, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, onPoll = null } = {}) {
    const startedAt = Date.now();
    let polls = 0;
    for (;;) {
        signal?.throwIfAborted();
        const result = await client.call(`tasks/${encodeURIComponent(taskId)}`, { method: 'GET', signal });
        const data = taskData(result);
        polls += 1;
        try { onPoll?.({ taskId, status: data?.status ?? 'unknown', polls, elapsedMs: Date.now() - startedAt }); } catch { /* observer */ }
        if (data?.status === 'completed') return result;
        if (data?.status === 'failed' || data?.status === 'canceled' || data?.status === 'cancelled') {
            throw new ApiError(`Задача seedream-5.5 завершилась со статусом «${data.status}»${data.error ? `: ${data.error}` : ''}.`, {
                code: 'TASK_FAILED', details: { taskId, status: data.status, reason: data.error },
            });
        }
        if (Date.now() - startedAt > timeoutMs) {
            throw new ApiError(`Задача seedream-5.5 не дождалась результата за ${Math.round(timeoutMs / 60_000)} мин (taskId ${taskId}).`, {
                code: 'TASK_TIMEOUT', details: { taskId, polls },
            });
        }
        const wait = Date.now() - startedAt < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
        await sleep(wait, undefined, { signal }).catch(() => { throw new ApiError('Ожидание задачи seedream-5.5 прервано.', { code: 'ABORTED' }); });
    }
}

/**
 * Split one picture into a base image and transparent PNG layers with seedream-5.5.
 * Returns normalized records: the base frame, one entry per layer (z-order, name, box in base
 * pixels, optional OCR text), and the raw parsed answer under `raw`.
 *
 * `channels` is the host chain the caller resolved for this model (`client.channels('images', model)`):
 * the gateway that serves seedream is rarely the primary host, and the decomposition body cannot go
 * through `images.generate`, so the walk over hosts happens here. A host that answers "model not
 * found" or is down advances to the next one; anything else is the caller's problem at once. The task
 * is polled on the host that created it, because a task id means nothing to the other backends.
 * @param {{ client?: { call: Function }, channels?: Array<{ client: { call: Function }, modelFor?: Function, label?: string }>,
 *   source: { bytes: Buffer, mime?: string }, model?: string,
 *   prompt?: string|null, size?: string|null, maxImages?: number|null, textRecognition?: boolean,
 *   signal?: AbortSignal, timeoutMs?: number, onPoll?: Function, onWarn?: Function }} options
 * @returns {Promise<{ base: object|null, layers: object[], ocr: object[], raw: object, taskId: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function decomposeLayers({ client = null, channels = null, source, model = SEEDREAM_MODEL, prompt = null,
    size = 'auto', maxImages = null, textRecognition = true, signal, timeoutMs, onPoll = null, onWarn = null }) {
    if (Buffer.byteLength(source?.bytes ?? '') > SEEDREAM_INPUT_MAX_BYTES) {
        throw new ApiError(`Вход разложения больше ${SEEDREAM_INPUT_MAX_BYTES} байт — уменьшите изображение.`, { code: 'IMAGE_TOO_LARGE' });
    }
    const chain = (Array.isArray(channels) && channels.length
        ? channels
        : (client?.call ? [{ client }] : [])
    ).filter((channel) => typeof channel?.client?.call === 'function');
    if (!chain.length) throw new ApiError('decomposeLayers: нужен API-клиент с методом call() или список каналов.', { code: 'INVALID_REQUEST' });
    let lastError = null;
    for (const channel of chain) {
        // Each host names the model its own way: `modelsBackends` may carry a vendor, prefix or suffix.
        const id = typeof channel.modelFor === 'function' ? channel.modelFor(model) : model;
        const body = layerDecompositionBody({ model: id, source, prompt, size, maxImages, textRecognition });
        try {
            const created = await channel.client.call('images/generations', { body, signal });
            const createdData = taskData(created);
            if (createdData?.status === 'completed') {
                const parsed = parseLayerDecomposition(created);
                return { ...parsed, raw: created, taskId: null, host: channel.label ?? null };
            }
            const taskId = String(created?.data?.[0]?.task_id ?? created?.data?.task_id ?? created?.task_id ?? '').trim();
            if (!taskId) {
                // No task and no completed data: the gateway answered something this route does not speak.
                const parsed = parseLayerDecomposition(created);
                if (parsed.base || parsed.layers.length) return { ...parsed, raw: created, taskId: null, host: channel.label ?? null };
                throw new ApiError('Ответ seedream-5.5 не содержит ни task_id, ни результатов разложения.', {
                    code: 'INVALID_RESPONSE', details: { keys: Object.keys(created ?? {}) },
                });
            }
            const settled = await pollTask(channel.client, taskId, { signal, timeoutMs, onPoll });
            const parsed = parseLayerDecomposition(settled);
            return { ...parsed, raw: settled, taskId, host: channel.label ?? null };
        } catch (error) {
            // A missing model or a dead host is this backend's answer, not the route's: try the next one.
            if (!modelMissing(error) && !providerDown(error)) throw error;
            lastError = error;
            const next = chain.indexOf(channel) < chain.length - 1;
            if (next) {
                try {
                    onWarn?.(`Разложение на ${channel.label || 'этом бэкенде'} не вышло (${error.message ?? error}); пробую следующий хост.`);
                } catch { /* observer */ }
            }
        }
    }
    throw lastError ?? new ApiError('Ни один бэкенд не выполнил разложение слоёв.', { code: 'NO_PROVIDER' });
}

/**
 * Ask seedream-5.5 for one transparent-background cut of a region (the enhanced-crop pass).
 * This is the ordinary generation route, not the decomposition one: `background: transparent` is
 * legal here and the frame travels as a free WIDTHxHEIGHT on the 16-pixel grid.
 * @param {{ client: { images?: object }, model?: string, prompt: string, bytes: Buffer, mime?: string,
 *   size?: string|null, signal?: AbortSignal }} options
 * @returns {Promise<string[]>} base64 payloads
 * @exports
 * @ai.hint io
 */
export async function generateTransparentLayer({ client, model = SEEDREAM_MODEL, prompt, bytes, mime = 'image/png', size = null, signal }) {
    const generate = client?.images?.generate;
    if (!generate) throw new ApiError('generateTransparentLayer: нужен клиент с images.generate().', { code: 'INVALID_REQUEST' });
    return generate({
        model,
        prompt,
        size,
        references: bytes?.length ? [toDataUri(bytes, mime)] : null,
        format: 'png',
        background: 'transparent',
        signal,
    });
}
