/**
 * @file src/commands/gen.js
 * @module commands/gen
 * @purpose `ai gen` — the web entry point of the monolith: it delegates to `@u2ai/webdev`.
 * @depends commands/run
 * @usedBy cli
 * @exports gen
 * @ai.tags cli, generate
 * @ai.hint io
 * @changed 2026-10-15 Alias of run.
 * @changed 2026-11-13 The web generation moved to `@u2ai/webdev`; the monolith forwards to it.
 */
import { run } from './run.js';

/**
 * `ai gen` uses the same handler, flags, and positionals as `ai run`.
 *
 * The web work belongs to the dedicated CLI since 0.3.x: the run is delegated to it, and the
 * monolith keeps its own team only when the package is not installed.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code from run.
 * @exports
 * @ai.hint io
 */
export async function gen(ctx) {
    return run(ctx, { delegate: true });
}
