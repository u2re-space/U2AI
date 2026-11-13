/**
 * @file test/rectify.test.js
 * @purpose Covers the deterministic rectification chain: residual-tilt measurement, corner
 *   refinement against real image edges, the single-pass homography, and the crops the decomposer
 *   runs on the result.
 *
 *   These tests exist because the first version of the tool rotated its own output to "fix" a tilt
 *   it had computed from the source corners. That put the skew back and resampled the file on every
 *   call, so three retries destroyed the reference. The tests below pin the properties that make
 *   that failure impossible to reintroduce: measurement sign and accuracy, a warp that levels a
 *   known quad, corners snapped to real boundaries, no rotation of the output, and a refusal to
 *   re-warp the tool's own output.
 *
 *   The synthetic cases are built by warping a level frame with a known quad, so the expected
 *   answer is known by construction instead of eyeballed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { detectMagick, magickCrop, magickTrimImage } from '../src/shared/image-magick.js';
import { rasterCrop, rasterTrim, decodeRgba } from '../src/shared/image-raster.js';
import { measureResidualSkew } from '../src/shared/image-skew.js';
import { refineQuadByEdges, edgePointsAlong, fitLine } from '../src/shared/image-edge-snapping.js';
import {
    perspectiveRectify, CORNER_ORDER, PROVENANCE_SUFFIX, MAX_RECTIFY_DEPTH, readRectifyProvenance,
} from '../src/shared/image-distort.js';
import { createToolset } from '../src/agent/tools.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const incorrect = path.join(root, 'incorrect');
const exists = (target) => stat(target).then(() => true, () => false);

/** A frame of bright horizontal bars on a light ground: the level rows the measurement needs. */
async function makeFlatImage({ exe, dir, file = 'flat.png', width = 300, height = 600 }) {
    await run(exe, [
        '-size', `${width}x${height}`, 'xc:#f2f2f2',
        '-fill', '#111111',
        '-draw', 'rectangle 20,40 280,70 rectangle 20,140 280,165 '
               + 'rectangle 20,240 280,265 rectangle 20,340 280,365 '
               + 'rectangle 20,440 280,465 rectangle 20,520 280,545',
        file,
    ], { cwd: dir, timeout: 15000 });
    return { width, height };
}

/** Warp a level frame into a known quad, so the true corners are known by construction. */
async function makeSkewed({ exe, dir, source, quad, file = 'flat.png', out = 'skewed.png' }) {
    const pairs = [
        [quad[0], [0, 0]], [quad[1], [source.width, 0]],
        [quad[2], [0, source.height]], [quad[3], [source.width, source.height]],
    ].map(([dst, src]) => `${src[0]},${src[1]} ${dst.x},${dst.y}`).join(' ');
    await run(exe, [
        file, '-filter', 'Lanczos', '-virtual-pixel', 'White',
        '-distort', 'Perspective', pairs, '+repage', out,
    ], { cwd: dir, timeout: 15000 });
    return path.join(dir, out);
}

async function sizeOf(exe, absPath) {
    const { stdout } = await run(exe, [absPath, '-format', '%w %h', 'info:'], {
        cwd: path.dirname(absPath), timeout: 10000,
    });
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return { width, height };
}

async function cornersOf(absPath) {
    const rgba = await decodeRgba(await readFile(absPath), 'auto', null);
    const probes = [
        [1, 1], [rgba.width - 2, 1], [1, rgba.height - 2], [rgba.width - 2, rgba.height - 2],
    ];
    return probes.map(([x, y]) => ({ x, y, alpha: rgba.data[(y * rgba.width + x) * 4 + 3] }));
}

/** A quad a vision model would plausibly guess: the true one with a few pixels of error each way. */
const QUAD = [{ x: 40, y: 60 }, { x: 250, y: 25 }, { x: 20, y: 545 }, { x: 240, y: 575 }];
const EYEBALL = [{ x: 54, y: 52 }, { x: 241, y: 38 }, { x: 31, y: 533 }, { x: 224, y: 582 }];

// ---------------------------------------------------------------------------
// Residual tilt: the only honest statement the tool can make about its output
// ---------------------------------------------------------------------------

test('skew: a level frame measures as level', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-skew-'));
    try {
        await makeFlatImage({ exe, dir });
        const skew = await measureResidualSkew(path.join(dir, 'flat.png'));
        assert.ok(Math.abs(skew.angleDeg) <= 0.3, `level frame read as ${skew.angleDeg}°`);
        assert.ok(skew.confidence > 0.9, `level rows should be confident, got ${skew.confidence}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('skew: every rotation is reported with the right sign and within a third of a degree', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-skew-'));
    try {
        await makeFlatImage({ exe, dir });
        const flat = path.join(dir, 'flat.png');
        for (const angle of [0, 1, 2, 3, -2, -4, 6, -7]) {
            const rotated = path.join(dir, `rot-${String(angle).replace('-', 'm')}.png`);
            await run(exe, [flat, '-background', 'white', '-rotate', String(angle), rotated], {
                cwd: dir, timeout: 10000,
            });
            const skew = await measureResidualSkew(rotated, { maxSide: 800 });
            assert.ok(Math.abs(skew.angleDeg - angle) <= 0.35,
                `rotated ${angle}° read as ${skew.angleDeg}°`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Corner refinement: snapping an eyeballed quad onto the boundaries in the file
// ---------------------------------------------------------------------------

test('fitLine: a horizontal and a vertical line are both well posed', () => {
    const horizontal = [];
    for (let x = 0; x < 100; x++) horizontal.push({ x, y: 50 + Math.sin(x) * 0.2 });
    const h = fitLine(horizontal);
    assert.ok(h);
    assert.ok(Math.abs(h.a) < 0.05, `a=${h.a} should vanish for a horizontal line`);
    assert.ok(Math.abs(Math.abs(h.b) - 1) < 0.05, `b=${h.b} should be ±1 for a horizontal line`);

    const vertical = [];
    for (let y = 0; y < 100; y++) vertical.push({ x: 30 + Math.sin(y) * 0.2, y });
    const v = fitLine(vertical);
    assert.ok(v);
    assert.ok(Math.abs(Math.abs(v.a) - 1) < 0.05, `a=${v.a} should be ±1 for a vertical line`);
    assert.ok(Math.abs(v.b) < 0.05, `b=${v.b} should vanish for a vertical line`);
});

test('fitLine: refuses a point cloud it cannot call a line', () => {
    assert.equal(fitLine([]), null);
    assert.equal(fitLine([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), null);
});

test('edgePointsAlong: probes across the boundary, not along it', () => {
    const width = 200;
    const height = 100;
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) gray[y * width + x] = y < 50 ? 255 : 17;
    }
    const points = edgePointsAlong(gray, width, height, { x: 50, y: 50 }, { x: 150, y: 50 });
    assert.ok(points.length > 10, `found ${points.length} boundary points`);
    for (const p of points) {
        assert.ok(Math.abs(p.y - 50) <= 2, `point landed at y=${p.y.toFixed(1)}, off the boundary`);
    }
});

test('edgePointsAlong: follows the gradient across the line, not the strongest one nearby', () => {
    const width = 200;
    const height = 200;
    const gray = new Float32Array(width * height);
    // A vertical outline at x=100, and horizontal bars across the whole frame that out-contrast
    // it. Searching for the gradient magnitude locked onto the bars; searching for the component
    // across the search line can only see the outline, because the bars run along the search.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const side = x < 100 ? 255 : 17;
            gray[y * width + x] = y % 10 < 4 ? Math.max(side, 250) : side;
        }
    }
    const points = edgePointsAlong(gray, width, height, { x: 100, y: 30 }, { x: 100, y: 170 }, 18);
    assert.ok(points.length > 10, `found ${points.length} boundary points`);
    for (const p of points) {
        assert.ok(Math.abs(p.x - 100) <= 2, `point landed at x=${p.x.toFixed(1)}, off the outline`);
    }
});

test('refineQuadByEdges: pulls an eyeballed quad onto the true corners', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-snap-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });
        const refined = await refineQuadByEdges(skewed, EYEBALL, {
            sourceWidth: source.width, sourceHeight: source.height,
        });
        assert.ok(refined.success, `refinement refused: ${refined.reason}`);
        for (let i = 0; i < 4; i++) {
            const before = Math.hypot(EYEBALL[i].x - QUAD[i].x, EYEBALL[i].y - QUAD[i].y);
            const after = Math.hypot(refined.refined[i].x - QUAD[i].x, refined.refined[i].y - QUAD[i].y);
            assert.ok(after <= 8, `corner ${i} landed ${after.toFixed(1)}px from the true corner`);
            assert.ok(after < before, `corner ${i} moved away: ${before.toFixed(1)}px → ${after.toFixed(1)}px`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('refineQuadByEdges: keeps the sides it can see when a side is cropped out of frame', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-snap-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });
        // Bottom corners pushed below the frame, as when a phone runs off the photo.
        const cropped = [{ x: 42, y: 57 }, { x: 248, y: 28 }, { x: 14, y: 640 }, { x: 244, y: 668 }];
        const refined = await refineQuadByEdges(skewed, cropped, {
            sourceWidth: source.width, sourceHeight: source.height,
        });
        assert.ok(refined.success, `one cropped side must not sink the refinement: ${refined.reason}`);
        assert.ok(refined.edges.bottom.fallback, 'the side outside the frame should fall back to the guess');
        for (const i of [0, 1]) {
            const error = Math.hypot(refined.refined[i].x - QUAD[i].x, refined.refined[i].y - QUAD[i].y);
            assert.ok(error <= 4, `visible corner ${i} landed ${error.toFixed(1)}px off`);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('refineQuadByEdges: declines to refine a frame with no boundaries in it', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-snap-'));
    try {
        await run(exe, ['-size', '400x400', 'xc:white', 'blank.png'], { cwd: dir, timeout: 10000 });
        const refined = await refineQuadByEdges(path.join(dir, 'blank.png'), [
            { x: 50, y: 50 }, { x: 350, y: 50 }, { x: 50, y: 350 }, { x: 350, y: 350 },
        ], { sourceWidth: 400, sourceHeight: 400 });
        assert.equal(refined.success, false, 'a blank frame has nothing to snap to');
        assert.equal(refined.refined, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('refineQuadByEdges: the reported deltas describe the quad it actually returns', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-snap-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });
        const refined = await refineQuadByEdges(skewed, EYEBALL, {
            sourceWidth: source.width, sourceHeight: source.height,
        });
        assert.ok(refined.success);
        for (let i = 0; i < 4; i++) {
            assert.equal(refined.deltas[i].dx, Number((refined.refined[i].x - EYEBALL[i].x).toFixed(2)));
            assert.equal(refined.deltas[i].dy, Number((refined.refined[i].y - EYEBALL[i].y).toFixed(2)));
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The warp itself
// ---------------------------------------------------------------------------

test('rectify: a true quad levels the picture exactly', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });
        const out = path.join(dir, 'out.png');
        const result = await perspectiveRectify({ input: skewed, output: out, quad: QUAD, cwd: dir, refine: false });

        assert.equal(result.engine, 'magick');
        assert.equal(result.refinement.success, false, 'refine=false must not touch the quad');
        assert.deepEqual(result.quadUsed, QUAD);
        assert.ok(result.residual.measured, 'the output must be measured, not assumed');
        assert.ok(Math.abs(result.residual.angleDeg) <= 0.5,
            `a true quad left ${result.residual.angleDeg}° of tilt`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: refinement is what saves an eyeballed quad', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });

        const raw = await perspectiveRectify({
            input: skewed, output: path.join(dir, 'raw.png'), quad: EYEBALL, cwd: dir, refine: false,
        });
        const snapped = await perspectiveRectify({
            input: skewed, output: path.join(dir, 'snapped.png'), quad: EYEBALL, cwd: dir, refine: true,
        });

        assert.ok(Math.abs(raw.residual.angleDeg) > 1,
            `the eyeballed quad should leave a visible tilt, measured ${raw.residual.angleDeg}°`);
        assert.ok(snapped.refinement.success);
        assert.ok(Math.abs(snapped.residual.angleDeg) <= 1,
            `refined corners should level it, measured ${snapped.residual.angleDeg}°`);
        assert.ok(Math.abs(snapped.residual.angleDeg) < Math.abs(raw.residual.angleDeg),
            `refinement made it worse: ${raw.residual.angleDeg}° → ${snapped.residual.angleDeg}°`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: never rotates — the output keeps the wedge-free corners a warp gives it', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });
        const out = path.join(dir, 'out.png');
        const result = await perspectiveRectify({ input: skewed, output: out, quad: QUAD, cwd: dir, refine: false });

        // A homography maps the quad onto the whole destination rectangle, so every corner of the
        // output is filled. Rotating afterwards opens transparent wedges — the fingerprint of the
        // deskew step this module used to run.
        for (const corner of await cornersOf(out)) {
            assert.ok(corner.alpha > 200,
                `corner (${corner.x},${corner.y}) alpha=${corner.alpha}; a rotation would leave a wedge`);
        }
        assert.ok(result.width > 0 && result.height > 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: refuses to warp its own output a third time', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-'));
    try {
        await makeFlatImage({ exe, dir });
        const square = [{ x: 0, y: 0 }, { x: 299, y: 0 }, { x: 0, y: 599 }, { x: 299, y: 599 }];
        const first = path.join(dir, 'one.png');
        const second = path.join(dir, 'two.png');
        const third = path.join(dir, 'three.png');

        const r1 = await perspectiveRectify({ input: path.join(dir, 'flat.png'), output: first, quad: square, cwd: dir, refine: false });
        assert.equal(r1.depth, 1);
        const r2 = await perspectiveRectify({ input: first, output: second, quad: square, cwd: dir, refine: false });
        assert.equal(r2.depth, MAX_RECTIFY_DEPTH);

        await assert.rejects(
            perspectiveRectify({ input: second, output: third, quad: square, cwd: dir, refine: false }),
            /выпрямлен|цепочк/,
            'a third generation of one lineage must be refused, not silently degraded',
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: records where the file came from', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-'));
    try {
        await makeFlatImage({ exe, dir });
        const square = [{ x: 0, y: 0 }, { x: 299, y: 0 }, { x: 0, y: 599 }, { x: 299, y: 599 }];
        const out = path.join(dir, 'out.png');
        await perspectiveRectify({ input: path.join(dir, 'flat.png'), output: out, quad: square, cwd: dir, refine: false });

        const sidecar = JSON.parse(await readFile(`${out}${PROVENANCE_SUFFIX}`, 'utf8'));
        assert.equal(sidecar.depth, 1);
        assert.equal(sidecar.quad.length, 4);
        assert.match(sidecar.input, /flat\.png$/);

        assert.equal((await readRectifyProvenance(out)).depth, 1);
        assert.equal(await readRectifyProvenance(path.join(dir, 'flat.png')), null, 'an original has no lineage');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: leaves no scratch files behind', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-'));
    try {
        await makeFlatImage({ exe, dir });
        const square = [{ x: 0, y: 0 }, { x: 299, y: 0 }, { x: 0, y: 599 }, { x: 299, y: 599 }];
        await perspectiveRectify({ input: path.join(dir, 'flat.png'), output: path.join(dir, 'out.png'), quad: square, cwd: dir, refine: false });

        const leftovers = (await readdir(dir)).filter((f) => /tmp|deskew/.test(f));
        assert.deepEqual(leftovers, [], `scratch files survived: ${leftovers.join(', ')}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('CORNER_ORDER is the order the whole chain speaks', () => {
    assert.deepEqual([...CORNER_ORDER], ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
});

// ---------------------------------------------------------------------------
// The real mockups the failure was seen on
// ---------------------------------------------------------------------------

test('rectify: the transfer screen that survived three retries comes out level', async (t) => {
    const src = path.join(incorrect, 'app.png');
    if (!await exists(src)) return t.skip('incorrect/app.png is not present');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-real-'));
    try {
        // The corners the model settled on after three attempts, bottom edge past the frame.
        const eyeballed = [
            { x: 698, y: 112 }, { x: 1009, y: 140 },
            { x: 584, y: 768 }, { x: 872, y: 823 },
        ];
        const raw = await perspectiveRectify({
            input: src, output: path.join(dir, 'raw.png'), quad: eyeballed, cwd: root, refine: false,
        });
        const snapped = await perspectiveRectify({
            input: src, output: path.join(dir, 'snapped.png'), quad: eyeballed, cwd: root, refine: true,
        });
        assert.ok(Math.abs(snapped.residual.angleDeg) <= 1.5,
            `the corrected transfer screen measured ${snapped.residual.angleDeg}°`);
        assert.ok(Math.abs(snapped.residual.angleDeg) < Math.abs(raw.residual.angleDeg),
            `refinement did not help on the real screen: ${raw.residual.angleDeg}° → ${snapped.residual.angleDeg}°`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the mockups the deskew bug produced really are tilted', async (t) => {
    const names = ['01-onboarding.png', '02-dashboard.png', '03-transfer-rectified.png'];
    const present = [];
    for (const name of names) {
        if (await exists(path.join(incorrect, name))) present.push(name);
    }
    if (!present.length) return t.skip('no incorrect/*.png samples are present');
    for (const name of present) {
        const skew = await measureResidualSkew(path.join(incorrect, name));
        assert.ok(Math.abs(skew.angleDeg) > 1,
            `${name} came out of the deskew loop and should still read as tilted, measured ${skew.angleDeg}°`);
    }
});

// ---------------------------------------------------------------------------
// Cropping: what the decomposer does with a rectified screen
// ---------------------------------------------------------------------------

test('crop: a box crop returns exactly the box', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-crop-'));
    try {
        await makeFlatImage({ exe, dir });
        const src = path.join(dir, 'flat.png');

        const viaMagick = path.join(dir, 'magick.png');
        const cropped = await magickCrop({ exe, input: src, output: viaMagick, x: 10, y: 20, width: 50, height: 80, cwd: dir });
        assert.equal(cropped.rel, viaMagick);
        assert.deepEqual(await sizeOf(exe, viaMagick), { width: 50, height: 80 });

        const viaRaster = path.join(dir, 'raster.png');
        const raster = await rasterCrop({ input: src, output: viaRaster, x: 15, y: 25, width: 40, height: 60, cwd: dir });
        assert.deepEqual({ width: raster.width, height: raster.height }, { width: 40, height: 60 });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('trim: uniform padding is cut by both engines', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-crop-'));
    try {
        await run(exe, [
            '-size', '400x400', 'xc:white', '-fill', 'black', '-draw', 'rectangle 120,100 280,300', 'pad.png',
        ], { cwd: dir, timeout: 10000 });
        const src = path.join(dir, 'pad.png');

        const byMagick = await magickTrimImage({ exe, input: src, output: path.join(dir, 'm.png'), cwd: dir, fuzz: 6 });
        assert.ok(byMagick.changed, `magick trim: ${byMagick.reason}`);
        assert.ok(byMagick.after.width < byMagick.before.width);
        assert.ok(byMagick.after.height < byMagick.before.height);

        const byRaster = await rasterTrim({ input: src, output: path.join(dir, 'r.png'), cwd: dir, fuzz: 6 });
        assert.ok(byRaster.changed, `raster trim: ${byRaster.reason}`);
        assert.ok(byRaster.after.width < byRaster.before.width);
        assert.ok(byRaster.after.height < byRaster.before.height);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a rectified screen survives being cropped, and stays level', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-crop-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });
        const rectified = path.join(dir, 'rectified.png');
        const result = await perspectiveRectify({ input: skewed, output: rectified, quad: QUAD, cwd: dir, refine: true });

        const cut = path.join(dir, 'cut.png');
        await magickCrop({
            exe, input: rectified, output: cut, x: 4, y: 4,
            width: result.width - 8, height: result.height - 8, cwd: dir,
        });
        for (const corner of await cornersOf(cut)) {
            assert.ok(corner.alpha > 200, `cropped corner (${corner.x},${corner.y}) alpha=${corner.alpha}`);
        }
        const skew = await measureResidualSkew(cut);
        assert.ok(Math.abs(skew.angleDeg) <= 1, `a crop of a level screen read as ${skew.angleDeg}°`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

/**
 * The same chain seen through the tools the decomposer actually calls, because the library tests
 * above cannot catch a tool that answers "ok" while writing a broken file, nor a crop that fails
 * only once it goes through the tool's own engine fallback.
 */
test('the correct_perspective tool levels the frame and stops the retry loop', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-tool-'));
    try {
        const source = await makeFlatImage({ exe, dir });
        const skewed = await makeSkewed({ exe, dir, source, quad: QUAD });

        const toolset = createToolset({
            root: dir, names: ['correct_perspective', 'crop_image'], approvalLevel: 'read',
            allowWrite: ['correct_perspective', 'crop_image'], config: { limits: {} },
        });
        const relative = path.relative(dir, skewed).split(path.sep).join('/');
        const corners = JSON.stringify(QUAD);
        // The toolset takes the wire shape the model emits, so the test exercises the same parse.
        const call = (name, args) => toolset.execute({ name, arguments: JSON.stringify(args) });

        const first = await call('correct_perspective', {
            path: relative, corners_json: corners, output: '.tmp/step1.png', reason: 'test',
        });
        assert.ok(first.ok, `first call failed: ${first.output}`);
        assert.match(first.output, /Наклон выхода измерен/, first.output);

        const step1 = path.join(dir, '.tmp', 'step1.png');
        assert.ok(await exists(step1), 'the tool reported success without writing the file');
        const measured = await measureResidualSkew(step1);
        assert.ok(Math.abs(measured.angleDeg) <= 1, `tool output still tilts ${measured.angleDeg}°`);

        /* A crop of the warped file has to keep working: it previously fell through to a magick
           trim whose command line was invalid, and the tool answered "padding not removed". */
        const square = await sizeOf(exe, step1);
        const cut = await call('crop_image', {
            path: '.tmp/step1.png', x: 3, y: 4, width: square.width - 6, height: square.height - 8,
            output: '.tmp/cut.png', reason: 'test',
        });
        assert.ok(cut.ok, `crop of the rectified file failed: ${cut.output}`);
        assert.match(cut.output, /Обрезано/, cut.output);

        /* Chaining is what destroyed the references. One correction of a corrected file is still
           allowed, the one after it has to be refused instead of degrading the picture again. */
        const cornersOfOutput = JSON.stringify([
            { x: 0, y: 0 }, { x: square.width - 1, y: 0 },
            { x: 0, y: square.height - 1 }, { x: square.width - 1, y: square.height - 1 },
        ]);
        const second = await call('correct_perspective', {
            path: '.tmp/step1.png', corners_json: cornersOfOutput, output: '.tmp/step2.png', reason: 'test',
        });
        assert.ok(second.ok, `second pass should still be allowed: ${second.output}`);

        const third = await call('correct_perspective', {
            path: '.tmp/step2.png', corners_json: cornersOfOutput, output: '.tmp/step3.png', reason: 'test',
        });
        assert.ok(!third.ok, `a third warp of the same chain was allowed:\n${third.output}`);
        assert.match(third.output, /уже выпрямлен/, third.output);
        assert.ok(!(await exists(path.join(dir, '.tmp', 'step3.png'))), 'the refused call still wrote a file');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

/**
 * A frame that already carries transparent wedges is the output of some earlier destructive edit,
 * and its wedge edges are straight — straight enough for corner refinement to snap onto them and
 * report a clean fit while rectifying the damage instead of the screen. The tool has to say so.
 */
test('correct_perspective warns when the input already carries cut-out regions', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-warn-'));
    try {
        await makeFlatImage({ exe, dir, file: 'flat.png' });
        // The same mistake the deskew bug made: rotate over a transparent background.
        await run(exe, ['flat.png', '-background', 'none', '-rotate', '4', '+repage', 'wedge.png'],
            { cwd: dir, timeout: 15000 });

        const toolset = createToolset({
            root: dir, names: ['correct_perspective'], approvalLevel: 'read',
            allowWrite: ['correct_perspective'], config: { limits: {} },
        });
        const call = (args) => toolset.execute({ name: 'correct_perspective', arguments: JSON.stringify(args) });
        const quad = JSON.stringify([
            { x: 10, y: 40 }, { x: 285, y: 40 }, { x: 10, y: 560 }, { x: 285, y: 560 },
        ]);

        const damaged = await call({
            path: 'wedge.png', corners_json: quad, output: '.tmp/d.png', reason: 'test',
        });
        assert.ok(damaged.ok, damaged.output);
        assert.match(damaged.output, /уже есть прозрачные области/, 'transparent wedges went unreported');
        assert.match(damaged.output, /Бери файл до правки/, 'the warning did not name the way out');

        const clean = await call({
            path: 'flat.png', corners_json: quad, output: '.tmp/c.png', reason: 'test',
        });
        assert.ok(clean.ok, clean.output);
        assert.doesNotMatch(clean.output, /уже есть прозрачные области/, 'a clean frame was warned about');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
