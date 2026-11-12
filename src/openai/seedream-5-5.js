/**
 * @file src/openai/seedream-5-5.js
 * @module openai/seedream-5-5
 * @purpose API layer for the seedream-5.5 image model: layer decomposition, transparent generation,
 *   async task polling, and the normalized layer geometry the advanced measurer builds on.
 * @depends node:timers/promises, openai/errors, shared/model-profiles, shared/images
 * @usedBy agent/advanced
 * @exports SEEDREAM_MODEL, isSeedream55, seedreamLayerSizes, seedreamGenerationSize,
 *   layerDecompositionBody, generationBody, parseLayerDecomposition, normalizeLayerBox,
 *   taskImageSources, downloadImageBytes, decomposeLayers, generateTransparentLayer,
 *   SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS
 * @ai.tags images, seedream, decomposition, layers
 * @ai.hint io
 * @changed 2026-11-10 First extraction of the seedream-5.5 route: decomposition is asynchronous
 *   (POST /images/generations answers a task_id, GET /tasks/{id} carries the results), so the model
 *   needs its own file instead of another flag inside the generic images client.
 * @changed 2026-11-11 Generation is asynchronous too, and its reference travels in `image_urls`:
 *   the enhanced-crop pass left the generic images route, which waited for a synchronous
 *   `b64_json`/`url` and posted `input_references` this model never reads. Both modes now share one
 *   task runner that walks the `modelsBackends` host chain.
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
import { saveImageResponse } from './image-diagnostics.js';
import { parseImageResponseWithAI } from './image-response-fallback.js';
import { SEEDREAM_5_5 } from '../shared/model-profiles.js';

/** Default model id of the seedream-5.5 route on the proxy gateway. */
//export const SEEDREAM_MODEL = 'bytedance-seed/seedream-5-5';
export const SEEDREAM_MODEL = 'seedream-5-5';

/** Frames the decomposition mode accepts. Anything else is a synchronous 400. */
export const SEEDREAM_LAYER_SIZES = Object.freeze(['1K', '1.5K', '2K', 'auto']);

/** Ratios the generation mode accepts (the vendor also reads `16x9` for `16:9`). */
export const SEEDREAM_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '2:1', '1:2']);

/** Pixel budget of one generation frame; an exact frame outside it is a synchronous 400. */
export const SEEDREAM_GENERATION_MIN_PIXELS = 921_600;
export const SEEDREAM_GENERATION_MAX_PIXELS = 4_624_220;

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
 * A frame the generation mode accepts. Unlike decomposition, generation also takes ratios and exact
 * pixels, but a measurement crop is far below the vendor's minimum pixel budget (921 600), so an
 * exact frame of a small region is a synchronous HTTP 400. A tier is what a crop can actually ask
 * for, and `1K` is the cheap one; anything unusable becomes `1K` rather than a rejected frame.
 * @param {string|null|undefined} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function seedreamGenerationSize(value) {
    const token = String(value ?? '').trim();
    if (!token) return '1K';
    const upper = token.toUpperCase();
    if (SEEDREAM_LAYER_SIZES.includes(upper)) return upper;
    const match = /^(\d+)\s*[xх*]\s*(\d+)$/i.exec(token);
    if (match) {
        const pixels = Number(match[1]) * Number(match[2]);
        if (pixels >= SEEDREAM_GENERATION_MIN_PIXELS && pixels <= SEEDREAM_GENERATION_MAX_PIXELS) return `${match[1]}x${match[2]}`;
    }
    if (SEEDREAM_RATIOS.includes(token.replace(/x/i, ':'))) return token.replace(/x/i, ':');
    return '1K';
}

/**
 * Body for POST /images/generations in the ordinary generation mode (the enhanced-crop pass).
 * The reference travels in `image_urls` — this model does not read the `input_references` field the
 * generic images route uses — transparency needs `output_format: "png"`, and `n` stays out because
 * the mode answers exactly one task.
 * @param {{ model?: string, prompt: string, references?: string[]|null, size?: string|null,
 *   background?: string|null, format?: string|null }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function generationBody({ model = SEEDREAM_MODEL, prompt, references = null, size = '1K', background = 'transparent', format = 'png' }) {
    const text = String(prompt ?? '').trim();
    // Unlike decomposition, generation cannot run without a prompt.
    if (!text) throw new ApiError('Генерация seedream-5.5 требует prompt.', { code: 'INVALID_REQUEST' });
    const images = (Array.isArray(references) ? references : []).filter((url) => typeof url === 'string' && url.trim());
    if (images.length > 10) throw new ApiError('seedream-5.5 принимает не больше 10 референсов.', { code: 'INVALID_REQUEST' });
    const body = { model, prompt: text, size: seedreamGenerationSize(size) };
    if (images.length) body.image_urls = images;
    const imageFormat = String(format ?? '').trim().toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
    body.output_format = imageFormat;
    // The vendor refuses transparent output combined with JPEG.
    const wanted = String(background ?? '').trim().toLowerCase();
    if (['transparent', 'opaque', 'auto'].includes(wanted) && !(wanted === 'transparent' && imageFormat === 'jpeg')) {
        body.background = wanted;
    }
    return body;
}

/**
 * `data` of a task answer, or null while the task is still running.
 * @param {object} result
 * @returns {{ status: string, error: string|null, reason: string|null, images: object[] }|null}
 * @ai.hint pure
 */
function taskData(result) {
    const data = result?.data ?? result ?? null;
    if (!data || typeof data !== 'object') return null;
    const status = String(data.status ?? '').trim().toLowerCase();
    if (!['pending', 'processing', 'completed', 'failed', 'canceled', 'cancelled'].includes(status)) return null;
    const error = typeof data.error === 'string' ? data.error : (data.error?.message ?? null);
    // `reason` is documented as the machine-readable cause and is the only part that tells a refused
    // picture apart from a timeout; the message alone reads the same for both.
    const reason = typeof data.error?.reason === 'string' ? data.error.reason.trim() : (typeof data.error?.code === 'string' ? data.error.code.trim() : null);
    return { status, error, reason, images: Array.isArray(data.result?.images) ? data.result.images : [] };
}

/**
 * Did the provider refuse the pictures rather than the request?
 * A decomposition redraws the whole reference — the base image and every layer are outputs the model
 * painted over somebody else's layout — and the vendor's moderation stops that under copyright
 * (`OutputImageSensitiveContentDetected.PolicyViolation`, `content_policy_violation`, "did not pass
 * content safety review"). Nothing in the request caused it and nothing in the request can fix it:
 * the same file asked again gets the same answer, so this class must end the attempt instead of
 * spending the remaining paid generations on it.
 * @param {unknown} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isContentRejection(error) {
    const parts = [
        error?.details?.reason, error?.details?.code, error?.apiCode, error?.code,
        error?.details?.message, error?.message, error,
    ];
    return parts.some((part) => typeof part === 'string'
        && /sensitivecontent|policyviolation|content[_\s]policy|content safety|copyright|moderation/i.test(part));
}

/**
 * What to tell a human when the provider refused the pictures. The vendor's sentence names a prompt
 * the caller never sent, so it is replaced rather than repeated: a user reading "adjust your prompt"
 * would go looking for a prompt that does not exist.
 * @param {unknown} error
 * @param {string} what the name of the operation that was refused
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function contentRejectionNotice(error, what) {
    // Only the machine-readable code is quoted; `details.reason` carries the vendor's prose, which is
    // exactly the sentence that blames a prompt this pipeline never sent.
    const code = [error?.apiCode, error?.details?.code].find((part) => typeof part === 'string' && part);
    return `${what} отклонено модерацией провайдера${code ? ` (${code})` : ''}: перерисовка чужого макета распознана `
        + 'как контент с авторскими ограничениями. Это ответ на само изображение, а не на запрос, поэтому повтор его не изменит; '
        + 'средства за неудачную задачу возвращаются.';
}

/**
 * Read one layer's box in base-image pixels, from either box shape the vendor sends.
 * `absolute` is `[left, top, right, bottom]`; `normalized` is the same frame on a 0–1000 scale, which
 * becomes pixels through `baseFrame` (`x = left / 1000 * width`, per the documented formula).
 *
 * Which frame that is deserves a note, because the docs and a measured answer disagree. The docs say
 * `absolute` is in pixels of the base image; the base PNG the task returns is rescaled to the tier
 * (`size: auto` grows an input under 1K to 1K, so a 1024×768 page answers 1182×887). Measured on that
 * page, a layer naming the right-hand panel reported left=829 while the panel starts at x=830 of the
 * 1024-wide file — the box belongs to the frame of the picture that was SENT, not to the 1182-wide
 * base file. Dividing by the base ratio moved every crop 13% up and left, so `absolute` is taken as it
 * arrives and the file's own size never enters here. Both frames stay approximate: the measurer
 * verifies the geometry on the picture.
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
 * The OCR of one text layer, kept close to the shape the vendor sends.
 * `lines[].bounding_box` matters more than it looks: it is a tight frame around the glyphs, while the
 * layer's own box is padded around the whole object. The line frames are the only coordinates in this
 * answer that hug the content, so they are what the measurer can actually read a font size off.
 * `runs[].style` carries the font family guess, the colour and the bold/italic flags — the fields the
 * measurer would otherwise have to invent.
 * @param {object|null|undefined} recognition
 * @param {{ width: number, height: number }|null} baseFrame
 * @returns {{text:string, lines: object[]}|null}
 * @ai.hint pure
 */
function parseTextRecognition(recognition, baseFrame) {
    if (!recognition || typeof recognition !== 'object') return null;
    const lines = Array.isArray(recognition.lines) ? recognition.lines : [];
    return {
        text: String(recognition.text ?? ''),
        lines: lines.map((line) => ({
            text: String(line?.text ?? ''),
            box: normalizeLayerBox(line?.bounding_box, baseFrame),
            runs: (Array.isArray(line?.runs) ? line.runs : []).map((run) => ({
                text: String(run?.text ?? ''),
                style: run?.style && typeof run.style === 'object' ? run.style : null,
            })),
        })),
    };
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
export function parseLayerDecomposition(result, coordinateFrame = null) {
    const rows = taskData(result)?.images ?? [];
    const out = { base: null, layers: [], ocr: [] };
    for (const row of rows) {
        const urls = Array.isArray(row?.url) ? row.url.filter((u) => typeof u === 'string' && u.trim()) : [];
        if (!urls.length) continue;
        const sizes = parseSizes(row.sizes);
        const meta = Array.isArray(row.layers) && row.layers.length === urls.length ? row.layers : null;
        const baseFrame = coordinateFrame?.width && coordinateFrame?.height
            ? coordinateFrame
            : (sizes[0]?.width ? { width: sizes[0].width, height: sizes[0].height } : null);
        out.base ??= { url: urls[0], size: sizes[0]?.width ? { width: sizes[0].width, height: sizes[0].height } : { width: null, height: null } };
        for (let index = 1; index < urls.length; index++) {
            const layer = meta?.[index] ?? null;
            const textRecognition = parseTextRecognition(layer?.text_recognition, out.base.size);
            out.layers.push({
                index,
                z: Number.isFinite(layer?.z_index) ? layer.z_index : index,
                name: String(layer?.name ?? '').trim(),
                description: String(layer?.description ?? '').trim(),
                url: urls[index],
                size: sizes[index] ?? { width: null, height: null },
                background: String(layer?.background ?? (Array.isArray(row.backgrounds) ? row.backgrounds[index] : '') ?? '').trim(),
                box: normalizeLayerBox(layer?.bounding_box, baseFrame),
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
                // `reason` is carried on the error itself: it is what tells a refused picture apart
                // from a timeout, and the caller has to be able to ask without parsing prose.
                code: 'TASK_FAILED',
                apiCode: data.reason,
                details: { taskId, status: data.status, reason: data.error, code: data.reason ?? null },
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
 * The channel list to walk: the resolved host chain, or the single client the caller handed over.
 * @param {{ call: Function }|null} client
 * @param {Array<{ client: object }>|null} channels
 * @param {string} what Route name, for the error text.
 * @returns {Array<{ client: { call: Function }, modelFor?: Function, label?: string }>}
 * @ai.hint pure
 */
function channelChain(client, channels, what) {
    const chain = (Array.isArray(channels) && channels.length
        ? channels
        : (client?.call ? [{ client }] : [])
    ).filter((channel) => typeof channel?.client?.call === 'function');
    if (!chain.length) throw new ApiError(`${what}: нужен API-клиент с методом call() или список каналов.`, { code: 'INVALID_REQUEST' });
    return chain;
}

/**
 * Post one seedream-5.5 body and wait for its task, walking the host chain.
 * Both modes of this model are asynchronous — generation answers a task id exactly like
 * decomposition does — so the schedule and the host walk belong here rather than in each caller.
 * A host that answers "model not found" or is down advances to the next one; anything else is the
 * caller's problem at once. The task is polled on the host that created it, because a task id means
 * nothing to the other backends.
 * @param {{ client?: object, channels?: Array<{ client: object, modelFor?: Function, label?: string }>,
 *   model: string, body: object, signal?: AbortSignal, timeoutMs?: number,
 *   onPoll?: Function, onWarn?: Function, what: string, noResult: string,
 *   route?: string, provider?: string|null }} options
 * @returns {Promise<{ raw: object, taskId: string|null, host: string|null }>}
 * @ai.hint io
 */
async function runSeedreamTask({ client = null, channels = null, model, body, signal, timeoutMs,
    onPoll = null, onWarn = null, what = 'Задача seedream-5.5', noResult = 'Ответ seedream-5.5 не содержит ни task_id, ни результатов.',
    route = 'seedream/generations', provider = null }) {
    const chain = channelChain(client, channels, what);
    /** Every answer this model gives is archived raw, task id or finished picture alike. */
    const archive = (raw, taskId, host) => saveImageResponse(raw, { route, model, host: host ?? null, taskId, provider });
    let lastError = null;
    for (const [index, channel] of chain.entries()) {
        // Each host names the model its own way: `modelsBackends` may carry a vendor, prefix or suffix.
        const id = typeof channel.modelFor === 'function' ? channel.modelFor(model) : model;
        const sent = { ...body, model: id };
        try {
            const created = await channel.client.call('images/generations', { body: sent, signal });
            if (taskData(created)?.status === 'completed') {
                return { raw: created, taskId: null, host: channel.label ?? null, savedFile: await archive(created, null, channel.label) };
            }
            const taskId = String(created?.data?.[0]?.task_id ?? created?.data?.task_id ?? created?.task_id ?? '').trim();
            if (!taskId) {
                const savedFile = await archive(created, null, channel.label);
                if (taskImageSources(created).length) {
                    return { raw: created, taskId: null, host: channel.label ?? null, savedFile };
                }
                throw new ApiError(noResult + (savedFile ? ` Сырой ответ сохранён: ${savedFile}.` : ''),
                    { code: 'INVALID_RESPONSE', details: { keys: Object.keys(created ?? {}), savedFile } });
            }
            const settled = await pollTask(channel.client, taskId, { signal, timeoutMs, onPoll });
            return { raw: settled, taskId, host: channel.label ?? null, savedFile: await archive(settled, taskId, channel.label) };
        } catch (error) {
            // A missing model or a dead host is this backend's answer, not the route's: try the next one.
            if (!modelMissing(error) && !providerDown(error)) throw error;
            lastError = error;
            if (index < chain.length - 1) {
                try {
                    onWarn?.(`${what} на ${channel.label || 'этом бэкенде'} не вышла (${error.message ?? error}); пробую следующий хост.`);
                } catch { /* observer */ }
            }
        }
    }
    throw lastError ?? new ApiError(`Ни один бэкенд не выполнил ${what.toLowerCase()}.`, { code: 'NO_PROVIDER' });
}

/**
 * Picture sources of a completed answer, in response order.
 * A task answer keeps them in `data.result.images[].url[]` — an array per row, index-aligned with
 * `sizes` and `layers` — while a synchronous gateway may answer the OpenAI shape `data[].url` or
 * `data[].b64_json`, so all three shapes are read.
 * @param {object} result
 * @returns {Array<{ kind: 'b64'|'url', value: string }>}
 * @exports
 * @ai.hint pure
 */
export function taskImageSources(result) {
    const out = [];
    const push = (value, kind) => {
        const text = String(value ?? '').trim();
        if (text) out.push({ kind, value: text });
    };
    const rows = [
        ...(taskData(result)?.images ?? []),
        ...(Array.isArray(result?.data) ? result.data : []),
    ];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (Array.isArray(row.url)) row.url.forEach((item) => push(item, 'url'));
        else if (typeof row.url === 'string') push(row.url, 'url');
        if (Array.isArray(row.b64_json)) row.b64_json.forEach((item) => push(item, 'b64'));
        else if (typeof row.b64_json === 'string') push(row.b64_json, 'b64');
    }
    return out;
}

/**
 * Bytes of one answer picture. A CDN link is fetched; a data URI is decoded, because `fetch` does
 * not speak that scheme and a gateway is free to answer inline.
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer|null>}
 * @exports
 * @ai.hint io
 */
export async function downloadImageBytes(url, signal) {
    try {
        const text = String(url ?? '').trim();
        if (/^data:/i.test(text)) {
            const comma = text.indexOf(',');
            const header = text.slice(0, comma);
            if (!/;base64/i.test(header)) return null;
            return Buffer.from(text.slice(comma + 1), 'base64');
        }
        const res = await fetch(text, { signal, redirect: 'follow' });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
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
  *   coordinateFrame?: { width: number, height: number }|null,
  *   signal?: AbortSignal, timeoutMs?: number, onPoll?: Function, onWarn?: Function }} options

 * @returns {Promise<{ base: object|null, layers: object[], ocr: object[], raw: object, taskId: string|null }>}
 * @exports
 * @ai.hint io
 */
export async function decomposeLayers({ client = null, channels = null, source, model = SEEDREAM_MODEL, prompt = null,
    size = 'auto', maxImages = null, textRecognition = true, coordinateFrame = null, signal, timeoutMs, onPoll = null, onWarn = null }) {
    if (Buffer.byteLength(source?.bytes ?? '') > SEEDREAM_INPUT_MAX_BYTES) {
        throw new ApiError(`Вход разложения больше ${SEEDREAM_INPUT_MAX_BYTES} байт — уменьшите изображение.`, { code: 'IMAGE_TOO_LARGE' });
    }
    const body = layerDecompositionBody({ model, source, prompt, size, maxImages, textRecognition });
    const { raw, taskId, host } = await runSeedreamTask({
        client, channels, model, body, signal, timeoutMs, onPoll, onWarn,
        route: 'seedream-decomposition',
        what: 'Разложение слоёв',
        noResult: 'Ответ seedream-5.5 не содержит ни task_id, ни результатов разложения.',
    });
    return { ...parseLayerDecomposition(raw, coordinateFrame), raw, taskId, host };
}

/**
 * Ask seedream-5.5 for one transparent-background cut of a region (the enhanced-crop pass).
 *
 * This is the generation mode, not the decomposition one: `background: transparent` is legal here.
 * It is still an asynchronous task — the gateway answers `data[0].task_id` for every seedream-5.5
 * call, generation included, and the picture only appears on `GET /tasks/{id}` under
 * `data.result.images[].url[]`. Routing this through `client.images.generate` cannot work twice
 * over: that route waits for a synchronous `b64_json`/`url` it will never get, and it carries the
 * reference in `input_references` while this model reads `image_urls`.
 * @param {{ client?: object, channels?: Array<{ client: object, modelFor?: Function, label?: string }>,
 *   model?: string, prompt: string, bytes?: Buffer|null, mime?: string, references?: string[]|null,
 *   size?: string|null, background?: string|null, format?: string|null, signal?: AbortSignal,
 *   timeoutMs?: number, onPoll?: Function, onWarn?: Function }} options
 * @returns {Promise<string[]>} base64 payloads (a `url` answer is downloaded)
 * @exports
 * @ai.hint io
 */
export async function generateTransparentLayer({ client = null, channels = null, model = SEEDREAM_MODEL, prompt,
    bytes = null, mime = 'image/png', references = null, size = '1K', background = 'transparent', format = 'png',
    signal, timeoutMs, onPoll = null, onWarn = null, parserModel = null, invoke = null, root = null, provider = null }) {
    const urls = Array.isArray(references) && references.length
        ? references
        : (bytes?.length ? [toDataUri(bytes, mime)] : []);
    const body = generationBody({ model, prompt, references: urls, size, background, format });
    const { raw, savedFile } = await runSeedreamTask({
        client, channels, model, body, signal, timeoutMs, onPoll, onWarn,
        route: 'seedream-generation', provider,
        what: 'Генерация прозрачного слоя', noResult: 'Ответ seedream-5.5 не содержит ни task_id, ни результатов генерации.',
    });
    let sources = taskImageSources(raw);
    if (!sources.length) {
        sources = (await parseImageResponseWithAI({
            result: raw, route: 'seedream-generation', model, host: null, taskId: null,
            invoke, parserModel, root, signal, onWarn, archive: false,
        })) ?? [];
    }
    const payloads = [];
    for (const source of sources) {
        if (source.kind === 'b64') { payloads.push(source.value); continue; }
        const image = await downloadImageBytes(source.value, signal);
        if (image) payloads.push(image.toString('base64'));
    }
    if (!payloads.length) {
        throw new ApiError('Задача seedream-5.5 завершилась без изображения.'
            + (savedFile ? ` Сырой ответ сохранён: ${savedFile}.` : ''), { code: 'INVALID_RESPONSE', details: { keys: Object.keys(raw ?? {}), savedFile } });
    }
    return payloads;
}
