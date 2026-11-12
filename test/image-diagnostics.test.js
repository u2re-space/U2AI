import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '../src/openai/client.js';
import { setImageDiagnostics, imageResponseDir } from '../src/openai/image-diagnostics.js';
import { describeShape, parseImageResponseWithAI } from '../src/openai/image-response-fallback.js';
import { generateTransparentLayer } from '../src/openai/seedream-5-5.js';
import { createToolset } from '../src/agent/tools.js';
import { TINY_PNG } from './helpers/mock-server.js';

const PNG_BYTES = Buffer.from(TINY_PNG, 'base64');

/** One project directory per test: the archive writes into it like into a real workspace. */
async function tempProject() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-image-dbg-'));
    setImageDiagnostics({ root, workId: 'run-1' });
    return { root, async cleanup() { setImageDiagnostics(null); await rm(root, { recursive: true, force: true }); } };
}

/** Start a mock gateway; `routes` maps a method+path to a handler replying to one request. */
async function mockGateway(routes) {
    const hits = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const key = `${req.method} ${req.url}`;
        hits.push({ key, body: Buffer.concat(chunks).toString('utf8') });
        const handler = routes[key];
        if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
        await handler(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        hits,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function json(res, body, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** The response shape `outputText()` reads, so the salvage call can be answered by a mock host. */
const modelAnswer = (text) => ({
    id: 'resp-salvage',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
});

async function archivedImages(root) {
    const names = await readdir(path.join(root, '.tmp', 'run-1', 'images')).catch(() => []);
    return names.sort();
}

test('an ordinary images answer is archived in full, base64 payload included', async () => {
    const project = await tempProject();
    const gateway = await mockGateway({
        'POST /v1/images/generations': (req, res) => json(res, { data: [{ b64_json: TINY_PNG }] }),
    });
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${gateway.port}/v1/`, retries: 0 });
    try {
        const payloads = await client.images.generate({ model: 'gpt-image-2.6', prompt: 'draw' });
        assert.deepEqual(payloads, [TINY_PNG], 'the normal parse still works');
        const names = await archivedImages(project.root);
        assert.equal(names.length, 1);
        const record = JSON.parse(await readFile(path.join(project.root, '.tmp', 'run-1', 'images', names[0]), 'utf8'));
        assert.equal(record.route, 'images/generations');
        assert.equal(record.model, 'gpt-image-2.6');
        assert.equal(record.response.data[0].b64_json, TINY_PNG, 'the archived answer keeps the payload verbatim');
    } finally {
        client.close();
        await gateway.close();
        await project.cleanup();
    }
});

test('a response in an unknown shape is salvaged by a model-written script that fetches and writes files', async () => {
    const project = await tempProject();
    const script = [
        'const item = response.result.artwork[0];',
        'const bytes = await fetchBytes(item.link);',
        'log("cdn bytes", bytes.length, sniff(bytes));',
        'await write("assets/salvaged.png", bytes);',
        'await write("assets/salvaged-note.txt", "kept from the odd response");',
        'return [item.href, bytes];',
    ].join('\n');
    const gateway = await mockGateway({
        'POST /v1/images/generations': (req, res) => json(res, {
            result: { artwork: [{ href: `data:image/png;base64,${TINY_PNG}`, link: `http://127.0.0.1:${gatewayPort}/cdn/a.png`, sizes: ['1x1'] }] },
            note: 'vendor-specific envelope',
        }),
        'GET /cdn/a.png': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG_BYTES); },
        'POST /v1/responses': (req, res) => json(res, modelAnswer(`\`\`\`js\n${script}\n\`\`\``)),
    });
    const gatewayPort = gateway.port;
    const client = createClient({
        apiKey: 'sk-test', baseURL: `http://127.0.0.1:${gateway.port}/v1/`, retries: 0,
        imageParserModel: 'gpt-6-luna', workspaceRoot: project.root,
    });
    try {
        const payloads = await client.images.generate({ model: 'gpt-image-2.6', prompt: 'draw' });
        assert.deepEqual(payloads, [TINY_PNG, TINY_PNG], 'a data-URI and a fetched link both come back as base64');
        assert.deepEqual(await readFile(path.join(project.root, 'assets', 'salvaged.png')), PNG_BYTES, 'the script may write files');
        assert.equal((await readFile(path.join(project.root, 'assets', 'salvaged-note.txt'), 'utf8')), 'kept from the odd response');
        const names = await archivedImages(project.root);
        assert.equal(names.filter((name) => name.endsWith('.json')).length, 1, 'the raw answer is archived once');
        assert.equal(names.filter((name) => name.endsWith('.js')).length, 1, 'the salvage script is archived too');
        const record = JSON.parse(await readFile(path.join(project.root, '.tmp', 'run-1', 'images', names.find((n) => n.endsWith('.json'))), 'utf8'));
        assert.equal(record.response.note, 'vendor-specific envelope');
        assert.match(await readFile(path.join(project.root, '.tmp', 'run-1', 'images', names.find((n) => n.endsWith('.js'))), 'utf8'), /fetchBytes\(item\.link\)/);
        assert.match(gateway.hits.find((hit) => hit.key === 'POST /v1/responses').body, /result.*artwork/s, 'the model sees the shape, not a megabyte of base64');
    } finally {
        client.close();
        await gateway.close();
        await project.cleanup();
    }
});

test('a salvage script that escapes the project or finds nothing cannot break the call', async () => {
    const project = await tempProject();
    const gateway = await mockGateway({
        'POST /v1/images/generations': (req, res) => json(res, { weird: { picture: 'none at all' } }),
        'POST /v1/responses': (req, res) => json(res, modelAnswer('```js\nawait write("../../escaped.png", "x");\nreturn [];```')),
    });
    const client = createClient({
        apiKey: 'sk-test', baseURL: `http://127.0.0.1:${gateway.port}/v1/`, retries: 0,
        imageParserModel: 'gpt-6-luna', workspaceRoot: project.root,
    });
    try {
        await assert.rejects(client.images.generate({ model: 'gpt-image-2.6', prompt: 'draw' }), /ни b64_json, ни url/);
        await assert.rejects(readFile(path.join(project.root, '..', 'escaped.png'), 'utf8'));
        const names = await archivedImages(project.root);
        assert.equal(names.filter((name) => name.endsWith('.json')).length, 1, 'the failed answer is still archived for debugging');
    } finally {
        client.close();
        await gateway.close();
        await project.cleanup();
    }
});

test('the seedream-5.5 task answer is archived before its own parser reads it', async () => {
    const project = await tempProject();
    const client = {
        async call(route) {
            if (route === 'images/generations') return { code: 200, data: [{ status: 'pending', task_id: 'task-dbg' }] };
            return { data: { status: 'completed', result: { images: [{ url: [`data:image/png;base64,${TINY_PNG}`] }] } } };
        },
    };
    try {
        const payloads = await generateTransparentLayer({ client, prompt: 'extract', bytes: Buffer.from('region') });
        assert.deepEqual(payloads, [TINY_PNG]);
        const names = await archivedImages(project.root);
        const record = JSON.parse(await readFile(path.join(project.root, '.tmp', 'run-1', 'images', names[0]), 'utf8'));
        assert.equal(record.route, 'seedream-generation');
        assert.equal(record.taskId, 'task-dbg');
        assert.deepEqual(record.response.data.result.images[0].url, [`data:image/png;base64,${TINY_PNG}`]);
    } finally {
        await project.cleanup();
    }
});

test('without an announced run nothing is archived and the client keeps its old behaviour', async () => {
    setImageDiagnostics(null);
    const gateway = await mockGateway({
        'POST /v1/images/generations': (req, res) => json(res, { data: [{ b64_json: TINY_PNG }] }),
    });
    const client = createClient({ apiKey: 'sk-test', baseURL: `http://127.0.0.1:${gateway.port}/v1/`, retries: 0 });
    try {
        assert.deepEqual(await client.images.generate({ model: 'gpt-image-2.6', prompt: 'draw' }), [TINY_PNG]);
        assert.equal(imageResponseDir(), null);
    } finally {
        client.close();
        await gateway.close();
    }
});

test('the shape sketch shows paths and elides the base64 body', () => {
    const shape = describeShape({ data: [{ b64_json: 'A'.repeat(5000), url: 'https://cdn/a.png' }], n: 2 });
    assert.match(shape, /"b64_json": <string 5000 chars/);
    assert.match(shape, /"url": "https:\/\/cdn\/a\.png"/);
    assert.ok(shape.length < 500, 'the sketch is a summary, not the payload');
});

test('salvage is inert without a parser model, and reports the archived file', async () => {
    const project = await tempProject();
    try {
        const sources = await parseImageResponseWithAI({ result: { odd: true }, route: 'images/edits', model: 'm' });
        assert.equal(sources, null);
        const names = await archivedImages(project.root);
        assert.equal(names.length, 1);
    } finally {
        await project.cleanup();
    }
});

test('an image role edits SVG as text and is refused on every other extension', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-svg-role-'));
    const toolset = createToolset({
        root, role: 'image-processor',
        config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', complexity: 'auto' }, limits: {} },
        names: ['read_file', 'write_file', 'replace_text'], approvalLevel: 'all',
    });
    try {
        const written = await toolset.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'assets/mark.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>' }) });
        assert.match(written.output, /assets\/mark\.svg/);
        const edited = await toolset.execute({ name: 'replace_text', arguments: JSON.stringify({ path: 'assets/mark.svg', search: 'viewBox="0 0 8 8"', replacement: 'viewBox="0 0 16 16"' }) });
        assert.match(edited.output, /Изменён/);
        assert.match(await readFile(path.join(root, 'assets', 'mark.svg'), 'utf8'), /viewBox="0 0 16 16"/);
        // SVG is text for this role, so it is read back as markup rather than sent to a vision model.
        const read = await toolset.execute({ name: 'read_file', arguments: JSON.stringify({ path: 'assets/mark.svg' }) });
        assert.equal(read.ok, true, read.output);
        assert.match(read.output, /<svg xmlns/);
        const refusedWrite = await toolset.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'process.exit(1)' }) });
        assert.equal(refusedWrite.ok, false);
        assert.match(refusedWrite.output, /\.svg/);
        const refusedEdit = await toolset.execute({ name: 'replace_text', arguments: JSON.stringify({ path: 'package.json', search: 'a', replacement: 'b' }) });
        assert.equal(refusedEdit.ok, false);
        assert.match(refusedEdit.output, /\.svg/);
        await assert.rejects(readFile(path.join(root, 'src', 'app.js'), 'utf8'), /ENOENT/);

        // The decorator keeps its stylesheet as well as its vectors; the worker keeps everything.
        const decor = createToolset({
            root, role: 'decorator',
            config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', complexity: 'auto' }, limits: {} },
            names: ['write_file'], approvalLevel: 'all',
        });
        assert.equal((await decor.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'styles/decor/ornament.css', content: '.o{color:red}' }) })).ok, true);
        assert.equal((await decor.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'x' }) })).ok, false);
        const worker = createToolset({
            root, role: 'worker',
            config: { baseURL: 'https://api.proxyapi.ru/v1/', imageModel: null, image: { size: 'auto', complexity: 'auto' }, limits: {} },
            names: ['write_file'], approvalLevel: 'all',
        });
        assert.equal((await worker.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'export const a = 1;' }) })).ok, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
