/**
 * @file test/decompose-command.test.js
 * @module test/decompose-command
 * @purpose Tests of the `ai decompose` command: the flags it forwards to the dedicated CLI and the
 *           binary it finds.
 * @depends node:test, commands/decompose, cli
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { decomposeArgs, decomposerCandidates, resolveDecomposer } from '../src/commands/decompose.js';
import { parseArgv } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'ai.js');

test('decompose: the flags of the monolith are translated into the flags of the new CLI', () => {
    const values = parseArgv([
        'decompose', '--image', 'a.png', '--image', 'b.png', '--out', 'out',
        '--config', 'cfg.json', '--model', 'vendor/vision', '--effort', 'high',
        '--image-model', 'vendor/editor', '--stop-after', 'rectify',
        '--stages', 'extend', '--stages', 'decompose', '--dry-run', '--advanced',
    ]).values;
    assert.deepEqual(decomposeArgs(values), [
        '--image', 'a.png', '--image', 'b.png',
        '--out', 'out',
        '--config', 'cfg.json',
        '--model', 'vendor/vision',
        '--effort', 'high',
        '--image-model', 'vendor/editor',
        '--stop-after', 'rectify',
        '--stages', 'extend,decompose',
        '--dry-run',
        '--advanced',
    ]);
});

test('decompose: nothing to forward means nothing to pass on', () => {
    assert.deepEqual(decomposeArgs({}), []);
});

test('decompose: the binary is looked up in the environment, the checkout and node_modules', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-decompose-'));
    const empty = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-decompose-empty-'));
    try {
        const script = path.join(dir, 'submodules', 'u2ai-decomposer', 'bin', 'ai-decompose.js');
        await mkdir(path.dirname(script), { recursive: true });
        await writeFile(script, '// empty\n');
        const candidates = decomposerCandidates({ root: dir, env: {} });
        assert.equal(candidates.length, 2);
        assert.ok(candidates[0].endsWith(path.join('submodules', 'u2ai-decomposer', 'bin', 'ai-decompose.js')));
        const found = await resolveDecomposer({ root: dir, env: {} });
        assert.equal(found.command, process.execPath);
        assert.deepEqual(found.args, [script]);

        const missing = await resolveDecomposer({ root: empty, env: { PATH: '' } });
        assert.equal(missing, null, 'nothing installed means nothing to delegate to');
    } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(empty, { recursive: true, force: true });
    }
});

test('decompose: the command runs the dedicated CLI and returns its exit code', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-decompose-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-decompose-work-'));
    try {
        const child = spawn(process.execPath, [bin, 'decompose', '--image', 'picture.png', '--dry-run'], {
            cwd: work,
            env: { ...process.env, AI_AGENT_HOME: home, AI_DECOMPOSE_HOME: path.join(home, 'decompose'), NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const code = await new Promise((resolve) => child.once('close', resolve));
        assert.equal(code, 0, stderr);
        assert.match(stdout + stderr, /Plan:/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});
