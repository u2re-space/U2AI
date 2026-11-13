/**
 * @file test/image-bridge.test.js
 * @module test/image-bridge
 * @purpose Tests of the `ai image` command: the flags it forwards to the dedicated CLI, the
 *           binary it finds and the exit code it gives back.
 * @depends node:test, commands/image, cli
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { imageArgs, imageCandidates, resolveImageCli } from '../src/commands/image.js';
import { parseArgv } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'ai.js');

test('image: a request without a picture is a generation', () => {
    const values = parseArgv(['image', 'a red bicycle']).values;
    assert.deepEqual(imageArgs(values, ['a red bicycle']), ['generate', 'a red bicycle']);
});

test('image: the first picture is the source of an edit, the rest are references', () => {
    const values = parseArgv(['image', '--image', 'a.png', '--image', 'b.png', '--image', 'c.png']).values;
    assert.deepEqual(imageArgs(values, ['make it blue']), [
        'edit', 'a.png', '--reference', 'b.png', '--reference', 'c.png', 'make it blue',
    ]);
});

test('image: the flags of the monolith are translated into the flags of the new CLI', () => {
    const values = parseArgv([
        'image', '--image', 'a.png', 'make it blue', '--out', 'out.png', '--config', 'cfg.json',
        '--model', 'vendor/text', '--image-model', 'vendor/editor', '--size', '1024x1024',
        '--format', 'webp', '--image-background', 'transparent', '--image-resolution', '2K',
        '--count', '3', '--json', '--dry-run',
    ]).values;
    assert.deepEqual(imageArgs(values, ['make it blue']), [
        'edit', 'a.png', 'make it blue',
        '--out', 'out.png',
        '--config', 'cfg.json',
        '--model', 'vendor/text',
        '--image-model', 'vendor/editor',
        '--size', '1024x1024',
        '--format', 'webp',
        '--background', 'transparent',
        '--resolution', '2K',
        '--count', '3',
        '--json',
        '--dry-run',
    ]);
});

test('image: the resolution auto and off are not passed on', () => {
    const auto = parseArgv(['image', '--image-resolution', 'auto']).values;
    assert.deepEqual(imageArgs(auto, []), ['generate']);
    const off = parseArgv(['image', '--image-resolution', 'off']).values;
    assert.deepEqual(imageArgs(off, []), ['generate']);
});

test('image: the binary is looked up in the environment, the checkout and node_modules', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-image-'));
    const empty = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-image-empty-'));
    try {
        const script = path.join(dir, 'submodules', 'u2ai-images', 'bin', 'ai-image.js');
        await mkdir(path.dirname(script), { recursive: true });
        await writeFile(script, '// empty\n');
        const candidates = imageCandidates({ root: dir, env: {} });
        assert.equal(candidates.length, 2);
        assert.ok(candidates[0].endsWith(path.join('submodules', 'u2ai-images', 'bin', 'ai-image.js')));
        const found = await resolveImageCli({ root: dir, env: {} });
        assert.equal(found.command, process.execPath);
        assert.deepEqual(found.args, [script]);

        const missing = await resolveImageCli({ root: empty, env: { PATH: '' } });
        assert.equal(missing, null, 'nothing installed means nothing to delegate to');
    } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(empty, { recursive: true, force: true });
    }
});

test('image: the command runs the dedicated CLI and returns its exit code', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-image-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-image-work-'));
    try {
        const fake = path.join(work, 'fake-ai-image.js');
        await writeFile(fake, 'console.log(process.argv.slice(2).join(" "));\nprocess.exit(3);\n');
        const child = spawn(process.execPath, [bin, 'image', '--image', 'a.png', 'make it blue'], {
            cwd: work,
            env: { ...process.env, AI_AGENT_HOME: home, AI_IMAGE_BIN: fake, NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const code = await new Promise((resolve) => child.once('close', resolve));
        assert.equal(code, 3, 'the exit code of the delegated CLI is the exit code of the command');
        assert.match(stdout, /^edit a\.png make it blue$/m);
        assert.match(stderr, /делегирую в ai-image/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

test('image: the JSON of the delegated CLI becomes events of the monolith', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-image-json-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-image-json-work-'));
    try {
        const fake = path.join(work, 'fake-ai-image.js');
        await writeFile(fake, 'console.log(JSON.stringify({ type: "result", files: ["a.png"] }));\n'
            + 'console.log("the picture is ready");\n');
        const child = spawn(process.execPath, [bin, 'image', 'a cat', '--json'], {
            cwd: work,
            env: { ...process.env, AI_AGENT_HOME: home, AI_IMAGE_BIN: fake, NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const code = await new Promise((resolve) => child.once('close', resolve));
        assert.equal(code, 0, stderr);
        const events = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const result = events.find((event) => event.type === 'result');
        assert.deepEqual(result.files, ['a.png']);
        const delta = events.find((event) => event.type === 'text.delta');
        assert.match(delta.text, /the picture is ready/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});
