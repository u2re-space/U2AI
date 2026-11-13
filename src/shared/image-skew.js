/**
 * @file src/shared/image-skew.js
 * @module shared/image-skew
 * @purpose Measure the residual rotation of an already-rectified image, without rotating anything.
 *
 *   A homography is only as good as the four corners it was given, and a vision model eyeballs
 *   those corners. The way to find out whether the output is actually upright is to measure the
 *   output, not to guess from the corners that produced it — the corners describe the *source*
 *   tilt, which the warp has already removed.
 *
 *   The measurement is the projection-profile method. A screen full of UI is rows of horizontal
 *   boundaries: text baselines, card edges, button rims. Sum the vertical-gradient energy along
 *   each row and the result is a spiky profile when the rows are level, because every boundary
 *   lands inside one row. Tilt the picture and each boundary smears across several rows, the spikes
 *   flatten, and the profile's roughness drops. So the sharpest profile is the upright orientation,
 *   and the tilt that produced the blur is the residual skew.
 *
 *   Nothing is resampled: a candidate angle is applied as an integer shear of the row starts, which
 *   is enough to locate the peak and costs no pixels. This is a measurement, not an edit.
 *
 * @depends node:fs/promises, shared/image-raster
 * @usedBy agent/tools (correct_perspective), shared/image-distort
 * @exports measureResidualSkew
 * @ai.tags images, skew, measurement, deskew, decomposer
 * @ai.hint io
 */

import { readFile } from 'node:fs/promises';
import { decodeRgba } from './image-raster.js';

/**
 * Row profile of horizontal-boundary energy after shifting row starts vertically by s(x).
 *
 * A boundary tilted by θ satisfies y = y0 + x·tanθ. Substituting the value of the *source* row at
 * each column, with s(x) = x·tanθ, collapses it onto a single row — which is exactly what makes the
 * profile spiky. Note that the displacement is a function of the column, not of the row: shearing
 * rows vertically as a function of their own y does nothing to a tilt and only invents edges.
 *
 * @param {Float32Array} gy vertical-gradient magnitude plane
 * @param {number} width
 * @param {number} height
 * @param {number} shift — signed vertical displacement of the last column relative to the first, px
 * @returns {Float32Array} mean energy per row; NaN where the shear left no valid columns
 * @ai.hint pure
 */
function shearedRowEnergy(gy, width, height, shift) {
    const energy = new Float32Array(height);
    const valid = new Uint32Array(height);
    const shearAt = (x) => Math.round((shift * x) / (width - 1));

    for (let x = 0; x < width; x++) {
        const dy = shearAt(x);
        for (let y = 0; y < height; y++) {
            const source = y + dy;
            if (source < 0 || source >= height) continue;
            energy[y] += gy[source * width + x];
            valid[y] += 1;
        }
    }
    // Average over the columns that survived the shear, so the wedges the shear pushes out of frame
    // do not read as empty rows and invent a sharpness peak of their own.
    for (let y = 0; y < height; y++) {
        energy[y] = valid[y] > 0 ? energy[y] / valid[y] : Number.NaN;
    }
    return energy;
}

/**
 * Roughness of a profile: the summed squared first difference over rows that survived the shear.
 * Peaks when the profile is spiky, which is what level rows look like.
 * @ai.hint pure
 */
function roughness(energy) {
    let sum = 0;
    let count = 0;
    for (let y = 1; y < energy.length; y++) {
        if (Number.isNaN(energy[y]) || Number.isNaN(energy[y - 1])) continue;
        const d = energy[y] - energy[y - 1];
        sum += d * d;
        count += 1;
    }
    return count > 0 ? sum / count : 0;
}

/**
 * Measure the residual tilt of an image in degrees.
 *
 * @param {string} imagePath — absolute path
 * @param {{ maxSide?: number, maxAngleDeg?: number, stepDeg?: number }} [options]
 * @returns {Promise<{ angleDeg: number, confidence: number, best: number, flat: number }>}
 *   angleDeg — how far the content is tilted: positive means it runs downhill to the right (clockwise);
 *     this is the tilt that a rotation of -angleDeg would remove.
 *   confidence — how much sharper the winning angle is than the flattest one tried, 0…1
 * @exports
 * @ai.hint io
 */
export async function measureResidualSkew(imagePath, { maxSide = 900, maxAngleDeg = 12, stepDeg = 0.1 } = {}) {
    const bytes = await readFile(imagePath);
    const rgba = await decodeRgba(bytes, 'auto', maxSide);
    const { width, height, data } = rgba;
    if (!width || !height || height < 24 || width < 24) {
        return { angleDeg: 0, confidence: 0, best: 0, flat: 0 };
    }

    // Vertical gradient only: horizontal boundaries are what we are aligning to.
    const gy = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        const up = (y - 1) * width;
        const mid = y * width;
        const down = (y + 1) * width;
        for (let x = 0; x < width; x++) {
            const a = (data[(up + x) * 4] + data[(up + x) * 4 + 1] + data[(up + x) * 4 + 2]) / 3;
            const b = (data[(down + x) * 4] + data[(down + x) * 4 + 1] + data[(down + x) * 4 + 2]) / 3;
            gy[mid + x] = Math.abs(b - a);
        }
    }

    // The shear parameter is the displacement across the frame, so a candidate angle is
    // tan(angle) = shift / (width - 1) and the angular step shrinks as the frame gets wider.
    const maxShift = Math.max(2, Math.round(Math.tan((maxAngleDeg * Math.PI) / 180) * (width - 1)));
    const shiftStep = Math.max(1, Math.round(Math.tan((stepDeg * Math.PI) / 180) * (width - 1)));

    let bestShift = 0;
    let bestScore = -1;
    let worstScore = Infinity;
    for (let shift = -maxShift; shift <= maxShift; shift += shiftStep) {
        const score = roughness(shearedRowEnergy(gy, width, height, shift));
        if (score > bestScore) { bestScore = score; bestShift = shift; }
        if (score < worstScore) worstScore = score;
    }

    const angleDeg = (Math.atan(bestShift / (width - 1)) * 180) / Math.PI;
    const confidence = bestScore > worstScore ? (bestScore - worstScore) / bestScore : 0;

    return {
        angleDeg: Number(angleDeg.toFixed(2)),
        confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(3)),
        best: bestScore,
        flat: worstScore,
    };
}
