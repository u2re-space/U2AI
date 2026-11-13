/**
 * @file archive/reference-phases/schemas.js
 * @module archive/reference-phases/schemas
 * @purpose Archived JSON schemas for the reference phases (extender, rectifier, restorer).
 *
 * On revival: merge lines 187-311 of src/agent/schemas.js back into that file.
 * The helpers `object`, `string`, `nullableString`, etc. are defined here so the
 * archived copy is a standalone module — but it does NOT need to run again.
 *
 * @ai.tags archived
 */

// ── helpers (copied from src/agent/schemas.js) ──────────────────────────
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const RESTORE_DEFECT_KINDS = ['leftover', 'missing', 'seam', 'artefact'];

const quadCorner = object({
    x: { type: 'number', description: 'X in pixels, measured from the left edge of this image.' },
    y: { type: 'number', description: 'Y in pixels, measured from the top edge of this image.' },
});

/**
 * The extension plan for one reference, produced by the `extender` role (phase 0.5).
 */
export const EXTEND_SCHEMA = object({
    verdict: {
        type: 'string', enum: ['keep', 'extend'],
        description: 'keep when every element that matters is complete inside the frame; extend when the picture is cut through real content.',
    },
    assessment: { ...string, description: 'What is cut off and where, or why the frame is complete. Say "nothing is cut" when keeping.' },
    edge: {
        type: 'string', enum: ['', 'bottom', 'right', 'top', 'left'],
        description: 'The edge the content is clipped by, the one the grown band has to continue from; empty when the verdict is keep.',
    },
    prompt: {
        ...string,
        description: 'The instruction for the image editor for the empty band only: what content continues into it and in what style, and what colours to carry on. Written from what this picture shows. Empty when the verdict is keep.',
    },
});

/**
 * The geometry verdict for one reference, produced by the `rectifier` role (phase 1).
 */
export const RECTIFY_SCHEMA = object({
    verdict: {
        type: 'string', enum: ['keep', 'rectified', 'unresolved'],
        description: 'keep when the picture is already one flat front-facing screen and you wrote no file; rectified when you produced at least one file and named every one of them in screens; unresolved when the picture is distorted or cut up but a corner could not be placed — say what is missing.',
    },
    assessment: { ...string, description: 'What the picture is (export or photograph of a screen, a collage of several) and how each screen sits in it. Say "flat export, no projection needed" when keeping.' },
    screens: {
        type: 'array',
        maxItems: 8,
        description: 'One entry per file you produced — for a collage, one entry per screen you cut out and levelled. Empty when the verdict is keep or unresolved.',
        items: object({
            label: { ...string, description: 'What this screen is, in two or three words, from what is on it (e.g. "transfer screen"). Used only to name the file when the tool left the naming to you.' },
            output: {
                ...string,
                description: 'The path of the file correct_perspective produced, exactly as the tool reported it.',
            },
            quad: {
                ...object({
                    tl: { ...quadCorner, description: 'The corner nearest the top-left of the screen as a viewer reads it.' },
                    tr: { ...quadCorner, description: 'The corner nearest the top-right of the screen as a viewer reads it.' },
                    br: { ...quadCorner, description: 'The corner nearest the bottom-right of the screen as a viewer reads it.' },
                    bl: { ...quadCorner, description: 'The corner nearest the bottom-left of the screen as a viewer reads it.' },
                }),
                description: 'The four corners you passed to correct_perspective for THIS screen, in the pixel coordinates of the original image. Corners of the interface itself — not the device bezel, not the desk behind it.',
            },
        }),
    },
});

/**
 * The repair plan for one sub-reference, produced by the `restorer` role.
 */
export const RESTORE_SCHEMA = object({
    verdict: {
        type: 'string', enum: ['clean', 'repair'],
        description: 'clean when the picture is a usable flat screen as it is; repair when something blocks measuring it.',
    },
    assessment: { ...string, description: 'One or two sentences on what you see and why it is or is not usable. Say "no defects" when clean.' },
    patches: {
        type: 'array',
        description: 'Regions to repair, in the pixel coordinates of the sub-reference image. Empty when the verdict is clean.',
        items: object({
            kind: {
                type: 'string', enum: RESTORE_DEFECT_KINDS,
                description: 'leftover = something that is not this screen (a strip of the neighbouring screen, a device bezel, a finger, a glare, a transparent wedge from an earlier rotation, a duplicated band at a seam); missing = part of a real element the frame cut off, which the visible pixels determine unambiguously; seam = a resampling artefact along a rectified edge; artefact = other damage that blocks measurement.',
            },
            x: { type: 'integer', description: 'Left edge of the region in pixels of the sub-reference image.' },
            y: { type: 'integer', description: 'Top edge of the region in pixels of the sub-reference image.' },
            width: { type: 'integer', description: 'Width of the region in pixels. Tight around the damage, not the whole screen.' },
            height: { type: 'integer', description: 'Height of the region in pixels. Tight around the damage, not the whole screen.' },
            finding: { ...string, description: 'What is wrong there, stated as an observed fact about this picture ("the left 18 px carry the right edge of the previous screen").' },
            prompt: {
                ...string,
                description: 'The instruction for the image editor, written for this region only: what to remove or to continue, and what to keep identical. Name the colours, the edge, and the direction the missing part must continue in. Never ask for a restyle, a cleanup, a translation, or new content.',
            },
        }),
    },
});

/**
 * The verdict on one repaired file: before against after.
 */
export const RESTORE_VERIFY_SCHEMA = object({
    verdict: {
        type: 'string', enum: ['better', 'same', 'worse'],
        description: 'better only when the defect is gone and the text, positions, sizes and colours survived; worse when anything else changed.',
    },
    reason: { ...string, description: 'One sentence naming what changed between the two files.' },
});
