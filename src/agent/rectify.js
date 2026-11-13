/**
 * @file src/agent/rectify.js
 * @module agent/rectify
 * @purpose Phase 1 of the decompose stage: run the `rectifier` role over each reference to detect
 *   and correct perspective distortion before the decomposer cuts screens from it.
 * @depends node:path, node:fs/promises, agent/paths, agent/schemas, shared/image-skew,
 *   shared/image-raster, core/attachments, commands/instructions
 * @usedBy agent/team (decompose stage, before the decomposer role)
 * @exports RECTIFIED_DIR, MAX_RESIDUAL_DEG, MIN_IMPROVEMENT_DEG, canRectify, rectifyTargets,
 *   acceptsRectification, validateRectifiedFile, rectifyReferences, swapReferencePaths
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
 * @changed 2026-11-13 First version (phase 1). Distort and perspective operations are now the
 *   exclusive responsibility of the rectifier role; the decomposer only works on already-rectified
 *   references and returns the source untouched when the picture is already flat.
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
            'Say whether this picture needs a projection, and if it does, place the corners of the screen and project once.',
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

        const outputRel = String(plan.data.output ?? '').trim().split(path.sep).join('/');
        if (!outputRel) {
            warnings.push(`${file.path}: verdict "rectified" без пути к результату — кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: 'нет выходного пути' });
            continue;
        }
        // The role writes inside `<dir>/rectified/`; anything else is a path it was never given.
        const outputAbs = path.isAbsolute(outputRel) ? path.resolve(outputRel) : path.join(root, outputRel);
        const fileValid = await validateRectifiedFile(outputAbs, outputDir);
        if (!fileValid.ok) {
            warnings.push(`${file.path}: результат «${outputRel}» не принят — ${fileValid.reason}; кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: fileValid.reason });
            continue;
        }

        const to = path.relative(root, outputAbs).split(path.sep).join('/');
        if (to === file.path) {
            warnings.push(`${file.path}: rectifier вернул путь исходника — исходный файл не перезаписывается, кадр остаётся как есть.`);
            kept.push({ path: file.path, reason: 'результат совпадает с исходником' });
            continue;
        }

        // The only honest check of a projection: the tilt still measurable in the pixels. The role
        // says it straightened the screen; this says whether the screen came back level.
        let sourceSkew = null;
        let resultSkew = null;
        try {
            [sourceSkew, resultSkew] = await Promise.all([
                measureResidualSkew(sourceAbs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 }),
                measureResidualSkew(outputAbs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 }),
            ]);
        } catch (error) {
            warnings.push(`${file.path}: остаточный наклон не измерен (${errorMessage(error)}) — результат принимается без верификации.`);
        }

        if (sourceSkew && resultSkew) {
            const accept = acceptsRectification(sourceSkew, resultSkew, maxResidualDeg, minImprovementDeg);
            if (!accept.ok) {
                warnings.push(`${file.path}: выпрямление отклонено (${accept.reason}); замеры пойдут по исходному кадру.`);
                kept.push({ path: file.path, reason: accept.reason });
                await unlink(outputAbs).catch(() => {});
                continue;
            }
        }

        notify({
            type: 'decompose.rectify', file: file.path, to,
            from: `${frame.width}×${frame.height}`,
            before: sourceSkew?.angleDeg ?? null, after: resultSkew?.angleDeg ?? null,
        });
        rectified.push({
            from: file.path, to,
            before: sourceSkew?.angleDeg ?? null, after: resultSkew?.angleDeg ?? null,
            confidence: resultSkew?.confidence ?? null,
            assessment: plan.data.assessment ?? '',
        });
        notify({ type: 'decompose.rectify.done', file: file.path, to });
    }

    return { rectified, kept, warnings };
}

/**
 * Re-point a list of reference paths at the rectified copies.
 * Pure, and pointed at the path list rather than at a decomposition: the phase runs before the
 * decomposer has named anything, so what has to change is the set of references every later role
 * sees. The index is kept — the attached image parts are matched to paths by position — so a
 * replaced path arrives as the same "Attached image N" the task captioned.
 * @param {string[]} paths reference paths in attachment order
 * @param {Array<{from:string,to:string}>} rectified results of `rectifyReferences`
 * @returns {{ paths: string[], swapped: Array<{from:string,to:string}> }}
 * @exports
 * @ai.hint pure
 */
export function swapReferencePaths(paths = [], rectified = []) {
    if (!rectified.length) return { paths: [...paths], swapped: [] };
    const byPath = new Map(rectified.map((item) => [
        String(item.from ?? '').trim().split(path.sep).join('/'), item.to,
    ]));
    const swapped = [];
    const next = paths.map((item) => {
        const rel = String(item ?? '').trim().split(path.sep).join('/');
        const to = byPath.get(rel);
        if (!to) return item;
        swapped.push({ from: item, to });
        return to;
    });
    return { paths: next, swapped };
}
