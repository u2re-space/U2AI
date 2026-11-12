/**
 * @file src/agent/advanced.js
 * @module agent/advanced
 * @purpose Advanced decomposer mode: seedream-5.5 splits one flat screen image into layers with
 *   bounding boxes. The harness runs it in the decompose stage, over the picture the decomposer
 *   role has already restored and cut (`00-restored.png` or the first sub-reference). The layers
 *   are hints for the measurer, never measurements: the measurer verifies every box on the picture
 *   in its own passes and cuts its own crops from the reference.
 * @depends node:path, node:fs/promises, openai/seedream-5-5, shared/model-profiles,
 *   openai/images, agent/image-magick, agent/paths
 * @usedBy agent/team (decompose stage)
 * @exports canRunAdvanced, advancedImageModel, advancedDecompose,
 *   shouldUseReasoningPro, LAYER_PROMPT
 * @ai.tags decomposer, advanced, seedream, decomposition
 * @ai.hint io
 * @changed 2026-11-10 First version: crop-first decomposition, OCR-aware elements, layer boxes as
 *   measurements, enhanced transparent crops, fallback on failure.
 * @changed 2026-11-11 The seedream model is resolved from `modelsBackends` when `imageModel` names
 *   another family, and the decomposition runs as a task on that host chain.
 * @changed 2026-11-11 A measured run showed the layer boxes are areas, not measurements (padded
 *   around the object, up to a tenth of the frame off, one object returned as several layers). They
 *   are no longer rescaled by the size of the returned base image, names are ASCII, and a text layer
 *   is narrowed to the union of its `text_recognition.lines[].bounding_box`, whose frames plus
 *   `runs[].style` fill the font size, line step, weight and family.
 * @changed 2026-11-11 The moderation of the vendor refuses the redraw of somebody else's layout
 *   (`OutputImageSensitiveContentDetected.PolicyViolation` / `content_policy_violation`), which is
 *   the normal fate of a commercial reference. That class is named in the warning instead of the
 *   vendor's prose about a prompt nobody sent.
 * @changed 2026-11-12 Each downloaded layer PNG is resized to its bounding-box content size using
 *   fitLayerToBox: the API generates each layer at ~1K canvas with the same aspect as its
 *   bounding_box, so the file is down-scaled to box.width×box.height (vendor docs: "приведите слой
 *   к w×h"). The original bounding box is preserved as `bbox` (the `box` field may be tightened to
 *   OCR line frames for text layers, which is a measurement, not a crop). The decomposition carries
 *   a `TIGHT_BOX_PROMPT` so the model writes tighter bounding boxes (no square rounding, no padding).
 * @changed 2026-11-12 The whole mode moved from the measurer to the decomposer. `advancedMeasure`
 *   and `advancedMeasurePhase1` become `advancedDecompose`; the partial sheet is gone (the measurer
 *   writes the only sheet), the paid "enhanced crops" are gone (the reference redraw measured
 *   nothing), and layer PNGs are written next to the sub-references instead of a private directory.
 *   The function now returns `{ layers, base, frame, decomposition, warnings }`.
 *
 * How the advanced decomposer differs from the standard one:
 *   - standard: the role names screens and cuts one flat sub-reference per screen.
 *   - advanced: after the role is done, the harness runs seedream-5.5 over the first sub-reference
 *     and attaches the returned layers (boxes, OCR, transparent PNGs) to `decomposition.json` as
 *     `layers`. The measurer receives them as hints with the pictures attached, verifies every box,
 *     and still runs its own overview and fragment passes over the same sub-reference.
 *
 * The measurer model gets `reasoning.mode: "pro"` when it is an OpenAI GPT model and the run
 * carries layer hints — the extra reasoning power is useful over the many boxes to verify.
 */

import path from 'node:path';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { isSeedream55, decomposeLayers, downloadImageBytes, isContentRejection, contentRejectionNotice, SEEDREAM_MODEL, SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS } from '../openai/seedream-5-5.js';
import { imageModelFor } from '../openai/images.js';
import { detectMagick, magickResize, magickPadImageBytes, magickRemoveImagePadding, magickTrimImage } from './image-magick.js';
import { rasterPadImageBytes, rasterRemoveImagePadding, rasterTrim, rasterFitToSourceFrame } from './image-raster.js';
import { paddedSizeToMinPixels, paddedSizeToMinPixelsByResolution } from '../shared/images.js';
import { readImageSize, inferResolution } from '../shared/images.js';

/** Fallback directory for layer artefacts when the caller passes no `outDir`. */
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

/**
 * The wording that makes the boxes hug the object. Measured on a real answer, six of nineteen layers
 * came back as the same square 272×272 — a wide tag, a round button and a row of icons all got one
 * box size — and since every layer file is resized to its own box, a square box around a wide object
 * buys back the phantom padding the sheet was built to remove. The canvas cannot be asked for (the
 * vendor scales each layer independently), but the box is a number the model writes, so it can.
 */
const TIGHT_BOX_PROMPT = 'Report each bounding_box as the tightest rectangle that fully contains the visible pixels of that layer, '
    + 'with no margin, no padding and no allowance for shadow. Do not round a box to a square and do not widen or heighten it to a '
    + 'convenient size: a wide element gets a wide box, a tall element a tall box, and each box keeps the aspect ratio of what it frames. '
    + 'Keep every box inside the frame of the source image.';

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
 * Resize a downloaded layer PNG to its bounding-box content size.
 * The API generates each layer at a ~1K canvas with the same aspect ratio as its bounding_box,
 * so the file is down-scaled to `box.width × box.height` (vendor docs: "приведите слой к w×h").
 * The original bounding box is preserved as `bbox` in the named mapping.
 * @param {string} abs absolute path to the layer PNG (overwritten with resized result)
 * @param {{ width: number, height: number }} box the bounding-box size to fit to
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>} true when the resize succeeded
 * @ai.hint io
 */
async function fitLayerToBox(abs, box, signal) {
    const targetW = Math.round(box.width);
    const targetH = Math.round(box.height);
    if (!(targetW > 0) || !(targetH > 0)) return false;

    const bytes = await readFile(abs).catch(() => null);
    if (!bytes?.length) return false;

    const actual = readImageSize(bytes);
    if (!actual?.width || !actual?.height) return false;
    if (actual.width === targetW && actual.height === targetH) return false;

    // Aspect guard: model generates layer canvas with same aspect as bounding_box.
    // If mismatch > 5% the resize would distort content — report but still proceed.
    const srcAspect = actual.width / actual.height;
    const dstAspect = targetW / targetH;
    const aspectDiff = Math.abs(srcAspect - dstAspect) / dstAspect;
    if (aspectDiff > 0.05) {
        console.warn(`fitLayerToBox: aspect mismatch ${(aspectDiff * 100).toFixed(1)}% for ${abs} (src ${srcAspect.toFixed(3)} vs dst ${dstAspect.toFixed(3)})`);
    }

    try {
        const fitted = await rasterFitToSourceFrame({ bytes, width: targetW, height: targetH, engine: 'auto' });
        if (fitted) {
            await writeFile(abs, fitted);
            return true;
        }
    } catch { /* fall through to ImageMagick */ }

    const exe = await detectMagick({ magickPath: null });
    if (exe) {
        try {
            // '!' forces exact resize (no aspect preservation).
            // Layer canvas aspect ≈ box aspect (vendor-generated), so exact is safe.
            await magickResize({ exe, input: abs, output: abs, width: targetW, height: targetH, cwd: path.dirname(abs), signal });
            return true;
        } catch { /* fall through */ }
    }
    return false;
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
async function padSeedreamInput(bytes, model, config, signal, resolution = "auto") {
    const original = readImageSize(bytes);
    if (!original?.width || !original?.height) return null;

    if (resolution?.includes?.("x")) {
        resolution = inferResolution(original, model);
    }

    const floor = paddedSizeToMinPixelsByResolution(original, model, resolution) ?? paddedSizeToMinPixels(original, model);
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
 * Split a flat screen image into layers with bounding boxes (seedream-5.5 decomposition).
 *
 * This is the 'advanced' decomposer mode (`agent.decomposerMode`): the harness runs it over the
 * screen image the decomposer role produced — `00-restored.png` or the first sub-reference — after
 * the role has already flattened the perspective and cut the screens. It returns the layer list and
 * the raw decomposition answer; the boxes are hints for the measurer, never measurements, and the
 * measurer verifies them on the picture itself (see the measure stage in team.js).
 *
 * Nothing is generated on top of the layers: the measurer's own crop stage
 * (`stageMeasurementCrops`) cuts fragments from the reference, so a redrawn "enhanced" fragment
 * would measure nothing the layer PNG does not already say.
 *
 * @param {{ root: string, workId: string, client: object, referencePath: string,
 *   prompt?: string|null, size: string|null, maxLayers: number, model?: string|null,
 *   outDir?: string|null, config: object, signal: AbortSignal, notify: Function }} options
 * @returns {Promise<{ layers: object[], base: object|null, frame: {width:number,height:number}|null, decomposition: object|null, warnings: string[] }>}
 * @ai.hint io
 */
export async function advancedDecompose({ root, workId, client, referencePath, prompt = null,
    size = 'auto', maxLayers = 16, model = null, outDir = null, config, signal, notify }) {
    const warnings = [];
    const layers = [];
    // Layer PNGs live next to the sub-references the role wrote, so one decomposition directory
    // holds everything the next stages read.
    const cropDir = outDir ? (outDir.endsWith('/') ? outDir : `${outDir}/`) : `${ADVANCED_DIR}crops/`;
    const cropDirAbs = path.join(root, cropDir);
    await mkdir(cropDirAbs, { recursive: true }).catch(() => {});
    const seedreamModel = model || advancedImageModel(config ?? {});
    const channels = decompositionChannels(client, seedreamModel);

    // Load the reference image.
    let refAbs = referencePath;
    if (!path.isAbsolute(referencePath)) {
        const resolved = await resolveInside(root, referencePath, { allowRoot: false });
        if (resolved) refAbs = resolved.abs;
        else { warnings.push(`Референс не найден: ${referencePath}`); return { layers, base: null, frame: null, decomposition: null, warnings }; }
    }
    const statInfo = await stat(refAbs).catch(() => null);
    if (!statInfo?.isFile()) { warnings.push(`Файл референса не найден: ${refAbs}`); return { layers, base: null, frame: null, decomposition: null, warnings }; }
    const refBytes = await readFile(refAbs);
    if (refBytes.length > SEEDREAM_INPUT_MAX_BYTES) {
        warnings.push(`Референс слишком большой (${refBytes.length} байт), разложение невозможно.`);
        return { layers, base: null, frame: null, decomposition: null, warnings };
    }
    // The vendor also caps the pixel count of one input; a giant collage fails the task outright.
    const refPixels = readImageSize(refBytes);
    if (refPixels?.width && refPixels.width * refPixels.height > SEEDREAM_INPUT_MAX_PIXELS) {
        warnings.push(`Референс слишком большой (${refPixels.width}x${refPixels.height} px), разложение невозможно.`);
        return { layers, base: null, frame: null, decomposition: null, warnings };
    }

    const inputPadding = await padSeedreamInput(refBytes, seedreamModel, config, signal, size).catch((error) => {
        warnings.push(`Padding входа Seedream не выполнен: ${error.message ?? String(error)}`);
        return null;
    });
    if (!inputPadding) return { layers, base: null, frame: null, decomposition: null, warnings };
    const inputBytes = inputPadding.bytes;
    const inputFrame = { width: inputPadding.width, height: inputPadding.height };
    const refMime = inputPadding.padded || refAbs.endsWith('.png') ? 'image/png'
        : (refAbs.endsWith('.jpg') || refAbs.endsWith('.jpeg') ? 'image/jpeg' : 'image/png');
    // The canvas size cannot be asked for — the vendor scales every layer independently and
    // `fitLayerToBox` restores the content size locally. The box itself is a different matter: it is
    // a number the model writes into the JSON, and left alone it rounds them to a square. So this
    // call carries the tight-box wording only, and nothing else, because a prompt sent alongside
    // `text_recognition` can cost the OCR the sheet measures with.
    const geometryPrompt = [prompt, TIGHT_BOX_PROMPT].filter(Boolean).join('\n\n') || null;

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
            return { layers, base: null, frame: null, decomposition: null, warnings };
        }
        const hosts = channels?.length ? ` на ${channels.length} бэкенде(ах): ${channels.map((c) => c.label).join(', ')}` : '';
        warnings.push(`Разложение слоёв не удалось (${seedreamModel}${hosts}): ${error.message ?? String(error)}`);
        notify?.({ type: 'warning', message: `Разложение слоёв не удалось (${seedreamModel}${hosts}): ${error.message ?? String(error)}` });
        return { layers, base: null, frame: null, decomposition: null, warnings };
    }

    if (!decomposition.base && decomposition.layers.length === 0) {
        warnings.push('Разложение вернуло пустой результат.');
        return { layers, base: null, frame: null, decomposition: null, warnings };
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
            bbox: layer.box,
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
            // Resize the layer PNG to its bounding-box content size.
            // Vendor docs: "Каждый слой масштабируется отдельно... приведите слой к w×h".
            // The PNG canvas is ~1K with the same aspect as the box — exact downscale.
            if (layer.bbox) {
                await fitLayerToBox(abs, layer.bbox, signal).catch(() => {});
            }
            // trim only when fit was not applied — fit already gives exact content size.
            if (!layer.bbox) {
                await trimLayerAsset(abs, config, signal);
            }
        }

        // A layer without pixels still carries its box, so it stays in the list for the measurer.
        layers.push({ ...layer, localPath: layerBytes ? rel : null });
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

    notify?.({ type: 'decompose.layers', phase: 'advanced-decomposition', layers: layers.length });

    return { layers, base, frame: refPixels, decomposition, warnings };
}
