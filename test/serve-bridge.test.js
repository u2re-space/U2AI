/**
 * The bridge to the package `@u2ai/server`: the lookup of the package, the server it
 * raises, the contract of `serve.json`, and the port that both servers share.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    serverPackageCandidates,
    resolveServerPackage,
    serverCliCandidates,
    resolveServerCli,
} from '../src/server/bridge.js';
import { startServeBridge } from '../src/commands/serve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function once(target, event) {
    return new Promise((resolve, reject) => {
        target.addEventListener(event, (value) => resolve(value));
        target.addEventListener('error', () => reject(new Error('socket error')));
    });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the package is looked up in the known places', () => {
    const candidates = serverPackageCandidates({ root: '/root', env: { AI_SERVE_PKG: '/pkg' } });
    assert.equal(candidates[0], path.resolve('/pkg'));
    assert.ok(candidates.includes(path.join('/root', 'submodules', 'u2ai-server')));
    assert.ok(candidates.includes(path.join('/root', 'node_modules', '@u2ai', 'server')));
    const without = serverPackageCandidates({ root: '/root', env: {} });
    assert.equal(without.length, 2);
});

test('the binary of the package is looked up in the known places', () => {
    const candidates = serverCliCandidates({ root: '/root', env: { AI_SERVE_BIN: '/bin/ai-serve.js' } });
    assert.equal(candidates[0], path.resolve('/bin/ai-serve.js'));
    assert.ok(candidates.includes(path.join('/root', 'submodules', 'u2ai-server', 'bin', 'ai-serve.js')));
});

test('a package that is not installed is not an error', async () => {
    const missing = await resolveServerPackage({ root: path.join(os.tmpdir(), 'ai-serve-nowhere'), env: {} });
    assert.equal(missing, null);
    const missingBin = await resolveServerCli({ root: path.join(os.tmpdir(), 'ai-serve-nowhere'), env: { PATH: '' } });
    assert.equal(missingBin, null);
});

test('the package of this repository is loaded', async () => {
    const pkg = await resolveServerPackage({ root: ROOT, env: {} });
    if (!pkg) return; // the checkout of the package is not here
    assert.equal(typeof pkg.startServe, 'function');
    assert.equal(typeof pkg.createHub, 'function');
});

test('the server of the package keeps the contract of serve.json', async () => {
    const pkg = await resolveServerPackage({ root: ROOT, env: {} });
    if (!pkg) return;
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-bridge-'));
    const handle = await startServeBridge({ pkg, home, token: 'c'.repeat(64) });
    try {
        const record = JSON.parse(await readFile(path.join(home, 'serve.json'), 'utf8'));
        assert.equal(record.url, handle.url);
        assert.equal(record.token, 'c'.repeat(64));
        assert.equal(record.pid, process.pid);
        assert.equal(record.complete, `${handle.url.replace(/^ws:/, 'http:')}/v1/complete`);
        assert.equal(record.structure, `${handle.url.replace(/^ws:/, 'http:')}/v1/structure`);
        assert.equal(record.completeWs, `${handle.url}/v1/complete`);
        const ws = new WebSocket(handle.url);
        const frames = [];
        ws.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
        await once(ws, 'open');
        ws.send(JSON.stringify({ type: 'hello', role: 'client', token: 'c'.repeat(64) }));
        await delay(50);
        assert.equal(frames[0].type, 'ready');
        ws.close();
    } finally {
        await handle.close();
        await assert.rejects(readFile(path.join(home, 'serve.json'), 'utf8'));
        await rm(home, { recursive: true, force: true });
    }
});

test('the server of the package and the server of the monolith do not fight for the port', async () => {
    const pkg = await resolveServerPackage({ root: ROOT, env: {} });
    if (!pkg) return;
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-bridge-port-'));
    const handle = await startServeBridge({ pkg, home, port: 0 });
    try {
        await assert.rejects(
            () => pkg.startServe({ home: `${home}-second`, port: handle.port }),
            (error) => {
                assert.equal(error.code, 'PORT_BUSY');
                return true;
            },
        );
    } finally {
        await handle.close();
        await rm(home, { recursive: true, force: true });
    }
});

test('ai mcp serve is a thin client to the MCP server of the package', async () => {
    const bin = path.join(ROOT, 'bin', 'ai.js');
    const child = spawn(process.execPath, [bin, 'mcp', 'serve'], {
        env: { ...process.env, AI_SERVE_HOME: path.join(os.tmpdir(), 'ai-serve-mcp-client') },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) break;
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) lines.push(line);
        }
    });
    try {
        child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
        })}\n`);
        for (let i = 0; i < 100 && lines.length === 0; i += 1) await delay(30);
        assert.equal(lines.length > 0, true, 'the MCP server did not answer');
        const answer = JSON.parse(lines[0]);
        assert.equal(answer.id, 1);
        assert.equal(answer.result.serverInfo.name, 'ai-serve');
    } finally {
        child.kill();
        await new Promise((resolve) => child.on('close', resolve));
    }
});

test('ai serve of the monolith and ai-serve serve do not fight for the port', async () => {
    const pkg = await resolveServerPackage({ root: ROOT, env: {} });
    if (!pkg) return;
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-serve-bridge-cli-'));
    const handle = await startServeBridge({ pkg, home, port: 0 });
    const bin = path.join(ROOT, 'submodules', 'u2ai-server', 'bin', 'ai-serve.js');
    if (!existsSync(bin)) {
        await handle.close();
        await rm(home, { recursive: true, force: true });
        return;
    }
    try {
        const child = spawn(process.execPath, [bin, 'serve', '--port', String(handle.port)], {
            env: { ...process.env, AI_SERVE_HOME: `${home}-second` },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve) => child.on('close', resolve));
        assert.notEqual(code, 0);
        assert.match(stderr, /busy/i);
    } finally {
        await handle.close();
        await rm(home, { recursive: true, force: true });
    }
});
