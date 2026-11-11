import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { canRunAdvanced, advancedImageModel, shouldUseReasoningPro, advancedMeasurerProfile, advancedMeasurePhase1, advancedEnhanceCrops } from '../src/agent/advanced.js';
import { detectMagick } from '../src/agent/image-magick.js';
import { SEEDREAM_MODEL } from '../src/openai/seedream-5-5.js';
import { TINY_PNG } from './helpers/mock-server.js';

/** A completed decomposition answer whose pictures come from the local test server. */
function answer(origin) {
    return {
        data: {
            status: 'completed',
            result: {
                images: [{
                    url: [`${origin}/base.png`, `${origin}/headline.png`, `${origin}/badge.png`],
                    sizes: ['1000x800', '500x400', '250x200'],
                    layers: [
                        { z_index: 0, name: 'base', background: 'opaque' },
                        {
                            z_index: 1, name: 'headline', background: 'transparent',
                            bounding_box: { absolute: [40, 20, 440, 120] },
                            text_recognition: { text: 'Big headline', lines: [] },
                        },
                        { z_index: 2, name: 'badge', background: 'transparent', bounding_box: { absolute: [500, 400, 900, 600] } },
                    ],
                }],
            },
        },
    };
}

test('advanced mode runs only on a seedream-5.5 picture model', () => {
    //assert.equal(canRunAdvanced({ imageModel: 'bytedance-seed/seedream-5-5' }), true);
    assert.equal(canRunAdvanced({ imageModel: 'seedream-5-5' }), true);
    assert.equal(canRunAdvanced({ imageModel: 'openai/gpt-image-2.6-sunburst' }), false);
    assert.equal(canRunAdvanced({}), false, 'without an images transport there is nothing to decompose with');
});

test('a seedream named only in modelsBackends is found and used for decomposition', () => {
    // The shape of a real config: the default image model is a GPT one, and seedream lives on a
    // single host that `modelsBackends` names. Advanced mode must still run, and on that host.
    const config = {
        baseURL: 'https://sprutdock.ru/v1',
        imageModel: 'openai/gpt-image-2.6-sunburst',
        backends: [{ baseURL: 'https://sprutdock.ru/v1', apiKey: 'k' }],
        imagesBackends: [{ baseURL: 'https://sprutdock.ru/v1', apiKey: 'k' }, { baseURL: 'https://api.apimart.ai/v1', apiKey: 'k' }],
        modelsBackends: { 'seedream-5-5': [{ baseURL: 'https://api.apimart.ai/v1' }] },
    };
    assert.equal(canRunAdvanced(config), true, 'the model is reachable even though imageModel is not seedream');
    assert.equal(advancedImageModel(config), 'seedream-5-5', 'the id is taken as the config writes it, so its host entry matches');
});

test('the decomposition model follows imageModel, then modelsBackends, then the gateway default', () => {
    assert.equal(advancedImageModel({ imageModel: 'bytedance-seed/seedream-5-5-pro' }), 'bytedance-seed/seedream-5-5-pro');
    assert.equal(advancedImageModel({ imageModel: 'openai/gpt-image-2.6-sunburst', modelsBackends: { 'seedream-5-5': [{}] } }), 'seedream-5-5');
    assert.equal(advancedImageModel({ imageModel: 'openai/gpt-image-2.6-sunburst' }), SEEDREAM_MODEL);
});

test('every OpenAI GPT model gets reasoning pro in advanced mode, other vendors do not', () => {
    assert.equal(shouldUseReasoningPro('gpt-6.1-terra'), true);
    assert.equal(shouldUseReasoningPro('openai/gpt-6-luna'), true);
    assert.equal(shouldUseReasoningPro('gpt-image-2.6-flare'), true);
    assert.equal(shouldUseReasoningPro('moonshotai/kimi-k3.1-pro'), false);
    assert.equal(shouldUseReasoningPro(null), false);
    const profile = advancedMeasurerProfile({ model: 'gpt-6-luna', roles: { measurer: { model: 'gpt-6.1-terra' } } });
    assert.deepEqual(profile, { needsReasoningPro: true, model: 'gpt-6.1-terra' });
});

test('phase 1 turns one decomposition answer into a sheet, layer files, and OCR notes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-'));
    const events = [];
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
    });
    try {
        await writeFile(path.join(dir, 'ref.png'), TINY_PNG);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const client = {
            async call(route) {
                return route === 'images/generations' ? { data: [{ task_id: 'task-1' }] } : answer(origin);
            },
        };
        const result = await advancedMeasurePhase1({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 } }, notify: (event) => events.push(event),
        });
        assert.deepEqual(result.warnings, []);
        assert.equal(result.layers.length, 2, 'both layers carry a box, so both are kept');
        assert.equal(result.cropPaths.length, 2);
        for (const rel of result.cropPaths) {
            assert.ok(await stat(path.join(dir, rel)).then((info) => info.isFile(), () => false), `${rel} is stored`);
        }
        const sheet = result.sheet;
        assert.equal(sheet.canvas.width, 1000);
        assert.equal(sheet.elements.length + sheet.regions.length, 2);
        const headline = [...sheet.elements, ...sheet.regions].find((item) => item.name === 'headline');
        assert.deepEqual(headline.box, { x: 40, y: 20, width: 400, height: 100 });
        assert.equal(headline.confidence, 'high', 'the box was read by the decomposition model');
        assert.match(headline.notes, /text: Big headline/);
        assert.match(sheet.notes, /OCR на нескольких слоях/);
        assert.deepEqual(sheet.assumptions, ['Layer boxes were read by seedream-5.5, not by the measurer role.']);
        assert.ok(events.some((event) => event.type === 'measure.pass' && event.phase === 'advanced-decomposition'));
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('phase 1 asks the backend that serves seedream, not the primary host', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-hosts-'));
    const tried = [];
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
    });
    try {
        await writeFile(path.join(dir, 'ref.png'), TINY_PNG);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const serving = {
            async call(route, options = {}) {
                tried.push(`apimart ${route} ${options.body?.model ?? ''}`.trim());
                return route === 'images/generations' ? { data: [{ task_id: 'task-1' }] } : answer(origin);
            },
        };
        const client = {
            // The primary host is the one that answers "model not found" in the field; it must never
            // be asked at all once the channel list says where the model actually lives.
            async call() { tried.push('primary'); throw new Error('the primary host must not be used'); },
            channels(kind, model) {
                tried.push(`channels ${kind} ${model}`);
                return [{ label: 'https://api.apimart.ai/v1', client: serving, modelFor: (name) => name }];
            },
        };
        const result = await advancedMeasurePhase1({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 }, modelsBackends: { 'seedream-5-5': [{ baseURL: 'https://api.apimart.ai/v1' }] } },
            notify: () => {},
        });
        assert.deepEqual(tried, ['channels images seedream-5-5', 'apimart images/generations seedream-5-5', 'apimart tasks/task-1']);
        assert.ok(result.sheet, 'the layers came from the host the config names');
        assert.equal(result.layers.length, 2);
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('the enhanced pass cuts a region and asks seedream for its transparent version as a task', async (t) => {
    const exe = await detectMagick({ magickPath: null });
    if (!exe) { t.skip('ImageMagick is not installed, so no region can be cut'); return; }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-enhance-'));
    const layerUrl = `data:image/png;base64,${TINY_PNG}`;
    const calls = [];
    const bodies = [];
    try {
        await writeFile(path.join(dir, 'ref.png'), Buffer.from(TINY_PNG, 'base64'));
        const client = {
            channels: () => [{
                label: 'https://api.apimart.ai/v1',
                client: {
                    async call(route, options = {}) {
                        calls.push(`${options.method ?? 'POST'} ${route}`);
                        if (route === 'images/generations') {
                            bodies.push(options.body);
                            return { code: 200, data: [{ status: 'pending', task_id: 'task-crop' }] };
                        }
                        return { data: { status: 'completed', result: { images: [{ url: [layerUrl], sizes: ['1024x1024'] }] } } };
                    },
                },
            }],
        };
        const out = await advancedEnhanceCrops({
            root: dir, client, referencePath: 'ref.png', cropPaths: ['x.png'],
            regions: [{ box: { x: 0, y: 0, width: 1, height: 1 } }],
            model: 'seedream-5-5', config: {}, notify: () => {},
        });
        assert.deepEqual(out.warnings, []);
        assert.equal(out.enhancedPaths.length, 1, 'the transparent cut came back from the task');
        assert.ok(await stat(path.join(dir, out.enhancedPaths[0])).then((info) => info.isFile(), () => false), 'the crop is stored');
        assert.deepEqual(calls, ['POST images/generations', 'GET tasks/task-crop'],
            'generation of this model is a task, not a synchronous images call');
        assert.equal(bodies[0].background, 'transparent');
        assert.equal(bodies[0].output_format, 'png');
        assert.equal(bodies[0].size, '1K', 'a 1×1 region cannot ask for its own pixel frame');
        assert.equal(bodies[0].image_urls.length, 1, 'the region travels in image_urls');
        assert.equal('input_references' in bodies[0], false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('phase 1 warns instead of throwing when the reference is missing or the task fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-missing-'));
    try {
        const missing = await advancedMeasurePhase1({
            root: dir, workId: 'w', client: { async call() { throw new Error('unused'); } },
            referencePath: 'nope.png', config: {}, notify: () => {},
        });
        assert.equal(missing.sheet, null);
        assert.match(missing.warnings.join('\n'), /Референс не найден|Файл референса не найден/);

        await writeFile(path.join(dir, 'ref.png'), TINY_PNG);
        const failed = await advancedMeasurePhase1({
            root: dir, workId: 'w',
            client: {
                async call(route) {
                    if (route === 'images/generations') return { data: [{ task_id: 'task-2' }] };
                    return { data: { status: 'failed', error: 'content policy' } };
                },
            },
            referencePath: 'ref.png', config: {}, notify: () => {},
        });
        assert.equal(failed.sheet, null);
        assert.match(failed.warnings.join('\n'), /Разложение слоёв не удалось/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
