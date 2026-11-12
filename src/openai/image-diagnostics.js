/**
 * @file src/openai/image-diagnostics.js
 * @module openai/image-diagnostics
 * @purpose Keep every raw image API answer on disk (.tmp/<id>/images/) so an unparsable or unexpected
 *   gateway shape can be inspected and re-parsed after the fact, base64 payloads included.
 * @depends node:path, node:fs/promises
 * @usedBy openai/client, openai/seedream-5-5, cli, agent/team
 * @exports setImageDiagnostics, imageDiagnosticsContext, saveImageResponse, saveImageParserScript, imageResponseDir
 * @ai.tags images, diagnostics, debug
 * @ai.hint io
 * @changed 2026-11-12 First version: generate/edit and the seedream-5.5 task answers are archived in
 *   full before any parsing, so a response the parsers cannot read is still recoverable evidence.
 *
 * The client and the seedream route know nothing about the project layout, and every caller that
 * could tell them (CLI, team orchestrator, agent tools) has a different one. So the directory is
 * module context: whoever owns the run announces it once with {@link setImageDiagnostics}, and the
 * image routes archive into it without threading a path through ten call sites. Without a context
 * the archiver is inert, which keeps the library usable as a plain client and keeps tests silent.
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

/** @type {{ root: string, workId: string|null, autoId: string|null }|null} */
let context = null;

/** One counter per process: two responses in the same second still get separate files. */
let sequence = 0;

/**
 * `20261112-141530` — sortable, filesystem-safe, no colons.
 * @returns {string}
 * @ai.hint pure
 */
function stamp() {
    const iso = new Date().toISOString();
    return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * A `.tmp` directory name for a run that never announced one (`ai image`, `--single`).
 * @returns {string}
 * @ai.hint io
 */
function autoWorkId() {
    return `image-${stamp()}-${process.pid}`;
}

/**
 * A `.tmp` directory name out of whatever the caller passed as the run id. Anything that is not a
 * plain word is dropped, so a stray path or flag value can never escape the archive directory.
 * @param {unknown} value
 * @returns {string|null}
 * @ai.hint pure
 */
function sanitizeWorkId(value) {
    const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 64);
    return text || null;
}

/**
 * Announce where image answers of this run belong.
 * @param {{ root: string, workId?: string|null }|null} next Project root and the run's `.tmp` name.
 *   `null` turns archiving off (tests, library use).
 * @returns {{ root: string, workId: string|null, autoId: string|null }|null}
 * @exports
 * @ai.hint pure
 */
export function setImageDiagnostics(next) {
    context = next?.root ? { root: next.root, workId: sanitizeWorkId(next.workId), autoId: null } : null;
    return context;
}

/**
 * The active archive context, or null when nobody announced a run.
 * @returns {{ root: string, workId: string|null, autoId: string|null }|null}
 * @exports
 * @ai.hint pure
 */
export function imageDiagnosticsContext() {
    return context;
}

/**
 * `.tmp/<id>/images/` of this run, project-relative, when a context exists.
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function imageResponseDir() {
    if (!context) return null;
    const id = context.workId || context.autoId || (context.autoId = autoWorkId());
    return path.posix.join('.tmp', id, 'images');
}

/**
 * Write one salvage script next to the answers, so the way a picture was extracted from an unusual
 * response survives the run that discovered it.
 * @param {string} script
 * @param {{ route?: string, notes?: string }} [meta]
 * @returns {Promise<string|null>} project-relative path, or null when nothing was written
 * @exports
 * @ai.hint io
 */
export async function saveImageParserScript(script, meta = {}) {
    if (!context) return null;
    try {
        const rel = imageResponseDir();
        if (!rel) return null;
        sequence += 1;
        const slug = String(meta.route ?? 'response').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'response';
        const file = `${stamp()}-${slug}-parser-${String(sequence).padStart(3, '0')}.js`;
        const abs = path.join(context.root, ...rel.split('/'), file);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, `// salvage script · ${new Date().toISOString()} · ${slug}\n`
            + (meta.notes ? `// ${String(meta.notes).replace(/\r?\n/g, ' ')}\n` : '')
            + `${script}\n`);
        return path.posix.join(rel, file);
    } catch {
        return null;
    }
}

/**
 * Archive one gateway answer in full — base64 payloads included — before anything parses it.
 * A failure to write is never the caller's problem: the response is already paid for, and losing
 * a debug file must not turn a good generation into a failed one.
 * @param {unknown} result Parsed JSON body as it came off the wire.
 * @param {{ route?: string, model?: string|null, host?: string|null, taskId?: string|null,
 *   provider?: string|null }} [meta] What produced the answer, for the file name and the header.
 * @returns {Promise<string|null>} Project-relative path of the saved file, or null when nothing
 *   was written (no context, or the disk refused).
 * @exports
 * @ai.hint io
 */
export async function saveImageResponse(result, meta = {}) {
    if (!context) return null;
    try {
        const rel = imageResponseDir();
        if (!rel) return null;
        sequence += 1;
        const slug = String(meta.route ?? 'response').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'response';
        const file = `${stamp()}-${slug}-${String(sequence).padStart(3, '0')}.json`;
        const abs = path.join(context.root, ...rel.split('/'), file);
        await mkdir(path.dirname(abs), { recursive: true });
        const record = {
            savedAt: new Date().toISOString(),
            route: meta.route ?? null,
            model: meta.model ?? null,
            host: meta.host ?? null,
            provider: meta.provider ?? null,
            taskId: meta.taskId ?? null,
            response: result ?? null,
        };
        await writeFile(abs, JSON.stringify(record, null, 2));
        return path.posix.join(rel, file);
    } catch {
        return null;
    }
}
