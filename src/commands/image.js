/**
 * @file src/commands/image.js
 * @module commands/image
 * @purpose `ai image` — delegate the work with the pictures to the dedicated CLI `@u2ai/images`
 *   (`ai-image`).
 *
 *   The picture work (generation, editing, sizing, cropping, padding, the alpha channel and the
 *   background) lives in its own package since 0.3.x: it has its own configuration, its own
 *   purposes, its own raster layer and its own tests. The monolith keeps one command that
 *   forwards to it, so the old entry point keeps working and the code stays in one place.
 *
 *   The binary is looked up in this order: `AI_IMAGE_BIN`, the `submodules/u2ai-images` checkout
 *   of this repository, the installed `node_modules/@u2ai/images`, and the `PATH`.
 * @depends node:path, node:fs/promises, node:child_process, commands/shared
 * @usedBy cli
 * @exports image, imageArgs, resolveImageCli, imageCandidates
 * @ai.tags cli, image, delegation
 * @ai.hint io
 * @changed 2026-11-13 The picture work moved to `@u2ai/images`; the monolith forwards to it.
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
 * @param {object} [options.env] the environment to read AI_IMAGE_BIN from
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function imageCandidates({ root = ROOT, env = process.env } = {}) {
    const candidates = [];
    if (env.AI_IMAGE_BIN) candidates.push(path.resolve(env.AI_IMAGE_BIN));
    candidates.push(path.join(root, 'submodules', 'u2ai-images', 'bin', 'ai-image.js'));
    candidates.push(path.join(root, 'node_modules', '@u2ai', 'images', 'bin', 'ai-image.js'));
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
export async function resolveImageCli({ root = ROOT, env = process.env } = {}) {
    for (const candidate of imageCandidates({ root, env })) {
        const found = await access(candidate).then(() => true).catch(() => false);
        if (!found) continue;
        if (candidate.endsWith('.js')) return { command: process.execPath, args: [candidate] };
        // A `.cmd` of Windows is a script for the shell, not an executable.
        if (candidate.endsWith('.cmd')) return { command: candidate, args: [], shell: true };
        return { command: candidate, args: [] };
    }
    return await findOnPath(env);
}

/**
 * The `ai-image` executable in PATH.
 * @param {object} env
 * @returns {Promise<{ command: string, args: string[] }|null>}
 * @exports
 * @ai.hint io
 */
async function findOnPath(env) {
    const names = process.platform === 'win32' ? ['ai-image.cmd', 'ai-image.exe', 'ai-image'] : ['ai-image'];
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
 * The two CLIs share most of their vocabulary: the pictures (`--image`), the output
 * (`--out`), the configuration (`--config`), the models (`--model`, `--image-model`), the frame
 * (`--size`), the format (`--format`), the background (`--image-background`), the tier
 * (`--image-resolution`) and the count (`--count`).
 *
 * One picture is a source of an edit; the rest are references. No picture at all is a
 * generation. The names of the flags change, the meaning does not.
 * @param {object} values the parsed flags of the monolith
 * @param {string[]} [positionals] the prompt of the run
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function imageArgs(values = {}, positionals = []) {
    const args = [];
    const images = Array.isArray(values.image) ? values.image : [];
    const prompt = positionals.map((value) => String(value)).join(' ').trim();
    if (images.length) {
        args.push('edit', images[0]);
        for (const extra of images.slice(1)) args.push('--reference', extra);
    } else {
        args.push('generate');
    }
    if (prompt) args.push(prompt);
    if (values.out) args.push('--out', values.out);
    if (values.config) args.push('--config', values.config);
    if (values.model) args.push('--model', values.model);
    if (values['image-model']) args.push('--image-model', values['image-model']);
    if (values.size) args.push('--size', values.size);
    if (values.format) args.push('--format', values.format);
    if (values['image-background']) args.push('--background', values['image-background']);
    const resolution = String(values['image-resolution'] ?? '').trim();
    if (resolution && resolution !== 'auto' && resolution !== 'off') args.push('--resolution', resolution);
    if (values.count) args.push('--count', values.count);
    if (values.json) args.push('--json');
    if (values['dry-run']) args.push('--dry-run');
    return args;
}

/**
 * `ai image` — run the dedicated picture CLI.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} the exit code of the delegated run.
 * @exports
 * @ai.hint io
 */
export async function image(ctx) {
    const { values, cwd, renderer, positionals } = ctx;
    const target = await resolveImageCli();
    if (!target) {
        throw new UsageError('Пакет @u2ai/images не найден. Установите его (npm i -g @u2ai/images) '
            + 'или укажите путь к ai-image в AI_IMAGE_BIN.');
    }
    const args = [...target.args, ...imageArgs(values, positionals)];
    renderer.line('info', `делегирую в ai-image: ${args.slice(1).join(' ') || '(без аргументов)'}`);
    return await run(target.command, args, cwd, renderer, target.shell === true);
}

/**
 * Run the delegated CLI and wait for it.
 *
 * In a terminal the child writes straight into the terminal: its own colors and its own
 * line breaks stay as they are. In the JSON mode the output is read line by line and goes
 * through the renderer: a JSON line becomes an event of the bus, a plain line becomes a
 * text delta.
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {object} renderer
 * @param {boolean} [shell]
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
function run(command, args, cwd, renderer, shell = false) {
    const events = renderer.mode === 'json';
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            stdio: events ? ['inherit', 'pipe', 'pipe'] : 'inherit',
            env: process.env,
            shell,
            windowsHide: true,
        });
        if (events) {
            forward(child.stdout, renderer);
            forward(child.stderr, renderer);
        }
        child.on('error', (error) => {
            process.stderr.write(`Не удалось запустить ai-image: ${error.message}\n`);
            resolve(1);
        });
        child.on('close', (code, signal) => {
            if (signal) resolve(130);
            else resolve(code ?? 1);
        });
    });
}

/**
 * Read a stream of the child line by line and give every line to the renderer.
 * @param {Readable} stream
 * @param {object} renderer
 * @returns {void}
 * @exports
 * @ai.hint io
 */
function forward(stream, renderer) {
    let rest = '';
    /**
     * Give one line to the renderer: a JSON line as an event, a plain line as text.
     * @param {string} line
     * @returns {void}
     * @ai.hint pure
     */
    const emit = (line) => {
        if (!line.trim()) return;
        try {
            const payload = JSON.parse(line);
            // Only an object becomes an event: a number or a string would be spread
            // into the fields of the event instead of being carried by it.
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                renderer.json(payload);
                return;
            }
        } catch { /* not a JSON line: plain text */ }
        renderer.text(`${line}\n`);
    };
    stream.on('data', (chunk) => {
        const lines = (rest + chunk.toString()).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) emit(line);
    });
    stream.on('end', () => {
        if (rest) emit(rest);
    });
}
