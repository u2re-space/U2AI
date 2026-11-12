/**
 * @file src/agent/shared/image-colors.js
 * @module agent/image-colors
 * @purpose Deterministic colour ground truth for measurement. Reads the actual pixels of a raster
 *   (or of one box inside it) and reports every colour in the notations a later role needs:
 *   sRGB hex, rgb(), hsl(), and OKLCH. OKLCH is the answer to the gamma problem — a model that
 *   reads a picture through a different transfer curve still agrees on OKLCH lightness, because
 *   OKLab is defined on linear light, not on the gamma-encoded bytes.
 * @depends node:fs/promises, agent/shared/kmeans, agent/shared/image-raster
 * @usedBy agent/tools (sample_colors)
 * @exports srgbToOklch, oklchCss, hslFromRgb, relLuminance, contrastRatio, sampleColors, paletteOf
 * @ai.tags colors, oklch, gamma, measurement, kmeans
 * @ai.hint io
 * @changed 2026-11-13 First version: pixel-true palette for the measurer, so colour stops being a
 *   matter of how each model happens to read the file.
 */

import { readFile } from 'node:fs/promises';
import { decodeRgba } from './image-raster.js';
import { kmeansPalette, toHex } from './kmeans.js';

// ---------------------------------------------------------------------------
// Colour space conversions (pure math, no dependency, no image I/O)
// ---------------------------------------------------------------------------

/**
 * sRGB transfer decode: gamma-encoded byte (0..255) to linear light (0..1).
 * This is the step every "same colour, different brightness" argument is really about.
 * @param {number} channel 0..255
 * @returns {number} 0..1 linear
 * @ai.hint pure
 */
function decodeSrgb(channel) {
    const c = Math.max(0, Math.min(255, channel)) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Convert an sRGB colour to OKLab, then to the OKLCH polar form.
 * Björn Ottosson's OKLab: perceptual lightness on linear light, so a model that assumes
 * a different gamma still lands on the same L when the bytes are the same.
 * @param {{ r: number, g: number, b: number }} rgb 0..255 per channel
 * @returns {{ l: number, c: number, h: number }} l 0..1, c >= 0, h in degrees
 * @ai.hint pure
 */
export function srgbToOklch(rgb) {
    const r = decodeSrgb(rgb.r);
    const g = decodeSrgb(rgb.g);
    const b = decodeSrgb(rgb.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1078255225 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const labL = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const labA = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const labB = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    const c = Math.sqrt(labA * labA + labB * labB);
    let h = Math.atan2(labB, labA) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { l: labL, c, h };
}

/**
 * The OKLCH value as a CSS declaration fragment — the notation the coder should write.
 * @param {{ l: number, c: number, h: number }} oklch
 * @param {number} [alpha=1]
 * @returns {string} e.g. `oklch(0.62 0.19 132.4)`
 * @ai.hint pure
 */
export function oklchCss(oklch, alpha = 1) {
    const l = oklch.l.toFixed(4);
    const c = oklch.c.toFixed(4);
    const h = oklch.h.toFixed(2);
    return alpha >= 1 ? `oklch(${l} ${c} ${h})` : `oklch(${l} ${c} ${h} / ${alpha.toFixed(2)})`;
}

/**
 * HSL from sRGB bytes (the notation designers quote).
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {{ h: number, s: number, l: number }} h degrees, s and l percents
 * @ai.hint pure
 */
export function hslFromRgb(rgb) {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l: l * 100 };
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * WCAG relative luminance of an sRGB colour (linear light, so gamma cannot skew it).
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {number} 0..1
 * @ai.hint pure
 */
export function relLuminance(rgb) {
    return 0.2126 * decodeSrgb(rgb.r) + 0.7152 * decodeSrgb(rgb.g) + 0.0722 * decodeSrgb(rgb.b);
}

/**
 * WCAG 2.1 contrast ratio between two colours. 21 for black on white, 1 for identical colours.
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 * @ai.hint pure
 */
export function contrastRatio(a, b) {
    const la = relLuminance(a);
    const lb = relLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Region extraction and palette
// ---------------------------------------------------------------------------

/**
 * One pixel of an RGBA frame as an rgb triple, or null when the pixel is transparent/out of frame.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame
 * @param {number} x
 * @param {number} y
 * @param {number} [alphaThreshold=128]
 * @returns {{ r: number, g: number, b: number, a: number }|null}
 * @ai.hint pure
 */
export function pixelAt(frame, x, y, alphaThreshold = 128) {
    if (!frame?.data || !frame.width || !frame.height) return null;
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) return null;
    const i = (py * frame.width + px) * 4;
    const a = frame.data[i + 3];
    if (a < alphaThreshold) return { r: 0, g: 0, b: 0, a };
    return { r: frame.data[i], g: frame.data[i + 1], b: frame.data[i + 2], a };
}

/**
 * All colours of one rectangle of the frame, with a bounded stride so a 4K box costs the same
 * as a small one. Also counts how many of the visited pixels were transparent, which is the
 * only honest way to report alpha: the ratio comes from the same stride sample as the colours.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {object} [options]
 * @param {number} [options.alphaThreshold=128]
 * @param {number} [options.maxSamples=4096]
 * @returns {{ colors: { r: number, g: number, b: number }[], visited: number, transparent: number }}
 * @ai.hint pure
 */
function sampleBox(frame, box, { alphaThreshold = 128, maxSamples = 4096 } = {}) {
    const { width: frameW, height: frameH, data } = frame || {};
    if (!data || !frameW || !frameH) return { colors: [], visited: 0, transparent: 0 };
    const x0 = Math.max(0, Math.round(box?.x ?? 0));
    const y0 = Math.max(0, Math.round(box?.y ?? 0));
    const x1 = Math.min(frameW, Math.round((box?.x ?? 0) + (box?.width ?? frameW)));
    const y1 = Math.min(frameH, Math.round((box?.y ?? 0) + (box?.height ?? frameH)));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return { colors: [], visited: 0, transparent: 0 };
    const total = w * h;
    const stride = Math.max(1, Math.floor(total / Math.max(1, maxSamples)));
    const picked = [];
    let visited = 0;
    let transparent = 0;
    for (let i = 0; i < total; i += stride) {
        const px = x0 + (i % w);
        const py = y0 + Math.floor(i / w);
        const p = (py * frameW + px) * 4;
        visited += 1;
        if (data[p + 3] >= alphaThreshold) picked.push({ r: data[p], g: data[p + 1], b: data[p + 2] });
        else transparent += 1;
    }
    return { colors: picked, visited, transparent };
}

/**
 * One colour in every notation the pipeline consumes.
 * @param {{ r: number, g: number, b: number }} rgb
 * @param {number} [share] coverage of the source area, 0..1
 * @param {number} [alpha=1]
 * @returns {object}
 * @ai.hint pure
 */
function describeColor(rgb, share = null, alpha = 1) {
    const hex = toHex(rgb);
    const hsl = hslFromRgb(rgb);
    const oklch = srgbToOklch(rgb);
    const entry = {
        hex,
        rgb: `rgb(${rgb.r} ${rgb.g} ${rgb.b})`,
        hsl: `hsl(${hsl.h.toFixed(1)} ${hsl.s.toFixed(1)}% ${hsl.l.toFixed(1)}%)`,
        oklch: oklchCss(oklch, alpha),
        luminance: Number(relLuminance(rgb).toFixed(4)),
        // OKLab lightness is the value two models disagree on least: it is computed on linear
        // light, so a wrong gamma assumption moves it far less than it moves a hex or an HSL L.
        perceptualLightness: Number(oklch.l.toFixed(4)),
    };
    if (share != null) entry.share = Number(share.toFixed(4));
    if (alpha < 1) entry.alpha = Number(alpha.toFixed(3));
    return entry;
}

/**
 * Decode a raster file into an RGBA frame.
 * @param {string} abs
 * @param {object} [options]
 * @param {string} [options.engine='auto']
 * @param {number|null} [options.maxSide=null]
 * @returns {Promise<{ width: number, height: number, data: Buffer }|null>}
 * @ai.hint io
 */
async function decode(abs, { engine = 'auto', maxSide = null } = {}) {
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) return null;
    return decodeRgba(bytes, engine, maxSide).catch(() => null);
}

/**
 * The palette of a file, or of one box inside it, read from the pixels.
 *
 * @param {{ abs: string, box?: {x:number,y:number,width:number,height:number}|null,
 *   k?: number, alphaThreshold?: number, maxSamples?: number, engine?: string,
 *   points?: Array<{x:number,y:number,label?:string}>|null }} options
 * @returns {Promise<{ canvas: {width:number,height:number}|null, colors: object[],
 *   background: object|null, border: object|null, points: object[], transparent: number,
 *   colorSpace: object, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function sampleColors({ abs, box = null, k = 5, alphaThreshold = 128, maxSamples = 8192, engine = 'auto', points = null }) {
    const warnings = [];
    const frame = await decode(abs, { engine });
    if (!frame) {
        return { canvas: null, colors: [], background: null, border: null, points: [], transparent: 0, colorSpace: null, warnings: [`Файл не декодируется: ${abs}`] };
    }
    const region = box && Number.isFinite(box.width) && Number.isFinite(box.height)
        ? box
        : { x: 0, y: 0, width: frame.width, height: frame.height };
    if (region.x < 0 || region.y < 0 || region.x + region.width > frame.width || region.y + region.height > frame.height) {
        warnings.push(`Область ${region.width}×${region.height} в (${region.x},${region.y}) выходит за кадр ${frame.width}×${frame.height}; использована часть внутри кадра.`);
    }
    const picked = sampleBox(frame, region, { alphaThreshold, maxSamples });
    if (!picked.colors.length) {
        return {
            canvas: { width: frame.width, height: frame.height }, colors: [], background: null, border: null,
            points: [], transparent: 1,
            colorSpace: colorSpaceNote(), warnings: [`В области всё прозрачное (alpha < ${alphaThreshold}): цветов нет.`],
        };
    }
    const palette = kmeansPalette(picked.colors, { k: Math.max(1, Math.min(16, k)), iterations: 12 })
        .map((c) => describeColor({ r: c.r, g: c.g, b: c.b }, c.share));

    // The plate the picture rests on: the largest cluster of the region border.
    const borderBox = {
        x: region.x, y: region.y,
        width: Math.max(1, region.width), height: Math.max(1, region.height),
    };
    const borderPicked = borderPixels(frame, borderBox, { alphaThreshold });
    const border = borderPicked.length
        ? describeColor(kmeansPalette(borderPicked, { k: 1, iterations: 6 })[0], null)
        : null;

    const sampled = Array.isArray(points) ? points.map((p) => {
        const rgb = pixelAt(frame, p?.x, p?.y, alphaThreshold);
        return {
            label: String(p?.label ?? '').trim() || `point-${p?.x},${p?.y}`,
            at: { x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0) },
            color: rgb ? describeColor(rgb, null, Number((rgb.a / 255).toFixed(3))) : null,
        };
    }) : [];

    return {
        canvas: { width: frame.width, height: frame.height },
        region: { x: region.x, y: region.y, width: region.width, height: region.height },
        colors: palette,
        background: palette[0] ?? null,
        border,
        points: sampled,
        transparentShare: picked.visited > 0 ? Number((picked.transparent / picked.visited).toFixed(3)) : 0,
        colorSpace: colorSpaceNote(),
        warnings,
    };
}

/**
 * The palette of an already decoded frame (no file I/O) — used by callers that hold the pixels.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame
 * @param {object} [options]
 * @returns {object[]}
 * @ai.hint pure
 */
export function paletteOf(frame, { box = null, k = 5, alphaThreshold = 128, maxSamples = 8192 } = {}) {
    const region = box ?? { x: 0, y: 0, width: frame?.width ?? 0, height: frame?.height ?? 0 };
    return kmeansPalette(sampleBox(frame, region, { alphaThreshold, maxSamples }).colors, { k, iterations: 12 })
        .map((c) => describeColor({ r: c.r, g: c.g, b: c.b }, c.share));
}

/**
 * Pixels along the four edges of a box — the region a flat plate always reaches.
 * @param {{ width: number, height: number, data: Buffer|Uint8Array }} frame
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {{ alphaThreshold?: number, maxSamples?: number }} [options]
 * @returns {{ r: number, g: number, b: number }[]}
 * @ai.hint pure
 */
function borderPixels(frame, box, { alphaThreshold = 128, maxSamples = 1024 } = {}) {
    const { width: frameW, height: frameH, data } = frame || {};
    if (!data || !frameW || !frameH) return [];
    const x0 = Math.max(0, Math.round(box.x));
    const y0 = Math.max(0, Math.round(box.y));
    const x1 = Math.min(frameW, Math.round(box.x + box.width));
    const y1 = Math.min(frameH, Math.round(box.y + box.height));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return [];
    const perimeter = 2 * (w + h);
    const stride = Math.max(1, Math.floor(perimeter / Math.max(1, maxSamples)));
    const picked = [];
    let seen = 0;
    const take = (x, y) => {
        const p = (y * frameW + x) * 4;
        if (data[p + 3] >= alphaThreshold && seen++ % stride === 0) {
            picked.push({ r: data[p], g: data[p + 1], b: data[p + 2] });
        }
    };
    for (let x = x0; x < x1; x++) { take(x, y0); take(x, y1 - 1); }
    for (let y = y0 + 1; y < y1 - 1; y++) { take(x0, y); take(x1 - 1, y); }
    return picked;
}

/**
 * What the numbers mean: the working colour space and the assumption a reader must share.
 * Stating it once per sheet is what removes the gamma argument — every value below is sRGB bytes,
 * and every perceptual field is derived from those bytes on linear light.
 * @returns {object}
 * @ai.hint pure
 */
function colorSpaceNote() {
    return {
        working: 'sRGB',
        encoding: 'IEC 61966-2-1 (sRGB transfer on the stored bytes)',
        hex: '#RRGGBB of the stored bytes; no profile conversion applied',
        oklch: 'OKLab/OKLCH computed on linear light (Björn Ottosson), so it is the notation two readers disagree on least',
        luminance: 'WCAG 2.1 relative luminance on linear light',
        assumption: 'The file carries no embedded ICC profile; if the source was a photo of a screen, the plate white balance is unknown and hex values are only valid inside this file',
    };
}
