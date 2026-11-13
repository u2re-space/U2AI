/**
 * @file src/commands/decompose.js
 * @module commands/decompose
 * @purpose `ai decompose` — delegate the reference decomposition to the dedicated CLI
 *   `@u2ai/decomposer` (`ai-decompose`).
 *
 *   The phases (extend → decompose → rectify → reconstruct → overlap → resolve) live in their own
 *   package since 0.3.x: they have their own configuration, their own roles and their own tests.
 *   The monolith keeps one command that forwards to it, so the old entry point keeps working and
 *   the code stays in one place.
 *
 *   The binary is looked up in this order: `AI_DECOMPOSE_BIN`, the `submodules/u2ai-decomposer`
 *   checkout of this repository, the installed `node_modules/@u2ai/decomposer`, and the `PATH`.
 * @depends node:path, node:fs/promises, node:child_process, commands/shared
 * @usedBy cli
 * @exports decompose, decomposeArgs, resolveDecomposer, decomposerCandidates
 * @ai.tags cli, decompose, delegation
 * @ai.hint io
 * @changed 2026-11-13 The phases moved to `@u2ai/decomposer`; the monolith forwards to it.
 */

import path from 'node:path';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageError } from './shared.js';

/** The root of the monolith: two levels above src/commands/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The files that may hold the new CLI, in the order they are tried.
 * @param {object} [options]
 * @param {string} [options.root] the root of the monolith
 * @param {object} [options.env] the environment to read AI_DECOMPOSE_BIN from
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function decomposerCandidates({ root = ROOT, env = process.env } = {}) {
    const candidates = [];
    if (env.AI_DECOMPOSE_BIN) candidates.push(path.resolve(env.AI_DECOMPOSE_BIN));
    candidates.push(path.join(root, 'submodules', 'u2ai-decomposer', 'bin', 'ai-decompose.js'));
    candidates.push(path.join(root, 'node_modules', '@u2ai', 'decomposer', 'bin', 'ai-decompose.js'));
    return candidates;
}

/**
 * Find the CLI to delegate to.
 *
 * A `.js` entry is run with the same Node that runs the monolith; anything else is an executable
 * and is started as it is.
 * @param {object} [options]
 * @param {string} [options.root] the monolith root
 * @param {object} [options.env] the environment
 * @returns {Promise<{ command: string, args: string[] }|null>} null when the CLI is not installed
 * @exports
 * @ai.hint io
 */
export async function resolveDecomposer({ root = ROOT, env = process.env } = {}) {
    for (const candidate of decomposerCandidates({ root, env })) {
        const found = await access(candidate).then(() => true).catch(() => false);
        if (!found) continue;
        if (candidate.endsWith('.js')) return { command: process.execPath, args: [candidate] };
        return { command: candidate, args: [] };
    }
    return await findOnPath(env);
}

/**
 * The `ai-decompose` executable in PATH.
 * @param {object} env
 * @returns {Promise<{ command: string, args: string[] }|null>}
 * @exports
 * @ai.hint io
 */
async function findOnPath(env) {
    const names = process.platform === 'win32' ? ['ai-decompose.cmd', 'ai-decompose.exe', 'ai-decompose'] : ['ai-decompose'];
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            const full = path.join(dir, name);
            if (!await access(full).then(() => true).catch(() => false)) continue;
            if (process.platform === 'win32' && name.endsWith('.cmd')) {
                return { command: full, args: [], shell: true };
            }
            return { command: full, args: [] };
        }
    }
    return null;
}

/**
 * The arguments of the new CLI, built from the flags of the monolith.
 *
 * The two CLIs share most of their vocabulary: pictures (`--image`), the output directory
 * (`--out`), the config (`--config`), the models (`--model`, `--effort`, `--image-model`) and the
 * pipeline controls (`--stop-after`). The stages of the new pipeline (`--stages`) and its two
 * switches (`--dry-run`, `--advanced`) are added here as well.
 * @param {object} values the parsed flags of the monolith
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function decomposeArgs(values = {}) {
    const args = [];
    for (const image of values.image ?? []) args.push('--image', image);
    if (values.out) args.push('--out', values.out);
    if (values.config) args.push('--config', values.config);
    if (values.model) args.push('--model', values.model);
    if (values.effort) args.push('--effort', values.effort);
    if (values['image-model']) args.push('--image-model', values['image-model']);
    if (values['stop-after']) args.push('--stop-after', values['stop-after']);
    if (values.stages?.length) args.push('--stages', values.stages.join(','));
    if (values['dry-run']) args.push('--dry-run');
    if (values.advanced) args.push('--advanced');
    return args;
}

/**
 * `ai decompose` — run the dedicated decomposition CLI.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} the exit code of the delegated run.
 * @exports
 * @ai.hint io
 */
export async function decompose(ctx) {
    const { values, cwd, renderer } = ctx;
    const target = await resolveDecomposer();
    if (!target) {
        throw new UsageError('Пакет @u2ai/decomposer не найден. Установите его (npm i -g @u2ai/decomposer) '
            + 'или укажите путь к ai-decompose в AI_DECOMPOSE_BIN.');
    }
    const args = [...target.args, ...decomposeArgs(values)];
    renderer.line('info', `делегирую в ai-decompose: ${args.slice(1).join(' ') || '(без аргументов)'}`);
    const code = await run(target.command, args, cwd);
    return code;
}

/**
 * Run the delegated CLI and wait for it.
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
function run(command, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            stdio: 'inherit',
            env: process.env,
            shell: Boolean(command.endsWith('.cmd')),
            windowsHide: true,
        });
        child.on('error', (error) => {
            process.stderr.write(`Не удалось запустить ai-decompose: ${error.message}\n`);
            resolve(1);
        });
        child.on('close', (code, signal) => {
            if (signal) resolve(130);
            else resolve(code ?? 1);
        });
    });
}
