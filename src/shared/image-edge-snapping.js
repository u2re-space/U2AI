/**
 * @file src/shared/image-edge-snapping.js
 * @module shared/image-edge-snapping
 * @purpose Deterministic refinement of eyeballed quad corners against real image edges.
 *
 *   A vision model's four-point corner guess is routinely 5–15 px off on a 1024 px image, and that
 *   error is what leaves 1–3° of residual tilt after a homography. The previous answer to this was a
 *   deskew rotation applied *after* the warp, which was wrong twice over: the angle it used was the
 *   tilt of the source quad — the very thing the homography had already removed — and it resampled
 *   the picture a second time.
 *
 *   This module fixes the corners instead of the output. For each of the four quad edges it walks
 *   along the eyeballed line, looks a short way to either side, records where the pixel gradient
 *   peaks, robustly fits a line through those peaks, and then re-intersects the four fitted lines.
 *   The corners land on the boundary that is actually in the file. One resample, no rotation, no
 *   guessing.
 *
 * @depends node:fs/promises, shared/image-raster
 * @usedBy shared/image-distort (perspectiveRectify)
 * @exports refineQuadByEdges
 * @ai.tags images, edge-detection, quad-refinement, homography, decomposer
 * @ai.hint io
 */

import { readFile } from 'node:fs/promises';
import { decodeRgba } from './image-raster.js';

/**
 * BT.601 luma of a decoded RGBA frame, as a single Float32 plane.
 * @param {{data: Uint8ClampedArray|Buffer, width: number, height: number}} rgba
 * @returns {Float32Array}
 * @ai.hint pure
 */
function toGrayscale({ data, width, height }) {
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
        gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return gray;
}

/**
 * Walk the segment p0→p1 and, at each step, record the perpendicular offset whose gradient
 * is strongest. Returns the pixels that the boundary actually passes through.
 *
 * The gradient component we look for is the projection of the gradient vector onto the
 * perpendicular of the eyeballed line. This is what actually changes across the boundary:
 * for a nearly horizontal edge it is |gy|, for a nearly vertical edge it is |gx|.
 * Using hypot(gx, gy) would also pick up edges parallel to the search line (e.g. horizontal
 * text lines inside a dark rectangle), which is exactly what fooled the old implementation.
 *
 * @param {Float32Array} gray grayscale image
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number}} p0
 * @param {{x:number,y:number}} p1
 * @param {number} radius — how far to either side of the eyeballed line to look
 * @param {number} threshold — the weakest gradient worth trusting
 * @returns {Array<{x:number,y:number}>}
 * @ai.hint pure
 */
export function edgePointsAlong(gray, width, height, p0, p1, radius = 18, threshold = 8) {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 2) return [];

    const ux = dx / len;
    const uy = dy / len;
    // Perpendicular unit vector: the direction we probe for the true boundary.
    const px = -uy;
    const py = ux;

    // Stay inside the frame: the ends of a photographed screen are often the least reliable part.
    const start = len * 0.15;
    const stop = len * 0.85;
    const steps = Math.max(12, Math.round((stop - start) / 2));

    const points = [];
    for (let s = 0; s <= steps; s++) {
        const along = start + ((stop - start) * s) / steps;
        const baseX = p0.x + ux * along;
        const baseY = p0.y + uy * along;

        let bestMag = 0;
        let bestOffset = 0;
        for (let r = -radius; r <= radius; r++) {
            const sx = Math.round(baseX + px * r);
            const sy = Math.round(baseY + py * r);
            if (sx <= 0 || sx >= width - 1 || sy <= 0 || sy >= height - 1) continue;

            // Central-difference gradient.
            const gx = gray[sy * width + (sx + 1)] - gray[sy * width + (sx - 1)];
            const gy = gray[(sy + 1) * width + sx] - gray[(sy - 1) * width + sx];
            // Projection of the gradient onto the perpendicular — the component that actually
            // crosses the boundary. For a horizontal edge this is |gy|; for a vertical edge it
            // is |gx|. Using hypot(gx, gy) would also pick up parallel edges (e.g. text lines
            // inside a dark rectangle) and confuse the search.
            const mag = Math.abs(gx * px + gy * py);
            if (mag > bestMag) {
                bestMag = mag;
                bestOffset = r;
            }
        }

        if (bestMag >= threshold) {
            points.push({ x: baseX + px * bestOffset, y: baseY + py * bestOffset });
        }
    }
    return points;
}

/**
 * Total-least-squares line through a point cloud, as a·x + b·y + c = 0 with a² + b² = 1, then one
 * pass of outlier rejection. Least squares (not y = kx + m) so a vertical edge is as well posed as
 * a horizontal one — three of a screen's four edges are near-vertical, which is exactly where a
 * slope-intercept fit blows up.
 *
 * @param {Array<{x:number,y:number}>} points
 * @returns {{a:number,b:number,c:number,inliers:number,meanResidual:number}|null}
 * @ai.hint pure
 */
export function fitLine(points) {
    if (points.length < 4) return null;

    const fitOnce = (pts) => {
        let cx = 0;
        let cy = 0;
        for (const p of pts) { cx += p.x; cy += p.y; }
        cx /= pts.length;
        cy /= pts.length;

        let sxx = 0;
        let sxy = 0;
        let syy = 0;
        for (const p of pts) {
            const dx = p.x - cx;
            const dy = p.y - cy;
            sxx += dx * dx;
            sxy += dx * dy;
            syy += dy * dy;
        }
        // Normal of the best-fit line = the minor eigenvector of the scatter matrix, i.e. the
        // direction the cloud is *thinnest* along.
        const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        const a = Math.sin(theta);
        const b = -Math.cos(theta);
        return { a, b, c: -(a * cx + b * cy) };
    };

    let line = fitOnce(points);
    let kept = points.filter((p) => Math.abs(line.a * p.x + line.b * p.y + line.c) <= 4);
    if (kept.length >= 4) line = fitOnce(kept);
    else kept = points;

    const residuals = kept.map((p) => Math.abs(line.a * p.x + line.b * p.y + line.c));
    const meanResidual = residuals.reduce((sum, r) => sum + r, 0) / (residuals.length || 1);

    return { ...line, inliers: kept.length, meanResidual };
}

/**
 * Intersection of two lines given as a·x + b·y + c = 0. Null when they are parallel.
 * @ai.hint pure
 */
/**
 * Intersection of a·x + b·y + c = 0 lines.
 * Cramer's rule: x = (b1·c2 − b2·c1) / det, y = (c1·a2 − c2·a1) / det.
 */
function intersect(l1, l2) {
    const det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < 1e-6) return null;
    return {
        x: (l1.b * l2.c - l2.b * l1.c) / det,
        y: (l1.c * l2.a - l2.c * l1.a) / det,
    };
}

/**
 * Snap an eyeballed quad onto the boundaries in the file.
 *
 * @param {string} imagePath — absolute path to the source image
 * @param {Array<{x:number,y:number}>} quad — corners in CORNER_ORDER, in source-image pixels
 * @param {{ sourceWidth: number, sourceHeight: number, searchRadius?: number, maxSide?: number }} options
 * @returns {Promise<{ refined: Array<{x:number,y:number}>|null, deltas: Array<{dx:number,dy:number}>,
 *   edges: object, success: boolean, reason: string }>}
 * @exports
 * @ai.hint io
 */
export async function refineQuadByEdges(imagePath, quad, { sourceWidth, sourceHeight, searchRadius = 18, maxSide = 1600 } = {}) {
    const giveUp = (reason, deltas) => ({ refined: null, deltas: deltas ?? [], edges: {}, success: false, reason });

    const bytes = await readFile(imagePath);
    const rgba = await decodeRgba(bytes, 'auto', maxSide);
    if (!rgba.width || !rgba.height) return giveUp('изображение не декодировалось');

    // The quad arrives in source pixels; the decoded plane may be downscaled. Work in the plane and
    // map back, so the refinement never depends on how the decoder chose to fit the frame.
    const kx = rgba.width / sourceWidth;
    const ky = rgba.height / sourceHeight;
    const toPlane = (p) => ({ x: p.x * kx, y: p.y * ky });
    const toSource = (p) => ({ x: p.x / kx, y: p.y / ky });

    const gray = toGrayscale(rgba);
    const [a, b, c, d] = quad.map(toPlane);

    const specs = [
        ['top', a, b],
        ['bottom', c, d],
        ['left', a, c],
        ['right', b, d],
    ];

    const edges = {};
    const fittedLines = {};

    // Collect edge pixels for each edge and fit lines.
    // A side that lies outside the frame (e.g. a phone whose bottom edge is cropped) will produce
    // zero edge pixels; in that case we fall back to the eyeballed line itself so the caller does
    // not lose the other three sides that *are* visible.
    for (const [name, p0, p1] of specs) {
        const points = edgePointsAlong(gray, rgba.width, rgba.height, p0, p1, searchRadius);
        const line = fitLine(points);
        edges[name] = { hits: points.length, inliers: line?.inliers ?? 0, residual: line ? Number(line.meanResidual.toFixed(2)) : null };

        if (!line || line.inliers < 3) {
            // No usable edge — fall back to the eyeballed line.
            const a_ = p1.y - p0.y;
            const b_ = p0.x - p1.x;
            const c_ = -(a_ * p0.x + b_ * p0.y);
            const n = Math.hypot(a_, b_) || 1;
            fittedLines[name] = { a: a_ / n, b: b_ / n, c: c_ / n, inliers: 0, meanResidual: 0 };
            edges[name].fallback = true;
            continue;
        }
        if (line.meanResidual > 1.5) {
            edges[name].fallback = true;
            const a_ = p1.y - p0.y;
            const b_ = p0.x - p1.x;
            const c_ = -(a_ * p0.x + b_ * p0.y);
            const n = Math.hypot(a_, b_) || 1;
            fittedLines[name] = { a: a_ / n, b: b_ / n, c: c_ / n, inliers: 0, meanResidual: 0 };
            continue;
        }
        fittedLines[name] = line;
    }

    // Intersect adjacent lines to get refined corners.
    const cornerPairs = [
        ['top', 'left'],
        ['top', 'right'],
        ['bottom', 'left'],
        ['bottom', 'right'],
    ];
    const refinedPlane = cornerPairs.map(([l1, l2]) => intersect(fittedLines[l1], fittedLines[l2]));
    for (let i = 0; i < 4; i++) {
        if (!refinedPlane[i]) {
            return giveUp(`стороны ${cornerPairs[i].join(' и ')} не пересекаются`, quad.map(p => ({ dx: 0, dy: 0 })));
        }
    }

    const refined = refinedPlane.map(toSource);

    // Trust the snap only while it stays near the guess. A corner that flies off has latched onto
    // some other edge in the frame — an inner card, the next phone in the collage — and the
    // eyeballed quad is the better of the two. Such a corner is put back where it was, so the
    // reported deltas and the returned quad always describe the same picture.
    const limit = Math.max(searchRadius * 2.5, 0.08 * Math.max(sourceWidth, sourceHeight));
    let rejected = 0;
    for (let i = 0; i < 4; i++) {
        if (Math.hypot(refined[i].x - quad[i].x, refined[i].y - quad[i].y) > limit) {
            refined[i] = { ...quad[i] };
            rejected += 1;
        }
    }

    const deltas = refined.map((p, i) => ({ dx: Number((p.x - quad[i].x).toFixed(2)), dy: Number((p.y - quad[i].y).toFixed(2)) }));
    const moved = deltas.some((d) => d.dx !== 0 || d.dy !== 0);
    if (!moved) return giveUp('ни один угол не сдвинулся — границы не найдены', deltas);
    if (rejected === 4) return giveUp('все четыре угла уехали слишком далеко', deltas);

    for (const name of Object.keys(edges)) delete edges[name].line;
    return {
        refined: refined.map((p) => ({ x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)) })),
        deltas,
        edges,
        success: true,
        reason: rejected ? `${rejected} угла возвращены как заданы (уехали слишком далеко)` : '',
    };
}
