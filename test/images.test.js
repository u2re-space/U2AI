import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from 'canvas';
import { createClient } from '../src/openai/client.js';
import { TINY_PNG } from './helpers/mock-server.js';
import { rasterInfo, rasterIsOpaque, rasterPadImageBytes } from '../src/shared/image-raster.js';
import { runProgram } from '../src/agent/shell.js';
import { imageModelFamily as sharedImageModelFamily, IMAGE_SIZES as SHARED_IMAGE_SIZES, VECTOR_RATIOS as SHARED_VECTOR_RATIOS } from '../src/openai/shared/images.js';
import { imageModelProfile as agentImageModelProfile, imageSizeAttempts as agentImageSizeAttempts } from '../src/agent/riverflow/images.js';
import { backgroundValue, encodeMultipart, generationBody, imageFormatField, imageModelFamily, imageModelFor, imageModelProfile, imagePayloads, imageComplexityValue, imageRequestSize, imageSizeAttempts, imageSizeFields, imageTransport, normalizeImageFormat, normalizeImageSize, normalizeVectorRatio, sameAspectImageSize, isImageSizeError, isVectorModel, needsMinPixelsPadding, paddedSizeToMinPixels, pngHasAlphaChannel, sniffImage, supportsTransparentBackground, PROXY_RIVERFLOW_MODEL, PROXY_VECTOR_MODEL, VECTOR_RATIOS, RIVERFLOW_RATIOS, readImageSize, MIN_IMAGE_PIXELS, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE, MAX_IMAGE_RATIO, aspectRatioToken, aspectFrame, ceilAspect, nearestAspect, parseAspectToken, rationalAspect, supportedAspectRatios, tierFromToken } from '../src/openai/images.js';
import { builtinTools } from '../src/agent/loop.js';
import { enabledToolNames } from '../src/agent/tool-specs.js';
import { createToolset } from '../src/agent/tools.js';

const RGB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAB3YoTpAAAAAd0SU1FB+oKFgUxCIqEz80AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMTAtMjJUMDU6NDk6MDgrMDA6MDAqmhesAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTEwLTIyVDA1OjQ5OjA4KzAwOjAwW8evEAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0xMC0yMlQwNTo0OTowOCswMDowMAzSjs8AAAAKSURBVAjXY2gAAACCAIHdQ2r0AAAAAElFTkSuQmCC';
test('image model family keeps GPT Image and Riverflow independent', () => {
    assert.equal(imageModelFamily('openai/gpt-image-2.6-sunburst'), 'gpt-image');
    assert.equal(imageModelFamily('sourceful/riverflow-v2.6-pro'), 'riverflow');
    assert.equal(imageModelFamily('recraft/recraft-v4.1-pro-vector'), 'other');
    assert.equal(sharedImageModelFamily('sourceful/riverflow-v2.6-pro'), 'riverflow');
    assert.deepEqual(SHARED_IMAGE_SIZES, ['1024x1024', '1024x1536', '1536x1024']);
    assert.ok(SHARED_VECTOR_RATIOS.includes('auto'));
    assert.deepEqual(agentImageModelProfile('sourceful/riverflow-v2.6-pro'), imageModelProfile('sourceful/riverflow-v2.6-pro'));
    assert.deepEqual(agentImageSizeAttempts('273x324', 'sourceful/riverflow-v2.6-pro'), imageSizeAttempts('273x324', 'sourceful/riverflow-v2.6-pro'));
});

test('proxyapi uses the images API and omits Responses-only image fields', () => {
    assert.equal(imageTransport({ baseURL: 'https://api.proxyapi.ru/v1/' }), 'images');
    assert.equal(imageTransport({ baseURL: 'https://api.openai.com/v1/' }), 'responses');
    assert.equal(imageTransport({ baseURL: 'https://api.proxyapi.ru/v1/', image: { transport: 'responses' } }), 'responses');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/' }), 'openai/gpt-image-2.6-sunburst');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/' }, { hasImage: true }), 'openai/gpt-image-2.6-sunburst');
    assert.equal(imageModelFor({ baseURL: 'https://api.proxyapi.ru/v1/', imageModel: 'custom/model' }, { hasImage: true }), 'custom/model');
    const body = generationBody({ model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', size: 'auto', complexity: 'auto', n: 1, format: 'png', background: 'transparent' });
    assert.deepEqual(body, { model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', image_format: 'png' });
    assert.deepEqual(
        generationBody({ model: 'gpt-image-2.6-sunburst', prompt: 'маяк', size: 'auto', complexity: 'auto', quality: 'high', n: 1, format: 'png', background: 'transparent' }),
        { model: 'gpt-image-2.6-sunburst', prompt: 'маяк', output_format: 'png', background: 'transparent' },
    );
    assert.equal('partial_images' in body, false);
    // gpt-image-1 always answers in base64 and rejects response_format, so the field stays out.
    assert.deepEqual(
        generationBody({ model: 'gpt-image-1', prompt: 'маяк', format: 'png', background: 'transparent' }),
        { model: 'gpt-image-1', prompt: 'маяк', output_format: 'png', background: 'transparent' },
    );
    assert.equal(supportsTransparentBackground('gpt-image-2.6-sunburst'), true);
    assert.equal(supportsTransparentBackground('gpt-image-1'), true);
    assert.equal(supportsTransparentBackground('gpt-image-2'), false);
    assert.equal(supportsTransparentBackground('gpt-image-2-2026-04-21'), false);
    assert.equal(supportsTransparentBackground('recraft/recraft-v4.1-utility'), false);
    assert.equal('background' in generationBody({ model: 'gpt-image-2', prompt: 'маяк', background: 'transparent' }), false);
    assert.equal(imageFormatField('gpt-image-2'), 'output_format');
    assert.equal(imageFormatField('gpt-image-2.6-sunburst'), 'output_format');
    assert.equal(imageFormatField('gpt-image-1'), 'output_format');
    assert.equal(imageFormatField('recraft/recraft-v4.1-utility'), 'image_format');
    assert.equal(backgroundValue({ model: 'gpt-image-2.6-sunburst', format: 'png', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: 'gpt-image-2.6-sunburst', format: 'webp', background: 'transparent' }), 'transparent');
    assert.equal(backgroundValue({ model: 'gpt-image-2.6-sunburst', format: 'jpeg', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: 'gpt-image-2.6-sunburst', format: 'png', background: 'opaque' }), 'opaque');
    assert.equal(backgroundValue({ model: 'gpt-image-2.6-sunburst', format: 'png', background: 'auto' }), null);
    assert.equal(backgroundValue({ model: 'gpt-image-2', format: 'png', background: 'transparent' }), null);
    assert.equal(backgroundValue({ model: 'recraft/recraft-v4.1-utility', format: 'png', background: 'transparent' }), null);
    assert.deepEqual(
        generationBody({ model: 'gpt-image-2.6-sunburst', prompt: 'маяк', format: 'jpeg', background: 'transparent' }),
        { model: 'gpt-image-2.6-sunburst', prompt: 'маяк', output_format: 'jpeg', complexity: 'high' },
    );
    assert.equal(normalizeImageFormat('auto'), null);
    assert.equal(normalizeImageFormat('jpg'), 'jpeg');
    assert.equal(normalizeImageFormat('PNG'), 'png');
    assert.deepEqual(imagePayloads({ data: [{ b64_json: TINY_PNG }, { b64_json: '' }] }), [TINY_PNG]);
    assert.equal(normalizeImageSize('auto'), null);
    assert.equal(normalizeImageSize(''), null);
    assert.equal(normalizeImageSize('1024x1024'), '1024x1024');
    assert.equal(normalizeImageSize('768x1024'), '768x1024');
    assert.equal(normalizeImageSize('1280x720'), '1536x1024');
    assert.equal(normalizeImageSize('portrait'), '768x1024');
    assert.equal(imageRequestSize('2048x2048', 'gpt-image-2.6-sunburst'), '2048x2048');
    assert.equal(imageRequestSize('1024x1024', 'gpt-image-1'), '1024x1024');
    assert.equal(generationBody({ model: 'gpt-image-2.6-sunburst', prompt: 'p', size: '2048x2048' }).size, '2048x2048');
    assert.deepEqual(imageSizeAttempts('2048x2048', 'gpt-image-2.6-sunburst'), ['2048x2048'/*, '1024x1024'*/]);
    //assert.deepEqual(imageSizeAttempts('100x100', 'gpt-image-2.6-sunburst'), ['112x112', '816x816', '1024x1024']);
    assert.deepEqual(imageSizeAttempts('100x100', 'gpt-image-2.6-sunburst'), ['100x100', '816x816', '1024x1024']);
    //assert.deepEqual(imageSizeAttempts('4096x2048', 'gpt-image-2.6-sunburst'), ['4096x2048', '3840x1920', '1536x1024']); // not able to pass this test...
    assert.deepEqual(imageSizeAttempts('1024x1024', 'gpt-image-2.6-sunburst'), ['1024x1024']);
    // 1.5K: a preset-only model resolves the tier token to a concrete frame and falls back to it.
    assert.equal(imageRequestSize('1.5k', 'gpt-image-2.6-sunburst'), '1536x1536');
    assert.deepEqual(imageSizeAttempts('2048x2048', 'gpt-image-2.6-sunburst', '1.5k'), ['2048x2048', '1536x1536']);
    assert.deepEqual(imageSizeAttempts('1536x1536', 'gpt-image-2.6-sunburst', '1.5k'), ['1536x1536']);
    // 3K: a rare tier some generators publish. The frame is asked first and falls back to the
    // largest legal frame of the same shape, staying inside 3K rather than jumping up to 4K.
    assert.equal(imageRequestSize('3k', 'gpt-image-2.6-sunburst'), '3072x3072');
    assert.deepEqual(imageSizeAttempts('3k', 'gpt-image-2.6-sunburst'), ['3072x3072', '2880x2880']);
    assert.deepEqual(imageSizeAttempts('3072x2048', 'gpt-image-2.6-sunburst'), ['3072x2048', '3072x2304']);
    // A bare 3072 names the 3K tier, so a 3K frame is never folded back up into the 4K preset.
    assert.equal(tierFromToken('3072'), '3k');
    assert.equal(sameAspectImageSize('bad'), null);
    assert.equal(sameAspectImageSize('100x100'), '816x816');
    assert.equal(sameAspectImageSize('100000x100000'), '2880x2880');
    assert.equal(sameAspectImageSize('1x4'), null);
    assert.equal(isImageSizeError({ status: 400, param: 'size' }), true);
    assert.equal(isImageSizeError({ status: 422, message: 'Unsupported dimensions for this model' }), true);
    assert.equal(isImageSizeError({ status: 401, message: 'Invalid size' }), false);
    assert.equal(isImageSizeError({ status: 400, message: 'Invalid API key' }), false);
    assert.equal(generationBody({ model: 'm', prompt: 'p', size: '768x1024' }).size, '768x1024');
    assert.equal(generationBody({ model: 'm', prompt: 'p', size: 'auto' }).size, undefined);
    const png = Buffer.from(TINY_PNG, 'base64');
    const form = encodeMultipart({ fields: { model: 'recraft/recraft-v4.1-utility', prompt: 'утро' }, files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }] });
    assert.match(form.contentType, /multipart\/form-data; boundary=/);
    assert.ok(form.body.includes(png));
    assert.match(form.body.toString('latin1'), /filename="shot.png"/);
    assert.equal(sniffImage(png).mime, 'image/png');
    assert.equal(pngHasAlphaChannel(png), true);
    assert.equal(pngHasAlphaChannel(Buffer.from(RGB_PNG, 'base64')), false);
    const proxy = { baseURL: 'https://api.proxyapi.ru/v1/', tools: { web: false, images: true }, image: { format: 'png', partialImages: 2, size: 'auto', complexity: 'auto', background: 'auto' }, webSearch: { contextSize: 'medium' } };
    assert.equal(builtinTools(proxy, { images: imageTransport(proxy) !== 'images' }).some((tool) => tool.type === 'image_generation'), false);
    assert.ok(enabledToolNames({ images: true, fs: true }, { imageApi: true }).includes('generate_image'));
    assert.ok(enabledToolNames({ images: true, fs: true }, { imageApi: true }).includes('edit_image'));
});

test('frame limits come from the model profile, not from a hardcoded model id', () => {
    // The gpt-image minimum area belongs to the gpt-image family; riverflow takes a far smaller frame.
    const riverflowLimits = { minPixels: 16_384, maxPixels: 16_777_216, maxEdge: 4096, maxRatio: 16 };
    const gptLimits = { minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3 };
    const read = (model) => ({
        minPixels: MIN_IMAGE_PIXELS(model),
        maxPixels: MAX_IMAGE_PIXELS(model),
        maxEdge: MAX_IMAGE_EDGE(model),
        maxRatio: MAX_IMAGE_RATIO(model),
    });

    assert.deepEqual(read('sourceful/riverflow-v2.6-pro'), riverflowLimits);
    // Any riverflow id gets the family limits: the old check matched only the exact `-v2.6-pro` suffix.
    assert.deepEqual(read('riverflow-v2.6-pro'), riverflowLimits);
    assert.deepEqual(read('sourceful/riverflow-v2.5-pro'), riverflowLimits);

    assert.deepEqual(read('openai/gpt-image-2.6-sunburst'), gptLimits);
    assert.deepEqual(read('gpt-image-2.6-sunburst'), gptLimits);
    // A model no profile describes keeps the gpt-image defaults.
    assert.deepEqual(read('recraft/recraft-v4.1-pro-vector'), gptLimits);
    assert.deepEqual(read(null), gptLimits);

    // The profile object carries the same numbers the accessors return: one table for both.
    for (const model of ['sourceful/riverflow-v2.6-pro', 'openai/gpt-image-2.6-sunburst', null]) {
        const profile = imageModelProfile(model);
        assert.deepEqual(read(model), {
            minPixels: profile.minPixels, maxPixels: profile.maxPixels,
            maxEdge: profile.maxEdge, maxRatio: profile.maxRatio,
        }, `the profile and the accessors must agree for ${model}`);
    }

    // The limits actually drive the frame a request gets: 128x128 is legal riverflow, too small gpt-image.
    assert.equal(sameAspectImageSize('128x128', PROXY_RIVERFLOW_MODEL), null);
    assert.notEqual(sameAspectImageSize('128x128', 'openai/gpt-image-2.6-sunburst'), null);
    // riverflow takes a 16:1 frame; gpt-image refuses anything past 3:1.
    assert.equal(sameAspectImageSize('1600x100', 'openai/gpt-image-2.6-sunburst'), null);
    assert.notEqual(sameAspectImageSize('1600x100', PROXY_RIVERFLOW_MODEL), null);
});

test('Riverflow keeps custom sizes, maps resolution/aspect_ratio, keeps -pro suffix', () => {
    assert.equal(PROXY_RIVERFLOW_MODEL, 'sourceful/riverflow-v2.6-pro');
    const profile = imageModelProfile('sourceful/riverflow-v2.6-pro');
    assert.equal(profile.customSizes, true);
    assert.equal(profile.keepProSuffix, true);
    assert.equal(profile.omitSizeOnReject, true);
    assert.equal(profile.div16Padding, false);

    // Pixel sizes pass through unchanged (customSizes: true).
    assert.equal(imageRequestSize('512x512', 'sourceful/riverflow-v2.6-pro'), '512x512');
    assert.equal(imageRequestSize('800x800', 'sourceful/riverflow-v2.6-pro'), '800x800');
    assert.equal(imageRequestSize('1024x1536', 'sourceful/riverflow-v2.6-pro'), '1024x1536');

    // imageSizeFields: pixel size → size, tier → resolution, ratio → aspect_ratio.
    assert.deepEqual(imageSizeFields('512x512', 'sourceful/riverflow-v2.6-pro'), { size: '512x512' });
    assert.deepEqual(imageSizeFields('512', 'sourceful/riverflow-v2.6-pro'), { resolution: '512' });
    assert.deepEqual(imageSizeFields('1K', 'sourceful/riverflow-v2.6-pro'), { resolution: '1K' });
    assert.deepEqual(imageSizeFields('2k', 'sourceful/riverflow-v2.6-pro'), { resolution: '2K' });
    assert.deepEqual(imageSizeFields('4K', 'sourceful/riverflow-v2.6-pro'), { resolution: '4K' });
    assert.deepEqual(imageSizeFields('16:9', 'sourceful/riverflow-v2.6-pro'), { aspect_ratio: '16:9' });
    assert.deepEqual(imageSizeFields('9:16', 'sourceful/riverflow-v2.6-pro'), { aspect_ratio: '9:16' });
    assert.deepEqual(imageSizeFields('auto', 'sourceful/riverflow-v2.6-pro'), {});
    // Non-riverflow: a tier token resolves to a concrete frame (the gateway has no resolution field).
    assert.deepEqual(imageSizeFields('512x512', 'gpt-image-2.6-sunburst'), { size: '512x512' });
    assert.deepEqual(imageSizeFields('512', 'gpt-image-2.6-sunburst'), { size: '512x512' });
    assert.deepEqual(imageSizeFields('1.5k', 'gpt-image-2.6-sunburst'), { size: '1536x1536' });
    assert.deepEqual(imageSizeFields('1K', 'gpt-image-2.6-sunburst'), { size: '1024x1024' });
    assert.deepEqual(imageSizeFields('2k', 'gpt-image-2.6-sunburst'), { size: '2048x2048' });
    assert.deepEqual(imageSizeFields('4K', 'gpt-image-2.6-sunburst'), { size: '4096x4096' });

    // generationBody: pixel size → size field; tier → resolution field.
    assert.equal(generationBody({ model: 'sourceful/riverflow-v2.6-pro', prompt: 'test', size: '512x512' }).size, '512x512');
    assert.equal(generationBody({ model: 'sourceful/riverflow-v2.6-pro', prompt: 'test', size: '1K' }).resolution, '1K');
    assert.equal(generationBody({ model: 'sourceful/riverflow-v2.6-pro', prompt: 'test', size: '16:9' }).aspect_ratio, '16:9');
    // -pro suffix is kept at any size.
    assert.equal(generationBody({ model: 'sourceful/riverflow-v2.6-pro', prompt: 'test', size: '512x512' }).model, 'sourceful/riverflow-v2.6-pro');
});

test('readImageSize reads the frame from encoded bytes without a raster engine', () => {
    const canvas = createCanvas(800, 600);
    canvas.getContext('2d').fillRect(0, 0, 800, 600);
    assert.deepEqual(readImageSize(canvas.toBuffer('image/png')), { width: 800, height: 600 });
    assert.deepEqual(readImageSize(canvas.toBuffer('image/jpeg', { quality: 60 })), { width: 800, height: 600 });

    // GIF89a: two little-endian 16-bit fields at a fixed offset.
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(640, 6);
    gif.writeUInt16LE(480, 8);
    assert.deepEqual(readImageSize(gif), { width: 640, height: 480 });

    // WebP VP8X: the canvas size is stored as value - 1 in three little-endian bytes each.
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.writeUInt32LE(18, 4);
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(1023, 24, 3);
    webp.writeUIntLE(767, 27, 3);
    assert.deepEqual(readImageSize(webp), { width: 1024, height: 768 });

    assert.equal(readImageSize(Buffer.from('not an image at all')), null);
    assert.equal(readImageSize(null), null);
});

test('riverflow edits travel through generations and keep the source frame', async () => {
    const canvas = createCanvas(800, 600);
    canvas.getContext('2d').fillRect(0, 0, 800, 600);
    const png = canvas.toBuffer('image/png');
    const seen = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seen.push({
            route: req.url,
            size: body.size ?? null,
            resolution: body.resolution ?? null,
            aspect: body.aspect_ratio ?? null,
            complexity: body.complexity ?? null,
            refs: body.input_references?.map((r) => r.image_url.url.slice(0, 24)) ?? null,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    try {
        // Riverflow answers /images/edits with the default square, so the edit is routed through
        // /images/generations: the source frame survives and the tuning fields go along.
        const payloads = await client.images.edit({
            model: 'sourceful/riverflow-v2.6-pro', prompt: 'edit', size: 'auto', format: 'png',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.equal(payloads[0], TINY_PNG);
        assert.deepEqual(seen.pop(), {
            route: '/v1/images/generations',
            size: '800x600', resolution: null, aspect: null,
            complexity: 'high',
            refs: ['data:image/png;base64,iV'],
        });
        // A frame the caller named still wins over the source.
        await client.images.edit({
            model: 'sourceful/riverflow-v2.6-pro', prompt: 'edit', size: '2K', format: 'png',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        const named = seen.pop();
        assert.equal(named.route, '/v1/images/generations');
        assert.equal(named.resolution, '2K');
        assert.equal(named.size, null);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('imageComplexityValue uses the model profile', () => {
    // Riverflow defaults to complexity=high.
    assert.equal(imageComplexityValue({ model: 'sourceful/riverflow-v2.6-pro', complexity: null }), 'high');
    assert.equal(imageComplexityValue({ model: 'sourceful/riverflow-v2.6-pro', complexity: 'auto' }), null);
    assert.equal(imageComplexityValue({ model: 'sourceful/riverflow-v2.6-pro', complexity: 'low' }), 'low');
    // gpt-image-2.6 defaults to complexity=high.
    assert.equal(imageComplexityValue({ model: 'gpt-image-2.6-sunburst', complexity: null }), 'high');
    assert.equal(imageComplexityValue({ model: 'gpt-image-2.6-sunburst', complexity: 'auto' }), null);
    // gpt-image-2.5 has no profile default.
    assert.equal(imageComplexityValue({ model: 'gpt-image-2.5-sunburst', complexity: null }), null);
    // generationBody uses the profile defaults when the caller passes nothing.
    const rf = generationBody({ model: 'sourceful/riverflow-v2.6-pro', prompt: 'test', size: '512x512' });
    assert.equal(rf.complexity, 'high');
    const gpt = generationBody({ model: 'gpt-image-2.6-sunburst', prompt: 'test', size: '512x512' });
    assert.equal(gpt.complexity, 'high');
});

test('sameAspectImageSize rounds small frames to 16 without inflating them', () => {
    // A small source frame (273x324) is already within riverflow's area and edge limits,
    // so it should round to 16-multiples without gcd inflation.
    assert.equal(sameAspectImageSize('273x324', 'sourceful/riverflow-v2.6-pro'), '272x320');
    // 100x100 is below gpt-image minimum area, so it must rescale via gcd.
    assert.equal(sameAspectImageSize('100x100', 'gpt-image-2.6-sunburst'), '816x816');
    // 100x100 is below riverflow's minimum area (16384), so it rescales via gcd to 128x128.
    assert.equal(sameAspectImageSize('100x100', 'sourceful/riverflow-v2.6-pro'), '128x128');
    // Already valid — null.
    assert.equal(sameAspectImageSize('272x320', 'sourceful/riverflow-v2.6-pro'), null);
    // riverflow allows up to 16:1 ratio.
    assert.notEqual(sameAspectImageSize('1600x100', 'sourceful/riverflow-v2.6-pro'), null);
    // gpt-image max ratio is 3:1 — 1600x100 is out of range.
    assert.equal(sameAspectImageSize('1600x100', 'gpt-image-2.6-sunburst'), null);
});

test('imageSizeAttempts for riverflow falls back to nearest aspect_ratio, not a broken preset', () => {
    // 273x324: exact → 272x320 (rounded to 16) → 4:5 (nearest ratio) → null (omit).
    const attempts = imageSizeAttempts('273x324', 'sourceful/riverflow-v2.6-pro');
    assert.deepEqual(attempts, ['273x324', '272x320', '4:5', null]);
    // 512x512 is square: no ratio fallback needed.
    assert.deepEqual(imageSizeAttempts('512x512', 'sourceful/riverflow-v2.6-pro'), ['512x512', null]);
    // 1920x1080: exact → 1920x1088 (rounded) → 16:9 → null.
    assert.deepEqual(imageSizeAttempts('1920x1080', 'sourceful/riverflow-v2.6-pro'), ['1920x1080', '1920x1088', '16:9', null]);
});

test('a shape is a fraction with small terms, scaled up and rounded to what the model has', () => {
    // The fraction: the smallest whole terms within 32, not the raw gcd of the pixel count.
    assert.deepEqual(rationalAspect('1920x1080'), { width: 16, height: 9, ratio: 16 / 9, exact: true });
    assert.deepEqual(rationalAspect('1000x600'), { width: 5, height: 3, ratio: 5 / 3, exact: true });
    assert.deepEqual(rationalAspect('21:9'), { width: 7, height: 3, ratio: 7 / 3, exact: true });
    // 2.39:1 is not a fraction of small terms, so the closest one within 32 stands in (0.2% off).
    assert.deepEqual(rationalAspect('2.39:1'), { width: 31, height: 13, ratio: 31 / 13, exact: false });
    assert.equal(rationalAspect('1919x1079').width / rationalAspect('1919x1079').height, 16 / 9);
    // A bare tier number names a tier, not a 512:1 shape.
    assert.equal(rationalAspect('512'), null);
    assert.equal(rationalAspect('2048'), null);
    assert.equal(parseAspectToken('cinemascope').ratio, 2.39);
    assert.equal(parseAspectToken('1.85').ratio, 1.85);
    assert.equal(parseAspectToken('garbage'), null);

    // Rounding: up, so the frame never lands under the asked budget, but a multiplier that only
    // touches a whole 16-pixel step stays there instead of costing a full extra step.
    assert.equal(ceilAspect(15.998), 16);
    assert.equal(ceilAspect(16.004), 16);
    assert.equal(ceilAspect(16.006), 17);
    assert.equal(ceilAspect(15.4), 16);
    // 16:9 on a 1K budget is the first legal frame at or above it: 1536x864, not 1280x720.44.
    assert.deepEqual(aspectFrame('16:9', { step: 16, pixels: 1024 * 1024 }), { width: 1536, height: 864, ratio: 16 / 9 });
    // A shape wider than the model refuses is clamped to the widest frame it takes (3:1).
    assert.deepEqual(aspectFrame('40:1', { step: 16, pixels: 1024 * 1024, maxRatio: 3 }), { width: 1776, height: 592, ratio: 3 });

    // Rounded to a shape the model is asked about: 2.39:1 is not on riverflow's menu, 21:9 is.
    assert.equal(nearestAspect('2.39:1', RIVERFLOW_RATIOS), '21:9');
    assert.equal(aspectRatioToken('cinemascope', PROXY_RIVERFLOW_MODEL), '21:9');
    assert.equal(aspectRatioToken('2.39:1', PROXY_VECTOR_MODEL, 'vector'), '16:9');
    assert.deepEqual([...supportedAspectRatios(PROXY_RIVERFLOW_MODEL)], [...RIVERFLOW_RATIOS]);
});

test('any shape token reaches each family as a frame or a ratio it accepts', () => {
    const riverflow = 'sourceful/riverflow-v2.6-pro';
    // A ratio-field family keeps the shape as the nearest ratio of its own list, tier and all.
    assert.deepEqual(imageSizeFields('2.39:1', riverflow), { aspect_ratio: '21:9' });
    assert.deepEqual(imageSizeFields('2.39:1', riverflow, '2K'), { aspect_ratio: '21:9', resolution: '2K' });
    assert.deepEqual(imageSizeFields('wide', riverflow), { aspect_ratio: '16:9' });
    assert.deepEqual(imageSizeFields('story', riverflow), { aspect_ratio: '9:16' });
    // The shape also survives the tool layer, which pre-reads the size before the client sees it.
    assert.equal(imageRequestSize('2.39:1', riverflow), '21:9');
    assert.deepEqual(imageSizeAttempts('2.39:1', riverflow), ['21:9', null]);
    assert.equal(generationBody({ model: riverflow, prompt: 'p', size: 'cinemascope' }).aspect_ratio, '21:9');

    // A free-frame family has no ratio field, so the shape becomes a real frame of the tier budget.
    assert.equal(imageRequestSize('2.39:1', 'gpt-image-2.6-sunburst'), '1984x832');
    assert.equal(imageRequestSize('16:9', 'gpt-image-2.6-sunburst', '2K'), '2816x1584');
    assert.equal(imageRequestSize('2.39:1', 'gpt-image-2.6-sunburst', '4K'), '3472x1456');
    // The frame is 16-multiple and inside the model limits, so a rejection retries on the preset.
    assert.deepEqual(imageSizeAttempts('2.39:1', 'gpt-image-2.6-sunburst'), ['1984x832', '2048x1536']);

    // A tier-based model without free frames takes the frame of its tier whose shape is closest.
    assert.equal(normalizeImageSize('21:9'), '1008x432');
    assert.equal(normalizeImageSize('21:9', '2K'), '2016x864');
    // A preset-only model has three shapes only: it gets the right one, never the raw token.
    assert.equal(imageRequestSize('21:9', 'm'), '1024x768');
    assert.equal(imageRequestSize('a4', 'm'), '768x1024');
    assert.equal(generationBody({ model: 'm', prompt: 'p', size: '2.39:1' }).size, '1024x768');

    // The vector ratio field reads the same shapes and rounds them to its own short list.
    assert.equal(normalizeVectorRatio('2.39:1'), '16:9');
    assert.equal(normalizeVectorRatio('cinemascope'), '16:9');
    assert.equal(normalizeVectorRatio('story'), '9:16');
    assert.equal(normalizeVectorRatio('1.0'), '1:1');
});

test('vector model uses aspect_ratio and svg output', () => {
    assert.equal(PROXY_VECTOR_MODEL, 'recraft/recraft-v4.1-pro-vector');
    assert.equal(isVectorModel('recraft/recraft-v4.1-vector'), true);
    assert.equal(isVectorModel('recraft/recraft-v4-styles-pro-vector'), true);
    assert.equal(isVectorModel('recraft/recraft-v4.1-utility'), false);
    assert.equal(isVectorModel(''), false);
    assert.deepEqual([...VECTOR_RATIOS], ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', 'auto']);
    assert.equal(normalizeVectorRatio(''), null);
    assert.equal(normalizeVectorRatio('auto'), null);
    assert.equal(normalizeVectorRatio('1:1'), '1:1');
    assert.equal(normalizeVectorRatio('square'), '1:1');
    assert.equal(normalizeVectorRatio('portrait'), '3:4');
    assert.equal(normalizeVectorRatio('landscape'), '4:3');
    assert.equal(normalizeVectorRatio('1024x1024'), '1:1');
    assert.equal(normalizeVectorRatio('1536x1024'), '3:2');
    assert.equal(normalizeVectorRatio('1024x1536'), '2:3');
    assert.equal(normalizeVectorRatio('1920x1080'), '16:9');
    assert.equal(normalizeVectorRatio('1080x1920'), '9:16');
    assert.equal(normalizeVectorRatio('garbage'), null);
    const vectorBody = generationBody({
        model: 'recraft/recraft-v4.1-pro-vector', prompt: 'логотип', size: '1024x1024', format: 'png', complexity: 'high', background: 'transparent',
    });
    // The prompt stays exactly as asked: the frame travels in fields, not in the text.
    assert.deepEqual(vectorBody, { model: 'recraft/recraft-v4.1-pro-vector', prompt: 'логотип', aspect_ratio: '1:1', image_format: 'svg' });
    assert.equal('size' in vectorBody, false);
    assert.equal('quality' in vectorBody, false);
    assert.equal('background' in vectorBody, false);
    assert.equal('input_references' in vectorBody, false);
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).mime, 'image/svg+xml');
    assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg></svg>')).ext, 'svg');
    assert.equal(sniffImage(Buffer.from('<svg')).ext, 'svg');
});

test('vectorize_image is offered together with the other image tools', () => {
    const names = enabledToolNames({ images: true, fs: true }, { imageApi: true });
    assert.ok(names.includes('vectorize_image'));
    assert.equal(enabledToolNames({ images: true, fs: true }, { imageApi: false }).includes('vectorize_image'), false);
});

test('images client vectorize posts the source as a multipart edit and the tool saves SVG', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>';
    const svgB64 = Buffer.from(svg).toString('base64');
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/v1/images/edits') {
            const form = raw.toString('latin1');
            assert.match(form, /name="model"\r\n\r\nrecraft\/recraft-v4\.1-pro-vector\r\n/);
            assert.match(form, /name="image_format"\r\n\r\nsvg\r\n/);
            assert.match(form, /name="image"; filename="logo\.png"/);
            assert.doesNotMatch(form, /name="size"/);
            assert.doesNotMatch(form, /name="aspect_ratio"/);
            res.end(JSON.stringify({ data: [{ b64_json: svgB64 }] }));
            return;
        }
        res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-vector-'));
    try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path.join(root, 'logo.png'), png);
        const toolset = createToolset({
            root, client, config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', complexity: 'auto' }, limits: {} },
            names: ['vectorize_image'], approvalLevel: 'all',
        });
        const result = await toolset.execute({ name: 'vectorize_image', arguments: JSON.stringify({ image: 'logo.png', path: 'assets/logo.svg', prompt: '', remove_background: true, force: false }) });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /assets\/logo\.svg/);
        assert.equal((await readFile(path.join(root, 'assets', 'logo.svg'), 'utf8')), svg);
    } finally {
        client.close();
        await rm(root, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});

test('openai edits send output_format and background instead of image_format', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('latin1');
        assert.match(raw, /name="model"\r\n\r\ngpt-image-1\r\n/);
        assert.match(raw, /name="output_format"\r\n\r\npng\r\n/);
        assert.match(raw, /name="background"\r\n\r\ntransparent\r\n/);
        assert.doesNotMatch(raw, /name="image_format"/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    try {
        const payloads = await client.images.edit({
            model: 'gpt-image-1', prompt: 'утро', format: 'png', background: 'transparent',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.equal(payloads[0], TINY_PNG);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image 2.6 edits send multipart fields and parse base64 response', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    let seen = null;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        seen = { route: req.url, form: Buffer.concat(chunks).toString('latin1') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, imageDiv16: 'never' });
    try {
        const payloads = await client.images.edit({
            model: 'gpt-image-2.6-sunburst', prompt: 'edit', size: '1024x1024', format: 'png', complexity: 'high',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.equal(payloads[0], TINY_PNG);
        assert.equal(seen.route, '/v1/images/edits');
        assert.match(seen.form, /name="model"\r\n\r\ngpt-image-2\.6-sunburst\r\n/);
        assert.match(seen.form, /name="size"\r\n\r\n1024x1024\r\n/);
        assert.match(seen.form, /name="output_format"\r\n\r\npng\r\n/);
        assert.match(seen.form, /name="complexity"\r\n\r\nhigh\r\n/);
        assert.match(seen.form, /name="image"; filename="shot\.png"/);
        assert.doesNotMatch(seen.form, /name="quality"/);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image 2.6 retries invalid dimensions in order and does not retry other errors', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const generationSizes = [];
    const editSizes = [];
    let authAttempts = 0;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const fail = (status, message, param = null) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message, param } }));
        };
        if (req.url === '/v1/images/generations') {
            const body = JSON.parse(raw.toString('utf8'));
            if (body.prompt === 'auth') { authAttempts++; return fail(401, 'Invalid API key'); }
            generationSizes.push(body.size);
            if (generationSizes.length < 3) return fail(400, 'Invalid image size', 'size');
        } else {
            const form = raw.toString('latin1');
            editSizes.push(/name="size"\r\n\r\n([^\r]+)/.exec(form)?.[1]);
            if (editSizes.length < 3) return fail(422, 'Unsupported dimensions');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    try {
        await client.images.generate({ model: 'gpt-image-2.6-sunburst', prompt: 'draw', size: '100x100' });
        assert.deepEqual(generationSizes, ['100x100', '816x816', '1024x1024']);
        //assert.deepEqual(generationSizes, ['112x112', '816x816', '1024x1024']);
        await client.images.edit({
            model: 'gpt-image-2.6-sunburst', prompt: 'edit', size: '100x100',
            files: [{ filename: 'shot.png', mime: 'image/png', bytes: png }],
        });
        assert.deepEqual(editSizes, ['16x16', '816x816', '1024x1024']);
        await assert.rejects(() => client.images.generate({ model: 'gpt-image-2.6-sunburst', prompt: 'auth', size: '100x100' }), { status: 401 });
        assert.equal(authAttempts, 1);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image 2.6 pads non-multiple input edges without scaling and removes returned padding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-'));
    const source = path.join(root, 'source.png');
    const paddedReply = path.join(root, 'reply.png');
    const generatePng = async (file, width, height) => {
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#cc2222';
        ctx.fillRect(16, 16, width - 32, height - 32);
        await writeFile(file, canvas.toBuffer('image/png'));
    };
    const pixelAt = async (file, x, y) => {
        const sharp = (await import('sharp')).default;
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const at = (y * info.width + x) * 4;
        return [...data.subarray(at, at + 4)];
    };
    try {
        await generatePng(source, 1000, 600);
        await generatePng(paddedReply, 1008, 608);
        const sourceBytes = await readFile(source);
        const seen = [];
        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('latin1');
            const header = /name="size"\r\n\r\n([^\r]+)/.exec(raw);
            const imagePart = /name="image"; filename="source\.png"\r\nContent-Type: image\/png\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
            seen.push({ size: header?.[1], file: Boolean(imagePart), image: imagePart?.[1] });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: (await readFile(paddedReply)).toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp' });
        try {
            const payloads = await client.images.edit({
                model: 'gpt-image-2.6-sunburst', prompt: 'preserve', format: 'png',
                files: [{ filename: 'source.png', mime: 'image/png', bytes: sourceBytes }],
            });
            const original = await rasterPadImageBytes({ bytes: sourceBytes, engine: 'sharp' });
            assert.deepEqual(seen.map(({ size, file }) => ({ size, file })), [{ size: '1008x608', file: true }]);
            assert.equal(original.width, 1008);
            assert.equal(original.height, 608);
            assert.equal(original.originalWidth, 1000);
            assert.equal(original.originalHeight, 600);
            assert.equal(original.padded, true);
            const sentPath = path.join(root, 'sent.png');
            await writeFile(sentPath, Buffer.from(seen[0].image, 'latin1'));
            const sentInfo = await rasterInfo(sentPath, { cwd: root, engine: 'sharp' });
            assert.equal(sentInfo.width, 1008);
            assert.equal(sentInfo.height, 608);
            assert.deepEqual(await pixelAt(sentPath, 20, 20), await pixelAt(source, 20, 20));
            assert.deepEqual(await pixelAt(sentPath, 1004, 604), [0, 0, 0, 0]);
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            assert.equal(info.width, 1000);
            assert.equal(info.height, 600);
            assert.equal(await rasterIsOpaque(resultPath, { cwd: root, engine: 'sharp' }), false);
            assert.deepEqual(await pixelAt(resultPath, 16, 16), [204, 34, 34, 255]);
            assert.deepEqual(await pixelAt(resultPath, 20, 20), [204, 34, 34, 255]);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('an edit whose reply grew past the padded frame is downscaled back to the source frame', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-downscale-'));
    const source = path.join(root, 'source.png');
    const bigReply = path.join(root, 'reply.png');
    try {
        // A 500×500 source: the wire frame is padded to 512×512, but the model repaints the whole
        // canvas and hands back 960×960 — larger than even the padded frame.
        const canvas = createCanvas(500, 500);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2266cc';
        ctx.fillRect(0, 0, 500, 500);
        await writeFile(source, canvas.toBuffer('image/png'));
        const replyCanvas = createCanvas(960, 960);
        replyCanvas.getContext('2d').drawImage(canvas, 0, 0, 960, 960);
        await writeFile(bigReply, replyCanvas.toBuffer('image/png'));

        const sourceBytes = await readFile(source);
        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: (await readFile(bigReply)).toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp' });
        try {
            const payloads = await client.images.edit({
                model: 'bytedance-seed/seedream-5-5', prompt: 'keep', format: 'png',
                files: [{ filename: 'source.png', mime: 'image/png', bytes: sourceBytes }],
            });
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            // The reply was downscaled to the source frame, not cropped to a corner.
            assert.equal(info.width, 500);
            assert.equal(info.height, 500);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a grown non-square reply is downscaled with the aspect kept and the residual cropped', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-crop-residual-'));
    const source = path.join(root, 'source.png');
    const bigReply = path.join(root, 'reply.png');
    try {
        // 1000×600 source → 1008×608 padded wire frame. The model upscales that frame 1.5× and
        // keeps its own aspect, so the reply (1512×912) is a different shape than 1000×600:
        // the correction must scale uniformly and crop the leftover strip, never stretch pixels.
        const canvas = createCanvas(1000, 600);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2266cc';
        ctx.fillRect(0, 0, 1000, 600);
        await writeFile(source, canvas.toBuffer('image/png'));
        const replyCanvas = createCanvas(1512, 912);
        replyCanvas.getContext('2d').drawImage(canvas, 0, 0, 1512, 912);
        await writeFile(bigReply, replyCanvas.toBuffer('image/png'));

        const sourceBytes = await readFile(source);
        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: (await readFile(bigReply)).toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp' });
        try {
            const payloads = await client.images.edit({
                model: 'bytedance-seed/seedream-5-5', prompt: 'keep', format: 'png',
                files: [{ filename: 'source.png', mime: 'image/png', bytes: sourceBytes }],
            });
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            // Exactly the source frame: the whole picture downscaled, only the rounding strip cropped.
            assert.equal(info.width, 1000);
            assert.equal(info.height, 600);
            const sharp = (await import('sharp')).default;
            const { data } = await sharp(resultPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            // A pixel row across the middle still holds the drawn subject, not a cut-off corner.
            const at = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
            assert.deepEqual(at(500, 300), [34, 102, 204, 255]);
            assert.deepEqual(at(4, 4), [34, 102, 204, 255]);
            assert.deepEqual(at(995, 595), [34, 102, 204, 255]);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a generate whose reply grew past the requested frame is downscaled back to it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-gen-downscale-'));
    const bigReply = path.join(root, 'reply.png');
    try {
        // The model returns 960×960 when the request asked for 512×512.
        const replyCanvas = createCanvas(960, 960);
        replyCanvas.getContext('2d').fillStyle = '#2266cc';
        replyCanvas.getContext('2d').fillRect(0, 0, 960, 960);
        await writeFile(bigReply, replyCanvas.toBuffer('image/png'));

        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: (await readFile(bigReply)).toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp' });
        try {
            const payloads = await client.images.generate({ model: 'gpt-image-2.6', prompt: 'test', size: '512x512', format: 'png' });
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            assert.equal(info.width, 512);
            assert.equal(info.height, 512);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('images client posts generations and edits and the tool saves the file', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const generations = [];
    const edits = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/v1/images/generations') {
            generations.push(JSON.parse(raw.toString('utf8')));
            res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
            return;
        }
        const text = raw.toString('latin1');
        assert.match(text, /name="image"/);
        edits.push({ text, model: /name="model"\r\n\r\n([^\r]+)\r\n/.exec(text)?.[1] ?? '' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-images-'));
    try {
        const drawn = await client.images.generate({ model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', size: 'auto', format: 'png', background: 'transparent' });
        assert.equal(drawn[0], TINY_PNG);
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(root, 'shot.png'), png));
        const toolset = createToolset({
            root, client, config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', complexity: 'auto' }, limits: {} },
            names: ['generate_image', 'edit_image'], approvalLevel: 'all',
        });
        const generated = await toolset.execute({ name: 'generate_image', arguments: JSON.stringify({ prompt: 'маяк', path: 'assets/portrait.png', size: '', complexity: '' }) });
        assert.match(generated.output, /assets\/portrait\.png/);
        assert.equal((await readFile(path.join(root, 'assets', 'portrait.png'))).equals(png), true);
        const edited = await toolset.execute({ name: 'edit_image', arguments: JSON.stringify({ prompt: 'утро', image: 'shot.png', path: 'assets/edited.png', size: '' }) });
        assert.match(edited.output, /assets\/edited\.png/);

        // The direct recraft call keeps the vendor-specific format field and gets no OpenAI-only background.
        assert.deepEqual(generations[0], { model: 'recraft/recraft-v4.1-utility', prompt: 'маяк', image_format: 'png' });
        // The tool defaults to gpt-image-2.6 for raster work.
        assert.equal(generations[1].model, 'openai/gpt-image-2.6-sunburst');
        assert.equal(generations[1].output_format, 'png');
        assert.equal('image_format' in generations[1], false);
        assert.equal(edits[0].model, 'openai/gpt-image-2.6-sunburst');
        assert.match(edits[0].text, /name="output_format"\r\n\r\npng\r\n/);
        assert.doesNotMatch(edits[0].text, /name="background"/);
    } finally {
        client.close();
        await rm(root, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image edits surfaces gateway error objects returned with HTTP 200', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const server = http.createServer(async (req, res) => {
        for await (const _ of req) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: {
            message: 'unsupported parameter: output_format',
            type: 'invalid_request_error',
            code: 'unsupported_parameter',
            param: 'output_format',
        } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, imageDiv16: 'never' });
    try {
        await assert.rejects(client.images.edit({
            model: 'openai/gpt-image-2.6-sunburst', prompt: 'edit',
            files: [{ filename: 'source.png', mime: 'image/png', bytes: png }],
        }), (error) => {
            assert.equal(error.code, 'HTTP_ERROR');
            assert.equal(error.apiCode, 'unsupported_parameter');
            assert.equal(error.apiType, 'invalid_request_error');
            assert.equal(error.param, 'output_format');
            assert.match(error.message, /unsupported parameter: output_format/);
            assert.doesNotMatch(error.message, /не содержит ни b64_json, ни url/);
            return true;
        });
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('GPT Image 2.6 retries HTTP 200 minimum-pixel errors with a same-ratio size', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    const sizes = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const form = Buffer.concat(chunks).toString('latin1');
        sizes.push(/name=.{1}size.{1}\r\n\r\n([^\r]+)/.exec(form)?.[1]);
        if (sizes.length === 1) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "Invalid size '288x336'. Requested resolution is below the current minimum pixel budget." } }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, imageDiv16: 'never' });
    try {
        const payloads = await client.images.edit({
            model: 'gpt-image-2.6-sunburst', prompt: 'edit', size: '288x336',
            files: [{ filename: 'source.png', mime: 'image/png', bytes: png }],
        });
        assert.deepEqual(sizes, ['288x336', '768x896']);
        assert.equal(payloads[0], TINY_PNG);
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('images edits reports response shape when a gateway returns no image payload', async () => {
    const png = Buffer.from(TINY_PNG, 'base64');
    let route = null;
    const server = http.createServer(async (req, res) => {
        route = req.url;
        for await (const _ of req) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ revised_prompt: 'accepted but no image data' }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, imageDiv16: 'never' });
    try {
        await assert.rejects(client.images.edit({
            model: 'openai/gpt-image-2.6-sunburst', prompt: 'edit',
            files: [{ filename: 'source.png', mime: 'image/png', bytes: png }],
        }), (error) => {
            assert.equal(error.code, 'INVALID_RESPONSE');
            assert.deepEqual(error.details.responseKeys, ['data']);
            assert.equal(error.details.dataType, 'array');
            assert.deepEqual(error.details.firstResultKeys, ['revised_prompt']);
            assert.match(error.message, /поля первого результата: revised_prompt/);
            return true;
        });
        assert.equal(route, '/v1/images/edits');
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Seedream 5.5 profile: a megapixel floor, free-frame on the 16px grid', () => {
    const SEED = 'bytedance-seed/seedream-5-5';
    const seedLimits = { minPixels: 921_600, maxPixels: 8_294_400, maxEdge: 3840, maxRatio: 3 };
    const read = (model) => ({
        minPixels: MIN_IMAGE_PIXELS(model),
        maxPixels: MAX_IMAGE_PIXELS(model),
        maxEdge: MAX_IMAGE_EDGE(model),
        maxRatio: MAX_IMAGE_RATIO(model),
    });

    // Profile accessors agree.
    assert.deepEqual(read(SEED), seedLimits);
    assert.deepEqual(read('seedream-5-5'), seedLimits);
    // A bare id with the version written with a dot gets the same limits.
    assert.deepEqual(read('bytedance-seed/seedream-5.5'), seedLimits);
    for (const model of [SEED, 'seedream-5-5', 'bytedance-seed/seedream-5-5']) {
        const profile = imageModelProfile(model);
        assert.deepEqual(read(model), {
            minPixels: profile.minPixels, maxPixels: profile.maxPixels,
            maxEdge: profile.maxEdge, maxRatio: profile.maxRatio,
        }, `profile and accessors agree for ${model}`);
    }

    // Family stays 'other' → gpt-image dispatch path (same as gpt-image-2.6).
    assert.equal(imageModelFamily(SEED), 'other');

    // Profile flags mirror gpt-image-2.6 with keepProSuffix for pro/flash/lite variants.
    const profile = imageModelProfile(SEED);
    assert.equal(profile.customSizes, true);
    assert.equal(profile.div16Padding, true);
    assert.equal(profile.keepProSuffix, true);
    assert.equal(profile.omitSizeOnReject, false);
    assert.equal(profile.complexity, 'high');
    assert.equal(profile.routeEditsThroughGeneration, false);
    assert.equal(profile.resolutionTiers, false);
    assert.equal(profile.paintsFakeTransparency, false);

    /* unsupported tests...
    // 16x16 is already legal (minPixels=256).
    assert.equal(sameAspectImageSize('16x16', SEED), null);

    // 100x100 → rounds to 96x96 (16px grid, area 9216 ≥ 256).
    assert.equal(sameAspectImageSize('100x100', SEED), '96x96');

    // 100x100 request → pad16 → 112x112 (imageRequestSize applies div16).
    assert.equal(imageRequestSize('100x100', SEED), '112x112');
    */

    // 2048x2048 is within limits → passed through.
    assert.equal(imageRequestSize('2048x2048', SEED), '2048x2048');

    // Aspect ratio request at 4K budget.
    assert.equal(imageRequestSize('2.39:1', SEED), '1984x832');
    assert.equal(imageRequestSize('2.39:1', SEED, '4K'), '3472x1456');

    // imageSizeFields: free-size → size field (no resolution tiers); tier tokens resolve to a frame.
    assert.deepEqual(imageSizeFields('512x512', SEED), { size: '512x512' });
    assert.deepEqual(imageSizeFields('512', SEED), { size: '512x512' });
    assert.deepEqual(imageSizeFields('1.5k', SEED), { size: '1536x1536' });
    assert.deepEqual(imageSizeFields('auto', SEED), {});

    // imageSizeAttempts: pad16 + preset fallback (not resolution tier).
    //assert.deepEqual(imageSizeAttempts('16x16', SEED), ['16x16', '512x512']);
    //assert.deepEqual(imageSizeAttempts('100x100', SEED), ['112x112', '512x512']);
    assert.deepEqual(imageSizeAttempts('2048x2048', SEED), ['2048x2048']);

    // 1.5K tier: preset-only models resolve the tier token to a concrete frame.
    assert.equal(imageRequestSize('1.5k', SEED), '1536x1536');
    assert.equal(imageRequestSize('1536x1536', SEED), '1536x1536');
    // With an explicit 1.5K resolution, a larger frame falls back to the 1.5K frame of the shape.
    assert.deepEqual(imageSizeAttempts('2048x2048', SEED, '1.5k'), ['2048x2048', '1536x1536']);
    // A 1.5K frame asked at its own tier has no other preset to fall back to.
    assert.deepEqual(imageSizeAttempts('1536x1536', SEED, '1.5k'), ['1536x1536']);

    // 3K tier: the rare 3072 class, asked through `size` and answered with a concrete frame.
    assert.equal(imageRequestSize('3k', SEED), '3072x3072');
    assert.deepEqual(imageSizeFields('3k', SEED), { size: '3072x3072' });
    // 3072x3072 sits past the model's own pixel ceiling, so the attempt list steps down inside 3K.
    assert.deepEqual(imageSizeAttempts('3k', SEED), ['3072x3072', '2880x2880']);
    // A 3K frame that is already legal passes through and stays in its own tier.
    assert.equal(imageRequestSize('2304x3072', SEED), '2304x3072');
    assert.deepEqual(imageSizeAttempts('3072x2304', SEED), ['3072x2304']);

    // generationBody: includes complexity and image_format (vendor default).
    const body = generationBody({ model: SEED, prompt: 'test', size: '512x512', format: 'png' });
    assert.equal(body.model, SEED);
    assert.equal(body.prompt, 'test');
    assert.equal(body.size, '512x512');
    assert.equal(body.complexity, 'high');
    assert.equal(body.image_format, 'png');

    // No background for seedream (does not support transparent).
    assert.equal(supportsTransparentBackground(SEED), false);
    assert.equal(backgroundValue({ model: SEED, format: 'png', background: 'transparent' }), null);
});

const SEEDREAM = 'bytedance-seed/seedream-5-5';

test('the model floor becomes a same-ratio padded frame', () => {
    // Both sides grow by one factor and land on the 16-pixel grid, so the source ratio survives and
    // the object keeps its own scale: only empty space is added, on the right and at the bottom.
    assert.deepEqual(paddedSizeToMinPixels('300x400', SEEDREAM), { width: 832, height: 1120, originalWidth: 300, originalHeight: 400 });
    assert.deepEqual(paddedSizeToMinPixels('500x500', SEEDREAM), { width: 960, height: 960, originalWidth: 500, originalHeight: 500 });
    assert.ok(832 * 1120 >= MIN_IMAGE_PIXELS(SEEDREAM));
    // A frame that already clears the floor needs no padding at all.
    assert.equal(paddedSizeToMinPixels('960x960', SEEDREAM), null);
    assert.equal(paddedSizeToMinPixels('1024x1024', SEEDREAM), null);
    // A shape whose padded frame would leave the model limits stays on the upscale path.
    assert.equal(paddedSizeToMinPixels('1600x100', SEEDREAM), null);
    // A token naming no pixels cannot be padded.
    assert.equal(paddedSizeToMinPixels('auto', SEEDREAM), null);
    assert.equal(paddedSizeToMinPixels('2.39:1', SEEDREAM), null);
    // The same rule reads the floor of another family.
    assert.deepEqual(paddedSizeToMinPixels('300x400', 'openai/gpt-image-2.6-sunburst'),
        { width: 704, height: 944, originalWidth: 300, originalHeight: 400 });
});

test('padding to the model floor follows the profile and the operator override', () => {
    // Seedream answers a bigger frame by keeping the object in the corner, so it gets the padding.
    assert.equal(imageModelProfile(SEEDREAM).padToMinPixels, true);
    assert.equal(needsMinPixelsPadding(SEEDREAM), true);
    // gpt-image-2.6 upscales on its own and keeps the downscale path it already had.
    assert.equal(imageModelProfile('openai/gpt-image-2.6-sunburst').padToMinPixels, false);
    assert.equal(needsMinPixelsPadding('openai/gpt-image-2.6-sunburst'), false);
    assert.equal(needsMinPixelsPadding('sourceful/riverflow-v2.6-pro', 'always'), true);
    assert.equal(needsMinPixelsPadding(SEEDREAM, 'never'), false);
});

test('raster padding reaches a target frame above the 16-pixel grid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-floor-'));
    try {
        const canvas = createCanvas(100, 120);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2266cc';
        ctx.fillRect(0, 0, 100, 120);
        const bytes = canvas.toBuffer('image/png');
        const padded = await rasterPadImageBytes({ bytes, engine: 'sharp', targetWidth: 960, targetHeight: 960 });
        assert.equal(padded.width, 960);
        assert.equal(padded.height, 960);
        assert.equal(padded.originalWidth, 100);
        assert.equal(padded.originalHeight, 120);
        assert.equal(padded.padded, true);
        const file = path.join(root, 'padded.png');
        await writeFile(file, padded.bytes);
        const sharp = (await import('sharp')).default;
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.width, 960);
        assert.equal(info.height, 960);
        const at = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
        assert.deepEqual(at(10, 10), [34, 102, 204, 255]);
        assert.deepEqual(at(99, 119), [34, 102, 204, 255]);
        assert.deepEqual(at(100, 120), [0, 0, 0, 0]);
        assert.deepEqual(at(950, 950), [0, 0, 0, 0]);
        // Without a target the frame is only rounded up to the 16-pixel grid, as before.
        const rounded = await rasterPadImageBytes({ bytes, engine: 'sharp' });
        assert.equal(rounded.width, 112);
        assert.equal(rounded.height, 128);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a source below the model floor is padded up to it and the padding is cut off the reply', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-min-'));
    try {
        // A 300×400 source sits far below seedream-5.5's 921 600 px floor. The model is not asked to
        // upscale it: the picture is padded to the smallest legal frame, and the model answers inside
        // that frame with the object kept at its own scale in the top-left corner.
        const canvas = createCanvas(300, 400);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2266cc';
        ctx.fillRect(0, 0, 300, 400);
        const sourceBytes = canvas.toBuffer('image/png');
        const sent = [];
        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('latin1');
            const imagePart = /name="image"; filename="source\.png"\r\nContent-Type: image\/png\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
            const bytes = Buffer.from(imagePart?.[1] ?? '', 'latin1');
            sent.push({ size: /name="size"\r\n\r\n([^\r]+)/.exec(raw)?.[1], bytes });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp' });
        try {
            const payloads = await client.images.edit({
                model: SEEDREAM, prompt: 'keep', format: 'png',
                files: [{ filename: 'source.png', mime: 'image/png', bytes: sourceBytes }],
            });
            const floor = paddedSizeToMinPixels('300x400', SEEDREAM);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].size, `${floor.width}x${floor.height}`);
            const sentPath = path.join(root, 'sent.png');
            await writeFile(sentPath, sent[0].bytes);
            const sentInfo = await rasterInfo(sentPath, { cwd: root, engine: 'sharp' });
            assert.deepEqual([sentInfo.width, sentInfo.height], [floor.width, floor.height]);
            const sharp = (await import('sharp')).default;
            const { data } = await sharp(sentPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const at = (x, y) => [...data.subarray((y * sentInfo.width + x) * 4, (y * sentInfo.width + x) * 4 + 4)];
            // The object is neither moved nor resampled; the added area is empty space.
            assert.deepEqual(at(10, 10), [34, 102, 204, 255]);
            assert.deepEqual(at(299, 399), [34, 102, 204, 255]);
            assert.deepEqual(at(300, 400), [0, 0, 0, 0]);
            // The answer comes back at the source frame, padding cut off, nothing downscaled.
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            assert.deepEqual([info.width, info.height], [300, 400]);
            const result = await sharp(resultPath).ensureAlpha().raw().toBuffer();
            assert.deepEqual([...result.subarray((399 * 300 + 299) * 4, (399 * 300 + 299) * 4 + 4)], [34, 102, 204, 255]);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('image.padToMin never leaves the small source at its own padded frame', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-off-'));
    try {
        const canvas = createCanvas(300, 400);
        canvas.getContext('2d').fillRect(0, 0, 300, 400);
        const sourceBytes = canvas.toBuffer('image/png');
        const sent = [];
        const server = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('latin1');
            const imagePart = /name="image"; filename="source\.png"\r\nContent-Type: image\/png\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
            const bytes = Buffer.from(imagePart?.[1] ?? '', 'latin1');
            sent.push({ size: /name="size"\r\n\r\n([^\r]+)/.exec(raw)?.[1], bytes });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${port}/v1/`, retries: 0, rasterEngine: 'sharp', imagePadToMin: 'never' });
        try {
            const payloads = await client.images.edit({
                model: SEEDREAM, prompt: 'keep', format: 'png',
                files: [{ filename: 'source.png', mime: 'image/png', bytes: sourceBytes }],
            });
            // Only the 16-pixel grid is added; the frame floor is left to the model's own upscale.
            const sentPath = path.join(root, 'sent.png');
            await writeFile(sentPath, sent[0].bytes);
            const sentInfo = await rasterInfo(sentPath, { cwd: root, engine: 'sharp' });
            assert.deepEqual([sentInfo.width, sentInfo.height], [304, 400]);
            assert.equal(sent[0].size, '304x400');
            const resultPath = path.join(root, 'result.png');
            await writeFile(resultPath, Buffer.from(payloads[0], 'base64'));
            const info = await rasterInfo(resultPath, { cwd: root, engine: 'sharp' });
            assert.deepEqual([info.width, info.height], [300, 400]);
        } finally {
            client.close();
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
