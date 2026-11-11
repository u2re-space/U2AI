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
 *   advancedEnhanceCrops, advancedMeasurerProfile, shouldUseReasoningPro, LAYER_PROMPT
 * @ai.tags measurer, advanced, seedream, decomposition
 * @ai.hint io
 * @changed 2026-11-10 First version: crop-first decomposition, OCR-aware elements, layer boxes as
 *   measurements, enhanced transparent crops, fallback on failure.
 * @changed 2026-11-11 The seedream model is resolved from `modelsBackends` when `imageModel` names
 *   another family, and both seedream modes now run as tasks on that host chain — the enhanced crop
 *   pass left the synchronous images route, which could neither poll a task nor carry the region in
 *   `image_urls`.
 * @changed 2026-11-11 A measured run showed the layer boxes are areas, not measurements (padded
 *   around the object, up to a tenth of the frame off, one object returned as several layers). They
 *   are no longer rescaled by the size of the returned base image, they enter the sheet at `medium`
 *   confidence as `box approximate`, names are ASCII, and the crops they feed are padded, deduplicated
 *   by IoU and dropped when most of the box lies outside the frame.
 * @changed 2026-11-11 The moderation of the vendor refuses the redraw of somebody else's layout
 *   (`OutputImageSensitiveContentDetected.PolicyViolation` / `content_policy_violation`), which is the
 *   normal fate of a commercial reference in this mode. That class is now named in the warning instead
 *   of the vendor's prose about a prompt nobody sent, and the enhanced-crop pass stops at the first
 *   such refusal: every remaining crop is a piece of the same refused picture and would be billed the
 *   same way.
 * @changed 2026-11-11 The padding that left every measurement with phantom spacing is narrowed where
 *   the answer gives tighter geometry: a text layer is cut to the union of its
 *   `text_recognition.lines[].bounding_box`, and the line frames plus `runs[].style` fill the font
 *   size, line step, weight and family instead of leaving them null. The decomposition now runs
 *   without a prompt, because the vendor states a prompt alongside `text_recognition` can cost the OCR.
 *
 * How advanced differs from standard:
 *   - standard: the model reads the reference and returns boxes; the harness cuts the crops.
 *   - advanced: seedream-5.5 splits the reference into layers with bounding boxes itself and also
 *     generates semi-transparent enhanced crops. Those boxes are approximate areas the generation
 *     model drew, so the measurer verifies every one of them on the picture before the sheet is
 *     trusted. The crop count ceiling (MAX_CROPS) does not apply in advanced mode.
 *
 * The measurer model gets `reasoning.mode: "pro"` when it is an OpenAI GPT model — the extra
 * reasoning power is useful for the second pass over the many layers and crops.
 */

import path from 'node:path';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { isSeedream55, decomposeLayers, generateTransparentLayer, downloadImageBytes, isContentRejection, contentRejectionNotice, SEEDREAM_MODEL, SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS } from '../openai/seedream-5-5.js';
import { imageModelFor } from '../openai/images.js';
import { detectMagick, magickCrop, magickPadImageBytes, magickRemoveImagePadding, magickTrimImage } from './image-magick.js';
import { rasterPadImageBytes, rasterRemoveImagePadding, rasterTrim } from './image-raster.js';
import { paddedSizeToMinPixels, paddedSizeToMinPixelsByResolution } from '../shared/images.js';
import { readImageSize } from '../shared/images.js';

/** Subdirectory where the advanced measurer writes decomposition artefacts. */
const ADVANCED_DIR = '.tmp/_advanced-measure/';

/**
 * An optional brief for the decomposition call. It is NOT sent by default: the vendor states that with
 * `text_recognition: true` a prompt can cost the OCR result, and the OCR is what this pipeline measures
 * with (the line frames, the font style, the copy). When a caller does pass one, this is the wording
 * that keeps names and descriptions in Latin script — a Russian plan pasted in here once came back
 * with layer names in Chinese.
 */
export const LAYER_PROMPT = 'Split this interface screenshot into its visual layers: background, panels, cards, images, icons, and every text block on its own. '
    + 'Name and describe each layer in English, using Latin letters, digits and hyphens only (nav-logo, hero-badge, price-card-1). '
    + 'Never write Chinese, Cyrillic or any other non-Latin script in names or descriptions.';

const SOURCE_GEOMETRY_PROMPT = 'Preserve the source image or fragment at its original scale and geometry, unchanged at canvas origin (0,0). '
    + 'Do not upscale, stretch, move, or recenter it. If a larger canvas is required, extend it to the right and bottom. '
    + 'Never guess or state unverified source dimensions.';

/** A region this small is not an object, and seedream cannot cut anything out of it. */
const MIN_CROP_SIDE = 32;

/**
 * The tight frame around the text a layer carries.
 * `bounding_box` of a layer is an area the generation model drew around the whole object, and it is
 * padded: measured on a real page, a heading layer was 644×597 where the glyphs occupy 604×410, and a
 * row of social icons came back 296×296 for a 34 px control. That padding is exactly the phantom
 * spacing a coder ends up writing. `text_recognition.lines[].bounding_box` is documented as a frame
 * of the line in the same coordinates and is the only geometry in this answer that hugs the content,
 * so a text layer is narrowed to the union of its lines.
 * @param {object[]} lines the OCR lines of one layer
 * @param {object} box the layer box the lines are claimed to sit in
 * @returns {object|null} the tighter box, or null when the lines do not describe a subset of it
 * @ai.hint pure
 */
function textBoxUnion(lines, box) {
    const boxes = lines.map((line) => line?.box).filter((item) => item?.width > 0 && item?.height > 0);
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map((item) => item.x));
    const top = Math.min(...boxes.map((item) => item.y));
    const right = Math.max(...boxes.map((item) => item.x + item.width));
    const bottom = Math.max(...boxes.map((item) => item.y + item.height));
    const tight = { x: left, y: top, width: right - left, height: bottom - top };
    // A union wider than the layer it belongs to means the line frames are not in the same frame as
    // the layer box; guessing which of the two is right would invent geometry, so the layer wins.
    const slack = 0.1 * Math.max(box.width, box.height);
    if (tight.x < box.x - slack || tight.y < box.y - slack
        || tight.x + tight.width > box.x + box.width + slack
        || tight.y + tight.height > box.y + box.height + slack) return null;
    return tight;
}

/**
 * The typography the OCR already measured, so the measurer verifies a number instead of inventing one.
 * `runs[].style` carries the family guess and the bold/italic flags, and the line frames give the two
 * numbers a picture cannot easily yield: the height of a line of glyphs and the step between lines.
 * Everything the vendor does not state stays null.
 * @param {object[]} lines
 * @returns {object|null}
 * @ai.hint pure
 */
function typographyFromLines(lines) {
    const styled = lines.flatMap((line) => (Array.isArray(line?.runs) ? line.runs : [])
        .map((run) => run?.style).filter((style) => style && typeof style === 'object'));
    const boxes = lines.map((line) => line?.box).filter((item) => item?.width > 0 && item?.height > 0)
        .sort((a, b) => a.y - b.y);
    if (!styled.length && !boxes.length) return null;
    const first = styled[0] ?? {};
    const lineHeight = boxes.length >= 2
        ? Math.round(boxes.slice(1).reduce((sum, box, i) => sum + (box.y - boxes[i].y), 0) / (boxes.length - 1))
        : null;
    return {
        role: 'text',
        family: String(first.similar_font_family ?? '').trim(),
        familyConfidence: String(first.similar_font_family ?? '').trim() ? 'low' : 'unknown',
        fontSize: boxes.length ? Math.round(Math.min(...boxes.map((box) => box.height))) : null,
        weight: typeof first.bold === 'boolean' ? (first.bold ? 700 : 400) : null,
        lineHeight,
        letterSpacing: null,
        style: first.italic === true ? 'italic' : '',
    };
}

/**
 * A file-name slug both the filesystem and the model can read. The gateway names layers in any script
 * it likes, and stripping a Chinese name down to `[a-z0-9]` used to leave a file called `01-.png`.
 * @param {string|null|undefined} name
 * @param {number} index
 * @returns {string}
 * @ai.hint pure
 */
function layerSlug(name, index) {
    const clean = String(name ?? '').normalize('NFKD')
        .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 32);
    return clean || `layer-${index}`;
}

/**
 * The layer name as it may enter the sheet: printable ASCII, or a generated label. A name the coder
 * cannot read is not a name, and the picture plus its box carry the meaning anyway.
 * @param {string|null|undefined} name
 * @param {number} index
 * @returns {string}
 * @ai.hint pure
 */
function layerLabel(name, index) {
    const clean = String(name ?? '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clean || `layer-${index}`;
}

/**
 * What the two frames the answer speaks about are, and whether they disagree.
 * `sizes[0]` is the pixel size of the base PNG the task produced (`size: auto` rescales the input to
 * a tier: a 1024×768 page comes back as 1182×887), while `bounding_box.absolute` is read in the frame
 * of the picture that was sent. Measured on a real decomposition: the boxes of a 1024×768 reference
 * land within a few tens of pixels of the element when used as they arrive, and every one of them
 * slides a further 13% up and left when divided by the base ratio. So the boxes are kept as they are
 * and the difference is only reported — the measurer is the one who reads the final numbers.
 * @param {{width:number,height:number}|null} baseFrame
 * @param {{width:number,height:number}|null} refFrame
 * @returns {{width:number,height:number}|null} the disagreement, or null when there is nothing to say
 * @ai.hint pure
 */
function frameMismatch(baseFrame, refFrame) {
    const bw = baseFrame?.width;
    const bh = baseFrame?.height;
    if (!bw || !bh || !refFrame?.width || !refFrame?.height) return null;
    if (Math.abs(bw - refFrame.width) / refFrame.width < 0.02 && Math.abs(bh - refFrame.height) / refFrame.height < 0.02) return null;
    return { width: bw, height: bh };
}

/**
 * Regions worth a paid generation, in the order they should spend the budget.
 * A seedream box is an area, not a measurement: on a real reference it came out padded around the
 * object and shifted up-left by up to a tenth of the frame, so a cut along its edges loses part of
 * what it names. Every box therefore grows by a margin before it is cut. The same object also comes
 * back as several layers (an icon, its shadow, the text on it), and each duplicate used to be
 * cropped, sent and billed for the very same picture, so a region whose box is the same area one
 * already on the list is dropped instead of paying twice for one fragment.
 * @param {object[]} regions
 * @param {{width:number,height:number}|null} frame
 * @param {number} limit
 * @returns {Array<{ name: string, box: object }>}
 * @ai.hint pure
 */
function cropTargets(regions, frame, limit) {
    const targets = [];
    for (const region of regions) {
        const box = region?.box;
        if (!box) continue;
        let { x, y, width, height } = box;
        const asked = Math.max(1, Math.max(0, width) * Math.max(0, height));
        const margin = Math.round(0.08 * Math.max(width, height));
        x -= margin;
        y -= margin;
        width += margin * 2;
        height += margin * 2;
        if (frame?.width && frame?.height) {
            x = Math.max(0, Math.round(x));
            y = Math.max(0, Math.round(y));
            width = Math.min(Math.round(width), frame.width - x);
            height = Math.min(Math.round(height), frame.height - y);
        } else {
            x = Math.max(0, Math.round(x));
            y = Math.max(0, Math.round(y));
            width = Math.round(width);
            height = Math.round(height);
        }
        if (!(width >= MIN_CROP_SIDE) || !(height >= MIN_CROP_SIDE)) continue;
        // A box that loses most of itself outside the frame is a geometry error of the model, not an
        // object touching the edge; the corner that survives holds nothing worth paying for.
        if (width * height < 0.5 * asked) continue;
        const area = width * height;
        const duplicate = targets.some((taken) => {
            const other = taken.box;
            const overlap = Math.max(0, Math.min(x + width, other.x + other.width) - Math.max(x, other.x))
                * Math.max(0, Math.min(y + height, other.y + other.height) - Math.max(y, other.y));
            // IoU, not containment: a small element inside a big panel is a different fragment and
            // deserves its own cut, while an icon and its shadow are the same box paid for twice.
            const union = area + other.width * other.height - overlap;
            return union > 0 && overlap / union >= 0.6;
        });
        if (duplicate) continue;
        targets.push({ name: region.name, box: { x, y, width, height } });
    }
    // The biggest regions are the ones the measurer cannot read without a cut-out, so they go first.
    targets.sort((a, b) => (b.box.width * b.box.height) - (a.box.width * a.box.height));
    return targets.slice(0, limit);
}

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
 * Add only the transparent frame Seedream requires; the verified source dimensions remain metadata
 * for cropping its reply back to the original top-left coordinate system.
 * @param {Buffer} bytes
 * @param {string} model
 * @param {object} config
 * @param {AbortSignal} signal
 * @returns {Promise<object|null>}
 * @ai.hint io
 */
async function padSeedreamInput(bytes, model, config, signal) {
    const original = readImageSize(bytes);
    if (!original?.width || !original?.height) return null;
    const floor = paddedSizeToMinPixelsByResolution(original, model); // TODO! support not only 1k, but 2k canvas...
    const width = Math.max(Math.ceil(original.width / 16) * 16, floor?.width ?? 0);
    const height = Math.max(Math.ceil(original.height / 16) * 16, floor?.height ?? 0);
    if (width === original.width && height === original.height) {
        return { bytes, width, height, originalWidth: width, originalHeight: height, padded: false, engine: null };
    }
    const options = { bytes, engine: config?.image?.rasterEngine ?? 'auto',
        targetWidth: floor?.width ?? null, targetHeight: floor?.height ?? null };
    let frame = null;
    try { frame = await rasterPadImageBytes(options); } catch { /* try ImageMagick */ }
    if (frame) return frame;
    const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
    if (!exe) throw new Error('Для padding входа Seedream требуется sharp, canvas или ImageMagick.');
    frame = await magickPadImageBytes({ exe, bytes, signal, targetWidth: options.targetWidth, targetHeight: options.targetHeight });
    return { ...frame, engine: 'magick', exe };
}

/**
 * Remove the known right/bottom frame added before a Seedream request, only when the returned image
 * has that exact frame. This preserves content coordinates and never rescales model output.
 * @param {Buffer} bytes
 * @param {object} padding
 * @param {AbortSignal} signal
 * @returns {Promise<Buffer>}
 * @ai.hint io
 */
async function unpadSeedreamOutput(bytes, padding, signal) {
    if (!padding?.padded) return bytes;
    const actual = readImageSize(bytes);
    if (!actual?.width || !actual?.height
        || Math.abs(actual.width / actual.height - padding.width / padding.height) > (padding.width / padding.height) * 0.02) return bytes;
    try {
        if (padding.engine === 'magick') {
            return await magickRemoveImagePadding({ ...padding, bytes, signal, normalized: true });
        }
        return await rasterRemoveImagePadding({ ...padding, bytes, engine: padding.engine, normalized: true }) ?? bytes;
    } catch {
        return bytes;
    }
}

/**
 * Trim transparent padding from an individual generated layer asset without changing its reference box.
 * @param {string} abs
 * @param {object} config
 * @param {AbortSignal} signal
 * @param {string|null} exe
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function trimLayerAsset(abs, config, signal) {
    try {
        const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
        if (exe) {
            await magickTrimImage({ exe, input: abs, cwd: path.dirname(abs), signal });
            return;
        }
        await rasterTrim({ input: abs, cwd: path.dirname(abs), signal, fuzz: 0, engine: config?.image?.rasterEngine ?? 'auto', transparentOnly: true });
    } catch { /* trimming an auxiliary layer is best-effort */ }
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
        const name = layerLabel(layer.name, layer.index);
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
            typography: isText ? (layer.typography ?? typographyFromLines(Array.isArray(layer.text?.lines) ? layer.text.lines : [])) : null,
            confidence: 'medium',
            source: sourcePath,
            notes: `Layer ${layer.index}, z=${layer.z}, background: ${layer.background}; `
                + (layer.tightened ? 'box tightened to the OCR line frames' : 'box approximate'),
            use: isText ? 'copy text content, font styling' : 'crop as artwork reference',
            crop: null,
        };
        if (isText) {
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
        units: { source: 'px', rootFontSize: 16, scale: null, preferred: ['rem', 'px', '%'], notes: 'Layer boxes come from a generation model: they are approximate areas, not measured edges.' },
        confidence: layers.filter((l) => l.box).length > layers.length * 0.5 ? 'medium' : 'low',
        assumptions: ['Layer boxes were read by seedream-5.5, a generation model, and are approximate: they are padded around the object and can sit tens of pixels off. The measurer must verify each box on the picture before it is trusted.'],
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
 *   prompt?: string|null, size: string|null, maxLayers: number, model?: string|null, config: object,
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

    const inputPadding = await padSeedreamInput(refBytes, seedreamModel, config, signal).catch((error) => {
        warnings.push(`Padding входа Seedream не выполнен: ${error.message ?? String(error)}`);
        return null;
    });
    if (!inputPadding) return { sheet: null, cropPaths, layers, warnings };
    const inputBytes = inputPadding.bytes;
    const inputFrame = { width: inputPadding.width, height: inputPadding.height };
    const refMime = inputPadding.padded || refAbs.endsWith('.png') ? 'image/png'
        : (refAbs.endsWith('.jpg') || refAbs.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
    const geometryPrompt = `${prompt ?? ''}\n\n${SOURCE_GEOMETRY_PROMPT}`
        + (inputPadding.padded
            ? ` The verified source is ${inputPadding.originalWidth}x${inputPadding.originalHeight} pixels on a ${inputPadding.width}x${inputPadding.height} canvas; the added area is padding.`
            : '');

    // Decompose. The host chain is resolved per model, because the gateway that serves seedream is
    // usually not the primary one, and `modelsBackends` is the only place that says which is which.
    let decomposition;
    try {
        decomposition = await decomposeLayers({
            client, channels, model: seedreamModel, source: { bytes: inputBytes, mime: refMime },
            prompt: geometryPrompt, coordinateFrame: inputFrame, size, maxImages: maxLayers, textRecognition: true, signal, onPoll: (data) => {
                notify?.({ type: 'measure.progress', phase: 'decomposition', status: data.status, polls: data.polls, elapsedMs: data.elapsedMs });
            }, onWarn: (message) => notify?.({ type: 'warning', message }),
        });
    } catch (error) {
        if (isContentRejection(error)) {
            // The vendor refused the picture itself. Saying so once, in plain words, is worth more than
            // a stack of retries on the same file: the answer is a property of the reference, not of
            // the request.
            const message = contentRejectionNotice(error, 'Разложение слоёв');
            warnings.push(message);
            notify?.({ type: 'warning', message });
            return { sheet: null, cropPaths, layers, warnings };
        }
        const hosts = channels?.length ? ` на ${channels.length} бэкенде(ах): ${channels.map((c) => c.label).join(', ')}` : '';
        warnings.push(`Разложение слоёв не удалось (${seedreamModel}${hosts}): ${error.message ?? String(error)}`);
        notify?.({ type: 'warning', message: `Разложение слоёв не удалось (${seedreamModel}${hosts}): ${error.message ?? String(error)}` });
        return { sheet: null, cropPaths, layers, warnings };
    }

    if (!decomposition.base && decomposition.layers.length === 0) {
        warnings.push('Разложение вернуло пустой результат.');
        return { sheet: null, cropPaths, layers, warnings };
    }

    // The boxes are read in the frame of the picture that was sent, so they are used as they arrive;
    // the base PNG the task returns is only a rescaled copy of it, and its size is worth reporting
    // because it tells the reader that the two frames of one answer are not the same picture.
    const offFrame = frameMismatch(decomposition.base?.size ?? null, inputFrame);
    if (inputPadding.padded) {
        warnings.push(`Вход Seedream локально дополнен справа и снизу с ${inputPadding.originalWidth}x${inputPadding.originalHeight} до ${inputPadding.width}x${inputPadding.height}; `
            + 'файлы ассетов будут обрезаны обратно, а боксы остаются в координатах исходного референса.');
    }
    if (offFrame) {
        warnings.push(`Базовое изображение разложения ${offFrame.width}x${offFrame.height}, кадр запроса ${inputFrame.width}x${inputFrame.height}: `
            + 'рамки не совпадают, normalized boundary boxes приведены к кадру запроса, absolute боксы остаются в исходных координатах.');
    }

    // The label is what reaches the file names, the sheet and the coder, so it stays readable ASCII.
    // A text layer is narrowed here, once, to the union of its OCR line frames: the layer's own box is
    // padded around the object and that padding is what a coder ends up writing as spacing. The tighter
    // frame is what the sheet, the layer list and the crops must all agree on.
    const named = decomposition.layers.map((layer) => {
        const lines = Array.isArray(layer.text?.lines) ? layer.text.lines : [];
        const isText = layer.text && String(layer.text.text).trim();
        const tight = isText ? textBoxUnion(lines, layer.box ?? {}) : null;
        return {
            ...layer,
            name: layerLabel(layer.name, layer.index),
            description: undefined,
            box: tight ?? layer.box,
            tightened: Boolean(tight),
            typography: isText ? typographyFromLines(lines) : null,
            text: layer.text ? { text: layer.text.text, lines: layer.text.lines } : null,
        };
    });
    const base = decomposition.base ? { ...decomposition.base, size: inputFrame } : null;

    // Download layers and save them.
    let serial = 1;
    for (const layer of named) {
        // Skip layers with no box — they are artwork fragments the measurer cannot measure.
        if (!layer.box) continue;
        const layerBytes = await downloadLayerImage(layer.url, signal);
        if (!layerBytes) {
            // No bytes available — still include the layer data for the second pass.
            warnings.push(`Слой ${layer.index} не скачан, данные для второго прохода сохранены.`);
        }

        const rel = `${cropDir}${String(serial).padStart(2, '0')}-${layerSlug(layer.name, layer.index)}.png`;
        if (layerBytes) {
            const abs = path.join(root, rel);
            await writeFile(abs, layerBytes).catch(() => {});
            await trimLayerAsset(abs, config, signal);
            cropPaths.push(rel);
        }

        // A layer without pixels still carries its box, so it stays in the list for the second pass.
        layers.push({ ...layer, localPath: layerBytes ? rel : null, bytes: layerBytes });
        serial += 1;
    }

    // Save the base image.
    const baseRel = `${cropDir}00-base.png`;
    const baseAbs = path.join(root, baseRel);
    if (base?.url) {
        const downloadedBase = await downloadLayerImage(base.url, signal);
        if (downloadedBase) {
            const restored = await unpadSeedreamOutput(downloadedBase, inputPadding, signal);
            await writeFile(baseAbs, restored).catch(() => {});
        }
        else warnings.push('Базовое изображение разложения не скачано.');
    }

    // Build partial sheet from layer geometry.
    const sheet = buildPartialSheet({ base, layers: named, ocr: decomposition.ocr ?? [], baseImageBytes: refBytes }, referencePath);
    sheet.canvas = refPixels ? { x: 0, y: 0, width: refPixels.width, height: refPixels.height } : sheet.canvas;
    if (offFrame) {
        sheet.assumptions.push(`The base image the task returned is ${offFrame.width}x${offFrame.height} while the padded request frame is `
            + `${inputFrame.width}x${inputFrame.height}; layer boxes are mapped to the original reference frame and remain approximate.`);
    }

    notify?.({ type: 'measure.pass', pass: 1, phase: 'advanced-decomposition', layers: layers.length, crops: cropPaths.length });

    return { sheet, cropPaths, layers, base, frame: refPixels, decomposition, warnings };
}

/**
 * Generate enhanced crops for specific regions using seedream-5.5 transparent generation.
 * This creates semi-transparent fragments that the measurer can inspect more closely. Every crop is
 * a paid generation (the reference is billed too), so the regions are deduplicated, clamped into the
 * frame, ordered by size and capped by `maxEnhanced`.
 * @param {{ root: string, client: object, referencePath: string, cropPaths: string[],
 *   regions: object[], maxEnhanced: number, frame?: {width:number,height:number}|null,
 *   model?: string|null, config: object, signal: AbortSignal, notify: Function }} options
 * @returns {Promise<{ enhancedPaths: string[], warnings: string[] }>}
 * @ai.hint io
 */
export async function advancedEnhanceCrops({ root, client, referencePath, cropPaths, regions = [],
    maxEnhanced = 8, frame = null, model = null, config, signal, notify }) {
    const enhancedPaths = [];
    const warnings = [];
    const seedreamModel = model || advancedImageModel(config ?? {});

    const targets = cropTargets(regions, frame, maxEnhanced);
    if (!cropPaths.length || !targets.length) return { enhancedPaths, warnings };
    // Generation is a task on this model too, so the enhanced pass walks the same host chain the
    // decomposition used instead of the synchronous images route.
    const channels = decompositionChannels(client, seedreamModel);
    const exe = await detectMagick({ magickPath: config?.magickPath ?? null });
    if (!exe) {
        warnings.push('ImageMagick не найден — улучшенные кропы не создаются, слои разложения остаются.');
        return { enhancedPaths, warnings };
    }

    let serial = 1;
    // Crop the reference to each region and ask seedream for a transparent version.
    for (const target of targets) {
        const box = target.box;
        const stamp = `${Date.now()}-${serial}`;
        try {
            const tmpOutput = `${ADVANCED_DIR}region-raw-${stamp}.png`;

            // The box is already in the reference frame, so the original file is what gets cut.
            const cropped = await magickCrop({ exe, input: referencePath, output: tmpOutput,
                x: box.x, y: box.y, width: box.width, height: box.height,
                cwd: root, signal });

            const rawBytes = await readFile(path.join(root, cropped.rel ?? tmpOutput)).catch(() => null);
            if (!rawBytes?.length) continue;

            // Generate transparent version. The task route owns both the host chain and the
            // `image_urls` field this model reads, so the crop travels as bytes and comes back as base64.
            const enhancedPadding = await padSeedreamInput(rawBytes, seedreamModel, config, signal);
            const b64 = await generateTransparentLayer({
                client, channels, model: seedreamModel,
                prompt: 'Extract the foreground object from this region with a transparent background. Remove any background, shadows, or artifacts. Keep only the object. '
                    + SOURCE_GEOMETRY_PROMPT
                    + (enhancedPadding?.padded
                        ? ` The verified source fragment is ${enhancedPadding.originalWidth}x${enhancedPadding.originalHeight} pixels on a ${enhancedPadding.width}x${enhancedPadding.height} canvas; the added area is padding.`
                        : ''),
                bytes: enhancedPadding?.bytes ?? rawBytes, mime: 'image/png', signal,
                onWarn: (message) => notify?.({ type: 'warning', message }),
            });

            if (b64?.length) {
                const enhancedRel = `${ADVANCED_DIR}enhanced-${String(serial).padStart(2, '0')}-${layerSlug(target.name, serial)}.png`;
                const enhancedAbs = path.join(root, enhancedRel);
                await mkdir(path.dirname(enhancedAbs), { recursive: true }).catch(() => {});
                const enhancedOutput = await unpadSeedreamOutput(Buffer.from(b64[0], 'base64'), enhancedPadding, signal);
                await writeFile(enhancedAbs, enhancedOutput).catch(() => {});
                await trimLayerAsset(enhancedAbs, config, signal);
                enhancedPaths.push(enhancedRel);
                serial += 1;
            }
        } catch (error) {
            if (isContentRejection(error)) {
                // The vendor's sentence arrives as a JSON body and names a prompt this pipeline never
                // sent, so it is replaced with the one line that says what happened and what follows.
                warnings.push(contentRejectionNotice(error, 'Генерация улучшенных кропов'));
                const skipped = targets.length - targets.indexOf(target) - 1;
                if (skipped > 0) warnings.push(`Улучшенных кропов не создано ещё ${skipped}: генерация остановлена после отказа модерации.`);
                break;
            }
            warnings.push(`Улучшенный кроп не создан (${target.name} ${box.x},${box.y} ${box.width}×${box.height}): ${error.message ?? String(error)}`);
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
    // The decomposition runs without a brief: `text_recognition` is on, and the vendor warns that a
    // prompt alongside it can cost the OCR — which is where the line frames and the font style come
    // from. The plan is read by the measurer in the second pass, where it belongs.
    const result = await advancedMeasurePhase1({
        root, workId, client, referencePath,
        prompt: null,
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
            frame: result.frame,
            model: seedreamModel,
            config, signal, notify,
        });
        result.cropPaths.push(...enhanced.enhancedPaths);
        result.warnings.push(...enhanced.warnings);
    }

    return result;
}
