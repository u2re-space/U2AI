/**
 * @file src/commands/webdev.js
 * @module commands/webdev
 * @purpose `ai gen` and the web part of `ai run` — delegate the web work to the dedicated CLI
 *   `@u2ai/webdev` (`ai-webdev`).
 *
 *   The web pipeline (the plan, the architecture, the setup, the markup, the code, the styles,
 *   the vector graphics, the icons, the review, the audit and the lessons) lives in its own
 *   package since 0.3.x: it has its own stages, its own roles, its own memory and its own tests.
 *   The monolith keeps the old team for the tasks that are not about the web, and forwards the
 *   web ones, so the old entry point keeps working and the code stays in one place.
 *
 *   The binary is looked up in this order: `AI_WEBDEV_BIN`, the `submodules/u2ai-webdev` checkout
 *   of this repository, the installed `node_modules/@u2ai/webdev`, and the `PATH`.
 *   `AI_WEBDEV_BIN=none` switches the delegation off: the monolith keeps its own pipeline.
 *
 * @depends node:path, node:fs/promises, node:child_process, node:url, generate/references
 * @usedBy commands/run, commands/gen, cli
 * @exports delegateWebdev, webdevArgs, webdevCandidates, resolveWebdev, webdevRoleName, isWebTask
 * @ai.tags cli, webdev, delegation
 * @ai.hint io
 * @changed 2026-11-13 The web pipeline moved to `@u2ai/webdev`; the monolith forwards to it.
 */

import path from 'node:path';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageReferences } from '../generate/references.js';

/** The root of the monolith: two levels above src/commands/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The values of `AI_WEBDEV_BIN` that switch the delegation off. */
const DISABLED = new Set(['none', 'off', 'no', '0', 'false']);

/**
 * The frameworks of the monolith and the ones of the new CLI.
 *
 * The new CLI knows a smaller set: a framework it does not know is left out of the call, and
 * the new CLI keeps its own default.
 */
const FRAMEWORKS = Object.freeze({
    vanilla: 'vanilla', default: 'vanilla', none: 'vanilla',
    react: 'react', 'react-ssr': 'react',
    vue: 'vue', 'vue-runtime': 'vue',
    svelte: 'svelte', next: 'next', astro: 'astro', vite: 'vite',
});

/** The markup languages: `htmx` and `pug` have no counterpart in the new CLI. */
const MARKUP = Object.freeze({
    html: 'html', default: 'html',
    jsx: 'jsx', tsx: 'tsx', vue: 'vue', svelte: 'svelte',
});

/** The stylesheet languages: `stylus` and `postcss-preset-env` have no counterpart. */
const STYLES = Object.freeze({
    css: 'css', vanilla: 'css', scss: 'scss', sass: 'scss', less: 'less',
});

/** The script languages: the new CLI knows JavaScript and TypeScript only. */
const SCRIPTS = Object.freeze({
    javascript: 'javascript', js: 'javascript', jsx: 'javascript',
    typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
});

/** The platform profiles: the monolith names a browser build, the new CLI names the browser. */
const PLATFORMS = Object.freeze({
    'chrome-156-stable': 'chromium',
    chromium: 'chromium',
});

/**
 * The stages of the monolith and the ones of the new CLI.
 *
 * Only the stages that mean the same thing in both pipelines are mapped; the rest are left to
 * the new CLI.
 */
const STAGES = Object.freeze({
    plan: 'plan',
    collect: 'collect',
    architect: 'architect',
    install: 'setup',
    work: 'coding',
    decor: 'vector',
    iconify: 'iconify',
    review: 'review',
    memory: 'learn',
});

/** The roles of the monolith and the ones of the new CLI. */
const ROLES = Object.freeze({
    planner: 'planner',
    architect: 'architect',
    orchestrator: 'director',
    worker: 'coder',
    styler: 'styler',
    iconifier: 'iconifier',
    installer: 'installer',
    decorator: 'editor',
    reviewer: 'reviewer',
});

/**
 * The files that may hold the new CLI, in the order they are tried.
 * @param {object} [options]
 * @param {string} [options.root] the root of the monolith
 * @param {object} [options.env] the environment to read AI_WEBDEV_BIN from
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function webdevCandidates({ root = ROOT, env = process.env } = {}) {
    const candidates = [];
    if (env.AI_WEBDEV_BIN) candidates.push(path.resolve(env.AI_WEBDEV_BIN));
    candidates.push(path.join(root, 'submodules', 'u2ai-webdev', 'bin', 'ai-webdev.js'));
    candidates.push(path.join(root, 'node_modules', '@u2ai', 'webdev', 'bin', 'ai-webdev.js'));
    return candidates;
}

/**
 * Find the CLI to delegate to.
 *
 * A `.js` entry is run with the same Node that runs the monolith; anything else is an executable
 * and is started as it is. `AI_WEBDEV_BIN=none` switches the delegation off.
 * @param {object} [options]
 * @param {string} [options.root] the monolith root
 * @param {object} [options.env] the environment
 * @returns {Promise<{ command: string, args: string[] }|null>} null when the CLI is not installed
 * @exports
 * @ai.hint io
 */
export async function resolveWebdev({ root = ROOT, env = process.env } = {}) {
    const raw = String(env.AI_WEBDEV_BIN ?? '').trim();
    if (DISABLED.has(raw.toLowerCase())) return null;
    for (const candidate of webdevCandidates({ root, env })) {
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
 * The `ai-webdev` executable in PATH.
 * @param {object} env
 * @returns {Promise<{ command: string, args: string[] }|null>}
 * @exports
 * @ai.hint io
 */
async function findOnPath(env) {
    const names = process.platform === 'win32' ? ['ai-webdev.cmd', 'ai-webdev.exe', 'ai-webdev'] : ['ai-webdev'];
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
 * The name of a role in the new CLI, or null when the role has no counterpart there.
 * @param {string} name the name of the role in the monolith
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function webdevRoleName(name) {
    return ROLES[String(name ?? '').trim().toLowerCase()] ?? null;
}

/**
 * Is this run a web run, so that it belongs to the dedicated CLI?
 *
 * A task that names a kind, or that asks for the knobs of a generation, is a web task. Everything
 * else stays in the own team of the monolith.
 * @param {{ kind?: string|null, wantsProfile?: boolean }} [prepared] the prepared invocation
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isWebTask(prepared = {}) {
    return Boolean(prepared?.kind) || Boolean(prepared?.wantsProfile);
}

/**
 * The arguments of the new CLI, built from the flags of the monolith.
 *
 * The two CLIs share most of their vocabulary: the task, the kind, the fidelity, the creativity,
 * the model, the effort, the configuration, the policy of the confirmations (`--extract`,
 * `--approve`) and the models of the roles (`--role`).
 *
 * The names of the flags change, the meaning does not. The values the new CLI does not know
 * (a framework it does not have, a stage of the old pipeline) are left out of the call: the new
 * CLI keeps its own default instead of failing on a foreign value.
 * @param {object} values the parsed flags of the monolith
 * @param {{ kind?: string|null, task?: string }} [context] the kind and the task of the run
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function webdevArgs(values = {}, { kind = null, task = '' } = {}) {
    const args = ['run'];
    const text = String(task ?? '').trim();
    if (text) args.push(text);
    if (kind) args.push('--kind', String(kind));

    if (values.fidelity !== undefined) args.push('--fidelity', String(values.fidelity));
    if (values.creativity !== undefined) args.push('--creativity', String(values.creativity));
    if (values.platform) {
        const platform = PLATFORMS[String(values.platform).trim().toLowerCase()];
        if (platform) args.push('--platform', platform);
    }

    const framework = FRAMEWORKS[String(values['frontend-framework'] ?? '').trim().toLowerCase()];
    if (framework) args.push('--frontend-framework', framework);
    const markup = MARKUP[String(values['frontend-markup-language'] ?? '').trim().toLowerCase()];
    if (markup) args.push('--frontend-markup-language', markup);
    const style = STYLES[String(values['frontend-style-language'] ?? '').trim().toLowerCase()];
    if (style) args.push('--frontend-style-language', style);
    const script = SCRIPTS[String(values['frontend-script-language'] ?? '').trim().toLowerCase()];
    if (script) args.push('--frontend-script-language', script);
    if (values['icon-set']) {
        const icons = String(values['icon-set']).trim().toLowerCase();
        if (['auto', 'lucide', 'phosphor'].includes(icons)) args.push('--icon-set', icons);
    }

    if (values.model) args.push('--model', String(values.model));
    if (values.effort) args.push('--effort', String(values.effort));
    if (values.config) args.push('--config', String(values.config));
    if (values.extract) args.push('--extract', String(values.extract));
    if (values.approve) args.push('--approve', String(values.approve));
    if (values.context && /^(small|normal|large|max|auto)$/i.test(String(values.context).trim())) {
        args.push('--context', String(values.context).trim().toLowerCase());
    }
    if (values.id) args.push('--id', String(values.id));
    if (values['stop-after']) {
        const stage = STAGES[String(values['stop-after']).trim().toLowerCase()];
        if (stage) args.push('--stop-after', stage);
    }
    for (const spec of values.role ?? []) {
        const match = /^([\w*-]+)=([^:]+?)(?::([a-z]*))?(?::([a-z]*))?$/.exec(String(spec).trim());
        if (!match) continue;
        const name = webdevRoleName(match[1]);
        if (!name) continue;
        const [, , model, effort, maxEffort] = match;
        args.push('--role', [name, model, effort, maxEffort].filter(Boolean).join(':'));
    }
    if (values.json) args.push('--json');
    if (values.quiet) args.push('--quiet');
    return args;
}

/**
 * The web part of a run: delegate it to the dedicated CLI.
 *
 * The references of the monolith are staged into `.ai/refs/`, the directory the new CLI reads
 * its pictures from, so a reference of the old entry point is a reference of the new one.
 *
 * @param {object} ctx Command context from cli.main.
 * @param {{ kind?: string|null, task?: string }} [context] the kind and the task of the run
 * @returns {Promise<number|null>} the exit code of the delegated run, or null when the package
 *   is not installed and the monolith has to do the work itself.
 * @exports
 * @ai.hint io
 */
export async function delegateWebdev(ctx, { kind = null, task = '' } = {}) {
    const { values, cwd, renderer } = ctx;
    const target = await resolveWebdev();
    if (!target) return null;

    let text = String(task ?? '').trim();
    const images = Array.isArray(values.image) ? values.image : [];
    if (images.length) {
        const staged = await stageReferences({
            images, cwd, maxBytes: ctx.config?.limits?.maxImageBytes ?? 20 * 1024 * 1024, signal: ctx.signal,
        });
        for (const warning of staged.warnings ?? []) renderer.line('warn', warning, { dim: true });
        if (staged.refs?.length) {
            const lines = staged.refs.map((item) => `- ${item.rel}${item.width && item.height ? ` (${item.width}×${item.height})` : ''}`);
            text = [text, `Reference images (project-relative paths):\n${lines.join('\n')}`].filter(Boolean).join('\n\n');
        }
    }

    const args = [...target.args, ...webdevArgs(values, { kind, task: text })];
    renderer.line('info', `делегирую в ai-webdev: ${args.slice(1).join(' ') || '(без аргументов)'}`);
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
            process.stderr.write(`Не удалось запустить ai-webdev: ${error.message}\n`);
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
