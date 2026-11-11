import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/openai/errors.js';
import {
    SEEDREAM_MODEL, isSeedream55, seedreamLayerSize, seedreamGenerationSize, layerDecompositionBody, generationBody,
    normalizeLayerBox, parseLayerDecomposition, taskImageSources, decomposeLayers, generateTransparentLayer,
} from '../src/openai/seedream-5-5.js';

const SOURCE = { bytes: Buffer.from('fake-png-bytes'), mime: 'image/png' };
const TINY = Buffer.from('layer-bytes').toString('base64');

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
                            text_recognition: {
                                text: 'Big headline',
                                lines: [{
                                    text: 'Big headline',
                                    bounding_box: { absolute: [48, 24, 300, 64] },
                                    runs: [{ text: 'Big headline', style: { similar_font_family: 'Inter', bold: true, foreground_color: '#FFFFFF' } }],
                                }, {
                                    text: 'second line',
                                    bounding_box: { absolute: [48, 68, 300, 108] },
                                    runs: [{ text: 'second line', style: { similar_font_family: 'Inter', bold: true } }],
                                }],
                            },
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
    assert.deepEqual(parsed.layers[0].box, { x: 40, y: 20, width: 400, height: 100 });
    // The line frames and the run styles are what the measurer measures typography off, so they have to
    // survive parsing in pixels and not as raw vendor objects.
    assert.deepEqual(parsed.layers[0].text.lines.map((line) => line.box), [
        { x: 48, y: 24, width: 252, height: 40 },
        { x: 48, y: 68, width: 252, height: 40 },
    ]);
    assert.equal(parsed.layers[0].text.lines[0].runs[0].style.similar_font_family, 'Inter');
    assert.equal(parsed.layers[0].text.lines[0].runs[0].style.bold, true);
    assert.equal(parsed.layers[1].box.x, 500, 'a normalized box becomes pixels through the base frame');
    assert.deepEqual(parsed.ocr.map((row) => row.text), ['Big headline']);
});

test('OCR lines without a frame or a style still parse, as nulls rather than guesses', () => {
    const answer = completedAnswer();
    answer.data.result.images[0].layers[1].text_recognition = { text: 'plain', lines: [{ text: 'plain' }] };
    const line = parseLayerDecomposition(answer).layers[0].text.lines[0];
    assert.deepEqual(line, { text: 'plain', box: null, runs: [] });
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

test('the enhanced-crop pass runs generation as a task and carries the crop in image_urls', async () => {
    const bodies = [];
    const calls = [];
    // The gateway answers a task id for generation too, and the picture only appears on the task.
    const client = {
        async call(route, options = {}) {
            calls.push(`${options.method ?? 'POST'} ${route}`);
            if (route === 'images/generations') {
                bodies.push(options.body);
                return { code: 200, data: [{ status: 'pending', task_id: 'task-crop' }] };
            }
            assert.equal(route, 'tasks/task-crop');
            return { data: { status: 'completed', result: { images: [{ url: [`data:image/png;base64,${TINY}`], sizes: ['1024x1024'] }] } } };
        },
    };
    const payloads = await generateTransparentLayer({ client, prompt: 'extract', bytes: Buffer.from('region') });
    assert.deepEqual(calls, ['POST images/generations', 'GET tasks/task-crop']);
    assert.deepEqual(payloads, [TINY], 'the data-URI answer is decoded into base64');
    const body = bodies[0];
    assert.equal(body.background, 'transparent');
    assert.equal(body.output_format, 'png');
    assert.equal(body.layer_decomposition, undefined, 'the enhanced crop is a generation, not a decomposition');
    assert.equal('n' in body, false);
    assert.match(body.image_urls[0], /^data:image\/png;base64,/);
    assert.equal('input_references' in body, false, 'this model reads image_urls, not the generic field');
});

test('generation frames: a small crop becomes 1K, a valid frame stays, a ratio survives', () => {
    // A measurement crop is far under the vendor's 921 600-pixel minimum, and an exact frame below
    // it is a synchronous HTTP 400 — so the tier is the only honest answer for a small region.
    assert.equal(seedreamGenerationSize('400x100'), '1K');
    assert.equal(seedreamGenerationSize(null), '1K');
    assert.equal(seedreamGenerationSize('2K'), '2K');
    assert.equal(seedreamGenerationSize('2048x1152'), '2048x1152', '2 359 296 px sits inside the budget');
    assert.equal(seedreamGenerationSize('16x9'), '16:9');
    assert.equal(seedreamGenerationSize('8k'), '1K');
});

test('a transparent generation never combines transparency with jpeg and always carries a prompt', () => {
    const body = generationBody({ prompt: 'cut out', references: ['https://cdn.test/x.png'], background: 'transparent', format: 'jpeg' });
    assert.equal(body.output_format, 'jpeg');
    assert.equal('background' in body, false, 'the vendor rejects transparent jpeg');
    assert.throws(() => generationBody({ prompt: '   ' }), /требует prompt/);
    assert.throws(() => generationBody({ prompt: 'x', references: Array(11).fill('https://cdn.test/x.png') }), /не больше 10 референсов/);
});

test('picture sources are read from both the task shape and the synchronous one', () => {
    assert.deepEqual(taskImageSources({ data: { status: 'completed', result: { images: [{ url: ['https://cdn/a.png', 'https://cdn/b.png'] }] } } }),
        [{ kind: 'url', value: 'https://cdn/a.png' }, { kind: 'url', value: 'https://cdn/b.png' }]);
    assert.deepEqual(taskImageSources({ data: [{ b64_json: 'AAA' }, { url: 'https://cdn/c.png' }] }),
        [{ kind: 'b64', value: 'AAA' }, { kind: 'url', value: 'https://cdn/c.png' }]);
    assert.deepEqual(taskImageSources({ data: [{ status: 'pending', task_id: 't' }] }), [], 'a running task has no pictures yet');
});

test('a generation task that ends without a picture is a named error, not an empty crop', async () => {
    const client = {
        async call(route) {
            return route === 'images/generations'
                ? { data: [{ task_id: 'task-empty' }] }
                : { data: { status: 'completed', result: { images: [] } } };
        },
    };
    await assert.rejects(generateTransparentLayer({ client, prompt: 'extract', bytes: Buffer.from('x') }), /без изображения/);
});

test('a host that does not carry seedream hands the decomposition to the next backend', async () => {
    const seen = [];
    const host = (label, { serves }) => ({
        async call(route, options = {}) {
            seen.push(`${label} ${route}`);
            if (!serves) throw new ApiError(`Model '${options.body?.model}' not found`, { status: 404, apiCode: 'model_not_found' });
            return route === 'images/generations' ? { data: [{ task_id: 'task-9' }] } : completedAnswer();
        },
    });
    const channels = [
        { label: 'https://sprutdock.ru/v1', client: host('sprutdock', { serves: false }) },
        // The second host names the model its own way, and the task is polled on the same host.
        { label: 'https://api.apimart.ai/v1', client: host('apimart', { serves: true }), modelFor: (name) => `bytedance-seed/${name}` },
    ];
    const result = await decomposeLayers({ channels, source: SOURCE, onWarn: () => {} });
    assert.equal(result.taskId, 'task-9');
    assert.equal(result.host, 'https://api.apimart.ai/v1', 'the answer names the host that served it');
    assert.deepEqual(seen, [
        'sprutdock images/generations',
        'apimart images/generations',
        'apimart tasks/task-9',
    ], 'a task id is polled where it was created, never on the host that refused the model');
});

test('the rewritten model id is what reaches the host that serves it', async () => {
    const bodies = [];
    const channels = [{
        label: 'apimart',
        modelFor: (name) => `bytedance-seed/${name}`,
        client: {
            async call(route, options = {}) {
                if (route === 'images/generations') {
                    bodies.push(options.body.model);
                    return { data: [{ task_id: 'task-1' }] };
                }
                return completedAnswer();
            },
        },
    }];
    await decomposeLayers({ channels, source: SOURCE });
    assert.deepEqual(bodies, ['bytedance-seed/seedream-5-5']);
});

test('a rejected request is not retried on another backend', async () => {
    const seen = [];
    const channels = ['first', 'second'].map((label) => ({
        label,
        client: {
            async call() {
                seen.push(label);
                throw new ApiError('size is not supported', { status: 400 });
            },
        },
    }));
    await assert.rejects(decomposeLayers({ channels, source: SOURCE }), /size is not supported/);
    assert.deepEqual(seen, ['first'], 'a 400 is the request’s own fault, so the chain stops');
});
