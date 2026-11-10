import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SEEDREAM_MODEL, isSeedream55, seedreamLayerSize, layerDecompositionBody,
    normalizeLayerBox, parseLayerDecomposition, decomposeLayers, generateTransparentLayer,
} from '../src/openai/seedream-5-5.js';

const SOURCE = { bytes: Buffer.from('fake-png-bytes'), mime: 'image/png' };

/** One completed task answer with a base image and two layers. */
function completedAnswer() {
    return {
        data: {
            status: 'completed',
            result: {
                images: [{
                    url: [
                        'https://cdn.test/base.png',
                        'https://cdn.test/layer-1.png',
                        'https://cdn.test/layer-2.png',
                    ],
                    sizes: ['1000x800', '500x400', '250x200'],
                    backgrounds: ['opaque', 'transparent', 'transparent'],
                    layers: [
                        { z_index: 0, name: 'base', background: 'opaque' },
                        {
                            z_index: 1, name: 'headline', background: 'transparent',
                            bounding_box: { absolute: [40, 20, 440, 120] },
                            text_recognition: { text: 'Big headline', lines: [{ text: 'Big headline' }] },
                        },
                        {
                            z_index: 2, name: 'badge', background: 'transparent',
                            bounding_box: { normalized: [500, 500, 900, 750] },
                        },
                    ],
                }],
            },
        },
    };
}

test('seedream-5.5 is recognized by its own id and aliases only', () => {
    assert.equal(isSeedream55(SEEDREAM_MODEL), true);
    assert.equal(isSeedream55('Seedream_5.5'), true);
    assert.equal(isSeedream55('bytedance-seed/seedream-5-0'), false);
    assert.equal(isSeedream55(null), false);
});

test('the decomposition frame falls back to auto instead of a rejected ratio or pixel frame', () => {
    assert.equal(seedreamLayerSize('1.5K'), '1.5K');
    assert.equal(seedreamLayerSize('2k'), '2K');
    assert.equal(seedreamLayerSize('1024x1536'), 'auto');
    assert.equal(seedreamLayerSize('16:9'), 'auto');
    assert.equal(seedreamLayerSize(null), 'auto');
});

test('the decomposition body carries one data uri, no background field, and no n', () => {
    const body = layerDecompositionBody({ source: SOURCE, prompt: '  ', size: '1K', maxImages: 17 });
    assert.equal(body.layer_decomposition, true);
    assert.equal(body.size, '1K');
    assert.equal('background' in body, false, 'the gateway rejects any background field in this mode');
    assert.equal('n' in body, false);
    assert.equal('prompt' in body, false, 'a blank prompt stays out of the request');
    assert.equal(body.image_urls.length, 1);
    assert.match(body.image_urls[0], /^data:image\/png;base64,/);
    assert.deepEqual(body.layer_decomposition_options, { max_images: 17, text_recognition: true });
});

test('max_images outside the documented range and a missing picture are refused', () => {
    assert.equal(layerDecompositionBody({ source: SOURCE, maxImages: 1 }).layer_decomposition_options.max_images, undefined);
    assert.equal(layerDecompositionBody({ source: SOURCE, maxImages: 101 }).layer_decomposition_options.max_images, undefined);
    assert.equal(layerDecompositionBody({ source: SOURCE, maxImages: 1.5 }).layer_decomposition_options.max_images, undefined);
    assert.throws(() => layerDecompositionBody({ source: { bytes: Buffer.alloc(0) } }), /ровно одно входное изображение/);
});

test('layer boxes come back in base pixels from either documented shape', () => {
    assert.deepEqual(normalizeLayerBox({ absolute: [40, 20, 440, 120] }, { width: 1000, height: 800 }),
        { x: 40, y: 20, width: 400, height: 100 });
    assert.deepEqual(normalizeLayerBox({ normalized: [500, 500, 900, 750] }, { width: 1000, height: 800 }),
        { x: 500, y: 400, width: 400, height: 200 });
    assert.equal(normalizeLayerBox({ normalized: [0, 0, 500, 500] }, null), null, 'no base frame, no pixels');
    assert.equal(normalizeLayerBox({ absolute: [10, 10, 5, 5] }, null), null, 'an inverted box is not a measurement');
    assert.equal(normalizeLayerBox(undefined, null), null);
});

test('a completed answer flattens into a base, layers with boxes, and OCR rows', () => {
    const parsed = parseLayerDecomposition(completedAnswer());
    assert.deepEqual(parsed.base, { url: 'https://cdn.test/base.png', size: { width: 1000, height: 800 } });
    assert.equal(parsed.layers.length, 2);
    assert.deepEqual(parsed.layers[0], {
        index: 1, z: 1, name: 'headline', description: '', url: 'https://cdn.test/layer-1.png',
        size: { width: 500, height: 400 }, background: 'transparent',
        box: { x: 40, y: 20, width: 400, height: 100 },
        text: { text: 'Big headline', lines: [{ text: 'Big headline' }] },
    });
    assert.deepEqual(parsed.layers[1].box, { x: 500, y: 400, width: 400, height: 200 });
    assert.deepEqual(parsed.ocr, [{ layer: 1, text: 'Big headline', lines: [{ text: 'Big headline' }] }]);
});

test('a layer whose metadata array does not line up keeps a null box instead of a guess', () => {
    const answer = completedAnswer();
    answer.data.result.images[0].layers = [{ z_index: 0 }];
    const parsed = parseLayerDecomposition(answer);
    assert.equal(parsed.layers.length, 2);
    assert.equal(parsed.layers[0].box, null);
    assert.equal(parsed.layers[0].name, '');
});

test('decomposeLayers polls the task it was given and returns the flattened layers', async () => {
    const calls = [];
    const client = {
        async call(path, options) {
            calls.push({ path, method: options.method ?? 'POST' });
            if (path === 'images/generations') return { data: [{ task_id: 'task-42' }] };
            assert.equal(path, 'tasks/task-42');
            return completedAnswer();
        },
    };
    const result = await decomposeLayers({ client, source: SOURCE, maxImages: 12 });
    assert.equal(result.taskId, 'task-42');
    assert.equal(result.layers.length, 2);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['POST images/generations', 'GET tasks/task-42']);
});

test('a failed task and an answer without results are both named errors', async () => {
    await assert.rejects(
        decomposeLayers({ client: { async call() { return { data: [{}] }; } }, source: SOURCE }),
        /не содержит ни task_id/,
    );
    const failing = {
        async call(path) {
            return path === 'images/generations'
                ? { data: [{ task_id: 'task-7' }] }
                : { data: { status: 'failed', error: 'content policy' } };
        },
    };
    await assert.rejects(decomposeLayers({ client: failing, source: SOURCE }), /статусом «failed»: content policy/);
});

test('the enhanced-crop pass asks the images route for a transparent png', async () => {
    const seen = [];
    const client = { images: { async generate(options) { seen.push(options); return ['AUNncmFtZQ==']; } } };
    const payloads = await generateTransparentLayer({ client, prompt: 'extract', bytes: Buffer.from('region') });
    assert.deepEqual(payloads, ['AUNncmFtZQ==']);
    assert.equal(seen[0].background, 'transparent');
    assert.equal(seen[0].format, 'png');
    assert.equal(seen[0].model, SEEDREAM_MODEL);
    assert.match(seen[0].references[0], /^data:image\/png;base64,/);
});
