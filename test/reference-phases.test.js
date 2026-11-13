/**
 * @file test/reference-phases.test.js
 * @purpose Covers the three reference phases that run inside the decompose stage: the frame grown
 *   (phase 0.5), the projection applied (phase 1), the sub-reference repaired (phase 1.5).
 *
 *   Each phase replaces a picture that later roles measure, so the tests pin the part that decides
 *   whether a replacement is allowed: which frames are worth asking about, when an answer counts as
 *   the same picture and not a redraw, and which of the role's own numbers are trusted. The generative
 *   half is stubbed — these tests are about the harness refusing a bad answer, not about what a model
 *   returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    acceptsExtension, canExtend, extendTarget, extendableFiles, regionDelta, extenderPrompt, EXTENDER_FRAME,
} from '../src/agent/extend.js';
import {
    acceptsRectification, canRectify, rectifyReferences, rectifyTargets, swapReferencePaths,
    validateRectifiedFile, RECTIFIED_DIR,
} from '../src/agent/rectify.js';
import { applyRepairs, restorableFiles } from '../src/agent/restore.js';
import { MIN_FRAGMENT_SIDE, editorPrompt, pickPatches, planFragment } from '../src/agent/restore-plan.js';
import { toolNamesForRole } from '../src/agent/team.js';
import { enabledToolNames } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';

// A 1×1 transparent-free PNG: enough for the attachment loader, which only sniffs the header.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
);

const rgba = (width, height, fill) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = fill[0];
        data[i * 4 + 1] = fill[1];
        data[i * 4 + 2] = fill[2];
        data[i * 4 + 3] = 255;
    }
    return { width, height, data };
};

// ---------------------------------------------------------------------------
// Phase 0.5: the frame that ends inside real content
// ---------------------------------------------------------------------------

test('extend: the frame asked of the editor is the model floor, not a square taste', () => {
    // 1024×768 is the case the phase exists for: the editor serves 1024×1024 and paints the extra
    // 256 rows unless the larger frame is asked for on purpose.
    assert.deepEqual(extendTarget({ width: 1024, height: 768 }, null), { width: 1024, height: 1024, from: 'preset' });
    assert.equal(extendTarget({ width: 1024, height: 1024 }, null), null, 'a frame the model already serves is left alone');
    assert.equal(extendTarget({ width: 0, height: 10 }), null);
    assert.equal(extendTarget(null), null);
});

test('extend: auto asks only about a frame that cannot be served as it stands', () => {
    const sources = [
        { path: 'a.png', width: 1024, height: 768 },
        { path: 'b.png', width: 1024, height: 1024 },
    ];
    const picked = extendableFiles(sources, 'auto', null, 4);
    assert.deepEqual(picked.map((item) => item.path), ['a.png']);
    assert.deepEqual(picked[0].target, { width: 1024, height: 1024, from: 'preset' });
    assert.equal(extendableFiles(sources, 'always', null, 4).length, 2, 'always asks even about a frame that fits');
    assert.equal(extendableFiles(sources, 'auto', null, 1).length, 1, 'the cap is honoured');
});

test('extend: an answer that redrew the picture is not an extension', () => {
    const before = rgba(8, 8, [10, 20, 30]);
    assert.deepEqual(
        { ok: true, reason: '' },
        acceptsExtension(regionDelta(before, rgba(8, 8, [10, 20, 30]), 8, 8)),
        'the same pixels are the same picture',
    );
    // The original area repainted a shade darker: a resample of the whole answer, not a band added.
    const drifted = acceptsExtension(regionDelta(before, rgba(8, 8, [40, 50, 60]), 8, 8));
    assert.equal(drifted.ok, false);
    assert.match(drifted.reason, /изменилось/);
    // One row changed by a hair is what a model that only painted the band looks like.
    const touched = rgba(8, 8, [10, 20, 30]);
    touched.data[0] = 14;
    assert.equal(acceptsExtension(regionDelta(before, touched, 8, 8)).ok, true);
    assert.equal(acceptsExtension({ meanDelta: Number.NaN, changedShare: 0 }).ok, false);
});

test('extend: the role writes the wording, the harness adds the contract', () => {
    const text = extenderPrompt('Continue the keyboard rows in the same grey.');
    assert.match(text, /^Continue the keyboard rows in the same grey\.\n\n/);
    assert.ok(text.includes(EXTENDER_FRAME), 'the frame that forbids touching the original is appended');
});

test('extend: the phase needs an editor model and the image tools', () => {
    assert.equal(canExtend({ tools: { images: false } }), false);
    assert.equal(canExtend({ tools: { images: true } }), false, 'no model, nobody to ask');
    assert.equal(canExtend({ tools: { images: true }, imageModel: 'vendor/editor' }), true);
});

// ---------------------------------------------------------------------------
// Phase 1: the projection, and the measurement that judges it
// ---------------------------------------------------------------------------

test('rectify: a copy is kept only when the tilt really went down', () => {
    const skew = (angleDeg, confidence = 0.9) => ({ angleDeg, confidence, best: 10, flat: 1 });
    assert.equal(acceptsRectification(skew(8), skew(0.2)).ok, true, 'levelled');
    assert.equal(acceptsRectification(skew(8), skew(6)).ok, true, 'improved and below the cap');
    const stalled = acceptsRectification(skew(8), skew(7.9));
    assert.equal(stalled.ok, false, 'a projection that barely moved the tilt is a wasted resampling');
    assert.match(stalled.reason, /улучшение недостаточно/);
    const worse = acceptsRectification(skew(2), skew(9));
    assert.equal(worse.ok, false);
    assert.match(worse.reason, /стало 9\.0/);
    assert.equal(acceptsRectification(skew(8, 0.05), skew(5, 0.05)).ok, true,
        'a frame without measurable boundaries is not judged by the measurement');
});

test('rectify: only the role reaches the projection tool', () => {
    const enabled = enabledToolNames({ ...defaults.tools, images: true }, { imageApi: true });
    const rectifier = toolNamesForRole(enabled, 'rectifier', null);
    assert.ok(rectifier.includes('correct_perspective'), rectifier.join(', '));
    for (const name of ['generate_image', 'edit_image', 'write_file', 'run_command']) {
        assert.equal(rectifier.includes(name), false, `${name} is not geometry`);
    }
    // The decomposer cuts and names screens; a second projection in that pass is how a tilt survived.
    assert.equal(toolNamesForRole(enabled, 'decomposer', null).includes('correct_perspective'), false);
    assert.equal(toolNamesForRole(enabled, 'restorer', null).includes('correct_perspective'), false);
    assert.equal(toolNamesForRole(enabled, 'extender', null).includes('correct_perspective'), false);
    assert.equal(canRectify({ tools: { images: false } }), false);
    assert.equal(canRectify({ tools: { images: true } }), true, 'the projection is local arithmetic');
});

test('rectify: off skips the phase, always lifts the count cap', () => {
    const files = [{ path: 'a.png' }, { path: 'b.png' }, { path: 'c.png' }];
    assert.deepEqual(rectifyTargets(files, 'off', 4), []);
    assert.equal(rectifyTargets(files, 'auto', 2).length, 2);
    assert.equal(rectifyTargets(files, 'always', 2).length, 2, 'the cap is the caller\'s, not the mode\'s');
});

test('rectify: a produced file outside the rectified directory is not the result', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-out-'));
    try {
        const outputDir = path.join(dir, RECTIFIED_DIR);
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, 'ok.png'), TINY_PNG);
        await writeFile(path.join(outputDir, 'empty.png'), Buffer.alloc(0));
        assert.equal((await validateRectifiedFile(path.join(outputDir, 'ok.png'), outputDir)).ok, true);
        assert.match((await validateRectifiedFile(path.join(dir, 'elsewhere.png'), outputDir)).reason, /вне каталога/);
        assert.match((await validateRectifiedFile(path.join(outputDir, 'missing.png'), outputDir)).reason, /не найден/);
        assert.match((await validateRectifiedFile(path.join(outputDir, 'empty.png'), outputDir)).reason, /пуст/);
        assert.match((await validateRectifiedFile('', outputDir)).reason, /путь не указан/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

/** A `roles` stub: one rectifier answer, no model behind it. */
const rectifyRoles = (answer) => ({
    async run() {
        return { status: 'completed', data: answer, error: null, text: '' };
    },
});

test('rectify: a flat reference is left exactly where it was', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-keep-'));
    try {
        await writeFile(path.join(dir, 'mockup.png'), TINY_PNG);
        const result = await rectifyReferences({
            root: dir, dir: '.tmp/w1', files: [{ path: 'mockup.png' }],
            roles: rectifyRoles({ verdict: 'keep', assessment: 'flat export, no projection needed', output: '', quad: null }),
            config: defaults,
        });
        assert.equal(result.rectified.length, 0);
        assert.equal(result.kept[0].path, 'mockup.png');
        assert.match(result.kept[0].reason, /flat export/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: a corrected file replaces the reference, a path outside the directory does not', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-rectify-file-'));
    try {
        await writeFile(path.join(dir, 'mockup.png'), TINY_PNG);
        const inside = `.tmp/w1/${RECTIFIED_DIR}/mockup.png`;
        await mkdir(path.join(dir, '.tmp', 'w1', RECTIFIED_DIR), { recursive: true });
        await writeFile(path.join(dir, ...inside.split('/')), TINY_PNG);

        const accepted = await rectifyReferences({
            root: dir, dir: '.tmp/w1', files: [{ path: 'mockup.png' }],
            roles: rectifyRoles({ verdict: 'rectified', assessment: 'фото под углом', output: inside, quad: null }),
            config: defaults,
        });
        assert.deepEqual(accepted.rectified.map((item) => item.to), [inside],
            accepted.warnings.join('; '));

        // The role names a file it was never allowed to write — the reference has to stay untouched.
        await writeFile(path.join(dir, 'somewhere-else.png'), TINY_PNG);
        const escaped = await rectifyReferences({
            root: dir, dir: '.tmp/w1', files: [{ path: 'mockup.png' }],
            roles: rectifyRoles({ verdict: 'rectified', assessment: '', output: 'somewhere-else.png', quad: null }),
            config: defaults,
        });
        assert.equal(escaped.rectified.length, 0);
        assert.match(escaped.warnings.join('\n'), /вне каталога выхода/);

        // "rectified" with no path is a claim with no file behind it.
        const silent = await rectifyReferences({
            root: dir, dir: '.tmp/w1', files: [{ path: 'mockup.png' }],
            roles: rectifyRoles({ verdict: 'rectified', assessment: '', output: '', quad: null }),
            config: defaults,
        });
        assert.equal(silent.rectified.length, 0);
        assert.match(silent.warnings.join('\n'), /без пути к результату/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('rectify: the replacement keeps the attachment index it replaces', () => {
    const paths = ['a.png', 'b.png', 'c.png'];
    const { paths: next, swapped } = swapReferencePaths(paths, [
        { from: 'b.png', to: '.tmp/w1/rectified/b.png' },
        { from: 'not-a-reference.png', to: '.tmp/w1/rectified/x.png' },
    ]);
    assert.deepEqual(next, ['a.png', '.tmp/w1/rectified/b.png', 'c.png'],
        'the second picture is still the second picture');
    assert.deepEqual(swapped, [{ from: 'b.png', to: '.tmp/w1/rectified/b.png' }]);
    assert.deepEqual(swapReferencePaths(paths, []).paths, paths);
});

// ---------------------------------------------------------------------------
// Phase 1.5: the repair lands in one box or not at all
// ---------------------------------------------------------------------------

test('restore: a sliver is grown, a whole-frame box is refused', () => {
    const corner = planFragment({ x: 10, y: 10, width: 10, height: 10 }, { frameWidth: 600, frameHeight: 800 });
    assert.equal(corner.grown, true);
    assert.ok(corner.width >= MIN_FRAGMENT_SIDE && corner.height >= MIN_FRAGMENT_SIDE, JSON.stringify(corner));
    assert.equal(corner.x, 0, 'a box at the corner grows inwards, never off the frame');
    const mid = planFragment({ x: 300, y: 400, width: 120, height: 80 }, { frameWidth: 600, frameHeight: 800 });
    assert.equal(mid.grown, false, 'a box with context around the damage is sent as it was reported');
    assert.equal(mid.x, 276);
});

test('restore: only a targeted, described, non-overlapping region is repaired', () => {
    const frame = { frameWidth: 600, frameHeight: 800, maxPatches: 2 };
    const usable = {
        kind: 'leftover', x: 0, y: 0, width: 40, height: 600,
        finding: 'левые 40 px — край соседнего экрана',
        prompt: 'Remove the neighbouring screen strip and continue the white background to the left edge.',
    };
    const accepted = pickPatches([
        usable,
        { ...usable, x: 500, y: 20, width: 60, height: 60, prompt: 'Continue the rounded card corner in the same white and border weight.' },
        { ...usable, x: 200, y: 620, width: 60, height: 60, prompt: 'Anything at all, long enough to pass the length check.' },
    ], frame);
    assert.equal(accepted.patches.length, 2, accepted.rejected.map((item) => item.reason).join('; '));
    assert.match(accepted.rejected[0].reason, /максимум 2/);

    const rejected = pickPatches([
        { ...usable, kind: 'restyle' },
        { ...usable, x: Number.NaN },
        { ...usable, x: 560, width: 100 },
        { ...usable, width: 590, height: 790 },
        { ...usable, prompt: 'fix it' },
    ], { ...frame, maxPatches: 9 });
    assert.equal(rejected.patches.length, 0);
    const reasons = rejected.rejected.map((item) => item.reason).join('\n');
    assert.match(reasons, /не из списка/);
    assert.match(reasons, /координаты не числа/);
    assert.match(reasons, /выходит за кадр/);
    assert.match(reasons, /перерисовка всего экрана/);
    assert.match(reasons, /слишком короткая/);

    const overlapping = pickPatches([usable, { ...usable, x: 20 }], frame);
    assert.match(overlapping.rejected[0].reason, /пересекается/);
});

test('restore: the prompt the role wrote travels under the fragment contract', () => {
    const text = editorPrompt('Continue the 1 px #DDDDDD border along the cut edge.');
    assert.match(text, /^Continue the 1 px #DDDDDD border along the cut edge\.\n\n/);
    assert.match(text, /fragment cut out of a larger interface screenshot/);
});

test('restore: auto looks only at the files a transform produced', () => {
    const files = [
        { rel: 'a.png', kind: 'crop' },
        { rel: 'b.png', kind: 'repaired' },
        { rel: 'c.png', kind: 'regenerated' },
    ];
    assert.deepEqual(restorableFiles(files, 'auto', 6).map((file) => file.rel), ['b.png', 'c.png']);
    assert.equal(restorableFiles(files, 'always', 6).length, 3);
    assert.equal(restorableFiles(files, 'auto', 1).length, 1);
});

test('restore: a replaced file is renamed everywhere the decomposition lists it', () => {
    const decomposition = {
        screens: [
            { name: 'Home', subReference: '.tmp/w/decomposition/01-home.png', subReferenceKind: 'restored' },
            { name: 'Other', subReference: '.tmp/w/decomposition/02-other.png', subReferenceKind: 'crop' },
        ],
        subReferences: [{ path: '.tmp/w/decomposition/01-home.png', kind: 'restored' }],
    };
    const touched = applyRepairs(decomposition, [{
        from: '.tmp/w/decomposition/01-home.png', to: '.tmp/w/decomposition/restored/01-home.png',
    }]);
    assert.equal(touched, 2);
    assert.equal(decomposition.screens[0].subReference, '.tmp/w/decomposition/restored/01-home.png');
    assert.equal(decomposition.screens[0].subReferenceKind, 'repaired');
    assert.equal(decomposition.screens[1].subReference, '.tmp/w/decomposition/02-other.png', 'untouched');
    assert.equal(decomposition.subReferences[0].kind, 'repaired');
    assert.equal(applyRepairs(null, []), 0);
});
