/**
 * @file src/agent/rectify.js
 * @module agent/rectify
 * @purpose Phase 1 of the decompose stage: run the `rectifier` role over each reference to detect
 *   and correct perspective distortion before the decomposer cuts screens from it.
 * @depends node:path, node:fs/promises, agent/paths, agent/schemas, shared/image-skew,
 *   shared/image-raster, core/attachments, commands/instructions
 * @usedBy agent/team (decompose stage, before the decomposer role)
 * @exports RECTIFIED_DIR, MAX_RESIDUAL_DEG, MIN_IMPROVEMENT_DEG, canRectify, rectifyTargets,
 *   acceptsRectification, producedScreens, validateRectifiedFile, rectifyReferences,
 *   swapReferencePaths
 * @ai.tags rectification, perspective, decomposition, images
 * @ai.hint io
 *
 * Why this is a phase and not left to the decomposer. A model eyeballing corners in the same pass
 * that names screens mixes two jobs and often lands a quad that is not the screen — the result is a
 * second warp that distorts the first. Here the geometry is handled by a dedicated role that returns
 * a quad; the harness then runs the deterministic `perspectiveRectify` (edge-snapping + single pass)
 * and verifies the result by measuring the residual tilt. If the residual is not smaller than the
 * source, the rectification is discarded and the original is kept.
 *
 * The projection is also the cut. The tool maps the quad onto a rectangle of that quad's own size,
 * so one call around one screen inside a collage returns that screen, flat, as its own file. A
 * marketing collage with three phones at different angles is therefore separated here: one call per
 * screen, and every screen that comes out level becomes a reference of its own. Nothing after this
 * stage can measure a screen out of a collage.
 *
 * @changed 2026-11-13 First version (phase 1). Distort and perspective operations are now the
 *   exclusive responsibility of the rectifier role; the decomposer only works on already-rectified
 *   references and returns the source untouched when the picture is already flat.
 * @changed 2026-11-13 Collage splitting: one call per screen, each screen becomes a separate
 *   reference in place of the collage; `swapReferencePaths` grows the list to accommodate.
 */

import path from 'node:path';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { RECTIFY_SCHEMA } from './schemas.js';
import { measureResidualSkew } from '../shared/image-skew.js';
import { rasterInfo } from '../shared/image-raster.js';
import { loadImageAttachment } from '../core/attachments.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { errorMessage } from '../util/text.js';

/** Subdirectory of the decomposition that holds rectified copies. */
export const RECTIFIED_DIR = 'rectified';

/** Residual tilt above which the output is considered still skewed. */
export const MAX_RESIDUAL_DEG = 0.8;

/** Residual tilt below which the output is considered flat enough. */
export const MIN_IMPROVEMENT_DEG = 0.4;

/**
 * Which references need rectification work. `auto` skips nothing — the role itself decides keep vs
 * rectify. `always` is the same; `off` skips the phase entirely.
 * @param {Array<{path:string,width?:number,height?:number}>} sources
 * @param {'off'|'auto'|'always'} mode
 * @param {number} maxFiles
 * @returns {Array<{path:string}>}
 * @exports
 * @ai.hint pure
 */
export function rectifyTargets(sources = [], mode = 'auto', maxFiles = 4) {
    if (mode === 'off') return [];
    return sources.slice(0, Math.max(1, maxFiles));
}

/**
 * Is the rectified output acceptable: less residual tilt than the source, or the source was flat.
 * @param {{ angleDeg:number, confidence:number, best:number, flat:number }} sourceResult
 * @param {{ angleDeg:number, confidence:number, best:number, flat:number }} result
 * @param {number} [maxDeg]
 * @param {number} [minImprovement]
 * @returns {{ ok: boolean, reason: string }}
 * @exports
 * @ai.hint pure
 */
export function acceptsRectification(
    sourceResult, result, maxDeg = MAX_RESIDUAL_DEG, minImprovement = MIN_IMPROVEMENT_DEG,
) {
    const sAngle = Math.abs(sourceResult.angleDeg);
    const rAngle = Math.abs(result.angleDeg);

    // If the measurement confidence is low on both sides, the frame has few straight boundaries —
    // a solid colour or a fine grid. In that case neither improvement nor residual is trustworthy;
    // accept by default (the source is not degraded by an extra warp).
    if (sourceResult.confidence < 0.15 && result.confidence < 0.15) {
        return { ok: true, reason: 'нет измеримых границ — исходник не ухудшён' };
    }

    // If the result is already flat enough, accept regardless of the source.
    if (rAngle <= maxDeg) {
        return { ok: true, reason: `остаток ${rAngle.toFixed(1)}° — экран ровный` };
    }

    // If the result is not flat and not improved enough, reject.
    if (rAngle >= sAngle - minImprovement) {
        return {
            ok: false,
            reason: `улучшение недостаточно: было ${sAngle.toFixed(1)}°, стало ${rAngle.toFixed(1)}° (минимум ${(sAngle - minImprovement).toFixed(1)}°)`,
        };
    }

    return { ok: true, reason: `улучшение: ${sAngle.toFixed(1)}° → ${rAngle.toFixed(1)}°` };
}

/**
 * The files the role claims to have produced, as a list.
 *
 * The schema asks for `screens[]`, one entry per screen, because a collage returns several files. A
 * model that answers in the older single-file shape (`output` + `quad` at the top level) is folded
 * into that list rather than discarded — the work is in the file it wrote, and losing a correct
 * projection to a shape mismatch would leave the skewed reference in place.
 * @param {object|null} data the parsed rectifier answer
 * @returns {Array<{label:string,output:string,quad:object|null}>}
 * @exports
 * @ai.hint pure
 */
export function producedScreens(data) {
    const list = (Array.isArray(data?.screens) ? data.screens : [])
        .map((entry) => ({
            label: String(entry?.label ?? '').trim(),
            output: String(entry?.output ?? '').trim(),
            quad: entry?.quad ?? null,
        }))
        .filter((entry) => entry.output);
    if (list.length) return list;
    const output = String(data?.output ?? '').trim();
    return output ? [{ label: '', output, quad: data?.quad ?? null }] : [];
}

/**
 * Verify that a rectified file is valid: exists, is a file, sits inside the output directory.
 * @param {string} filePath absolute path
 * @param {string} outputDir absolute path
 * @returns {Promise<{ ok: boolean, reason: string, size?: number }>}
 * @exports
 * @ai.hint io
 */
export async function validateRectifiedFile(filePath, outputDir) {
    const value = String(filePath ?? '').trim();
    if (!value) return { ok: false, reason: 'путь не указан' };
    const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(process.cwd(), value);
    if (abs !== outputDir && !abs.startsWith(outputDir + path.sep)) {
        return { ok: false, reason: `файл вне каталога выхода (${outputDir})` };
    }
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return { ok: false, reason: 'выходной файл не найден' };
    if (!info.size) return { ok: false, reason: 'выходной файл пуст' };
    return { ok: true, size: info.size };
}

/**
 * Can this run straighten anything? The projection tool is deterministic (ImageMagick + sharp), so it
 * needs the image tools switched on and no generator.
 * @param {object} config
 * @param {{images?:boolean}|null} [tools]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function canRectify(config, tools = null) {
    return (tools ?? config?.tools)?.images !== false;
}

/**
 * Ask the `rectifier` role about one reference.
 * @returns {Promise<{ data: object|null, status: string, error: string|null }>}
 */
async function askRectifier({ cwd, roles, file, frame, outDir, toolset, model, effort, maxTurns, signal }) {
    const attachment = await loadImageAttachment(file.path, { cwd, maxBytes: Number.MAX_SAFE_INTEGER });
    const result = await roles.run('rectifier', {
        text: [
            `Reference: ${file.path}`,
            `Size: ${frame.width}×${frame.height} pixels. Every coordinate you place belongs to this file.`,
            `Write any corrected file under ${outDir}/ — nowhere else, and never over the reference itself.`,
            '',
            'Say whether this picture needs a projection, and if it does, place the corners of every screen it carries',
            'and project each one separately: one correct_perspective call per screen cuts that screen out and levels',
            'it in the same step, because the tool maps your quad onto a rectangle of the quad\'s own size.',
        ].join('\n'),
        parts: [attachment.part],
        instructions: ROLE_INSTRUCTIONS.rectifier,
        schema: RECTIFY_SCHEMA,
        schemaName: 'rectifyPlan',
        maxTurns,
        toolset,
        builtin: [],
        silent: true,
        model,
        effort,
        signal,
    });
    return {
        data: result.data ?? null,
        status: result.status,
        error: result.error ? errorMessage(result.error) : null,
    };
}

/**
 * Rectify the listed references. Each rectified copy is a new file; the input is never rewritten.
 * @param {{
 *   root: string, dir: string, files: object[], roles: object, config: object,
 *   toolset: object|null, signal?: AbortSignal, notify?: (event: object) => void,
 *   model?: string|null, effort?: string|null, maxTurns?: number,
 *   maxResidualDeg?: number, minImprovementDeg?: number
 * }} options
 * @returns {Promise<{ rectified: Array<{from:string, to:string, before:number, after:number,
 *   verdict:string, assessment:string}>, kept: Array<{path:string,reason:string}>,
 *   warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function rectifyReferences({
    root, dir, files = [], roles, config, toolset = null, signal, notify = () => {},
    model: modelOverride = null, effort = null, maxTurns = 6,
    maxResidualDeg = MAX_RESIDUAL_DEG, minImprovementDeg = MIN_IMPROVEMENT_DEG,
}) {
    const rectified = [];
    const kept = [];
    const warnings = [];
    const engine = config.image?.rasterEngine ?? 'auto';
    const rectifierModel = modelOverride || config?.imageModel || null;
    const outputDir = path.join(root, dir, RECTIFIED_DIR);
    await mkdir(outputDir, { recursive: true }).catch(() => {});

    for (const file of files) {
        signal?.throwIfAborted();

        const resolved = await resolveInside(root, file.path, { allowRoot: false }).catch(() => null);
        if (!resolved) {
            kept.push({ path: file.path, reason: 'файл не найден' });
            continue;
        }
        const sourceAbs = resolved.abs;

        let frame;
        try {
            frame = await rasterInfo(sourceAbs, { cwd: root, engine });
        } catch {
            kept.push({ path: file.path, reason: 'размеры не читаются' });
            continue;
        }
        if (!frame?.width || !frame?.height) {
            kept.push({ path: file.path, reason: 'размеры не определены' });
            continue;
        }

        let plan;
        try {
            plan = await askRectifier({
                cwd: root, roles, file, frame, outDir: `${dir}/${RECTIFIED_DIR}`, toolset,
                model: rectifierModel, effort, maxTurns, signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            warnings.push(`${file.path}: rectifier не ответил (${errorMessage(error)}); кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: 'rectifier не ответил' });
            continue;
        }
        if (!plan.data) {
            warnings.push(`${file.path}: план не разобран (${plan.error ?? plan.status}); кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: plan.error ?? plan.status });
            continue;
        }
        if (plan.data.verdict !== 'rectified') {
            kept.push({ path: file.path, reason: `кадр ровный (${plan.data.assessment || 'без пояснения'})` });
            continue;
        }

        // One reference can carry several screens, and the projection cuts as it levels: each entry the
        // role names is one screen of the collage, produced by its own call. Each is verified on its
        // own pixels and accepted on its own — a collage where two of three screens came out level is
        // worth more than the collage itself, and the third screen stays inside the original file the
        // decomposer still sees.
        const produced = producedScreens(plan.data);
        if (!produced.length) {
            warnings.push(`${file.path}: verdict "rectified" без единого файла в screens — кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: 'ни одного файла в screens' });
            continue;
        }

        // The tilt of the source is measured once for the whole picture. On a collage it is a mixture of
        // every screen in it, which is why a produced screen is judged first by its own residual tilt and
        // the comparison against the source is only the fallback.
        let sourceSkew = null;
        try {
            sourceSkew = await measureResidualSkew(sourceAbs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 });
        } catch (error) {
            warnings.push(`${file.path}: наклон источника не измерен (${errorMessage(error)}); результаты принимаются без сравнения с ним.`);
        }

        const acceptedScreens = [];
        for (const entry of produced) {
            const outputRel = String(entry?.output ?? '').trim().split(path.sep).join('/');
            if (!outputRel) {
                warnings.push(`${file.path}: экран «${String(entry?.label ?? '').trim() || '(без имени)'}» без пути — не принят.`);
                continue;
            }
            // The role writes inside `<dir>/rectified/`; anything else is a path it was never given.
            const outputAbs = path.isAbsolute(outputRel) ? path.resolve(outputRel) : path.join(root, outputRel);
            const fileValid = await validateRectifiedFile(outputAbs, outputDir);
            if (!fileValid.ok) {
                warnings.push(`${file.path}: результат «${outputRel}» не принят — ${fileValid.reason}.`);
                continue;
            }
            const to = path.relative(root, outputAbs).split(path.sep).join('/');
            if (to === file.path) {
                warnings.push(`${file.path}: rectifier вернул путь исходника — исходный файл не перезаписывается.`);
                continue;
            }

            // The only honest check of a projection: the tilt still measurable in the pixels. The role
            // says it levelled the screen; this says whether the screen came back level.
            let resultSkew = null;
            try {
                resultSkew = await measureResidualSkew(outputAbs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 });
            } catch (error) {
                warnings.push(`${to}: остаточный наклон не измерен (${errorMessage(error)}) — принимается без верификации.`);
            }
            if (resultSkew && sourceSkew) {
                const accept = acceptsRectification(sourceSkew, resultSkew, maxResidualDeg, minImprovementDeg);
                if (!accept.ok) {
                    warnings.push(`${to}: экран не принят (${accept.reason}).`);
                    await unlink(outputAbs).catch(() => {});
                    continue;
                }
            }

            notify({
                type: 'decompose.rectify.file', file: to, from: file.path,
                screen: String(entry?.label ?? '').trim(),
                before: sourceSkew?.angleDeg ?? null, after: resultSkew?.angleDeg ?? null,
            });
            acceptedScreens.push({
                from: file.path, to,
                screen: String(entry?.label ?? '').trim(),
                before: sourceSkew?.angleDeg ?? null, after: resultSkew?.angleDeg ?? null,
                confidence: resultSkew?.confidence ?? null,
                assessment: plan.data.assessment ?? '',
            });
        }

        if (acceptedScreens.length) {
            rectified.push(...acceptedScreens);
        } else {
            kept.push({ path: file.path, reason: 'ни один экран не прошёл проверку наклона' });
        }
    }

    return { rectified, kept, warnings };
}

/**
 * Re-point a list of reference paths at the rectified copies.
 * Pure, and pointed at the path list rather than at a decomposition: the phase runs before the
 * decomposer has named anything, so what has to change is the set of references every later role
 * sees. One source can produce several screens — a collage is cut one quad at a time — so an entry is
 * replaced by the whole list of files produced from it, in place, and the list grows. That is safe
 * because the attachment parts are re-generated from this list by position, and every caption
 * "Attached image N" is computed from the same order.
 * @param {string[]} paths reference paths in attachment order
 * @param {Array<{from:string,to:string}>} rectified results of `rectifyReferences`
 * @returns {{ paths: string[], swapped: Array<{from:string,to:string}> }}
 * @exports
 * @ai.hint pure
 */
export function swapReferencePaths(paths = [], rectified = []) {
    if (!rectified.length) return { paths: [...paths], swapped: [] };
    const byPath = new Map();
    for (const item of rectified) {
        const from = String(item?.from ?? '').trim().split(path.sep).join('/');
        const to = String(item?.to ?? '').trim().split(path.sep).join('/');
        if (!from || !to) continue;
        if (!byPath.has(from)) byPath.set(from, []);
        const list = byPath.get(from);
        if (!list.includes(to)) list.push(to);
    }
    const swapped = [];
    const next = [];
    for (const item of paths) {
        const rel = String(item ?? '').trim().split(path.sep).join('/');
        const to = byPath.get(rel);
        if (!to) {
            next.push(item);
            continue;
        }
        for (const produced of to) {
            next.push(produced);
            swapped.push({ from: item, to: produced });
        }
    }
    return { paths: next, swapped };
}
