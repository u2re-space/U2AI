import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createToolset } from '../src/agent/tools.js';
import { buildProjectMap, loadProjectMap } from '../src/agent/map.js';
import { detectMagick } from '../src/agent/image-magick.js';
import { defaults } from '../src/core/config.js';
import { CancelledError } from '../src/openai/errors.js';
import { backupSummaryRows } from '../src/commands/shared.js';
import { TINY_PNG } from './helpers/mock-server.js';

async function rootFor(name) {
    return mkdtemp(path.join(os.tmpdir(), `ai-proc-${name}-`));
}

// An opaque, two-tone PNG built with sharp: TINY_PNG is a single transparent pixel, which makes
// sample_colors report "no colours" and gives perspective a degenerate frame. Both tools need real
// pixels.
async function opaquePng(size = 16) {
    const sharp = (await import('sharp')).default;
    const channels = 3;
    const buf = Buffer.alloc(size * size * channels);
    for (let i = 0; i < size * size; i++) {
        const left = (i % size) < size / 2;
        buf[i * channels] = left ? 220 : 20;
        buf[i * channels + 1] = left ? 30 : 200;
        buf[i * channels + 2] = left ? 40 : 60;
    }
    return sharp(buf, { raw: { width: size, height: size, channels } }).png().toBuffer();
}

test('processing: null uses Node and a host result does not touch the disk', async () => {
    const root = await rootFor('null');
    try {
        const local = createToolset({
            root, config: defaults, names: ['write_file'], approvalLevel: 'all',
            processTool: async () => null,
        });
        const written = await local.execute({
            name: 'write_file', call_id: 'c1',
            arguments: JSON.stringify({ path: 'note.txt', content: 'local\n', overwrite: true }),
        });
        assert.equal(written.ok, true);
        assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'local\n');
        const remote = createToolset({
            root, config: defaults, names: ['write_file'], approvalLevel: 'all', editPaths: () => new Set(),
            processTool: async () => ({ output: 'remote', summary: 'r', changes: [{ op: 'create', path: 'other.txt' }] }),
        });
        const hosted = await remote.execute({
            name: 'write_file', call_id: 'c2',
            arguments: JSON.stringify({ path: 'other.txt', content: 'nope\n', overwrite: true }),
        });
        assert.equal(hosted.output, 'remote');
        assert.equal(await stat(path.join(root, 'other.txt')).catch(() => null), null);
        assert.deepEqual(remote.stats().changes, [{ op: 'create', path: 'other.txt' }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: copy_path copies binary data and records the destination change', async () => {
    const root = await rootFor('copy');
    try {
        const bytes = Buffer.from([0, 255, 128, 1]);
        await writeFile(path.join(root, 'source.bin'), bytes);
        const toolset = createToolset({ root, config: defaults, names: ['copy_path'], approvalLevel: 'all' });
        const result = await toolset.execute({
            name: 'copy_path', call_id: 'c1',
            arguments: JSON.stringify({ source: 'source.bin', destination: 'assets/copied.bin' }),
        });
        assert.equal(result.ok, true, result.output);
        assert.deepEqual(await readFile(path.join(root, 'assets', 'copied.bin')), bytes);
        assert.deepEqual(toolset.stats().changes, [{ op: 'create', path: 'assets/copied.bin' }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: replace_text changes refresh the project map', async () => {
    const root = await rootFor('map');
    try {
        await writeFile(path.join(root, 'lib.js'), 'export function hello() {}\n');
        await buildProjectMap(root);
        const toolset = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'all',
            processTool: async () => {
                await writeFile(path.join(root, 'lib.js'), 'export function goodbye() {}\n');
                return { output: 'Изменён lib.js', summary: '~ lib.js', changes: [{ op: 'edit', path: './lib.js' }] };
            },
        });
        const result = await toolset.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'lib.js', search: 'hello', replacement: 'goodbye', all: false }),
        });
        assert.equal(result.output, 'Изменён lib.js');
        assert.deepEqual(toolset.stats().changes, [{ op: 'edit', path: 'lib.js' }]);
        const loaded = await loadProjectMap(root);
        assert.ok(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'goodbye'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: bad changes warn and read_file drops them', async () => {
    const root = await rootFor('warn');
    try {
        await writeFile(path.join(root, 'a.txt'), 'hello\n');
        const warnings = [];
        const edits = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'all', emit: (event) => warnings.push(event),
            processTool: async () => ({
                output: 'kept', summary: 's',
                changes: [{ op: 'nope', path: 'a.js' }, { op: 'edit', path: '../out.js' }, { op: 'edit', path: '.backup/a.js' }, { op: 'edit', path: 'b.js' }],
            }),
        });
        const edited = await edits.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'a.js', search: 'a', replacement: 'b', all: false }),
        });
        assert.equal(edited.output, 'kept');
        assert.deepEqual(edits.stats().changes, [{ op: 'edit', path: 'b.js' }]);
        assert.ok(warnings.some((event) => event.message === 'Некорректная запись changes.'));
        assert.ok(warnings.some((event) => /вне рабочего каталога/.test(event.message)));
        assert.ok(warnings.some((event) => event.message === 'Запись в .backup запрещена: .backup/a.js'));
        const many = Array.from({ length: 101 }, (_, index) => ({ op: 'edit', path: `f${index}.js` }));
        warnings.length = 0;
        const bulk = createToolset({
            root, config: defaults, names: ['delete_file'], approvalLevel: 'all', emit: (event) => warnings.push(event),
            processTool: async () => ({ output: 'bulk', summary: 'b', changes: many }),
        });
        await bulk.execute({ name: 'delete_file', call_id: 'c2', arguments: JSON.stringify({ path: 'a.txt' }) });
        assert.equal(bulk.stats().changes.length, 100);
        assert.ok(warnings.some((event) => event.message === 'changes содержит больше 100 записей.'));
        const reader = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => ({ output: 'host-read', summary: 'h', changes: [{ op: 'edit', path: 'a.txt' }] }),
        });
        const read = await reader.execute({
            name: 'read_file', call_id: 'c3',
            arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }),
        });
        assert.equal(read.output, 'host-read');
        assert.deepEqual(reader.stats().changes, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: denial, cancellation, shell stats, and make_dir stay local', async () => {
    const root = await rootFor('gate');
    try {
        let calls = 0;
        const denied = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'ask', approve: async () => 'no',
            processTool: async () => { calls += 1; return { output: 'x', summary: 'y' }; },
        });
        const blocked = await denied.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'a.js', search: 'a', replacement: 'b', all: false }),
        });
        assert.equal(calls, 0);
        assert.equal(blocked.ok, false);
        const cancelled = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => { throw new CancelledError('stop'); },
        });
        await assert.rejects(
            cancelled.execute({ name: 'read_file', call_id: 'c2', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }) }),
            (error) => error instanceof CancelledError && error.message === 'stop',
        );
        const aborted = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => {
                const error = new Error('Отменено.');
                error.name = 'AbortError';
                throw error;
            },
        });
        await assert.rejects(
            aborted.execute({ name: 'read_file', call_id: 'c2b', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }) }),
            (error) => error instanceof CancelledError && error.message === 'Отменено.',
        );
        const broken = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => { throw new Error('boom'); },
        });
        const failed = await broken.execute({
            name: 'read_file', call_id: 'c3', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }),
        });
        assert.equal(failed.ok, false);
        assert.match(failed.output, /^Ошибка: boom/);
        const shell = createToolset({
            root, config: defaults, names: ['run_command'], approvalLevel: 'all',
            editPaths: () => new Set(),
            processTool: async () => ({ output: 'plain', summary: '0', changes: [{ op: 'edit', path: 'a.js' }] }),
        });
        const command = await shell.execute({
            name: 'run_command', call_id: 'c4',
            arguments: JSON.stringify({ command: 'echo hi', shell: '', cwd: null, timeout_seconds: null, reason: 'check' }),
        });
        assert.equal(command.output, 'plain');
        assert.deepEqual(shell.stats().commands, []);
        assert.deepEqual(shell.stats().changes, []);
        const dirs = createToolset({
            root, config: defaults, names: ['make_dir'], approvalLevel: 'all',
            processTool: async () => { calls += 1; return { output: 'no', summary: 'no' }; },
        });
        const made = await dirs.execute({ name: 'make_dir', call_id: 'c5', arguments: JSON.stringify({ path: 'sub' }) });
        assert.equal(made.ok, true);
        assert.equal(calls, 0);
        assert.equal((await stat(path.join(root, 'sub'))).isDirectory(), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: read access auto-approves measurement crops only under .tmp', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const root = await rootFor('crop');
    try {
        await writeFile(path.join(root, 'mockup.png'), Buffer.from(TINY_PNG, 'base64'));
        const toolset = createToolset({
            root, config: defaults, names: ['crop_image'], approvalLevel: 'read', allowWrite: ['crop_image'],
        });
        const allowed = await toolset.execute({
            name: 'crop_image', call_id: 'c1',
            arguments: JSON.stringify({
                path: 'mockup.png', x: 0, y: 0, width: 1, height: 1, trim: false,
                output: '.tmp/measure/crop.png', reason: 'measure the edge',
            }),
        });
        assert.equal(allowed.ok, true, allowed.output);
        assert.ok((await stat(path.join(root, '.tmp/measure/crop.png'))).size > 0);
        const denied = await toolset.execute({
            name: 'crop_image', call_id: 'c2',
            arguments: JSON.stringify({
                path: 'mockup.png', x: 0, y: 0, width: 1, height: 1, trim: false,
                output: 'mockup.png', reason: 'must not overwrite the reference',
            }),
        });
        assert.equal(denied.ok, false);
        assert.match(denied.output, /\.tmp/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// correct_perspective is category 'write' (it writes a rectified PNG), so it must be listed in
// allowWrite AND in AUTO_WRITE_TOOLS to pass decide() at read access. A missing entry in
// either list silently blocked the decomposer's whole deterministic rectification path.
test('processing: read access auto-approves correct_perspective only under .tmp', async (t) => {
    const exe = await detectMagick();
    if (!exe) return t.skip('ImageMagick is not installed');
    const root = await rootFor('perspective');
    try {
        const img = await opaquePng(64);
        await writeFile(path.join(root, 'mockup.png'), img);
        const toolset = createToolset({
            root, config: defaults, names: ['correct_perspective'], approvalLevel: 'read', allowWrite: ['correct_perspective'],
        });
        // corners: top-left, top-right, bottom-left, bottom-right — must use {x,y}, not source_x/dest_x
        const corners = JSON.stringify([
            { x: 0, y: 0 }, { x: 63, y: 0 }, { x: 0, y: 63 }, { x: 63, y: 63 },
        ]);
        const allowed = await toolset.execute({
            name: 'correct_perspective', call_id: 'p1',
            arguments: JSON.stringify({
                path: 'mockup.png', corners_json: corners,
                output: '.tmp/perspective/flat.png', reason: 'rectify a photographed screen',
            }),
        });
        assert.equal(allowed.ok, true, allowed.output);
        assert.ok((await stat(path.join(root, '.tmp/perspective/flat.png'))).size > 0);
        const denied = await toolset.execute({
            name: 'correct_perspective', call_id: 'p2',
            arguments: JSON.stringify({
                path: 'mockup.png', corners_json: corners,
                output: 'flat.png', reason: 'must not write outside .tmp at read access',
            }),
        });
        assert.equal(denied.ok, false);
        assert.match(denied.output, /\.tmp/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// sample_colors is category 'read' — it reads pixels and writes nothing — so decide() must allow it
// at every approval level without any allowWrite entry.
test('processing: sample_colors runs at read access without any write grant', async (t) => {
    const root = await rootFor('colors');
    try {
        const img = await opaquePng(32);
        await writeFile(path.join(root, 'mockup.png'), img);
        const toolset = createToolset({
            root, config: defaults, names: ['sample_colors'], approvalLevel: 'read', allowWrite: [],
        });
        const result = await toolset.execute({
            name: 'sample_colors', call_id: 's1',
            arguments: JSON.stringify({ path: 'mockup.png', k: 3 }),
        });
        assert.equal(result.ok, true, result.output);
        assert.match(result.output, /Палитра mockup\.png/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: the backup row appears only when a change has a backup path', () => {
    const remote = backupSummaryRows([{ op: 'edit', path: 'a.js' }], '/tmp/backup');
    assert.deepEqual(remote, [['изменения', '~ a.js']]);
    const local = backupSummaryRows([{ op: 'edit', path: 'a.js', backupPath: '/tmp/backup/a.js' }], '/tmp/backup');
    assert.deepEqual(local, [['изменения', '~ a.js'], ['резервные копии', '/tmp/backup']]);
    assert.deepEqual(backupSummaryRows([], '/tmp/backup'), []);
});

