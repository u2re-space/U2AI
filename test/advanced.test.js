import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { canRunAdvanced, advancedImageModel, shouldUseReasoningPro, advancedMeasurerProfile, advancedMeasurePhase1, advancedEnhanceCrops, advancedMeasure } from '../src/agent/advanced.js';
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
        assert.equal(headline.confidence, 'medium', 'a box a generation model drew is a hint, not a measurement');
        assert.match(headline.notes, /box approximate/);
        assert.match(headline.notes, /text: Big headline/);
        assert.match(sheet.notes, /OCR на нескольких слоях/);
        assert.match(sheet.assumptions[0], /approximate/);
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
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
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
            regions: [
                { name: '英雄 区域', box: { x: 200, y: 150, width: 600, height: 200 } },
                { name: 'the same object, cut twice', box: { x: 200, y: 150, width: 600, height: 200 } },
                { name: 'a dot', box: { x: 5, y: 5, width: 1, height: 1 } },
                { name: 'off frame', box: { x: 990, y: 790, width: 600, height: 200 } },
            ],
            frame: { width: 1000, height: 800 },
            model: 'seedream-5-5', config: {}, notify: () => {},
        });
        assert.deepEqual(out.warnings, []);
        assert.equal(out.enhancedPaths.length, 1, 'the transparent cut came back from the task');
        assert.deepEqual(calls, ['POST images/generations', 'GET tasks/task-crop'],
            'generation of this model is a task, not a synchronous images call');
        assert.match(out.enhancedPaths[0], /^\.tmp\/[\w-]+\/enhanced-01-[a-z0-9-]+\.png$/, 'the file name stays ASCII');
        assert.equal(bodies[0].background, 'transparent');
        assert.equal(bodies[0].output_format, 'png');
        assert.equal(bodies[0].size, '1K', 'a 600×200 region is under the pixel floor of a pixel frame');
        assert.equal(bodies[0].image_urls.length, 1, 'the region travels in image_urls');
        assert.equal('input_references' in bodies[0], false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the enhanced pass spends the cap on the biggest regions first', async (t) => {
    const exe = await detectMagick({ magickPath: null });
    if (!exe) { t.skip('ImageMagick is not installed, so no region can be cut'); return; }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-cap-'));
    const layerUrl = `data:image/png;base64,${TINY_PNG}`;
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        const client = {
            channels: () => [{
                label: 'https://api.apimart.ai/v1',
                client: {
                    async call(route) {
                        return route === 'images/generations'
                            ? { data: [{ status: 'pending', task_id: 'task-x' }] }
                            : { data: { status: 'completed', result: { images: [{ url: [layerUrl], sizes: ['1024x1024'] }] } } };
                    },
                },
            }],
        };
        const out = await advancedEnhanceCrops({
            root: dir, client, referencePath: 'ref.png', cropPaths: ['x.png'], maxEnhanced: 2,
            regions: [
                { name: 'small', box: { x: 0, y: 0, width: 120, height: 120 } },
                { name: 'huge', box: { x: 0, y: 0, width: 800, height: 600 } },
                { name: 'medium', box: { x: 0, y: 0, width: 400, height: 300 } },
            ],
            frame: { width: 1000, height: 800 },
            model: 'seedream-5-5', config: {}, notify: () => {},
        });
        assert.equal(out.enhancedPaths.length, 2, 'the cap is the cap');
        assert.match(out.enhancedPaths[0], /huge/, 'the biggest region is generated first');
        assert.match(out.enhancedPaths[1], /medium/);
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
                    return { data: { status: 'failed', error: 'generation_timeout' } };
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

test('a reference the moderation refuses is reported as refused, not as a broken request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-policy-'));
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        const refused = await advancedMeasurePhase1({
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
        assert.equal(refused.sheet, null);
        assert.match(text, /отклонено модерацией провайдера \(content_policy_violation\)/);
        assert.doesNotMatch(text, /did not pass content safety review/, 'the vendor sentence about a prompt nobody sent is not repeated');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('the enhanced pass stops buying generations once the moderation refuses the picture', async (t) => {
    const exe = await detectMagick({ magickPath: null });
    if (!exe) { t.skip('ImageMagick is not installed, so no region can be cut'); return; }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-advanced-policy-crops-'));
    const posts = [];
    try {
        await writeFile(path.join(dir, 'ref.png'), pngOf(1000, 800));
        const client = {
            channels: () => [{
                label: 'https://api.apimart.ai/v1',
                client: {
                    async call(route, options = {}) {
                        if (route === 'images/generations') {
                            posts.push(options.body);
                            return { data: [{ task_id: 'task-crop' }] };
                        }
                        return {
                            data: {
                                status: 'failed',
                                error: { message: 'output image may be related to copyright restrictions', code: 'OutputImageSensitiveContentDetected.PolicyViolation' },
                            },
                        };
                    },
                },
            }],
        };
        const out = await advancedEnhanceCrops({
            root: dir, client, referencePath: 'ref.png', cropPaths: ['x.png'],
            regions: [
                { name: 'first', box: { x: 0, y: 0, width: 800, height: 600 } },
                { name: 'second', box: { x: 0, y: 0, width: 400, height: 300 } },
                { name: 'third', box: { x: 500, y: 200, width: 300, height: 300 } },
            ],
            frame: { width: 1000, height: 800 },
            model: 'seedream-5-5', config: {}, notify: () => {},
        });
        assert.equal(posts.length, 1, 'one refusal is enough: every remaining crop is a piece of the same refused picture');
        assert.equal(out.enhancedPaths.length, 0);
        assert.match(out.warnings.join('\n'), /генерация остановлена после отказа модерации/i);
        assert.match(out.warnings.join('\n'), /ещё 2/);
        assert.equal(out.warnings.filter((warning) => /отклонено модерацией/.test(warning)).length, 1);
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
        const result = await advancedMeasurePhase1({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 } }, notify: () => {},
        });
        assert.equal('prompt' in bodies[0], false, 'OCR is asked for, so no prompt travels with the decomposition');
        assert.equal(result.sheet.canvas.width, 500);
        assert.equal(result.sheet.canvas.height, 400);
        const item = [...result.sheet.elements, ...result.sheet.regions][0];
        assert.deepEqual(item.box, { x: 200, y: 150, width: 600, height: 200 }, 'the box is used exactly as the model sent it');
        assert.match(item.name, /^[a-z0-9][a-z0-9-]*$/, 'a CJK layer name does not reach the sheet');
        for (const rel of result.cropPaths) assert.match(rel, /^\.tmp\/[\w./-]+$/, 'file names stay ASCII');
        assert.match(result.warnings.join(' '), /рамки не совпадают/);
        assert.match(result.sheet.assumptions.join(' '), /base image the task returned is 1000x800/);
        assert.match(result.sheet.notes, /Купить/, 'the text the layer carries stays as evidence');
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('advanced measure never sends the Russian plan to the decomposition call', async () => {
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
        const result = await advancedMeasure({
            root: dir, workId: 'w', referencePath: 'ref.png',
            plan: 'Русский план страницы: hero с заголовком и карточками.',
            config: { agent: {} }, client, notify: () => {},
        });
        assert.ok(result.sheet);
        assert.equal('prompt' in bodies[0], false, 'the plan stays out of the vision call, which is what put Cyrillic into the layer names');
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
        const result = await advancedMeasurePhase1({
            root: dir, workId: 'w', client, referencePath: 'ref.png',
            config: { agent: { advancedMaxLayers: 12 } }, notify: () => {},
        });
        const [hero, note] = result.sheet.elements;
        assert.equal(hero.name, 'hero-heading');
        assert.deepEqual(hero.box, { x: 300, y: 150, width: 460, height: 270 }, 'the padded area gave way to the union of the two lines');
        assert.match(hero.notes, /box tightened to the OCR line frames/);
        assert.equal(hero.typography.fontSize, 100, 'a line of glyphs is 100 px tall');
        assert.equal(hero.typography.lineHeight, 170, 'the step between the two line tops');
        assert.equal(hero.typography.weight, 700, 'bold came from the style flags');
        assert.equal(hero.typography.family, 'Inter');
        assert.deepEqual(note.box, { x: 100, y: 100, width: 300, height: 120 }, 'a layer whose lines leave its box keeps the box');
        assert.match(note.notes, /box approximate/);
    } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
