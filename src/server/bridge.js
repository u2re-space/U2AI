/**
 * @file src/server/bridge.js
 * @module server/bridge
 * @purpose The bridge to the package `@u2ai/server`: where it lives and how to reach it.
 *
 *   The server of the bus moved into its own package in 0.3.x. The monolith keeps the
 *   commands and the hub of the terminal runs, and it raises the server through the
 *   package when the package is installed. When it is not, the monolith keeps working
 *   the way it worked before.
 *
 *   The package is looked up in this order: `AI_SERVE_PKG`, the `submodules/u2ai-server`
 *   checkout of this repository, the installed `node_modules/@u2ai/server`, and the
 *   `PATH` (for the binary only).
 * @depends node:path, node:fs/promises, node:url
 * @usedBy commands/serve, commands/mcp
 * @exports serverPackageCandidates, resolveServerPackage, serverCliCandidates,
 *          resolveServerCli, runServerCli
 * @ai.tags server, bridge, delegation
 * @ai.hint io
 * @changed 2026-11-14 The server of the bus moved into `@u2ai/server`; the monolith delegates.
 */

import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The root of the monolith: two levels above src/server/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Whether the path exists.
 * @param {string} file
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function exists(file) {
    return await access(file).then(() => true).catch(() => false);
}

/**
 * The path of the entry of the package: a directory means its `index.js`.
 * @param {string} candidate
 * @returns {Promise<string|null>}
 * @ai.hint io
 */
async function entryOf(candidate) {
    if (!await exists(candidate)) return null;
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) {
        const inside = path.join(candidate, 'index.js');
        return await exists(inside) ? inside : null;
    }
    return candidate;
}

/**
 * The places the package may live, in the order they are tried.
 * @param {object} [options]
 * @param {string} [options.root] the root of the monolith
 * @param {object} [options.env] the environment to read AI_SERVE_PKG from
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function serverPackageCandidates({ root = ROOT, env = process.env } = {}) {
    const candidates = [];
    if (env.AI_SERVE_PKG) candidates.push(path.resolve(env.AI_SERVE_PKG));
    candidates.push(path.join(root, 'submodules', 'u2ai-server'));
    candidates.push(path.join(root, 'node_modules', '@u2ai', 'server'));
    return candidates;
}

/**
 * Load the package `@u2ai/server`.
 *
 * A package that is not installed is not an error: the monolith raises the server the
 * old way. A package that is broken is skipped as well — the monolith must not stop
 * working because of a broken dependency.
 * @param {object} [options]
 * @param {string} [options.root] the root of the monolith
 * @param {object} [options.env] the environment
 * @returns {Promise<object|null>} the module of the package, or null
 * @exports
 * @ai.hint io
 */
export async function resolveServerPackage({ root = ROOT, env = process.env } = {}) {
    for (const candidate of serverPackageCandidates({ root, env })) {
        const entry = await entryOf(candidate);
        if (!entry) continue;
        try {
            return await import(pathToFileURL(entry).href);
        } catch {
            // The package is broken: the monolith keeps its own server.
        }
    }
    return null;
}

/**
 * The places the binary of the package may live, in the order they are tried.
 * @param {object} [options]
 * @param {string} [options.root] the root of the monolith
 * @param {object} [options.env] the environment to read AI_SERVE_BIN from
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function serverCliCandidates({ root = ROOT, env = process.env } = {}) {
    const candidates = [];
    if (env.AI_SERVE_BIN) candidates.push(path.resolve(env.AI_SERVE_BIN));
    candidates.push(path.join(root, 'submodules', 'u2ai-server', 'bin', 'ai-serve.js'));
    candidates.push(path.join(root, 'node_modules', '@u2ai', 'server', 'bin', 'ai-serve.js'));
    return candidates;
}

/**
 * Find the binary of the package.
 *
 * A `.js` entry is run with the same Node that runs the monolith; anything else is an
 * executable and is started as it is.
 * @param {object} [options]
 * @param {string} [options.root] the root of the monolith
 * @param {object} [options.env] the environment
 * @returns {Promise<{ command: string, args: string[] }|null>} null when the binary is not installed
 * @exports
 * @ai.hint io
 */
export async function resolveServerCli({ root = ROOT, env = process.env } = {}) {
    for (const candidate of serverCliCandidates({ root, env })) {
        if (!await exists(candidate)) continue;
        if (candidate.endsWith('.js')) return { command: process.execPath, args: [candidate] };
        return { command: candidate, args: [] };
    }
    const names = process.platform === 'win32' ? ['ai-serve.cmd', 'ai-serve.exe', 'ai-serve'] : ['ai-serve'];
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            const full = path.join(dir, name);
            if (!await exists(full)) continue;
            if (process.platform === 'win32' && name.endsWith('.cmd')) {
                return { command: full, args: [], shell: true };
            }
            return { command: full, args: [] };
        }
    }
    return null;
}

/**
 * Run the binary of the package and wait for it.
 *
 * The streams are inherited: the client of the stdio transport of MCP talks to the
 * package directly, and nothing may be printed between the two of them.
 * @param {{ command: string, args?: string[], shell?: boolean }} target
 * @param {string[]} args the arguments of the command
 * @param {string} cwd the working directory
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export function runServerCli(target, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(target.command, [...(target.args ?? []), ...args], {
            cwd,
            stdio: 'inherit',
            env: process.env,
            shell: Boolean(target.shell),
            windowsHide: true,
        });
        child.on('error', (error) => {
            process.stderr.write(`Не удалось запустить ai-serve: ${error.message}\n`);
            resolve(1);
        });
        child.on('close', (code, signal) => {
            if (signal) resolve(130);
            else resolve(code ?? 1);
        });
    });
}
