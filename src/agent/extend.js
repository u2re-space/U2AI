/**
 * @file src/agent/extend.js
 * @module agent/extend
 * @purpose Phase 0.5 of the decompose stage: grow a reference whose frame ends inside real content,
 *   so the projections (phase 1) have something complete to work on.
 * @depends node:path, node:fs/promises, agent/paths, agent/schemas, shared/image-raster,
 *   shared/images, core/attachments, commands/instructions
 * @usedBy agent/team (decompose stage, before the decomposer role)
 * @exports EXTENDER_FRAME, MAX_MEAN_DELTA, MAX_CHANGED_SHARE, extendTarget, regionDelta,
 *   acceptsExtension, extenderPrompt, canExtend, extendableFiles, extendReferences
 * @ai.tags extension, outpainting, decomposition, images
 * @ai.hint io
 *
 * Why this is a phase and not a side effect of the editor call. A model handed a 1024×768 reference
 * and asked for anything answers in the frame it serves — usually 1024×1024 — and quietly paints the
 * extra 256 rows with whatever it likes. That is how a reference loses its last list row and gains an
 * invented one in the same request. Here the growth is asked for on purpose, and it is bounded:
 *
 *   1. the canvas is grown locally, by transparent padding, so the original pixels are placed 1:1
 *      with no resampling and no crop;
 *   2. the `extender` role decides whether anything real is clipped and writes the instruction for the
 *      empty band — no fixed outpainting sentence is reused from one reference to the next;
 *   3. the answer is accepted only when the original area of it is the original, measured pixel by
 *      pixel. A model that redrew the picture to fit its own grid is rejected and the file is kept.
 *
 * @changed 2026-11-13 First version.
 */

import path from 'node:path';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { EXTEND_SCHEMA } from './schemas.js';
import { decodeRgba, rasterPadImageBytes } from '../shared/image-raster.js';
import { IMAGE_SIZES, imageModelFor, paddedSizeToMinPixels, sniffImage } from '../shared/images.js';
import { loadImageAttachment } from '../core/attachments.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { errorMessage } from '../util/text.js';

/** Subdirectory of the decomposition that holds the grown copies. */
export const EXTENDED_DIR = 'extended';

/** The edges a local pad can grow towards; a pad never moves the original pixels. */
const GROWABLE_EDGES = new Set(['bottom', 'right', '']);

/**
 * The contract appended to the instruction the `extender` role writes. Fixed for every reference on
 * purpose: the role says what continues into the band, and this says that the band is the only thing
 * it may touch.
 */
export const EXTENDER_FRAME = 'The attached picture is a reference image whose canvas has been made larger. '
    + 'Its original content occupies the top-left part of the frame and is already finished; the rest of the frame is empty. '
    + 'Draw only into the empty part, continuing what the edge of the original content leaves open. '
    + 'Do not move, resize, crop, rescale, sharpen, recolour or redraw anything inside the original content, and do not add a frame, a border or a watermark. '
    + 'Return the same frame size you were given, with the original content in exactly the same place.';

/**
 * A model that resamples the whole answer shifts every pixel by a fraction of a level; anything above
 * this mean difference did not come out of a paint restricted to the empty band.
 */
export const MAX_MEAN_DELTA = 3;

/** Share of original pixels allowed to differ before the answer counts as a redraw. */
export const MAX_CHANGED_SHARE = 0.01;

/**
 * The frame the editor model has to be given for this source, or null when the source already fits.
 *
 * The floor of the model decides, not a taste for squares: `paddedSizeToMinPixels` grows both sides
 * by one factor so the ratio survives, and when the model serves fixed presets instead the answer is
 * the smallest preset that still covers the source. That is the 1024×768 → 1024×1024 case.
 * @param {{width:number,height:number}} size source frame
 * @param {string|null} model
 * @returns {{width:number,height:number,from:'minPixels'|'preset'}|null}
 * @exports
 * @ai.hint pure
 */
export function extendTarget(size, model = null) {
    const width = Number(size?.width);
    const height = Number(size?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
    const padded = paddedSizeToMinPixels({ width, height }, model);
    if (padded) return { width: padded.width, height: padded.height, from: 'minPixels' };
    const covering = IMAGE_SIZES
        .map((token) => token.split('x').map(Number))
        .filter(([presetWidth, presetHeight]) => presetWidth >= width && presetHeight >= height)
        .sort((a, b) => (a[0] * a[1]) - (b[0] * b[1]))[0];
    if (!covering) return null;
    const [targetWidth, targetHeight] = covering;
    if (targetWidth === width && targetHeight === height) return null;
    return { width: targetWidth, height: targetHeight, from: 'preset' };
}

/**
 * How far the original area of an answer drifted from the original.
 * Both frames are raw RGBA of the same target size; only the top-left W×H is compared, which is where
 * the untouched content has to still sit.
 * @param {{width:number,height:number,data:Buffer}} before original RGBA
 * @param {{width:number,height:number,data:Buffer}} after answer RGBA
 * @param {number} width original width
 * @param {number} height original height
 * @returns {{meanDelta:number, changedShare:number}}
 * @exports
 * @ai.hint pure
 */
export function regionDelta(before, after, width, height) {
    let sum = 0;
    let changed = 0;
    let seen = 0;
    for (let y = 0; y < height; y++) {
        const beforeRow = y * before.width * 4;
        const afterRow = y * after.width * 4;
        for (let x = 0; x < width; x++) {
            const from = beforeRow + x * 4;
            const to = afterRow + x * 4;
            const delta = Math.abs(before.data[from] - after.data[to])
                + Math.abs(before.data[from + 1] - after.data[to + 1])
                + Math.abs(before.data[from + 2] - after.data[to + 2]);
            sum += delta / 3;
            if (delta > 12) changed += 1;
            seen += 1;
        }
    }
    return { meanDelta: seen ? sum / seen : Infinity, changedShare: seen ? changed / seen : 1 };
}

/**
 * Is the answer a grown canvas rather than a repainted reference.
 * @param {{meanDelta:number, changedShare:number}} delta
 * @param {{maxMeanDelta?:number, maxChangedShare?:number}} [limits]
 * @returns {{ok:boolean, reason:string}}
 * @exports
 * @ai.hint pure
 */
export function acceptsExtension(delta, { maxMeanDelta = MAX_MEAN_DELTA, maxChangedShare = MAX_CHANGED_SHARE } = {}) {
    if (!Number.isFinite(delta?.meanDelta)) return { ok: false, reason: 'область оригинала не читается в ответе модели' };
    if (delta.meanDelta > maxMeanDelta) {
        return { ok: false, reason: `содержимое внутри кадра изменилось (среднее расхождение ${delta.meanDelta.toFixed(1)} уровня)` };
    }
    if (delta.changedShare > maxChangedShare) {
        return { ok: false, reason: `${Math.round(delta.changedShare * 100)}% исходных пикселей отличается от оригинала` };
    }
    return { ok: true, reason: '' };
}

/** The full text sent to the editor: the role's wording about the band, then the contract. */
export function extenderPrompt(authored) {
    return `${String(authored ?? '').trim()}\n\n${EXTENDER_FRAME}`;
}

/**
 * Can this run grow anything? Needs the images API; without an editor there is nobody to ask.
 * @param {object} config
 * @param {{images?:boolean}|null} [tools]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function canExtend(config, tools = null) {
    if ((tools ?? config.tools)?.images === false) return false;
    return Boolean(config?.imageModel || config?.backends?.length || config?.imagesBackends?.length);
}

/**
 * The references worth asking about. `auto` skips a picture that already sits in a frame the editor
 * serves — growing it would add invented pixels for nothing.
 * @param {Array<{path:string,width:number,height:number}>} sources
 * @param {'off'|'auto'|'always'} mode
 * @param {string|null} model
 * @param {number} maxFiles
 * @returns {Array<{path:string,width:number,height:number,target:{width:number,height:number,from:string}}>}
 * @exports
 * @ai.hint pure
 */
export function extendableFiles(sources = [], mode = 'auto', model = null, maxFiles = 4) {
    const picked = [];
    for (const source of sources.slice(0, Math.max(1, maxFiles))) {
        const target = extendTarget(source, model);
        if (!target) {
            if (mode === 'always') picked.push({ ...source, target: null });
            continue;
        }
        picked.push({ ...source, target });
    }
    return picked;
}

/**
 * Grow the listed references. Each grown copy is a new file; the input is never rewritten, and a
 * rejected answer leaves nothing behind.
 * @param {{
 *   root: string, files: object[], roles: object, client: object, config: object,
 *   signal?: AbortSignal, notify?: (event: object) => void, model?: string|null, effort?: string|null,
 *   dir?: string, maxMeanDelta?: number, maxChangedShare?: number
 * }} options
 * The copies land in `<dir>/extended/`, the same folder the stage already keeps its derived files in —
 * never over the reference itself.
 * @returns {Promise<{ extended: Array<{from:string,to:string,edge:string,band:{width:number,height:number},prompt:string}>,
 *   kept: Array<{path:string,reason:string}>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function extendReferences({
    root, files = [], roles, client, config, signal, notify = () => {},
    model: modelOverride = null, effort = null, dir = '',
    maxMeanDelta = MAX_MEAN_DELTA, maxChangedShare = MAX_CHANGED_SHARE,
}) {
    const extended = [];
    const kept = [];
    const warnings = [];
    if (!client?.images) {
        return { extended, kept, warnings: ['Расширение пропущено: images API недоступен.'] };
    }
    const engine = config.image?.rasterEngine ?? 'auto';
    const editorModel = modelOverride || imageModelFor(config, { hasImage: true });
    const scratchAbs = path.join(root, '.tmp', `extend-${Date.now()}`);

    for (const file of files) {
        signal?.throwIfAborted();
        if (!file.target) {
            kept.push({ path: file.path, reason: 'кадр уже подходит модели' });
            continue;
        }
        const located = await resolveInside(root, file.path, { allowRoot: false }).catch(() => null);
        if (!located) {
            kept.push({ path: file.path, reason: 'файл не найден' });
            continue;
        }
        const originalBytes = await readFile(located.abs).catch(() => null);
        if (!originalBytes) {
            kept.push({ path: file.path, reason: 'файл не читается' });
            continue;
        }

        let attachment;
        try {
            attachment = await loadImageAttachment(file.path, { cwd: root, maxBytes: Number.MAX_SAFE_INTEGER });
        } catch (error) {
            warnings.push(`${file.path}: не удалось приложить роли extender (${errorMessage(error)}).`);
            kept.push({ path: file.path, reason: 'не приложен к роли' });
            continue;
        }
        const asked = await roles.run('extender', {
            text: `Reference: ${file.path}\nSize: ${file.width}×${file.height} pixels.\n`
                + 'Say whether the frame cuts real content, and write the instruction for the band that would have to be grown.',
            parts: [attachment.part],
            instructions: ROLE_INSTRUCTIONS.extender,
            schema: EXTEND_SCHEMA, schemaName: 'extendPlan', maxTurns: 1, silent: true,
            model: modelOverride, effort, signal,
        });
        const plan = asked.data;
        if (asked.status !== 'completed' || !plan) {
            warnings.push(`${file.path}: extender не дал плана (${asked.error ? errorMessage(asked.error) : asked.status}); кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: 'extender не ответил' });
            continue;
        }
        if (plan.verdict !== 'extend') {
            kept.push({ path: file.path, reason: `кадр полный (${plan.assessment || 'без пояснения'})` });
            continue;
        }
        const edge = String(plan.edge ?? '').trim().toLowerCase();
        if (!GROWABLE_EDGES.has(edge)) {
            warnings.push(`${file.path}: extender назвал край «${edge}», а канвас растётся только вправо и вниз — кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: `край ${edge} не растётся` });
            continue;
        }
        if (String(plan.prompt ?? '').trim().length < 24) {
            warnings.push(`${file.path}: extender не описал, что продолжает в полосу — кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: 'пустая инструкция' });
            continue;
        }

        const padded = await rasterPadImageBytes({
            bytes: originalBytes, engine, targetWidth: file.target.width, targetHeight: file.target.height,
        });
        if (!padded?.padded) {
            kept.push({ path: file.path, reason: 'канвас не растётся локальным движком' });
            continue;
        }
        const band = {
            width: padded.width - file.width,
            height: padded.height - file.height,
        };
        notify({
            type: 'decompose.extend', file: file.path, edge: edge || 'bottom',
            from: `${file.width}×${file.height}`, to: `${padded.width}×${padded.height}`, model: editorModel,
        });

        const paddedAbs = path.join(scratchAbs, `${path.basename(file.path, path.extname(file.path))}-padded.png`);
        const answerAbs = path.join(scratchAbs, `${path.basename(file.path, path.extname(file.path))}-grown.png`);
        try {
            await mkdir(scratchAbs, { recursive: true });
            await writeFile(paddedAbs, padded.bytes);
            const payloads = await client.images.edit({
                model: editorModel,
                prompt: extenderPrompt(plan.prompt),
                // The grown frame is asked for explicitly: without it the model answers in its own
                // default frame and the original content is rescaled to fit.
                size: `${padded.width}x${padded.height}`,
                format: config.image?.format ?? 'png', background: 'auto', signal,
                files: [{
                    filename: path.basename(paddedAbs),
                    mime: sniffImage(padded.bytes).mime,
                    bytes: padded.bytes,
                }],
            });
            if (!Array.isArray(payloads) || !payloads.length) throw new Error('модель вернула пустой ответ');
            const answerBytes = Buffer.from(payloads[0], 'base64');
            await writeFile(answerAbs, answerBytes);

            const [before, after] = await Promise.all([
                decodeRgba(originalBytes, engine),
                decodeRgba(answerBytes, engine),
            ]);
            if (after.width < file.width || after.height < file.height) {
                throw new Error(`модель вернула ${after.width}×${after.height} вместо ${padded.width}×${padded.height}`);
            }
            const delta = regionDelta(before, after, file.width, file.height);
            const accepted = acceptsExtension(delta, { maxMeanDelta, maxChangedShare });
            if (!accepted.ok) throw new Error(accepted.reason);

            const to = `${dir ? `${dir.replace(/[\/]+$/, '')}/` : ''}${EXTENDED_DIR}/${path.basename(file.path)}`;
            const targetAbs = path.join(root, ...to.split('/'));
            await mkdir(path.dirname(targetAbs), { recursive: true });
            await writeFile(targetAbs, answerBytes);
            extended.push({
                from: file.path, to, edge: edge || 'bottom', band,
                prompt: plan.prompt, assessment: plan.assessment ?? '',
                meanDelta: Number(delta.meanDelta.toFixed(3)),
            });
            notify({ type: 'decompose.extend.done', file: file.path, to, band });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            warnings.push(`${file.path}: расширение отклонено (${errorMessage(error)}) — замеры пойдут по исходному кадру.`);
            kept.push({ path: file.path, reason: errorMessage(error) });
        } finally {
            await unlink(paddedAbs).catch(() => {});
            await unlink(answerAbs).catch(() => {});
        }
    }

    await rm(scratchAbs, { recursive: true, force: true }).catch(() => {});
    return { extended, kept, warnings };
}
