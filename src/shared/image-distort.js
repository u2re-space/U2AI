/**
 * @file src/agent/shared/image-distort.js
 * @module agent/image-distort
 * @purpose Deterministic geometric rectification for the decomposer. A projective (homography)
 *   transform maps the four corners of a photographed or skewed screen onto an upright rectangle,
 *   pixel for pixel.
 *
 *   This exists because the alternative — asking a generation model to "remove the perspective" —
 *   is a draw from a bag. It re-renders the screen, so the text, the palette and the geometry come
 *   back wherever that sampling happened to land, and a screen that lands 3 % off is measured 3 %
 *   off. A homography is not a draw: the same four corners always produce the same rectangle, and
 *   every pixel of the source that survives the warp is the pixel that was already there.
 *
 *   Eyeballed corners are never perfect, and an early version of this module tried to pay for that
 *   by rotating the *output* to cancel the tilt it read back off the corners. That was wrong twice.
 *   The angle computed from the corners is the tilt of the *source* quad — the exact thing the
 *   homography had just removed — so the rotation put the skew back. And it resampled the picture a
 *   second time, so every retry degraded it further, while the transparent wedges a rotation opens
 *   at the corners made the next corner guess worse still. The loop of "still tilted, rectify again"
 *   ate the reference.
 *
 *   The fix is upstream: refine the corners against the boundaries that are actually in the file
 *   (shared/image-edge-snapping) and warp exactly once. The output is reported with a measured
 *   residual tilt (shared/image-skew) so the caller can see the truth instead of inferring it from
 *   the corners it typed in.
 *
 * @depends node:path, node:fs/promises, agent/shell, shared/image-magick, shared/image-raster,
 *   shared/image-edge-snapping, shared/image-skew
 * @usedBy agent/tools (correct_perspective)
 * @exports perspectiveRectify, quadToRect, solveQuadError, CORNER_ORDER
 * @ai.tags images, perspective, homography, decomposer, rectification
 * @ai.hint io
 * @changed 2026-11-13 First version: the decomposer stops gambling a restored screen on the
 *   generator and rectifies the source locally instead.
 * @changed 2026-11-13 Removed the residual deskew rotation. It measured the source quad's tilt and
 *   rotated the already-rectified output by it, which re-added the skew and resampled the file on
 *   every call; three retries destroyed the reference. Corners are now snapped to real edges before
 *   the single warp, and the output is measured rather than assumed.
 */

import path from 'node:path';
import { stat, mkdir, rename, readFile, writeFile } from 'node:fs/promises';
import { runProgram } from '../agent/shell.js';
import { detectMagick } from './image-magick.js';
import { refineQuadByEdges } from './image-edge-snapping.js';
import { measureResidualSkew } from './image-skew.js';

/**
 * The corner order this module speaks: top-left, top-right, bottom-left, bottom-right.
 * A quad in any other order describes a bow-tie, not a screen.
 */
export const CORNER_ORDER = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

/**
 * Sidecar that records where a rectified file came from.
 *
 * A rectified file is a resampled approximation of its source, so rectifying it again approximates
 * the approximation. Without a record of the chain, a caller that thinks the output "is still
 * tilted" reaches for the tool a second time on the wrong file and grinds the reference down — the
 * exact failure this module used to cause with its deskew rotation. The sidecar lets the tool say
 * "this input is already my output; go back to the original".
 */
export const PROVENANCE_SUFFIX = '.rectified.json';

/** How many warps in a row one reference may go through before the tool refuses. */
export const MAX_RECTIFY_DEPTH = 2;

/**
 * Read the provenance sidecar of a file, or null when it has none (i.e. it is an original).
 * @param {string} absPath absolute path of the image
 * @returns {Promise<{input: string, quad: Array<{x:number,y:number}>, depth: number, at: string}|null>}
 * @exports
 * @ai.hint io
 */
export async function readRectifyProvenance(absPath) {
    try {
        const raw = await readFile(`${absPath}${PROVENANCE_SUFFIX}`, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && Number.isFinite(parsed.depth) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Run one ImageMagick command, reporting its argv the way the magick module does.
 * @param {string} exe
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 * @ai.hint io
 */
async function runMagick(exe, args, { cwd, signal, timeoutMs = 60000 }) {
    const result = await runProgram({ file: exe, args, cwd, timeoutMs, maxOutputBytes: 16384, signal });
    if (result.exitCode !== 0) {
        throw new Error(`ImageMagick (${args.join(' ')}): ${result.stderr || `exit code ${result.exitCode}`}`);
    }
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/**
 * Read the pixel size of a file through ImageMagick.
 * @param {string} exe
 * @param {string} input
 * @param {{ cwd: string, signal?: AbortSignal }} options
 * @returns {Promise<{ width: number, height: number }>}
 * @ai.hint io
 */
async function identify(exe, input, { cwd, signal }) {
    const { stdout } = await runMagick(exe, [input, '-format', '%w %h', 'info:'], { cwd, signal, timeoutMs: 15000 });
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return { width: Number.isFinite(width) ? width : 0, height: Number.isFinite(height) ? height : 0 };
}

/**
 * Is a four-point quad usable as a screen outline?
 *
 * The checks are the ones that actually catch a model's bad corner guesses: points far outside the
 * frame, a quad with no area, and a quad whose winding is inverted (which is a bow-tie, not a
 * rectangle seen at an angle). A screen can legitimately extend past the photo edge, so the slack
 * is generous (30 %); the real guard is the area and winding checks.
 *
 * @param {Array<{x:number,y:number}>} quad four points in CORNER_ORDER
 * @param {{ width: number, height: number }} frame the source image size
 * @returns {{ ok: boolean, reason: string }}
 * @ai.hint pure
 */
export function quadToRect(quad, frame) {
    if (!Array.isArray(quad) || quad.length !== 4) return { ok: false, reason: 'нужно ровно четыре угла' };
    for (const point of quad) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            return { ok: false, reason: 'у каждого угла нужны числовые x и y' };
        }
    }
    // A photographed screen often runs past the photo edge, so corners outside the frame are normal.
    const slack = 0.30 * Math.max(frame.width, frame.height);
    if (quad.some((p) => p.x < -slack || p.y < -slack || p.x > frame.width + slack || p.y > frame.height + slack)) {
        return { ok: false, reason: `угол далеко за кадром ${frame.width}×${frame.height}` };
    }
    // Shoelace area: a real quad encloses area, a degenerate one does not.
    const [a, b, c, d] = quad;
    const area = Math.abs(
        (a.x * b.y - b.x * a.y) + (b.x * d.y - d.x * b.y) + (d.x * c.y - c.x * d.y) + (c.x * a.y - a.x * c.y),
    ) / 2;
    const frameArea = frame.width * frame.height;
    if (!(area > 0)) return { ok: false, reason: 'четыре угла не ограничивают площадь' };
    if (area < 0.01 * frameArea) return { ok: false, reason: 'четыре угла не ограничивают площадь' };
    // Winding: top edge must sit above the bottom edge on average, left of right on average.
    const topMid = (a.y + b.y) / 2;
    const bottomMid = (c.y + d.y) / 2;
    const leftMid = (a.x + c.x) / 2;
    const rightMid = (b.x + d.x) / 2;
    if (bottomMid <= topMid) return { ok: false, reason: 'углы перепутаны: нижняя сторона выше верхней' };
    if (rightMid <= leftMid) return { ok: false, reason: 'углы перепутаны: правая сторона левее левой' };
    return { ok: true, reason: '' };
}

/**
 * How far a quad is from being a rectangle, as the honest confidence number for the sheet.
 *
 * This describes the *source* outline: how far the photographed screen deviated from a rectangle
 * before the warp. It is not a statement about the output, and it must never be used to decide
 * whether the output needs another rotation — the homography has already removed exactly this.
 *
 * @param {Array<{x:number,y:number}>} quad four points in CORNER_ORDER
 * @returns {{ aspectError: number, skewError: number, sizeRatio: number }}
 * @ai.hint pure
 */
export function solveQuadError(quad) {
    const [a, b, c, d] = quad;
    const edge = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);
    const top = edge(a, b);
    const bottom = edge(c, d);
    const left = edge(a, c);
    const right = edge(b, d);
    const widthRatio = Math.max(top, bottom) > 0 ? Math.min(top, bottom) / Math.max(top, bottom) : 0;
    const heightRatio = Math.max(left, right) > 0 ? Math.min(left, right) / Math.max(left, right) : 0;
    const aspectError = 1 - Math.min(widthRatio, heightRatio);
    // Skew: how far the two diagonals disagree with the mid-line lengths of a rectangle.
    const midHorizontal = edge({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 });
    const midVertical = edge({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, { x: (b.x + d.x) / 2, y: (b.y + d.y) / 2 });
    const skewError = Math.max(midHorizontal, midVertical) > 0
        ? 1 - Math.min(midHorizontal, midVertical) / Math.max(midHorizontal, midVertical)
        : 1;
    const rectArea = Math.max(top, bottom) * Math.max(left, right);
    const [p, q, r, s] = [a, b, d, c];
    const quadArea = Math.abs(
        (p.x * q.y - q.x * p.y) + (q.x * s.y - s.x * q.y) + (s.x * r.y - r.x * s.y) + (r.x * p.y - p.x * r.y),
    ) / 2;
    const sizeRatio = rectArea > 0 ? quadArea / rectArea : 0;
    return {
        aspectError: Number(aspectError.toFixed(4)),
        skewError: Number(skewError.toFixed(4)),
        sizeRatio: Number(sizeRatio.toFixed(4)),
    };
}

/**
 * Rectify a quadrilateral region of an image into an upright rectangle.
 *
 * ImageMagick's `-distort Perspective` solves the 8-degree-of-freedom homography from the four
 * point pairs and resamples once. The output frame is the measured rectangle of the quad, so a
 * screen photographed at an angle comes back at its own proportions rather than the photo's.
 *
 * The corners are first snapped onto the boundaries in the file (`refine: true`), which is what
 * actually removes the tilt an eyeballed quad leaves behind. The output is warped exactly once and
 * never rotated afterwards: a rotation on top of a homography is a second resampling, and its
 * result is what the next corner guess would have to work from.
 *
 * @param {{ input: string, output: string, quad: Array<{x:number,y:number}>,
 *   cwd: string, magickPath?: string|null, signal?: AbortSignal,
 *   outputSize?: {width:number,height:number}|null, refine?: boolean, measure?: boolean }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number,
 *   engine: 'magick', quadError: object, source: {width:number,height:number},
 *   quadUsed: Array<{x:number,y:number}>, refinement: object, residual: object }>}
 * @exports
 * @ai.hint io
 */
export async function perspectiveRectify({
    input, output, quad, cwd, magickPath = null, signal = null,
    outputSize = null, refine = true, measure = true,
}) {
    const exe = await detectMagick({ magickPath });
    if (!exe) throw new Error('ImageMagick не найден: перспективная коррекция невозможна.');

    const source = await identify(exe, input, { cwd, signal });
    if (!source.width || !source.height) throw new Error(`Размеры источника не читаются: ${input}`);

    const check = quadToRect(quad, source);
    if (!check.ok) throw new Error(`Некорректный четырёхугольник: ${check.reason}`);

    // ---------------------------------------------------------------------------
    // Refuse to warp a file this tool has already warped.
    //
    // A rectified picture is a resampled approximation of its source. Warping it again
    // approximates the approximation, and the caller who cannot tell the two apart is the
    // one who reports "still tilted" and tries once more. The chain is recorded in a
    // sidecar so the second retry on the same lineage is a hard no with an instruction
    // to go back to the original file.
    // ---------------------------------------------------------------------------
    const inputAbs = path.isAbsolute(input) ? input : path.join(cwd, input);
    const cameFrom = await readRectifyProvenance(inputAbs);
    const depth = (cameFrom?.depth ?? 0) + 1;
    if (depth > MAX_RECTIFY_DEPTH) {
        throw new Error(
            `${path.basename(inputAbs)} уже выпрямлен ${depth - 1}× подряд (цепочка от ${cameFrom.input}). `
            + 'Каждый повтор приближает приближение и ничего не выравнивает. Возьмите исходный файл и '
            + 'вызовите correct_perspective один раз с точными углами; если угла не хватает — используйте '
            + 'crop_image вместо повторной проекции.',
        );
    }

    // ---------------------------------------------------------------------------
    // Snap the eyeballed corners onto the boundaries in the file, then warp once.
    // Refining the corners is what removes the residual tilt; rotating the output
    // afterwards would only add a second resampling on top of the first.
    // ---------------------------------------------------------------------------
    let quadUsed = quad;
    let refinement = { success: false, reason: 'отключено', deltas: [], edges: {} };
    if (refine) {
        try {
            const snappedResult = await refineQuadByEdges(input, quad, {
                sourceWidth: source.width, sourceHeight: source.height,
            });
            if (snappedResult.success && snappedResult.refined) {
                const snapped = snappedResult.refined.map((p) => ({ x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)) }));
                const stillValid = quadToRect(snapped, source);
                if (stillValid.ok) {
                    quadUsed = snapped;
                    refinement = snappedResult;
                } else {
                    refinement = { ...snappedResult, success: false, refined: null, reason: `уточнённый квад не прошёл проверку: ${stillValid.reason}` };
                }
            } else {
                refinement = snappedResult;
            }
        } catch (error) {
            // A failed refinement must never cost the caller the rectification it asked for.
            refinement = { success: false, reason: `уточнение не удалось: ${error.message ?? error}`, deltas: [], edges: {} };
        }
    }

    // Destination rectangle: the quad's own measured extent, unless the caller fixed the size.
    const [a, b, c, d] = quadUsed;
    const destWidth = outputSize?.width || Math.max(1, Math.round(Math.max(
        Math.hypot(b.x - a.x, b.y - a.y),
        Math.hypot(d.x - c.x, d.y - c.y),
    )));
    const destHeight = outputSize?.height || Math.max(1, Math.round(Math.max(
        Math.hypot(c.x - a.x, c.y - a.y),
        Math.hypot(d.x - b.x, d.y - b.y),
    )));

    // ImageMagick wants "srcX,srcY dstX,dstY" pairs, in the same corner order.
    const pairs = [
        [a, [0, 0]],
        [b, [destWidth, 0]],
        [c, [0, destHeight]],
        [d, [destWidth, destHeight]],
    ].map(([src, dst]) => `${src.x},${src.y} ${dst[0]},${dst[1]}`).join(' ');

    const outAbs = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outAbs), { recursive: true });

    // One resampling, written through a temporary name so a failed warp cannot leave a half-written
    // file where the caller will look for a finished one.
    const staged = `${outAbs}.warp.tmp`;
    await runMagick(exe, [
        input,
        '-filter', 'Lanczos',
        '-virtual-pixel', 'Transparent',
        '-distort', 'Perspective', pairs,
        '-background', 'none',
        // -distort already lands the quad on the destination points; crop to the exact rect and
        // reset the virtual canvas so no offset survives into the next crop.
        '-crop', `${destWidth}x${destHeight}+0+0`,
        '+repage',
        'PNG32:' + staged,
    ], { cwd, signal });
    await rename(staged, outAbs);

    const after = await identify(exe, outAbs, { cwd, signal });
    const info = await stat(outAbs).catch(() => null);

    // Record the lineage so the next caller knows this file is a warp, not a source.
    await writeFile(`${outAbs}${PROVENANCE_SUFFIX}`, JSON.stringify({
        input: path.isAbsolute(input) ? input : inputAbs,
        quad: quadUsed,
        depth,
        engine: 'magick',
        at: new Date().toISOString(),
    }, null, 2), 'utf8').catch(() => {});

    // Measure the result so the caller reads the truth about the output instead of reasoning about
    // the corners it typed in. Report-only: this module never rotates the picture.
    let residual = { angleDeg: 0, confidence: 0, measured: false };
    if (measure) {
        try {
            const skew = await measureResidualSkew(outAbs);
            residual = { ...skew, measured: true };
        } catch {
            // Measurement is a courtesy; the rectification already succeeded.
        }
    }

    return {
        rel: output,
        bytes: info?.size ?? 0,
        width: after.width || destWidth,
        height: after.height || destHeight,
        engine: 'magick',
        quadError: solveQuadError(quadUsed),
        source,
        quadUsed,
        refinement,
        residual,
        depth,
    };
}
