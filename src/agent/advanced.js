/**
 * @file src/agent/advanced.js
 * @module agent/advanced
 * @purpose Advanced measurer pipeline: seedream-5.5 layer decomposition → crop analysis → JSON
 *   measurement sheet. The first pass splits the reference into layers and enhanced crops
 *   (the model reads the boxes itself), and the second pass lets the normal measurer continue
 *   from the already-produced numbers — those count towards the final sheet.
 * @depends node:path, node:fs/promises, openai/seedream-5-5, shared/model-profiles,
 *   openai/images, agent/image-magick, agent/paths
 * @usedBy agent/team
 * @exports canRunAdvanced, advancedImageModel, advancedMeasure, advancedMeasurePhase1,
 *   advancedEnhanceCrops, advancedMeasurerProfile, shouldUseReasoningPro
 * @ai.tags measurer, advanced, seedream, decomposition
 * @ai.hint io
 * @changed 2026-11-10 First version: crop-first decomposition, OCR-aware elements, layer boxes as
 *   measurements, enhanced transparent crops, fallback on failure.
 * @changed 2026-11-11 The seedream model is resolved from `modelsBackends` when `imageModel` names
 *   another family, and both seedream modes now run as tasks on that host chain — the enhanced crop
 *   pass left the synchronous images route, which could neither poll a task nor carry the region in
 *   `image_urls`.
 *
 * How advanced differs from standard:
 *   - standard: the model reads the reference and returns boxes; the harness cuts the crops.
 *   - advanced: seedream-5.5 splits the reference into layers with bounding boxes itself (the
 *     model read those boxes, not the measurer), and also generates semi-transparent enhanced
 *     crops. The JSON sheet merges both. The crop count ceiling (MAX_CROPS) does not apply in
 *     advanced mode.
 *
 * The measurer model gets `reasoning.mode: "pro"` when it is an OpenAI GPT model — the extra
 * reasoning power is useful for the second pass over the many layers and crops.
 */

import path from 'node:path';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { isSeedream55, decomposeLayers, generateTransparentLayer, downloadImageBytes, SEEDREAM_MODEL, SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS } from '../openai/seedream-5-5.js';
import { imageModelFor } from '../openai/images.js';
import { detectMagick, magickCrop } from './image-magick.js';
import { readImageSize } from '../shared/images.js';

/** Subdirectory where the advanced measurer writes decomposition artefacts. */
const ADVANCED_DIR = '.tmp/_advanced-measure/';

/**
 * The seedream-5.5 id this run should decompose with, or null when the configuration names none.
 * Three places say the model exists, in the order a user would expect them to be honored:
 *   1. `imageModel` itself, when it already is a seedream-5.5 id;
 *   2. a key of `modelsBackends` — the map that says "this host serves this model", which is where
 *      seedream is usually written while the default image model stays a GPT one;
 *   3. the gateway's own id, tried across every images backend in turn.
 * Case 3 is why this never returns null on a bare config: availability is decided by the answer of
 * the hosts, not by a name the config happened to mention.
 * @param {object} config
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function advancedImageModel(config) {
    const configured = config?.imageModel ?? imageModelFor(config ?? {}, {});
    if (configured && isSeedream55(configured)) return configured;
    const declared = Object.keys(config?.modelsBackends ?? {}).filter((name) => isSeedream55(name));
    if (declared.length) return declared[0];
    return SEEDREAM_MODEL;
}

/**
 * Whether the current configuration can run the advanced measurer at all.
 * Two shapes say yes: seedream-5.5 is named somewhere the router can address (`imageModel`, or a key
 * of `modelsBackends`), or there is an images pool to walk looking for it. A config with neither has
 * nowhere to ask, and the run stays on the standard passes instead of paying for a doomed task.
 * @param {object} config
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function canRunAdvanced(config) {
    if (isSeedream55(config?.imageModel)) return true;
    if (Object.keys(config?.modelsBackends ?? {}).some((name) => isSeedream55(name))) return true;
    return [...(config?.imagesBackends ?? []), ...(config?.backends ?? [])]
        .some((item) => String(item?.baseURL ?? '').trim());
}

/**
 * Hosts to decompose on, in the order they should be tried, each knowing how it names the model.
 * A client without a channel list (a test double, a single-host caller) walks the plain route.
 * @param {object} client
 * @param {string} model
 * @returns {Array<{ client: object, modelFor?: Function, label?: string }>|null}
 * @ai.hint pure
 */
function decompositionChannels(client, model) {
    if (typeof client?.channels !== 'function') return null;
    try {
        const list = client.channels('images', model);
        return Array.isArray(list) && list.length ? list : null;
    } catch {
        return null;
    }
}

/**
 * Is this a GPT model from OpenAI? In advanced mode such a measurer model additionally gets
 * `reasoning.mode: "pro"`: the second pass over dozens of layers and crops is exactly where the
 * gateway's extended reasoning pays for itself. Matches the text families (gpt-6.1-terra,
 * gpt-6-luna, …) and the image family (gpt-image-*), bare or openai/-prefixed.
 * @param {string} model
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function shouldUseReasoningPro(model) {
    return /^(?:openai\/)?gpt-/i.test(String(model ?? '').trim());
}

/**
 * Detect the measurer model from the config.
 * @param {object} config
 * @returns {string|null}
 * @ai.hint pure
 */
function measurerModel(config) {
    return config.roles?.measurer?.model ?? config.model ?? null;
}

/**
 * Download one layer image. The gateway usually answers CDN URLs, but a data URI is legal in the
 * response too; both shapes are handled by the shared seedream reader. A failed download still
 * leaves the layer data: the box is the measurement, not the pixels.
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer|null>}
 * @ai.hint io
 */
async function downloadLayerImage(url, signal) {
    return downloadImageBytes(url, signal);
}

/**
 * Build a partial measurement sheet from layer decomposition data.
 * The model read the bounding boxes itself — these are real measurements, not the measurer's.
 * @param {{ base: object|null, layers: object[], ocr: object[], baseImageBytes?: Buffer }} decomposition
 * @param {string} sourcePath
 * @returns {{ summary: string, source: string, unit: string, units: object,
 *   confidence: string, assumptions: string[], canvas: object|null,
 *   elements: object[], regions: object[], rules: string[], notes: string }}
 * @ai.hint pure
 */
function buildPartialSheet({ base, layers, ocr, baseImageBytes }, sourcePath) {
    const elements = [];
    const regions = [];
    const assumptions = [];
    const canvas = base?.size ? { x: 0, y: 0, width: base.size.width, height: base.size.height } : null;

    for (const layer of layers) {
        const box = layer.box;
        if (!box) continue;
        const isText = layer.text && String(layer.text.text).trim();
        const name = layer.name || `layer-${layer.index}`;
        const kind = isText ? 'text' : (layer.background === 'transparent' ? 'transparent' : 'region');
        const entry = {
            name,
            kind,
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
            rotation: null,
            borders: '',
            radius: null,
            padding: { top: null, right: null, bottom: null, left: null },
            margin: { top: null, right: null, bottom: null, left: null },
            gap: null,
            placement: '',
            css: '',
            typography: null,
            confidence: box ? 'high' : 'low',
            source: sourcePath,
            notes: `Layer ${layer.index}, z=${layer.z}${layer.name ? `, "${layer.name}"` : ''}, background: ${layer.background}`,
            use: isText ? 'copy text content, font styling' : 'crop as artwork reference',
            crop: null,
        };
        if (isText) {
            entry.typography = {
                role: 'text',
                family: '',
                familyConfidence: 'unknown',
                fontSize: null,
                weight: null,
                lineHeight: null,
                letterSpacing: null,
                style: '',
            };
            entry.notes += `; text: ${String(layer.text.text).slice(0, 120)}`;
        }
        if (kind === 'transparent') {
            regions.push(entry);
        } else {
            elements.push(entry);
        }
    }

    // OCR notes
    const ocrTexts = ocr.map((o) => `Layer ${o.layer}: ${String(o.text ?? '').slice(0, 200)}`);
    const notes = ocrTexts.length ? 'OCR на нескольких слоях:' + ocrTexts.join('\n') : '';

    return {
        summary: `Advanced decomposition: ${layers.length} layers from seedream-5.5`,
        source: sourcePath,
        unit: 'px',
        units: { source: 'px', rootFontSize: 16, scale: null, preferred: ['rem', 'px', '%'], notes: 'Layer boxes from decomposition, not from visual reading.' },
        confidence: layers.filter((l) => l.box).length > layers.length * 0.5 ? 'medium' : 'low',
        assumptions: ['Layer boxes were read by seedream-5.5, not by the measurer role.'],
        canvas,
        elements,
        regions,
        rules: [],
        notes,
    };
}

/**
 * Split the reference into layers and enhanced crops. Returns the partial sheet, crop paths, and
 * the raw layer data so the second pass can refer to them.
 * @param {{ root: string, workId: string, client: object, referencePath: string,
 *   prompt: string|null, size: string|null, maxLayers: number, config: object,
 *   signal: AbortSignal, notify: Function }} options
 * @returns {Promise<{ sheet: object|null, cropPaths: string[], layers: object[], warnings: string[] }>}
 * @ai.hint io
 */
export async function advancedMeasurePhase1({ root, workId, client, referencePath, prompt = null,
    size = 'auto', maxLayers = 16, model = null, config, signal, notify }) {
    const warnings = [];
    const layers = [];
    const cropPaths = [];
    const cropDir = `${ADVANCED_DIR}crops/`;
    const cropDirAbs = path.join(root, cropDir);
    await mkdir(cropDirAbs, { recursive: true }).catch(() => {});
    const seedreamModel = model || advancedImageModel(config ?? {});
    const channels = decompositionChannels(client, seedreamModel);

    // Load the reference image.
    let refAbs = referencePath;
    if (!path.isAbsolute(referencePath)) {
        const resolved = await resolveInside(root, referencePath, { allowRoot: false });
        if (resolved) refAbs = resolved.abs;
        else { warnings.push(`Референс не найден: ${referencePath}`); return { sheet: null, cropPaths: [], layers, warnings }; }
    }
    const statInfo = await stat(refAbs).catch(() => null);
    if (!statInfo?.isFile()) { warnings.push(`Файл референса не найден: ${refAbs}`); return { sheet: null, cropPaths: [], layers, warnings }; }
    const refBytes = await readFile(refAbs);
    if (refBytes.length > SEEDREAM_INPUT_MAX_BYTES) {
        warnings.push(`Референс слишком большой (${refBytes.length} байт), разложение невозможно.`);
        return { sheet: null, cropPaths, layers, warnings };
    }
    // The vendor also caps the pixel count of one input; a giant collage fails the task outright.
    const refPixels = readImageSize(refBytes);
    if (refPixels?.width && refPixels.width * refPixels.height > SEEDREAM_INPUT_MAX_PIXELS) {
        warnings.push(`Референс слишком большой (${refPixels.width}x${refPixels.height} px), разложение невозможно.`);
        return { sheet: null, cropPaths, layers, warnings };
    }

    const refMime = refAbs.endsWith('.jpg') || refAbs.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

    // Decompose. The host chain is resolved per model, because the gateway that serves seedream is
    // usually not the primary one, and `modelsBackends` is the only place that says which is which.
    let decomposition;
    try {
        decomposition = await decomposeLayers({
            client, channels, model: seedreamModel, source: { bytes: refBytes, mime: refMime },
            prompt, size, maxImages: maxLayers, textRecognition: true, signal, onPoll: (data) => {
                notify?.({ type: 'measure.progress', phase: 'decomposition', status: data.status, polls: data.polls, elapsedMs: data.elapsedMs });
            }, onWarn: (message) => notify?.({ type: 'warning', message }),
        });
    } catch (error) {
        const hosts = channels?.length ? ` на ${channels.length} бэкенде(ах): ${channels.map((c) => c.label).join(', ')}` : '';
        warnings.push(`Разложение слоёв не удалось (${seedreamModel}${hosts}): ${error.message ?? String(error)}`);
        notify?.({ type: 'warning', message: `Разложение слоёв не удалось (${seedreamModel}${hosts}): ${error.message ?? String(error)}` });
        return { sheet: null, cropPaths, layers, warnings };
    }

    if (!decomposition.base && decomposition.layers.length === 0) {
        warnings.push('Разложение вернуло пустой результат.');
        return { sheet: null, cropPaths, layers, warnings };
    }

    // Download layers and save them.
    let serial = 1;
    for (const layer of decomposition.layers) {
        // Skip layers with no box — they are artwork fragments the measurer cannot measure.
        if (!layer.box) continue;
        const layerBytes = await downloadLayerImage(layer.url, signal);
        if (!layerBytes) {
            // No bytes available — still include the layer data for the second pass.
            warnings.push(`Слой ${layer.index} не скачан, данные для второго прохода сохранены.`);
        }

        const slug = (layer.name || `layer-${layer.index}`).replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
        const rel = `${cropDir}${String(serial).padStart(2, '0')}-${slug}.png`;
        if (layerBytes) {
            const abs = path.join(root, rel);
            await writeFile(abs, layerBytes).catch(() => {});
            cropPaths.push(rel);
        }
        // A layer without pixels still carries its box, so it stays in the list for the second pass.
        layers.push({ ...layer, localPath: layerBytes ? rel : null, bytes: layerBytes });
        serial += 1;
    }

    // Save the base image.
    const baseRel = `${cropDir}00-base.png`;
    const baseAbs = path.join(root, baseRel);
    if (decomposition.base) {
        const baseBytes = await downloadLayerImage(decomposition.base.url, signal);
        if (baseBytes) await writeFile(baseAbs, baseBytes).catch(() => {});
        else warnings.push('Базовое изображение разложения не скачано.');
    }

    // Build partial sheet from layer geometry.
    const sheet = buildPartialSheet({ ...decomposition, baseImageBytes: refBytes }, referencePath);

    notify?.({ type: 'measure.pass', pass: 1, phase: 'advanced-decomposition', layers: layers.length, crops: cropPaths.length });

    return { sheet, cropPaths, layers, warnings };
}

/**
 * Generate enhanced crops for specific regions using seedream-5.5 transparent generation.
 * This creates semi-transparent fragments that the measurer can inspect more closely. Every crop is
 * a paid generation (the reference is billed too), so the region count is capped by `maxEnhanced`.
 * @param {{ root: string, client: object, referencePath: string, cropPaths: string[],
 *   regions: object[], maxEnhanced: number, model?: string|null, config: object, signal: AbortSignal,
 *   notify: Function }} options
 * @returns {Promise<{ enhancedPaths: string[], warnings: string[] }>}
 * @ai.hint io
 */
export async function advancedEnhanceCrops({ root, client, referencePath, cropPaths, regions = [],
    maxEnhanced = 8, model = null, config, signal, notify }) {
    const enhancedPaths = [];
    const warnings = [];
    const seedreamModel = model || advancedImageModel(config ?? {});

    if (!cropPaths.length || !regions.length) return { enhancedPaths, warnings };
    // Generation is a task on this model too, so the enhanced pass walks the same host chain the
    // decomposition used instead of the synchronous images route.
    const channels = decompositionChannels(client, seedreamModel);

    let serial = 1;
    // Crop the reference to each region and ask seedream for a transparent version.
    for (const region of regions.slice(0, maxEnhanced)) {
        const box = region.box;
        if (!box) continue;
        try {
            const exe = await detectMagick({ magickPath: config.magickPath ?? null });
            if (!exe) continue;

            const stamp = `${Date.now()}-${serial++}`;
            const tmpOutput = `.tmp/_advanced-measure/region-raw-${stamp}.png`;

            // Crop the region from the original.
            const cropped = await magickCrop({ exe, input: referencePath, output: tmpOutput,
                x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
                cwd: root, signal });

            const rawBytes = await readFile(path.join(root, cropped.rel ?? tmpOutput)).catch(() => null);
            if (!rawBytes?.length) continue;

            // Generate transparent version. The task route owns both the host chain and the
            // `image_urls` field this model reads, so the crop travels as bytes and comes back as base64.
            const b64 = await generateTransparentLayer({
                client, channels, model: seedreamModel,
                prompt: 'Extract the foreground object from this region with a transparent background. Remove any background, shadows, or artifacts. Keep only the object.',
                bytes: rawBytes, mime: 'image/png', signal,
                onWarn: (message) => notify?.({ type: 'warning', message }),
            });

            if (b64?.length) {
                const enhancedRel = `.tmp/_advanced-measure/enhanced-${stamp}.png`;
                const enhancedAbs = path.join(root, enhancedRel);
                await mkdir(path.dirname(enhancedAbs), { recursive: true }).catch(() => {});
                await writeFile(enhancedAbs, Buffer.from(b64[0], 'base64')).catch(() => {});
                enhancedPaths.push(enhancedRel);
            }
        } catch (error) {
            warnings.push(`Улучшенный кроп не создан: ${error.message ?? String(error)}`);
        }
    }

    return { enhancedPaths, warnings };
}

/**
 * Check if the measurer model in advanced mode is a GPT model (needs reasoning.mode: pro).
 * @param {object} config
 * @returns {{ needsReasoningPro: boolean, model: string|null }}
 * @ai.hint pure
 */
export function advancedMeasurerProfile(config) {
    const model = measurerModel(config);
    return { needsReasoningPro: shouldUseReasoningPro(model), model };
}

/**
 * Run the full advanced measurer pipeline: decomposition → crops → optional enhanced crops →
 * return the partial sheet for the second pass to continue.
 * If decomposition fails, returns null so the caller falls back to standard mode.
 * @param {{ root: string, workId: string, referencePath: string, plan: string,
 *   config: object, client: object, signal: AbortSignal, notify: Function }} options
 * @returns {Promise<{ sheet: object|null, cropPaths: string[], layers: object[], warnings: string[] }>}
 * @ai.hint io
 */
export async function advancedMeasure({ root, workId, referencePath, plan = '', config,
    client, signal, notify }) {
    const seedreamModel = advancedImageModel(config ?? {});
    const result = await advancedMeasurePhase1({
        root, workId, client, referencePath,
        prompt: plan || null,
        size: 'auto',
        maxLayers: config.agent.advancedMaxLayers ?? 32,
        model: seedreamModel,
        config, signal, notify,
    });

    if (result.sheet && result.cropPaths.length) {
        // Generate enhanced crops for regions with boxes.
        const enhanced = await advancedEnhanceCrops({
            root, client, referencePath, cropPaths: result.cropPaths,
            regions: result.sheet.regions ?? [],
            model: seedreamModel,
            config, signal, notify,
        });
        result.cropPaths.push(...enhanced.enhancedPaths);
        result.warnings.push(...enhanced.warnings);
    }

    return result;
}
