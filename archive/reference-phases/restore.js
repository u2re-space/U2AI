/**
 * @file src/agent/restore.js
 * @module agent/restore
 * @purpose Phase 1.5 inside the decompose stage — after the projections (phase 1) and before the
 *   layer split (phase 2, advanced mode): clean a sub-reference the deterministic path cannot fix —
 *   the strip of a neighbour that came with the crop, a bezel or a finger, the wedge an earlier
 *   rotation left, a control the frame cut in half — without redrawing the screen.
 * @depends node:path, node:fs/promises, agent/paths, agent/schemas, shared/image-raster,
 *   shared/images, shared/constants, core/attachments, commands/instructions
 * @usedBy agent/team (restore stage)
 * @exports canRestore, restorableFiles, restoreSubReferences, applyRepairs, EDITOR_FRAME,
 *   MAX_PATCH_COVERAGE, MIN_FRAGMENT_SIDE
 * @ai.tags restoration, sub-reference, decomposition, images, measurer
 * @ai.hint io
 *
 * Why the repair is a cut-out and not a full-screen edit. The decomposer already put every pixel
 * where it belongs; what it cannot do is remove content that does not belong to the screen. Sending
 * the whole sub-reference to a generative editor throws the deterministic work away: the model
 * redraws every glyph, drifts the palette, and moves elements where its sampler landed, and the
 * measurer then reads that drawing as the design. So the harness cuts the box the `restorer` role
 * named, sends only that fragment, and stitches the answer back into exactly that box. Every pixel
 * outside the box is copied from the untouched source file, so the paddings, the type sizes and the
 * colours around the repair still measure the original screen.
 *
 * The instruction sent to the editor is written by the `restorer` role, per region, after it has
 * looked at this particular picture. A fixed sentence cannot do that job: which neighbour leaked
 * into the crop, which half of a control the frame clipped, and what colour the surface continues
 * into are facts about one file. What the harness adds is `EDITOR_FRAME` — not a repair recipe but
 * the contract the fragment travels under (it is a cut-out, keep its scale, change only the named
 * thing), which no caller can override.
 *
 * @changed 2026-11-13 First version.
 */

import path from 'node:path';
import { mkdir, readFile, unlink, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA } from './schemas.js';
import { rasterCrop, rasterInfo, rasterPatch } from '../shared/image-raster.js';
import { imageModelFor, sniffImage } from '../shared/images.js';
import { EDITOR_FRAME, MAX_PATCH_COVERAGE, MIN_FRAGMENT_SIDE, editorPrompt, pickPatches, planFragment } from './restore-plan.js';
import { loadImageAttachment } from '../core/attachments.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { errorMessage } from '../util/text.js';

/** Directory under the work directory where repaired copies are written. */
export const RESTORED_DIR = 'restored';

/** Sub-reference kinds a transform produced, so `restore: auto` has something to look for. */
const TRANSFORMED_KINDS = new Set(['restored', 'regenerated', 'repaired']);

/** Where a repaired copy of `rel` belongs: `restored/` beside the sub-reference, same file name. */
function restoredPath(rel) {
    const name = rel.split('/').pop();
    return `${path.posix.dirname(rel)}/${RESTORED_DIR}/${name}`;
}

/**
 * Can this run repair anything? The stage needs the images API and the image tools switched on;
 * a run without them has no editor to send the fragment to.
 * @param {object} config
 * @param {{ images?: boolean }} [tools]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function canRestore(config, tools = null) {
    if ((tools ?? config.tools)?.images === false) return false;
    return Boolean(config?.imageModel || config?.backends?.length || config?.imagesBackends?.length);
}

/**
 * The sub-references worth looking at. `auto` reads every sub-reference the decomposer produced —
 * a crop of a flat export can still carry a neighbour's strip, a clipped keyboard or a shadow, and
 * only the role can tell that from a clean cut — while `always` also reads files that were already
 * through a transform pass (`restored`, `repaired`, `regenerated`), which `auto` leaves alone so a
 * second pass cannot grind the same file down.
 * @param {object[]} files collected sub-references
 * @param {'off'|'auto'|'always'} mode
 * @param {number} maxFiles
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function restorableFiles(files = [], mode = 'auto', maxFiles = 6) {
    if (mode === 'off') return [];
    const pool = mode === 'always' ? files : files.filter((file) => !TRANSFORMED_KINDS.has(file.kind));
    return pool.slice(0, Math.max(1, maxFiles));
}

/**
 * One vision request over one sub-reference: what blocks measurement, and the editor instruction for
 * each region. The role returns coordinates of the sub-reference, which is the file being repaired.
 * @returns {Promise<{ data: object|null, status: string, error: string|null }>}
 */
async function askRestorer({ cwd, roles, file, originalPart, frame, model, effort, signal }) {
    const attachment = await loadImageAttachment(file.rel, { cwd, maxBytes: Number.MAX_SAFE_INTEGER });
    const parts = [attachment.part];
    if (originalPart) parts.push(originalPart);
    const result = await roles.run('restorer', {
        text: [
            `Sub-reference: ${file.rel}`,
            `Screen: ${file.screen || '(unnamed)'}`,
            `Produced by: ${file.kind}${file.note ? ` — ${file.note}` : ''}`,
            `Source: ${file.source || '(unknown)'}`,
            `Size of the sub-reference: ${frame.width}x${frame.height} pixels. Every coordinate you return belongs to this file.`,
            originalPart ? 'The second image is the original reference this file was cut or rectified from, for comparison only.' : '',
            '',
            'Name what stops this file from being measured, and write the editor instruction for each region.',
        ].filter(Boolean).join('\n'),
        parts,
        instructions: ROLE_INSTRUCTIONS.restorer,
        schema: RESTORE_SCHEMA, schemaName: 'restorePlan', maxTurns: 1, silent: true,
        model, effort, signal,
    });
    return { data: result.data ?? null, status: result.status, error: result.error ? errorMessage(result.error) : null };
}

/**
 * Ask whether the repaired file is better than the one it would replace.
 * Anything but a clean "better" keeps the original: a repair that redrew the lettering is worse
 * for measurement than the defect it removed, and the measurer cannot tell the two apart.
 * @returns {Promise<{ verdict: string, reason: string }>}
 */
async function verifyRepair({ roles, before, after, cwd, maxBytes, model, effort, signal }) {
    const [first, second] = await Promise.all([
        loadImageAttachment(before, { cwd, maxBytes }),
        loadImageAttachment(after, { cwd, maxBytes }),
    ]);
    const result = await roles.run('restorer', {
        text: 'BEFORE is the first image, AFTER is the second. Which should the measurer use?',
        parts: [first.part, second.part],
        instructions: ROLE_INSTRUCTIONS.restorerVerify,
        schema: RESTORE_VERIFY_SCHEMA, schemaName: 'restoreVerdict', maxTurns: 1, silent: true,
        model, effort, signal,
    });
    const data = result.data;
    if (result.status !== 'completed' || !data?.verdict) {
        return { verdict: 'worse', reason: `верификация не ответила (${result.status})` };
    }
    return { verdict: data.verdict, reason: String(data.reason ?? '').trim() };
}

/**
 * Repair the listed sub-references.
 *
 * Nothing here overwrites an input: each repaired screen is a new file under `restored/`, and the
 * caller decides whether it replaces the sub-reference. A file whose patches all failed keeps its
 * original and is reported, so the measurer still gets a screen.
 * @param {{
 *   root: string, decomposition: object|null, files: object[], roles: object, client: object,
 *   config: object, signal?: AbortSignal, notify?: (event: object) => void,
 *   originals?: Map<string, object|null>, maxPatches?: number, verify?: boolean,
 *   model?: string|null, effort?: string|null, maxBytes?: number, outDir?: string|null
 * }} options
 * @returns {Promise<{ replaced: Array<{from:string,to:string,patches:object[],verification:object|null,bytes:number}>,
 *   kept: Array<{rel:string,reason:string}>, warnings: string[], patchesProposed: number }>}
 * @exports
 * @ai.hint io
 */
export async function restoreSubReferences({
    root, files = [], roles, client, config, signal, notify = () => {},
    originals = new Map(), maxPatches = 3, verify = true,
    model: modelOverride = null, effort = null, editorModel: editorOverride = null,
    maxBytes = Number.MAX_SAFE_INTEGER, outDir = null,
}) {
    const warnings = [];
    const replaced = [];
    const kept = [];
    let patchesProposed = 0;
    if (!client?.images) {
        return { replaced, kept, warnings: ['Восстановление пропущено: images API недоступен.'], patchesProposed };
    }
    const engine = config.image?.rasterEngine ?? 'auto';
    // `modelOverride` is the vision model the restorer role uses to inspect the picture;
    // `editorOverride` is the image-editing model that actually redraws the fragment. They are
    // never the same: a chat/vision model (e.g. kimi-k3.1-pro) has no Images API entry, so
    // passing the role model to images.edit always returns "No model found".
    const editorModel = editorOverride || imageModelFor(config, { hasImage: true });
    // A run whose image transport is the Responses tool has no Images API model to name here; without
    // this guard every fragment fails with the same "No model found".
    if (!editorModel) {
        return { replaced, kept, warnings: ['Восстановление пропущено: модель для Images API не определена (imageModel не задан, транспорт — Responses tool).'], patchesProposed };
    }
    const scratch = path.posix.join(outDir ?? '.tmp', `restore-${Date.now()}`);
    const scratchAbs = path.join(root, ...scratch.split('/'));

    for (const file of files) {
        signal?.throwIfAborted();
        const abs = file.abs ?? path.join(root, ...file.rel.split('/'));
        const frame = await rasterInfo(abs, { cwd: root, engine }).catch(() => null);
        if (!frame?.width || !frame?.height) {
            kept.push({ rel: file.rel, reason: 'файл не читается' });
            continue;
        }

        let plan;
        try {
            plan = await askRestorer({
                cwd: root, roles, file, originalPart: originals.get(file.rel)?.part ?? null,
                frame, model: modelOverride, effort, signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            warnings.push(`${file.rel}: restorer не ответил (${errorMessage(error)}); файл остаётся как есть.`);
            kept.push({ rel: file.rel, reason: 'restorer не ответил' });
            continue;
        }
        if (!plan.data) {
            warnings.push(`${file.rel}: план восстановления не разобран (${plan.error ?? plan.status}); файл остаётся как есть.`);
            kept.push({ rel: file.rel, reason: plan.error ?? plan.status });
            continue;
        }
        if (plan.data.verdict !== 'repair' || !(plan.data.patches ?? []).length) {
            kept.push({ rel: file.rel, reason: 'чисто' });
            continue;
        }
        patchesProposed += plan.data.patches.length;

        const accepted = pickPatches(plan.data.patches, {
            frameWidth: frame.width, frameHeight: frame.height, maxPatches,
        });
        for (const rejected of accepted.rejected) {
            warnings.push(`${file.rel}: патч (${rejected.patch.x},${rejected.patch.y}) ${rejected.patch.width}×${rejected.patch.height} отклонён — ${rejected.reason}.`);
        }
        if (!accepted.patches.length) {
            kept.push({ rel: file.rel, reason: 'все патчи отклонены' });
            continue;
        }

        notify({
            type: 'restore.start', file: file.rel, patches: accepted.patches.length,
            assessment: plan.data.assessment ?? '', model: editorModel,
        });

        // Each patch is applied to the result of the previous one, so the last merge is the file
        // that replaces the sub-reference. Merges accumulate in the scratch directory; only the
        // final copy is written under `restored/`.
        let currentAbs = abs;
        const applied = [];
        await mkdir(scratchAbs, { recursive: true }).catch(() => {});
        for (const [index, patch] of accepted.patches.entries()) {
            signal?.throwIfAborted();
            const box = planFragment(patch, { frameWidth: frame.width, frameHeight: frame.height });
            const stem = path.posix.basename(file.rel, path.posix.extname(file.rel));
            const fragmentRel = `${scratch}/${stem}-${index + 1}.png`;
            const editedRel = `${scratch}/${stem}-${index + 1}-edited.png`;
            const mergedRel = `${scratch}/${stem}-${index + 1}-merged.png`;
            const fragmentAbs = resolveInside(root, fragmentRel, { forWrite: true, allowRoot: false }).abs;
            const editedAbs = resolveInside(root, editedRel, { forWrite: true, allowRoot: false }).abs;
            const mergedAbs = resolveInside(root, mergedRel, { forWrite: true, allowRoot: false }).abs;
            try {
                await rasterCrop({
                    input: currentAbs, output: fragmentAbs, x: box.x, y: box.y,
                    width: box.width, height: box.height, cwd: root, signal, engine,
                });
                const bytes = await readFile(fragmentAbs);
                const payloads = await client.images.edit({
                    model: editorModel,
                    prompt: editorPrompt(patch.prompt),
                    size: null, format: config.image?.format ?? 'png', background: 'auto', signal,
                    files: [{
                        filename: path.basename(fragmentAbs),
                        mime: sniffImage(bytes).mime,
                        bytes,
                    }],
                });
                if (!Array.isArray(payloads) || !payloads.length) throw new Error('модель вернула пустой ответ');
                await writeFile(editedAbs, Buffer.from(payloads[0], 'base64'));
                const merged = await rasterPatch({
                    input: currentAbs, patch: editedAbs, output: mergedAbs,
                    x: box.x, y: box.y, width: box.width, height: box.height, cwd: root, signal, engine,
                });
                applied.push({
                    kind: patch.kind, box: merged.box, finding: patch.finding,
                    prompt: patch.prompt, resized: merged.resized, grown: box.grown,
                });
                currentAbs = mergedAbs;
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                warnings.push(`${file.rel}: регион ${index + 1} не исправлен (${errorMessage(error)}).`);
            } finally {
                await unlink(fragmentAbs).catch(() => {});
                await unlink(editedAbs).catch(() => {});
                // A merge that did not become the current one is dead weight; the scratch directory
                // is removed at the end of the file either way.
                if (currentAbs !== mergedAbs) await unlink(mergedAbs).catch(() => {});
            }
        }

        await rm(scratchAbs, { recursive: true, force: true }).catch(() => {});
        if (!applied.length) {
            kept.push({ rel: file.rel, reason: 'ни один регион не исправлен' });
            notify({ type: 'restore.done', file: file.rel, status: 'failed', patches: 0 });
            continue;
        }

        const to = restoredPath(file.rel);
        const target = path.join(root, ...to.split('/'));
        try {
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(currentAbs, target);
        } catch (error) {
            warnings.push(`${file.rel}: результат восстановления не сохранён (${errorMessage(error)}).`);
            kept.push({ rel: file.rel, reason: 'результат не сохранён' });
            continue;
        }

        let verification = null;
        if (verify) {
            try {
                verification = await verifyRepair({
                    roles, before: file.rel, after: to, cwd: root, maxBytes,
                    model: modelOverride, effort, signal,
                });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                verification = { verdict: 'worse', reason: errorMessage(error) };
            }
            if (verification.verdict !== 'better') {
                warnings.push(`${file.rel}: восстановление отклонено верификацией (${verification.verdict}: ${verification.reason}) — остаётся исходный суб-референс.`);
                await unlink(target).catch(() => {});
                kept.push({ rel: file.rel, reason: `вердикт ${verification.verdict}` });
                notify({ type: 'restore.done', file: file.rel, status: 'rejected', patches: applied.length, verdict: verification.verdict });
                continue;
            }
        }

        const saved = await readFile(target);
        replaced.push({ from: file.rel, to, patches: applied, verification, bytes: saved.length });
        notify({
            type: 'restore.done', file: file.rel, status: 'repaired',
            to, patches: applied.length, verdict: verification?.verdict ?? 'not verified',
        });
    }

    return { replaced, kept, warnings, patchesProposed };
}

/**
 * Point the decomposition at the repaired copies.
 *
 * Pure, so the rewrite of `subReference` / `subReferences` is testable without an image API: a
 * replaced file must be renamed in both places the decomposition lists it, or the measurer keeps
 * attaching the dirty one while the report already names the clean one.
 * @param {object} decomposition the decomposition to rewrite (mutated)
 * @param {Array<{from:string,to:string}>} replaced repairs to apply
 * @returns {number} how many screen entries were repointed
 * @exports
 * @ai.hint pure
 */
export function applyRepairs(decomposition, replaced = []) {
    if (!decomposition || !replaced.length) return 0;
    const byPath = new Map(replaced.map((item) => [item.from, item]));
    const swap = (value) => {
        const rel = String(value ?? '').trim().split(path.sep).join('/');
        const hit = byPath.get(rel) ?? byPath.get(rel.replace(/^\.tmp\/[^/]+\/decomposition\//, ''));
        return hit ? hit.to : value;
    };
    let touched = 0;
    for (const screen of Array.isArray(decomposition.screens) ? decomposition.screens : []) {
        const next = swap(screen.subReference);
        if (next && next !== screen.subReference) {
            screen.subReference = next;
            if (!screen.subReferenceKind || screen.subReferenceKind === 'restored' || screen.subReferenceKind === 'regenerated') {
                screen.subReferenceKind = 'repaired';
            }
            touched += 1;
        }
    }
    for (const entry of Array.isArray(decomposition.subReferences) ? decomposition.subReferences : []) {
        const next = swap(entry.path);
        if (next && next !== entry.path) {
            entry.path = next;
            entry.kind = 'repaired';
            touched += 1;
        }
    }
    return touched;
}

export { EDITOR_FRAME, MAX_PATCH_COVERAGE, MIN_FRAGMENT_SIDE };
