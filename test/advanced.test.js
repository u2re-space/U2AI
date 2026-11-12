import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { canRunAdvanced, advancedImageModel, shouldUseReasoningPro, advancedDecompose } from '../src/agent/advanced.js';
import { detectMagick } from '../src/agent/image-magick.js';
import { SEEDREAM_MODEL } from '../src/openai/seedream-5-5.js';
import { TINY_PNG } from './helpers/mock-server.js';
import { pngOf } from './helpers/png.js';

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

test('every OpenAI GPT model gets reasoning pro, other vendors do not', () => {
    assert.equal(shouldUseReasoningPro('gpt-6.1-terra'), true);
    assert.equal(shouldUseReasoningPro('openai/gpt-6-luna'), true);
    assert.equal(shouldUseReasoningPro('gpt-image-2.6-flare'), true);
    assert.equal(shouldUseReasoningPro('moonshotai/kimi-k3.1-pro'), false);
    assert.equal(shouldUseReasoningPro(null), false);
});

test('phase 1 turns one decomposition answer into layers and layer files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-'));
    const events = [];
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
    });
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const client = {
            async call(route) {
                return route === 'images/generations' ? { data: [{ task_id: 'task-1' }] } : answer(origin);
            },
        };
        const result = await advancedDecompose({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 } }, notify: (event) => events.push(event),
        });
        assert.match(result.warnings.join(' '), /Вход Seedream локально дополнен справа и снизу/);
        assert.equal(result.layers.length, 2, 'both layers carry a box, so both are kept');
        for (const layer of result.layers) {
            assert.ok(layer.localPath, `layer ${layer.name} carries its file`);
            assert.ok(await stat(path.join(dir, layer.localPath)).then((info) => info.isFile(), () => false), `${layer.localPath} is stored`);
        }
        assert.deepEqual(result.frame, { width: 1000, height: 800 }, 'the frame is the reference that was sent');
        const headline = result.layers.find((layer) => layer.name === 'headline');
        assert.deepEqual(headline.box, { x: 40, y: 20, width: 400, height: 100 });
        assert.equal(headline.tightened, false, 'an empty OCR line list cannot tighten the box');
        assert.equal(headline.text.text, 'Big headline', 'the OCR text travels with the layer');
        assert.ok(events.some((event) => event.type === 'decompose.layers'));
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
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
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
        const result = await advancedDecompose({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 }, modelsBackends: { 'seedream-5-5': [{ baseURL: 'https://api.apimart.ai/v1' }] } },
            notify: () => {},
        });
        assert.deepEqual(tried, ['channels images seedream-5-5', 'apimart images/generations seedream-5-5', 'apimart tasks/task-1']);
        assert.equal(result.layers.length, 2, 'the layers came from the host the config names');
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('phase 1 warns instead of throwing when the reference is missing or the task fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-missing-'));
    try {
        const missing = await advancedDecompose({
            root: dir, workId: 'w', client: { async call() { throw new Error('unused'); } },
            referencePath: 'nope.png', config: {}, notify: () => {},
        });
        assert.equal(missing.layers.length, 0);
        assert.match(missing.warnings.join('\n'), /Референс не найден|Файл референса не найден/);

        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        const failed = await advancedDecompose({
            root: dir, workId: 'w',
            client: {
                async call(route) {
                    if (route === 'images/generations') return { data: [{ task_id: 'task-2' }] };
                    return { data: { status: 'failed', error: 'generation_timeout' } };
                },
            },
            referencePath: 'ref.png', config: {}, notify: () => {},
        });
        assert.equal(failed.layers.length, 0);
        assert.match(failed.warnings.join('\n'), /Разложение слоёв не удалось/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('a reference the moderation refuses is reported as refused, not as a broken request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-policy-'));
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        const refused = await advancedDecompose({
            root: dir, workId: 'w',
            client: {
                async call(route) {
                    if (route === 'images/generations') return { data: [{ task_id: 'task-3' }] };
                    return {
                        data: {
                            status: 'failed',
                            error: {
                                message: 'Your request did not pass content safety review. Please adjust your prompt or input files and try again.',
                                reason: 'content_policy_violation',
                            },
                        },
                    };
                },
            },
            referencePath: 'ref.png', config: {}, notify: () => {},
        });
        const text = refused.warnings.join('\n');
        assert.equal(refused.layers.length, 0);
        assert.match(text, /отклонено модерацией провайдера \(content_policy_violation\)/);
        assert.doesNotMatch(text, /did not pass content safety review/, 'the vendor sentence about a prompt nobody sent is not repeated');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('phase 1 keeps the boxes in the reference frame and every name ASCII', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-frame-'));
    const bodies = [];
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
    });
    try {
        // The file on disk is 500×400 while the tier answers a 1000×800 base it rescaled the page to.
        // The boxes belong to the picture that was sent, so they stay where they are and the two
        // frames are only reported: scaling them by 1000/500 moved every crop off its object.
        await writeFile(path.join(dir, 'ref.png'), pngOf(500, 400));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const client = {
            async call(route, options = {}) {
                if (route === 'images/generations') {
                    bodies.push(options.body);
                    return { data: [{ task_id: 'task-1' }] };
                }
                return {
                    data: {
                        status: 'completed',
                        result: {
                            images: [{
                                url: [`${origin}/base.png`, `${origin}/cta.png`],
                                sizes: ['1000x800', '300x100'],
                                layers: [
                                    { z_index: 0, name: '背景', background: 'opaque' },
                                    {
                                        z_index: 1, name: 'ボタン 区域', background: 'transparent',
                                        bounding_box: { absolute: [200, 150, 800, 350] },
                                        text_recognition: { text: 'Купить', lines: [] },
                                    },
                                ],
                            }],
                        },
                    },
                };
            },
        };
        const result = await advancedDecompose({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 } }, notify: () => {},
        });
        // The canvas size cannot be asked for, so no geometry guard is sent; what the call does
        // carry is the tight-box wording, because the model otherwise rounds boxes to a square.
        assert.equal('prompt' in bodies[0], true, 'the decomposition request carries the tight-box guard');
        assert.match(bodies[0].prompt, /tightest rectangle that fully contains the visible pixels/);
        assert.doesNotMatch(bodies[0].prompt, /original scale and geometry/, 'no canvas-size guard is asked of a mode that cannot honour it');
        assert.deepEqual(result.frame, { width: 500, height: 400 }, 'the frame reported is the reference on disk');
        assert.equal(result.layers.length, 1, 'the opaque base carries no box and is not a layer to measure');
        const [cta] = result.layers;
        assert.deepEqual(cta.box, { x: 200, y: 150, width: 600, height: 200 }, 'the box is used exactly as the model sent it');
        assert.match(cta.name, /^[a-z0-9][a-z0-9-]*$/, 'a CJK layer name does not reach the layer list');
        assert.match(cta.localPath, /^\.tmp\/[\w./-]+$/, 'file names stay ASCII');
        assert.match(result.warnings.join(' '), /Вход Seedream локально дополнен справа и снизу/);
        assert.match(result.warnings.join(' '), /Базовое изображение разложения 1000x800/, 'the two frames of one answer are reported');
        assert.equal(cta.text.text, 'Купить', 'the text the layer carries stays as evidence');
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('the decomposition sends only the tight-box guard', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-prompt-'));
    const bodies = [];
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
    });
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const client = {
            async call(route, options = {}) {
                if (route === 'images/generations') {
                    bodies.push(options.body);
                    return { data: [{ task_id: 'task-1' }] };
                }
                return answer(origin);
            },
        };
        // The team calls the decomposition with no prompt: a longer text alongside
        // `text_recognition` can cost the OCR, and the page plan belongs to the measurer, not here.
        const result = await advancedDecompose({
            root: dir, workId: 'w', referencePath: 'ref.png',
            config: { agent: {} }, client, notify: () => {},
        });
        assert.equal(result.layers.length, 2);
        assert.equal('prompt' in bodies[0], true, 'the tight-box guard is the only text the call carries');
        assert.match(bodies[0].prompt, /tightest rectangle that fully contains the visible pixels/);
        assert.doesNotMatch(bodies[0].prompt, /Русский план страницы/, 'no plan text ever reaches the model');
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('a text layer is narrowed to its OCR lines and carries the style the OCR measured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-tight-'));
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(TINY_PNG);
    });
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const client = {
            async call(route) {
                return route === 'images/generations'
                    ? { data: [{ task_id: 'task-1' }] }
                    : {
                        data: {
                            status: 'completed',
                            result: {
                                images: [{
                                    url: [`${origin}/base.png`, `${origin}/hero.png`, `${origin}/note.png`],
                                    sizes: ['1000x800', '600x400', '300x120'],
                                    layers: [
                                        { z_index: 0, name: 'base', background: 'opaque' },
                                        {
                                            // The area the generation model drew is padded around the glyphs by
                                            // a quarter on each side; the line frames are the real geometry.
                                            z_index: 1, name: 'hero-heading', background: 'transparent',
                                            bounding_box: { absolute: [200, 100, 800, 620] },
                                            text_recognition: {
                                                text: 'Brand\nand Design',
                                                lines: [
                                                    {
                                                        text: 'Brand', bounding_box: { absolute: [300, 150, 700, 250] },
                                                        runs: [{ text: 'Brand', style: { similar_font_family: 'Inter', bold: true } }],
                                                    },
                                                    {
                                                        text: 'and Design', bounding_box: { absolute: [300, 320, 760, 420] },
                                                        runs: [{ text: 'and Design', style: { similar_font_family: 'Inter', bold: true } }],
                                                    },
                                                ],
                                            },
                                        },
                                        {
                                            z_index: 2, name: 'note', background: 'transparent',
                                            bounding_box: { absolute: [100, 100, 400, 220] },
                                            // A line frame outside the layer box means the two disagree, and
                                            // guessing which is right would invent geometry.
                                            text_recognition: { text: 'stray', lines: [{ text: 'stray', bounding_box: { absolute: [900, 700, 980, 760] } }] },
                                        },
                                    ],
                                }],
                            },
                        },
                    };
            },
        };
        const result = await advancedDecompose({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 } }, notify: () => {},
        });
        const [hero, note] = result.layers;
        assert.equal(hero.name, 'hero-heading');
        assert.deepEqual(hero.box, { x: 300, y: 150, width: 460, height: 270 }, 'the padded area gave way to the union of the two lines');
        assert.equal(hero.tightened, true, 'the box was narrowed to the OCR line frames');
        assert.deepEqual(hero.bbox, { x: 200, y: 100, width: 600, height: 520 }, 'the area the model drew is kept next to the tightened box');
        assert.equal(hero.typography.fontSize, 100, 'a line of glyphs is 100 px tall');
        assert.equal(hero.typography.lineHeight, 170, 'the step between the two line tops');
        assert.equal(hero.typography.weight, 700, 'bold came from the style flags');
        assert.equal(hero.typography.family, 'Inter');
        assert.deepEqual(note.box, { x: 100, y: 100, width: 300, height: 120 }, 'a layer whose lines leave its box keeps the box');
        assert.equal(note.tightened, false);
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
