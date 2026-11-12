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
 * @depends node:path, node:fs/promises, agent/shell, agent/shared/image-magick
 * @usedBy agent/tools (correct_perspective)
 * @exports perspectiveRectify, quadToRect, solveQuadError, CORNER_ORDER
 * @ai.tags images, perspective, homography, decomposer, rectification
 * @ai.hint io
 * @changed 2026-11-13 First version: the decomposer stops gambling a restored screen on the
 *   generator and rectifies the source locally instead.
 */

import path from 'node:path';
import { stat, mkdir } from 'node:fs/promises';
import { runProgram } from '../agent/shell.js';
import { detectMagick } from './image-magick.js';

/**
 * The corner order this module speaks: top-left, top-right, bottom-left, bottom-right.
 * A quad in any other order describes a bow-tie, not a screen.
 */
export const CORNER_ORDER = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

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
 * The checks are the ones that actually catch a model's bad corner guesses: points outside the
 * frame, a quad with no area, and a quad whose winding is inverted (which is a bow-tie, not a
 * rectangle seen at an angle).
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
    const slack = 0.05 * Math.max(frame.width, frame.height);
    if (quad.some((p) => p.x < -slack || p.y < -slack || p.x > frame.width + slack || p.y > frame.height + slack)) {
        return { ok: false, reason: `угол вне кадра ${frame.width}×${frame.height}` };
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
 * How far a rectified quad is from being a rectangle, as the honest confidence number for the sheet.
 *
 * A true front-view export gives a rectified quad whose corners are right angles; a photo taken at
 * an angle leaves residual skew after the transform, and the measurer should know it is reading a
 * picture that had to be pulled straight.
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
 * @param {{ input: string, output: string, quad: Array<{x:number,y:number}>,
 *   cwd: string, magickPath?: string|null, signal?: AbortSignal,
 *   outputSize?: {width:number,height:number}|null }} options
 * @returns {Promise<{ rel: string, bytes: number, width: number, height: number,
 *   engine: 'magick', quadError: object, source: {width:number,height:number} }>}
 * @exports
 * @ai.hint io
 */
export async function perspectiveRectify({ input, output, quad, cwd, magickPath = null, signal = null, outputSize = null }) {
    const exe = await detectMagick({ magickPath });
    if (!exe) throw new Error('ImageMagick не найден: перспективная коррекция невозможна.');

    const source = await identify(exe, input, { cwd, signal });
    if (!source.width || !source.height) throw new Error(`Размеры источника не читаются: ${input}`);

    const check = quadToRect(quad, source);
    if (!check.ok) throw new Error(`Некорректный четырёхугольник: ${check.reason}`);

    // Destination rectangle: the quad's own measured extent, unless the caller fixed the size.
    const [a, b, c, d] = quad;
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
        'PNG32:' + output,
    ], { cwd, signal });

    const after = await identify(exe, output, { cwd, signal });
    const info = await stat(outAbs).catch(() => null);
    return {
        rel: output,
        bytes: info?.size ?? 0,
        width: after.width || destWidth,
        height: after.height || destHeight,
        engine: 'magick',
        quadError: solveQuadError(quad),
        source,
    };
}
