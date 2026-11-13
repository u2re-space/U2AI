/**
 * @file test/webdev-bridge.test.js
 * @module test/webdev-bridge
 * @purpose Tests of the delegation to the dedicated web CLI: the flags it forwards, the binary it
 *           finds, the exit code it gives back and the commands that stay in the monolith.
 * @depends node:test, commands/webdev, cli
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { webdevArgs, webdevCandidates, resolveWebdev, webdevRoleName, isWebTask } from '../src/commands/webdev.js';
import { parseArgv } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'ai.js');

/**
 * Run the CLI in a child process.
 * @param {string[]} args the arguments of the command
 * @param {object} [options] the environment and the directories of the run
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(args, { env = {}, cwd, home } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [bin, ...args], {
            cwd: cwd ?? root,
            env: { ...process.env, NO_COLOR: '1', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

test('webdev: the task and the kind of the run are the first arguments', () => {
    const values = parseArgv(['gen', 'landing', 'собери страницу']).values;
    const args = webdevArgs(values, { kind: 'landing', task: 'собери страницу' });
    assert.deepEqual(args.slice(0, 4), ['run', 'собери страницу', '--kind', 'landing']);
});

test('webdev: the flags of the monolith are translated into the flags of the new CLI', () => {
    const values = parseArgv([
        'gen', 'landing', 'задача', '--fidelity', '87', '--creativity', '20',
        '--platform', 'chrome-156-stable', '--frontend-framework', 'react-ssr',
        '--frontend-style-language', 'scss', '--frontend-script-language', 'typescript',
        '--icon-set', 'phosphor', '--model', 'vendor/text', '--effort', 'high',
        '--extract', 'auto', '--approve', 'write', '--role', 'worker=vendor/text:medium',
        '--stop-after', 'work', '--id', 'my-run', '--json',
    ]).values;
    const args = webdevArgs(values, { kind: 'landing', task: 'задача' });
    assert.deepEqual(args, [
        'run', 'задача',
        '--kind', 'landing',
        '--fidelity', '87',
        '--creativity', '20',
        '--platform', 'chromium',
        '--frontend-framework', 'react',
        '--frontend-style-language', 'scss',
        '--frontend-script-language', 'typescript',
        '--icon-set', 'phosphor',
        '--model', 'vendor/text',
        '--effort', 'high',
        '--extract', 'auto',
        '--approve', 'write',
        '--id', 'my-run',
        '--stop-after', 'coding',
        '--role', 'coder:vendor/text:medium',
        '--json',
    ]);
});

test('webdev: the values the new CLI does not know are left out', () => {
    const values = parseArgv([
        'gen', 'landing', 'задача', '--frontend-framework', 'angular',
        '--frontend-markup-language', 'pug', '--stop-after', 'decompose',
    ]).values;
    const args = webdevArgs(values, { kind: 'landing', task: 'задача' });
    assert.deepEqual(args, ['run', 'задача', '--kind', 'landing']);
});

test('webdev: the roles of the monolith are named as the roles of the new CLI', () => {
    assert.equal(webdevRoleName('worker'), 'coder');
    assert.equal(webdevRoleName('planner'), 'planner');
    assert.equal(webdevRoleName('measurer'), null);
});

test('webdev: the binary is looked up in the environment, the checkout and node_modules', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-'));
    const empty = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-empty-'));
    try {
        const script = path.join(dir, 'submodules', 'u2ai-webdev', 'bin', 'ai-webdev.js');
        await mkdir(path.dirname(script), { recursive: true });
        await writeFile(script, '// empty\n');
        const candidates = webdevCandidates({ root: dir, env: {} });
        assert.equal(candidates.length, 2);
        assert.ok(candidates[0].endsWith(path.join('submodules', 'u2ai-webdev', 'bin', 'ai-webdev.js')));
        const found = await resolveWebdev({ root: dir, env: {} });
        assert.equal(found.command, process.execPath);
        assert.deepEqual(found.args, [script]);

        const missing = await resolveWebdev({ root: empty, env: { PATH: '' } });
        assert.equal(missing, null, 'nothing installed means nothing to delegate to');

        const off = await resolveWebdev({ root: dir, env: { AI_WEBDEV_BIN: 'none' } });
        assert.equal(off, null, 'AI_WEBDEV_BIN=none switches the delegation off');
    } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(empty, { recursive: true, force: true });
    }
});

test('webdev: ai gen runs the dedicated CLI and returns its exit code', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-work-'));
    try {
        const fake = path.join(work, 'fake-ai-webdev.js');
        await writeFile(fake, 'console.log(process.argv.slice(2).join(" "));\nprocess.exit(3);\n');
        const result = await runCli(['gen', 'landing', 'собери страницу', '--fidelity', '87'], {
            cwd: work,
            env: { AI_AGENT_HOME: home, AI_WEBDEV_BIN: fake },
        });
        assert.equal(result.code, 3, 'the exit code of the delegated CLI is the exit code of the command');
        assert.match(result.stdout, /^run собери страницу --kind landing --fidelity 87$/m);
        assert.match(result.stderr, /делегирую в ai-webdev/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

test('webdev: the web part of ai run is delegated too', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-run-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-run-work-'));
    try {
        const fake = path.join(work, 'fake-ai-webdev.js');
        await writeFile(fake, 'console.log(process.argv.slice(2).join(" "));\n');
        const result = await runCli(['run', 'site', 'собери витрину'], {
            cwd: work,
            env: { AI_AGENT_HOME: home, AI_WEBDEV_BIN: fake },
        });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^run собери витрину --kind site$/m);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});

test('webdev: a task that is not about the web stays in the monolith', () => {
    assert.equal(isWebTask({ kind: null, wantsProfile: false }), false);
    assert.equal(isWebTask({ kind: 'landing', wantsProfile: true }), true);
    assert.equal(isWebTask({ kind: null, wantsProfile: true }), true);
});

test('webdev: the JSON of the delegated CLI becomes events of the monolith', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-json-home-'));
    const work = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-webdev-json-work-'));
    try {
        const fake = path.join(work, 'fake-ai-webdev.js');
        await writeFile(fake, 'console.log(JSON.stringify({ type: "result", files: ["index.html"] }));\n'
            + 'console.log("the page is ready");\n');
        const result = await runCli(['gen', 'landing', 'собери страницу', '--json'], {
            cwd: work,
            env: { AI_AGENT_HOME: home, AI_WEBDEV_BIN: fake },
        });
        assert.equal(result.code, 0, result.stderr);
        const events = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const done = events.find((event) => event.type === 'result');
        assert.deepEqual(done.files, ['index.html']);
        const delta = events.find((event) => event.type === 'text.delta');
        assert.match(delta.text, /the page is ready/);
    } finally {
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    }
});
